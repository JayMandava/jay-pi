import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { discoverAgents, type AgentScope } from './agents.ts';
import { createHarness, finalOutput } from '../harness/runtime.mjs';
// pi is a frontend, not a second execution engine. The CLI uses the same
// runtime, proof check, cancellation protocol and atomic run artifacts.
const Params = Type.Object({
    action: StringEnum(['catalog', 'run', 'status', 'result', 'cancel', 'cleanup'] as const),
    agent: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    previousRunId: Type.Optional(Type.String({ description: 'Context-only continuation from a terminal run; not provider session resume.' })),
    cycleId: Type.Optional(Type.String()),
    agentScope: Type.Optional(StringEnum(['user', 'project', 'both'] as const)),
    background: Type.Optional(Type.Boolean({ default: true })),
    autoHandoff: Type.Optional(Type.Boolean({ default: true })),
    confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
    allowEdits: Type.Optional(Type.Boolean({ default: false, description: 'Request mutation-capable role tools. Requires an actual interactive confirmation; not a sandbox guarantee.' })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 10, maximum: 86400000 })),
    envAllowlist: Type.Optional(Type.Array(Type.String(), { description: 'Additional environment variable names to forward. Values are never shown in the preview.' })),
    skipApprovalGuard: Type.Optional(Type.Boolean({ default: false, description: 'Deprecated: bypass is no longer supported. Approve the current plan instead.' })),
});
const text = (value: string, details?: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: value }], details: details ?? {}, ...(isError ? { isError: true } : {}) });
const statusText = (record: any) => `[status: ${record.status}]${record.statusReason ? ` ${record.statusReason}` : ''}`;
export default function lifecycleSubagent(pi: ExtensionAPI) {
    const harnesses = new Map<string, ReturnType<typeof createHarness>>();
    const harness = (cwd: string) => {
        let instance = harnesses.get(cwd);
        if (!instance) {
            instance = createHarness({ cwd });
            harnesses.set(cwd, instance);
        }
        return instance;
    };
    pi.on('session_start', async (_event, ctx) => {
        if (ctx.mode !== 'tui') {
            return;
        }
        try {
            const recovered = harness(ctx.cwd).recover();
            if (recovered.length) {
                ctx.ui.notify(`Recovered ${recovered.length} orphaned run(s). Inspect their partial work before retrying.`, 'warning');
            }
        }
        catch (error) {
            ctx.ui.notify(`Run recovery failed: ${String(error)}`, 'warning');
        }
    });
    pi.registerTool({
        name: 'subagent', label: 'Subagent',
        description: 'Run separate-process lifecycle agents with verified records, durable status, cancellation, and optional automatic handoff. Read-only tool profile by default; allowEdits needs human confirmation. Developer always needs an approved current plan.',
        parameters: Params,
        async execute(_id, params, signal, onUpdate, ctx) {
            try {
                const h = harness(ctx.cwd);
                const action = params.action;
                const agentScope = (params.agentScope ?? 'both') as AgentScope;
                if (action === 'catalog') {
                    const discovery = discoverAgents(ctx.cwd, agentScope, ctx.sessionManager.getSessionId());
                    return text([
                        `Session: ${discovery.sessionId || '(none)'}`,
                        `Profile: ${discovery.sessionProfileSource} | ${discovery.sessionProfilePath}`,
                        ...discovery.agents.map(agent => `${agent.name} (${agent.source}) - ${agent.runner || 'pi'} | ${agent.model || 'default'}`),
                        ...(discovery.agents.length ? [] : ['No agents found.']),
                    ].join('\n'), { action, ...discovery });
                }
                if (action === 'status' || action === 'result') {
                    if (!params.runId) {
                        return text('runId is required for status/result.', undefined, true);
                    }
                    const record = h.get(params.runId);
                    if (!record) {
                        return text(`Unknown runId: ${params.runId}`, undefined, true);
                    }
                    const output = finalOutput(record.results[0]?.messages);
                    return text(action === 'status' ? `${record.runId}: ${record.status}${record.cancellationRequestedAt ? ' (cancellation requested)' : ''}\n${record.statusReason || ''}` : `${statusText(record)}\n\n${output || '(no output captured)'}`, { action, ...record });
                }
                if (action === 'cancel') {
                    if (!params.runId) {
                        return text('runId is required for cancel.', undefined, true);
                    }
                    const record = h.cancel(params.runId);
                    return text(`${record.runId}: ${record.status}${record.status === 'running' ? ' (cancellation requested; waiting for controller)' : ''}`, { action, ...record });
                }
                if (action === 'cleanup') {
                    const removed = h.cleanup(params.runId);
                    return text(`Removed ${removed.length} terminal run artifact(s).`, { action, removed });
                }
                if (signal?.aborted) {
                    return text('Canceled before starting a run.', undefined, true);
                }
                if (!params.agent || !params.task) {
                    return text('agent and task are required for action=run.', undefined, true);
                }
                if (params.skipApprovalGuard) {
                    return text('Approval bypass is no longer supported. Review and approve the current plan with approve_plan.', undefined, true);
                }
                const discovery = discoverAgents(ctx.cwd, agentScope, ctx.sessionManager.getSessionId());
                const agent = discovery.agents.find(candidate => candidate.name === params.agent);
                if (!agent) {
                    return text(`Unknown agent: ${params.agent}. Available: ${discovery.agents.map(a => a.name).join(', ') || 'none'}`, undefined, true);
                }
                if (agent.source === 'project') {
                    // A model-supplied confirmProjectAgents:false is not human consent.
                    if (!ctx.hasUI || !await ctx.ui.confirm('Run project-local agent?', `Agent: ${agent.name}\nSource: ${discovery.projectAgentsDir}\nOnly continue for a trusted repository.`)) {
                        return text('Project-local agent not approved.', undefined, true);
                    }
                }
                if (params.allowEdits) {
                    if (!ctx.hasUI || !await ctx.ui.confirm('Allow agent edits?', `Agent: ${agent.name}\nRunner: ${agent.runner || 'pi'}\nTask: ${params.task}\n\nThis permits mutation-capable tools. pi/Claude are trusted local processes, not OS sandboxes. Plan approval is still required for Developer.`)) {
                        return text('Mutation-capable tools not approved.', undefined, true);
                    }
                }
                if (params.envAllowlist?.length) {
                    if (!ctx.hasUI || !await ctx.ui.confirm('Forward extra environment variables?', `Names only: ${params.envAllowlist.join(', ')}\nThese values become accessible to the child process. Only approve names needed by this runner.`)) {
                        return text('Extra environment forwarding not approved.', undefined, true);
                    }
                }
                const background = params.background ?? true;
                const autoHandoff = params.autoHandoff ?? true;
                if (signal?.aborted) {
                    return text('Canceled while waiting for confirmation; no run started.', undefined, true);
                }
                const handle = h.start({
                    agent, task: params.task, previousRunId: params.previousRunId, cycleId: params.cycleId, timeoutMs: params.timeoutMs, envAllowlist: params.envAllowlist, permissionProfile: params.allowEdits ? 'workspace-write' : 'read-only', background, autoHandoff,
                    onUpdate: background ? undefined : (record: any) => onUpdate?.(text(`${statusText(record)}\n${finalOutput(record.results[0]?.messages) || '(running...)'}`, { action: 'run', ...record })),
                });
                const abort = () => { try {
                    h.cancel(handle.runId);
                }
                catch { } };
                if (!background) {
                    signal?.addEventListener('abort', abort, { once: true });
                    if (signal?.aborted) abort();
                }
                if (background) {
                    if (autoHandoff) {
                        void handle.completion.then((record: any) => {
                            pi.sendMessage({
                                customType: 'subagent-handoff', content: `Background ${agent.name} run ${record.runId} finished. ${statusText(record)}\n\n${finalOutput(record.results[0]?.messages) || '(no output captured)'}`, display: true, details: { runId: record.runId, status: record.status, artifactPath: record.artifactPath }
                            }, { deliverAs: 'followUp', triggerTurn: true });
                        }).catch(() => { });
                    }
                    return text(`Started ${agent.name} in background. runId: ${handle.runId}. autoHandoff: ${autoHandoff ? 'enabled' : 'disabled'}.`, { action: 'run', ...h.get(handle.runId) });
                }
                const record = await handle.completion;
                signal?.removeEventListener('abort', abort);
                return text(`${statusText(record)}\n\n${finalOutput(record.results[0]?.messages) || '(no output captured)'}`, { action: 'run', ...record }, record.status === 'failed' || record.status === 'orphaned');
            }
            catch (error) {
                return text(error instanceof Error ? error.message : String(error), undefined, true);
            }
        },
    });
    pi.registerCommand('subagent-runs', { description: 'List saved subagent runs', handler: async (_args, ctx) => {
            try {
                const runs = harness(ctx.cwd).list().slice(0, 20);
                ctx.ui.notify(runs.length ? runs.map(r => `${r.runId}  ${r.status}  ${r.updatedAt}`).join('\n') : 'No subagent runs found.', 'info');
            }
            catch (error) {
                ctx.ui.notify(String(error), 'error');
            }
        } });
}
