// Deterministic fake provider executable implementation. These are protocol
// fixtures, not vendor CLIs or model responses. No network calls are made.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeCycleRecord } from '../../extensions/cycle-store.mjs';

const STAGES = { planner: 'approach', developer: 'implementation', tester: 'feedback', lead: 'review' };
const flagValue = (args, flag) => {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `Expected ${flag}`);
  assert.ok(index + 1 < args.length, `Missing value for ${flag}`);
  return args[index + 1];
};

// Only decode the generated string-valued TOML inline table this contract
// uses. Reject anything else instead of evaluating config as JavaScript.
function parseStringTable(value) {
  assert.ok(value.startsWith('{') && value.endsWith('}'), 'Expected TOML inline table');
  let remaining = value.slice(1, -1).trim();
  const result = {};
  const entry = /^("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")\s*/;
  while (remaining) {
    const match = remaining.match(entry);
    assert.ok(match, 'Invalid string-valued TOML entry');
    result[JSON.parse(match[1])] = JSON.parse(match[2]);
    remaining = remaining.slice(match[0].length);
    if (!remaining) break;
    assert.equal(remaining[0], ',', 'Expected TOML entry separator');
    remaining = remaining.slice(1).trim();
  }
  return result;
}

function readMcpConfig(provider, args) {
  if (provider === 'claude') {
    const configPath = flagValue(args, '--mcp-config');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers), ['record-cycle']);
    return { ...config.mcpServers['record-cycle'], configPath };
  }
  const overrides = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '-c') continue;
    const value = args[++index];
    const separator = value.indexOf('=');
    assert.ok(separator > 0, 'Expected Codex key=value override');
    overrides[value.slice(0, separator)] = value.slice(separator + 1);
  }
  assert.equal(overrides.approval_policy, '"never"');
  assert.equal(overrides.mcp_servers, '{}');
  return {
    command: JSON.parse(overrides['mcp_servers.record-cycle.command']),
    args: JSON.parse(overrides['mcp_servers.record-cycle.args']),
    env: parseStringTable(overrides['mcp_servers.record-cycle.env']),
  };
}

async function callActualMcpServer(config, arguments_) {
  assert.equal(config.command, process.execPath, 'Use the actual Node executable, not an inherited command');
  assert.equal(config.args.length, 1);
  assert.equal(config.args[0], fileURLToPath(new URL('../../extensions/mcp/record-cycle-server/server.mjs', import.meta.url)), 'Only the actual record-cycle server may execute');
  assert.ok(fs.existsSync(config.args[0]), 'Generated MCP path must resolve');
  const server = spawn(config.command, config.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', stderr = '', nextId = 1;
  const pending = new Map();
  const rejectPending = error => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  server.stderr.on('data', bytes => { stderr += bytes; });
  server.stdin.on('error', rejectPending);
  server.stdout.on('data', bytes => {
    buffer += bytes;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let response;
      try { response = JSON.parse(line); }
      catch (error) { rejectPending(error); continue; }
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      pending.delete(response.id);
      if (response.error) waiter.reject(new Error(JSON.stringify(response.error)));
      else waiter.resolve(response.result);
    }
  });
  server.on('error', rejectPending);
  server.on('exit', () => rejectPending(new Error(`MCP server exited unexpectedly: ${stderr}`)));
  const timer = setTimeout(() => {
    rejectPending(new Error('Fixture MCP request timed out'));
    server.kill('SIGTERM');
  }, 5000);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialization = await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'jay-pi-fake-provider-process', version: '1' },
    });
    assert.equal(initialization.serverInfo.name, 'record-cycle');
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalog = await request('tools/list', {});
    assert.deepEqual(catalog.tools.map(tool => tool.name), ['record_cycle']);
    const result = await request('tools/call', { name: 'record_cycle', arguments: arguments_ });
    return { result, transport: 'actual-mcp-stdio', serverPid: server.pid };
  } finally {
    clearTimeout(timer);
    server.stdin.end();
    server.kill('SIGTERM');
    if (server.exitCode === null && server.signalCode === null) {
      await new Promise(resolve => server.once('exit', resolve));
    }
  }
}

