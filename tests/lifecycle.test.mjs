import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUB = fileURLToPath(new URL('./fixtures/stub-claude.mjs', import.meta.url));

// Runs the real `subagent` tool against a stub `claude` on PATH, in a temp HOME
// and a temp project, so nothing touches the user's pi config or real providers.
async function fixture(t, { projectAgent = false, hasUI = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'));
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  for (const dir of [cwd, bin, path.join(home, '.pi/agent/agents')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`, { mode: 0o755 });
  const agentMd = '---\nname: tester\ndescription: t\nrunner: claude-cli\ntools: read, record_cycle\n---\nYou are the tester.';
  fs.writeFileSync(path.join(home, '.pi/agent/agents/tester.md'), agentMd);
  if (projectAgent) {
    fs.mkdirSync(path.join(cwd, '.pi/agents'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.pi/agents/tester.md'), agentMd);
  }
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, STUB_SCENARIO: process.env.STUB_SCENARIO };
  process.env.HOME = home;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  t.after(() => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); fs.rmSync(root, { recursive: true, force: true }); });
  const { default: register } = await import(`../extensions/lifecycle-subagent/index.ts?${Math.random()}`);
  let tool;
  register({ on() {}, registerTool(value) { tool = value; }, registerCommand() {}, sendMessage() {} });
  const ctx = { cwd, hasUI, mode: 'tui', sessionManager: { getSessionId: () => 'fixture-session' }, ui: { confirm: async () => true, notify() {} } };
  const call = (params) => tool.execute('call', params, null, null, ctx);
  const run = (scenario, extra = {}) => { process.env.STUB_SCENARIO = scenario; return call({ action: 'run', agent: 'tester', task: 'check it', background: false, ...extra }); };
  return { cwd, call, run };
}
const statusOf = (result) => result.details?.status;

test('a verified record_cycle receipt for this run and stage completes the run', async (t) => {
  const f = await fixture(t);
  assert.equal(statusOf(await f.run('good')), 'completed');
});

test('prose claim, wrong stage and another run\'s receipt never complete', async (t) => {
  const f = await fixture(t);
  for (const scenario of ['prose', 'wrongstage', 'wrongrun']) assert.equal(statusOf(await f.run(scenario)), 'incomplete', scenario);
});

test('termination by signal is failed, never completed', async (t) => {
  const f = await fixture(t);
  const result = await f.run('signal');
  assert.equal(statusOf(result), 'failed');
});

test('run ids are validated: traversal and absolute paths cannot reach the filesystem', async (t) => {
  const f = await fixture(t);
  const outside = path.join(path.dirname(f.cwd), 'victim.json');
  fs.writeFileSync(outside, '{}');
  for (const runId of ['../../victim', '/etc/passwd', 'run_../x', 'run_']) {
    for (const action of ['status', 'result', 'cancel', 'cleanup']) {
      const result = await f.call({ action, runId });
      assert.equal(result.isError, true, `${action} ${JSON.stringify(runId)}`);
    }
  }
  assert.ok(fs.existsSync(outside), 'file outside run storage untouched');
});

test('cleanup derives its path from the id, not from a persisted artifactPath', async (t) => {
  const f = await fixture(t);
  const run = await f.run('good');
  const runFile = path.join(f.cwd, 'data/subagent-runs', `${run.details.runId}.json`);
  const victim = path.join(path.dirname(f.cwd), 'victim.txt');
  fs.writeFileSync(victim, 'keep');
  const record = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  record.artifactPath = victim;
  fs.writeFileSync(runFile, JSON.stringify(record));
  await f.call({ action: 'cleanup' });
  assert.ok(fs.existsSync(victim), 'tampered artifactPath was not deleted');
  assert.ok(!fs.existsSync(runFile), 'the real run file was removed');
});

test('corrupt run records are reported as corrupt, not as unknown', async (t) => {
  const f = await fixture(t);
  const run = await f.run('good');
  fs.writeFileSync(path.join(f.cwd, 'data/subagent-runs', `${run.details.runId}.json`), '{"runId": ');
  const result = await f.call({ action: 'status', runId: run.details.runId });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /corrupt/);
});

test('cancel: stops an owned run, is idempotent on terminal runs, refuses unowned PIDs', async (t) => {
  const f = await fixture(t);
  const started = await f.run('hang', { background: true });
  const runId = started.details.runId;
  const canceled = await f.call({ action: 'cancel', runId });
  assert.match(canceled.content[0].text, /Canceled/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(statusOf(await f.call({ action: 'status', runId })), 'canceled', 'close handler did not overwrite canceled');
  assert.match((await f.call({ action: 'cancel', runId })).content[0].text, /already canceled/);

  // A "running" record this session does not own must not get its stored PID signalled.
  const stray = path.join(f.cwd, 'data/subagent-runs/run_abcdef12.json');
  fs.writeFileSync(stray, JSON.stringify({ runId: 'run_abcdef12', status: 'running', pid: process.pid, cwd: f.cwd, results: [], artifactPath: stray, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const refused = await f.call({ action: 'cancel', runId: 'run_abcdef12' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /not owned/);
});

test('project-local agents cannot run headless, and the model cannot skip the confirmation', async (t) => {
  const headless = await fixture(t, { projectAgent: true, hasUI: false });
  const refused = await headless.run('good', { agentScope: 'project' });
  assert.equal(refused.isError, true);
  const interactive = await fixture(t, { projectAgent: true, hasUI: true });
  let asked = 0;
  const original = interactive.call;
  assert.ok(original);
  // confirmProjectAgents:false from the model is ignored; the dialog still runs.
  const ctxAsk = async () => { asked++; return false; };
  const { default: register } = await import(`../extensions/lifecycle-subagent/index.ts?${Math.random()}`);
  let tool; register({ on() {}, registerTool(v) { tool = v; }, registerCommand() {}, sendMessage() {} });
  const result = await tool.execute('c', { action: 'run', agent: 'tester', task: 'x', agentScope: 'project', confirmProjectAgents: false, background: false }, null, null,
    { cwd: interactive.cwd, hasUI: true, mode: 'tui', sessionManager: { getSessionId: () => 's' }, ui: { confirm: ctxAsk, notify() {} } });
  assert.equal(asked, 1);
  assert.match(result.content[0].text, /not approved/);
});
