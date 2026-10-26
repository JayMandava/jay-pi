import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const PROVIDERS = Object.freeze({
    pi: {
        id: 'pi', status: 'existing integration, fixture-tested', resume: false, recordCycle: true, isolation: 'none; trusted local process'
    },
    'claude-cli': {
        id: 'claude-cli', status: 'CLI adapter, fixture-tested; live validation required', resume: false, recordCycle: true, isolation: 'tool policy only; not an OS sandbox'
    },
    'codex-cli': {
        id: 'codex-cli', status: 'experimental CLI adapter, fixture-tested; live validation required', resume: false, recordCycle: true, isolation: 'requests provider read-only sandbox; host MCP is outside it'
    },
    mock: {
        id: 'mock', status: 'offline deterministic fixture, not an AI provider', resume: false, recordCycle: true, isolation: 'fixture subprocess only'
    },
});
export function scopedEnvironment(source = process.env, allowlist = []) {
    if (!Array.isArray(allowlist) || allowlist.some(k => typeof k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) {
        throw new Error('envAllowlist must contain environment variable names');
    }
    const base = ['PATH', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM'];
    const env = {};
    for (const key of new Set([...base, ...allowlist])) {
        if (key.startsWith('PI_HARNESS_')) {
            continue;
        }
        if (source[key] !== undefined) {
            env[key] = source[key];
        }
    }
    return env;
}
export function buildInvocation({ runner = 'pi', agent, prompt, runId, cycleId, mockScenario = 'success', env, tempDir, permissionProfile = 'read-only' }) {
    if (typeof runner !== 'string' || !Object.hasOwn(PROVIDERS, runner)) {
        throw new Error(`Unsupported runner: ${runner}`);
    }
    if (!['read-only', 'workspace-write'].includes(permissionProfile)) {
        throw new Error('Unsupported permission profile');
    }
    const mcpServer = fileURLToPath(new URL('../mcp/record-cycle-server/server.mjs', import.meta.url));
    const recordEnv = { PI_HARNESS_RUN_ID: runId, ...(cycleId ? { PI_HARNESS_CYCLE_ID: cycleId } : {}) };
    const args = [];
    if (runner === 'mock') {
        if (!['success', 'incomplete', 'wrong-stage', 'fail', 'hang', 'malformed', 'signal', 'oversize', 'fragmented'].includes(mockScenario)) {
            throw new Error('Unknown mock scenario');
        }
        return {
            command: process.execPath, args: [fileURLToPath(new URL('./mock-worker.mjs', import.meta.url)), agent.name, mockScenario], stdin: prompt, env: { ...env, ...recordEnv }, security: PROVIDERS.mock
        };
    }
    if (runner === 'pi') {
        args.push('--mode', 'json', '-p', '--no-session');
        if (agent.model) {
            args.push('--model', agent.model);
        }
        if (agent.thinking) {
            args.push('--thinking', agent.thinking);
        }
        const tools = permissionProfile === 'workspace-write' ? (agent.tools?.length ? agent.tools : ['read', 'bash', 'edit', 'write']) : ['read', 'grep', 'find', 'ls'];
        args.push('--tools', tools.join(','));
        const promptFile = path.join(tempDir, 'system.md');
        fs.writeFileSync(promptFile, agent.systemPrompt || '', { mode: 0o600 });
        args.push('--append-system-prompt', promptFile, prompt);
        return {
            command: 'pi', args, env: { ...env, ...recordEnv }, security: { ...PROVIDERS.pi, permissionProfile }
        };
    }
    if (runner === 'claude-cli') {
        const config = path.join(tempDir, 'mcp.json');
        fs.writeFileSync(config, JSON.stringify({ mcpServers: { 'record-cycle': { command: process.execPath, args: [mcpServer], env: recordEnv } } }), { mode: 0o600 });
        // Do not inherit user/project allow rules or hooks. This still shares HOME
        // for login and is explicitly not a hostile-code isolation boundary.
        args.push('-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--setting-sources', '', '--tools', permissionProfile === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep', '--allowedTools', permissionProfile === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write,mcp__record-cycle__record_cycle' : 'Read,Glob,Grep,mcp__record-cycle__record_cycle', '--mcp-config', config, '--strict-mcp-config');
        if (agent.model) {
            args.push('--model', agent.model);
        }
        return {
            command: 'claude', args, stdin: prompt, env: { ...env, ...recordEnv }, security: { ...PROVIDERS['claude-cli'], permissionProfile }
        };
    }
    // The adapter requests read-only shell access. record_cycle is the only
    // injected MCP server; it is a host process with narrow write semantics.
    // Unknown CLI flags fail the run rather than silently downgrading policy.
    args.push('exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', permissionProfile, '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '-c', `mcp_servers.record-cycle.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.record-cycle.args=${JSON.stringify([mcpServer])}`, '-c', `mcp_servers.record-cycle.env=${`{${Object.entries(recordEnv).map(([key,value])=>`${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ')}}`}`);
    if (agent.model) {
        args.push('--model', agent.model);
    }
    args.push('-');
    return {
        command: 'codex', args, stdin: prompt, env: { ...env, ...recordEnv }, security: { ...PROVIDERS['codex-cli'], permissionProfile }
    };
}
const textMessage = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() });
export function createNormalizer(runner) {
    if (typeof runner !== 'string' || !Object.hasOwn(PROVIDERS, runner)) {
        throw new Error(`Unsupported runner: ${runner}`);
    }
    const names = new Map();
    return event => {
        const messages = [];
        let failed = false;
        let usage;
        if (runner === 'pi' || runner === 'mock') {
            if (['message_end', 'tool_result_end'].includes(event.type) && event.message && ['assistant', 'toolResult'].includes(event.message.role)) {
                messages.push(event.message);
            }
            if (event.message?.stopReason === 'error' || event.type === 'error') {
                failed = true;
            }
            if (event.message?.role === 'assistant' && event.message.usage) {
                const value = event.message.usage;
                usage = {input:value.input, output:value.output, cacheRead:value.cacheRead, cacheWrite:value.cacheWrite, contextTokens:value.totalTokens, cost:value.cost?.total};
            }
            return { messages, failed, usage };
        }
        if (runner === 'claude-cli') {
            if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                const content = event.message.content.flatMap(part => {
                    if (part.type === 'text' && typeof part.text === 'string') {
                        return [{ type: 'text', text: part.text }];
                    }
                    if (part.type === 'tool_use' && typeof part.id === 'string') {
                        names.set(part.id, part.name);
                        return [{
                                type: 'toolCall', id: part.id, name: part.name, arguments: part.input
                            }];
                    }
                    return [];
                });
                messages.push({
                    role: 'assistant', content, timestamp: Date.now(), model: event.message.model, usage: event.message.usage
                });
                const value=event.message.usage;
                if(value) usage={input:value.input_tokens,output:value.output_tokens,cacheRead:value.cache_read_input_tokens,cacheWrite:value.cache_creation_input_tokens,contextTokens:(value.input_tokens??0)+(value.output_tokens??0)};
            }
            if (event.type === 'user' && Array.isArray(event.message?.content)) {
                for (const part of event.message.content) {
                    if (part.type === 'tool_result') {
                        messages.push({
                            role: 'toolResult', toolCallId: part.tool_use_id, toolName: names.get(part.tool_use_id), isError: !!part.is_error, content: typeof part.content === 'string' ? [{ type: 'text', text: part.content }] : part.content, timestamp: Date.now()
                        });
                    }
                }
            }
            if (event.type === 'result') {
                failed = !!event.is_error;
                if (typeof event.result === 'string') {
                    messages.push(textMessage(event.result));
                }
                usage = { costTotal: event.total_cost_usd };
            }
            return { messages, failed, usage };
        }
        if (event.type === 'item.completed' && event.item) {
            const item = event.item;
            if (item.type === 'agent_message' && typeof item.text === 'string') {
                messages.push(textMessage(item.text));
            }
            if (item.type === 'mcp_tool_call') {
                const name = `mcp__${item.server}__${item.tool}`;
                messages.push({ role: 'assistant', content: [{
                            type: 'toolCall', id: item.id, name, arguments: item.arguments
                        }] });
                messages.push({
                    role: 'toolResult', toolCallId: item.id, toolName: name, isError: item.status !== 'completed' || !!item.error, content: item.result?.content ?? [], details: item.result?.structuredContent
                });
            }
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
            failed = true;
        }
        if (event.type === 'turn.completed') {
            const value=event.usage;
            if(value)usage={input:value.input_tokens,output:value.output_tokens,cacheRead:value.cached_input_tokens,contextTokens:(value.input_tokens??0)+(value.output_tokens??0)};
        }
        return { messages, failed, usage };
    };
}