export async function runProviderFixture(provider) {
  const args = process.argv.slice(2);
  const requestPath = path.join(process.cwd(), 'provider-fixture-request.json');
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  assert.equal(request.fixture, 'jay-pi-offline-provider');
  assert.equal(request.provider, provider);
  assert.match(process.env.PI_HARNESS_RUN_ID, /^run_[a-z0-9]+$/);
  let stdin = '';
  for await (const bytes of process.stdin) stdin += bytes;
  const prompt = provider === 'pi' ? args.at(-1) : stdin;
  assert.ok(prompt.includes(request.taskMarker), 'Actual adapter must deliver the task');
  const systemPrompt = provider === 'pi' ? fs.readFileSync(flagValue(args, '--append-system-prompt'), 'utf8') : null;
  const mcp = provider === 'pi' ? null : readMcpConfig(provider, args);
  if (mcp) {
    assert.equal(mcp.env.PI_HARNESS_RUN_ID, process.env.PI_HARNESS_RUN_ID);
    assert.equal(mcp.env.PI_HARNESS_CYCLE_ID, process.env.PI_HARNESS_CYCLE_ID);
  }
  const capture = {
    fixture: true, provider, pid: process.pid, args, stdin, prompt, systemPrompt,
    environmentKeys: Object.keys(process.env).sort(),
    forwardedValue: process.env.QA_PROVIDER_ALLOWED,
    deniedValue: process.env.QA_PROVIDER_DENIED ?? null,
    home: process.env.HOME,
    runId: process.env.PI_HARNESS_RUN_ID,
    cycleId: process.env.PI_HARNESS_CYCLE_ID,
    mcp,
  };
  const capturePath = path.join(process.cwd(), `provider-capture-${capture.runId}.json`);
  const saveCapture = () => {
    const temporary = `${capturePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(capture, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, capturePath);
  };
  saveCapture();
  const scenario = request.scenario ?? 'success';
  if (scenario === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'signal') {
    process.kill(process.pid, 'SIGTERM');
    return;
  }
  if (scenario === 'malformed') {
    process.stdout.write('not-json: record_cycle completed\n');
    return;
  }
  if (scenario === 'exit') {
    process.stderr.write('Deliberate fake provider exit failure\n');
    process.exitCode = 23;
    return;
  }
  let stage = STAGES[request.role];
  assert.ok(stage, 'Fixture role must be a lifecycle role');
  if (scenario === 'wrong-stage') stage = stage === 'feedback' ? 'approach' : 'feedback';
  const arguments_ = {
    stage, cycleId: process.env.PI_HARNESS_CYCLE_ID,
    summary: `Offline fake ${provider} process recorded ${request.role} evidence through the supported persistence boundary.`,
    data: { fixture: true, provider, role: request.role },
  };
  if (scenario === 'rejected-record') arguments_.summary = 'too thin';
  let toolResult;
  if (scenario !== 'missing-evidence') {
    if (provider === 'pi') {
      const receipt = writeCycleRecord({ cwd: process.cwd(), ...arguments_ });
      toolResult = { isError: !receipt.ok, structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      capture.transport = 'supported-cycle-store';
    } else {
      const actual = await callActualMcpServer(mcp, arguments_);
      toolResult = actual.result;
      capture.transport = actual.transport;
      capture.serverPid = actual.serverPid;
    }
    capture.toolResult = toolResult;
    saveCapture();
  }
  const events = [];
  const output = 'Offline provider fixture completed ✓; this is not a model response.';
  if (provider === 'pi') {
    if (toolResult) {
      events.push({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'record-1', name: 'record_cycle', arguments: arguments_ }] } });
      events.push({ type: 'tool_result_end', message: { role: 'toolResult', toolCallId: 'record-1', toolName: 'record_cycle', isError: !!toolResult.isError, details: toolResult.structuredContent, content: toolResult.content } });
    }
    events.push({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: output }], stopReason: scenario === 'provider-error' ? 'error' : 'stop', usage: { input: 12, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } } } });
  } else if (provider === 'claude') {
    events.push({ type: 'system', subtype: 'init', session_id: 'offline-session' });
    if (toolResult) {
      events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'record-1', name: 'mcp__record-cycle__record_cycle', input: arguments_ }] } });
      events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'record-1', is_error: !!toolResult.isError, content: toolResult.content }] } });
    }
    events.push({ type: 'assistant', message: { content: [{ type: 'text', text: output }], usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } } });
    events.push({ type: 'result', is_error: scenario === 'provider-error', result: output, total_cost_usd: 0.01 });
  } else {
    events.push({ type: 'thread.started', thread_id: 'offline-thread' }, { type: 'turn.started' });
    if (toolResult) {
      events.push({ type: 'item.completed', item: { id: 'record-1', type: 'mcp_tool_call', server: 'record-cycle', tool: 'record_cycle', arguments: arguments_, status: toolResult.isError ? 'failed' : 'completed', result: toolResult } });
    }
    events.push({ type: 'item.completed', item: { id: 'answer-1', type: 'agent_message', text: output } });
    events.push(scenario === 'provider-error'
      ? { type: 'turn.failed', error: { message: 'Deliberate provider-reported failure' } }
      : { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: 2 } });
  }
  for (let index = 0; index < events.length; index++) {
    const bytes = Buffer.from(JSON.stringify(events[index]) + (index === events.length - 1 ? '' : '\n'));
    const unicode = bytes.indexOf(Buffer.from('✓'));
    const split = unicode < 0 ? Math.floor(bytes.length / 2) : unicode + 1;
    process.stdout.write(bytes.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 2));
    process.stdout.write(bytes.subarray(split));
  }
  if (scenario === 'exit-after-evidence') process.exitCode = 23;
}
