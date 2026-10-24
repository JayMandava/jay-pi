#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const HELP = `Jay Pi — evidence-first agent work

  jay-pi demo                         Run a complete offline fixture cycle
  jay-pi doctor                       Inspect local prerequisites (no execution)
  jay-pi run --role ROLE --task TEXT   Run a role through the shared engine
    --runner pi|claude-cli|codex-cli|mock  (default: pi)
    --model NAME --cycle ID --timeout MS --previous RUN_ID
    --allow-edits                     Explicit workspace-write permission
  jay-pi list                         List saved runs
  jay-pi status RUN_ID                 Inspect outcome and evidence
  jay-pi result RUN_ID                 Read final output
  jay-pi events RUN_ID                 Inspect lifecycle events
  jay-pi plan                          Show the latest recorded plan
  jay-pi approve [ROW_ID]              Review and approve exact plan (TTY only)
  jay-pi recover                      Mark abandoned runs; never replay work

Global: --cwd DIRECTORY --json --help
Run is foreground; Ctrl-C cancels the owned child. Approval is a trusted-local
human operation, not an agent tool. No --yes bypass. Provider calls may incur
costs; demo uses only local fixture subprocesses, with no credentials/network.
`;
const VALUE_FLAGS = new Set(['cwd', 'role', 'task', 'runner', 'model', 'cycle', 'timeout', 'previous']);
function parse(argv) {
  const opts = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (key === 'json' || key === 'help' || key === 'allow-edits') { opts[key] = true; continue; }
    if (!VALUE_FLAGS.has(key)) throw new Error(`Unknown option: ${arg}`);
    if (opts[key] !== undefined) throw new Error(`Duplicate option: ${arg}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`Missing value: ${arg}`);
    opts[key] = argv[++i];
  }
  return { opts, positional };
}
function output(value, json, human) {
  process.stdout.write(json ? JSON.stringify(value, null, 2) + '\n' : (human ?? JSON.stringify(value, null, 2)) + '\n');
}
function finalText(record) {
  const messages = record.results?.[0]?.messages ?? [];
  return [...messages].reverse().find(m => m.role === 'assistant' && m.content?.some(p => p.type === 'text'))?.content.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '(no output)';
}
function executableOnPath(name) {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}
function rolePrompt(name) {
  if (name === 'lead') return 'Review the approved plan, implementation and independent tester evidence. Record concrete review findings through record_cycle with stage review. Never claim checks that were not performed.';
  const file = fileURLToPath(new URL(`../agents/${name}.md`, import.meta.url));
  return fs.readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}
function hasMcpDependencies(root) {
  try { createRequire(path.join(root, 'extensions/mcp/record-cycle-server/server.mjs')).resolve('@modelcontextprotocol/sdk/server/index.js'); return true; } catch { return false; }
}
async function doctor(opts) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = {
    node: process.version, nodeSupported: Number(process.versions.node.split('.')[0]) >= 24,
    cwd: path.resolve(opts.cwd ?? process.cwd()),
    providers: ['pi', 'claude', 'codex'].map(command => ({ command, installed: executableOnPath(command), liveValidated: false })),
    mcpServer: fs.existsSync(path.join(root, 'extensions/mcp/record-cycle-server/server.mjs')),
    mcpDependencies: hasMcpDependencies(root),
    note: 'Presence only; no provider was invoked. Offline demo needs only Node 24+. Live CLI contracts are fixture-tested, not account-validated. Local workflow gates are not a hostile-code sandbox.',
  };
  output(report, opts.json, `Jay Pi doctor\nNode ${report.node}: ${report.nodeSupported ? 'supported' : 'upgrade to 24+'}\n${report.providers.map(p => `${p.command}: ${p.installed ? 'found' : 'not installed (optional)'}`).join('\n')}\nRecord MCP dependencies: ${report.mcpDependencies ? 'present' : 'missing (needed for live MCP runners)'}\n${report.note}`);
  if (!report.nodeSupported) process.exitCode = 1;
}
async function demo(opts, createHarness, approval) {
  if (opts.cwd) throw new Error('demo always creates an isolated temporary workspace; omit --cwd.');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-pi-demo-'));
  const harness = createHarness({ cwd });
  const cycleId = 'OFFLINE-DEMO-R1', steps = [];
  const run = async (name, scenario = 'success') => {
    const handle = await harness.start({ agent: { name, runner: 'mock', systemPrompt: '' }, task: `Offline fixture: ${name} for ${cycleId}.`, cycleId, mockScenario: scenario, timeoutMs: 5000 });
    const record = await handle.completion;
    steps.push({ role: name, scenario, runId: record.runId, status: record.status });
    return record;
  };
  await run('planner');
  const plan = approval.getLatestApproach(cwd);
  if (!plan) throw new Error('Fixture planner did not persist a plan.');
  approval.approveApproach(cwd, plan.id, { confirmed: true, actor: 'offline-demo-fixture (not a human approval)', expectedDigest: plan.digest });
  await run('developer'); await run('tester'); await run('lead');
  await run('tester', 'incomplete'); await run('tester', 'wrong-stage'); await run('tester', 'fail');
  const hanging = await harness.start({ agent: { name: 'tester', runner: 'mock', systemPrompt: '' }, task: 'Offline cancellation fixture.', cycleId, mockScenario: 'hang', timeoutMs: 5000 });
  await harness.cancel(hanging.runId);
  const canceled = await hanging.completion;
  steps.push({ role: 'tester', scenario: 'cancel', runId: canceled.runId, status: canceled.status });
  const interruptedRunId = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/recovery-fixture.mjs', import.meta.url))], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await harness.recover();
  const recovered = await harness.get(interruptedRunId);
  steps.push({ role: 'tester', scenario: 'recovery', runId: interruptedRunId, status: recovered.status });
  const expected = ['completed', 'completed', 'completed', 'completed', 'incomplete', 'incomplete', 'failed', 'canceled', 'orphaned'];
  const passed = steps.every((s, i) => s.status === expected[i]);
  const report = { mode: 'offline-fixture', syntheticApproval: true, cwd, cycleId, passed, steps,
    note: 'Local mock subprocesses, real SQLite writes and shared runtime. No models, accounts, network or human approval were exercised. Workspace retained for inspection.' };
  output(report, opts.json, `Jay Pi offline demo — ${passed ? 'PASS' : 'FAIL'}\n${steps.map(s => `${s.role.padEnd(10)} ${s.scenario.padEnd(12)} ${s.status.padEnd(10)} ${s.runId}`).join('\n')}\n\n${report.note}\nInspect: node bin/jay-pi.mjs list --cwd ${JSON.stringify(cwd)}\nWorkspace: ${cwd}`);
  if (!passed) process.exitCode = 1;
}
async function main() {
  const { opts, positional } = parse(process.argv.slice(2));
  const command = positional.shift() ?? 'help';
  if (opts.help || command === 'help') { process.stdout.write(HELP); return; }
  if (command === 'doctor') { await doctor(opts); return; }
  const { createHarness } = await import('../extensions/harness/runtime.mjs');
  const approval = await import('../extensions/harness/approval-store.mjs');
  if (command === 'demo') { await demo(opts, createHarness, approval); return; }
  const cwd = path.resolve(opts.cwd ?? process.cwd()), harness = createHarness({ cwd });
  if (command === 'list') {
    const records = await harness.list();
    output(records, opts.json, records.length ? records.map(r => `${r.runId}  ${r.status.padEnd(10)} ${r.results?.[0]?.agent ?? '-'}  ${r.updatedAt}`).join('\n') : 'No runs yet. Try jay-pi demo.'); return;
  }
  if (['status', 'result', 'events'].includes(command)) {
    if (!positional[0]) throw new Error(`${command} requires RUN_ID.`);
    const record = await harness.get(positional[0]);
    if (!record) throw new Error(`Unknown run: ${positional[0]}`);
    const value = command === 'events' ? record.events ?? [] : record;
    output(value, opts.json, command === 'result' ? `[${record.status}]\n${finalText(record)}` : undefined); return;
  }
  if (command === 'recover') { output(await harness.recover(), opts.json); return; }
  if (command === 'plan' || command === 'approve') {
    const plan = approval.getLatestApproach(cwd);
    if (!plan) throw new Error('No plan recorded. Run Planner first.');
    if (command === 'plan') { output(plan, opts.json); return; }
    if (positional[0] && String(plan.id) !== positional[0]) throw new Error('Only the latest plan may be approved. Inspect jay-pi plan.');
    if (!process.stdin.isTTY || !process.stdout.isTTY || opts.json) throw new Error('Approval requires an interactive terminal. Piped input, --json and unattended approval are refused.');
    output(plan, false);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await rl.question(`Approve this exact plan? Type "approve ${plan.id}" (anything else declines): `); } finally { rl.close(); }
    if (answer !== `approve ${plan.id}`) { output({ approved: false }, false, 'Not approved.'); return; }
    const result = approval.approveApproach(cwd, plan.id, { confirmed: true, actor: 'local-terminal-user', expectedDigest: plan.digest });
    output(result, false, `Approved plan ${plan.id}. Any revision invalidates this approval.`); return;
  }
  if (command === 'run') {
    if (!opts.role || !opts.task) throw new Error('run requires --role and --task.');
    if (!['planner', 'developer', 'tester', 'lead'].includes(opts.role)) throw new Error('Role must be planner, developer, tester or lead.');
    const timeoutMs = opts.timeout === undefined ? 300000 : Number(opts.timeout);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('--timeout must be an integer from 1 to 3600000 milliseconds.');
    const handle = await harness.start({ agent: { name: opts.role, runner: opts.runner ?? 'pi', model: opts.model, systemPrompt: rolePrompt(opts.role) }, task: opts.task, cycleId: opts.cycle, previousRunId: opts.previous, timeoutMs, permissionProfile: opts['allow-edits'] ? 'workspace-write' : 'read-only' });
    const stop = () => { void harness.cancel(handle.runId); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const record = await handle.completion;
      output(record, opts.json, `${record.runId}: ${record.status}\n${record.statusReason ?? ''}\n${finalText(record)}`);
      if (record.status !== 'completed') process.exitCode = record.status === 'incomplete' ? 2 : 1;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  throw new Error(`Unknown command: ${command}. Run jay-pi --help.`);
}
main().catch(error => { process.stderr.write(`jay-pi: ${error.message}\n`); process.exitCode = 1; });
