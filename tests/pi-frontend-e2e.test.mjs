// Production TypeScript frontend executed by Node's native type stripping.
// The pi host/UI and PATH provider are fixtures; runtime, SQLite, adapters and
// filesystem persistence are real. No authenticated provider or terminal UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import registerTicker from '../extensions/subagent-status.ts';
import { createHarness } from '../extensions/harness/runtime.mjs';
import lifecycleSubagent from '../extensions/lifecycle-subagent/index.ts';
import agentSessionProfile from '../extensions/agent-session-profile/index.ts';
import { saveAgentSessionProfile, loadAgentSessionProfile } from '../extensions/agent-session-profile/profile.ts';
import planApproval from '../extensions/plan-approval.ts';
import { writeCycleRecord } from '../extensions/cycle-store.mjs';
import { createRunStore } from '../extensions/harness/run-store.mjs';
import { isApproachApproved } from '../extensions/harness/approval-store.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-pi-e2e-'));
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(cwd, '.pi', 'agents'), { recursive: true });
  for (const role of ['planner', 'developer']) fs.writeFileSync(path.join(cwd, '.pi', 'agents', `${role}.md`), `---\nname: ${role}\ndescription: offline fixture\nrunner: pi\n---\nOffline fixture only.`);
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(bin, 'pi'), `#!${process.execPath}
import fs from 'node:fs';
import { writeCycleRecord } from ${JSON.stringify(new URL('../extensions/cycle-store.mjs', import.meta.url).href)};
const args = process.argv.slice(2);
fs.writeFileSync('spawned.json', JSON.stringify({ args, forwarded: process.env.QA_FORWARD_VALUE ?? null, hidden: process.env.QA_HIDDEN_VALUE ?? null }));
if (args.join(' ').includes('fixture-hang')) { setInterval(() => {}, 1000); }
else {
const stage = args.join(' ').includes('fixture-developer') ? 'implementation' : 'approach';
const input = { stage, summary: 'This offline frontend fixture records real stage evidence without invoking any model.', cycleId: process.env.PI_HARNESS_CYCLE_ID };
const receipt = writeCycleRecord({ cwd: process.cwd(), ...input });
const emit = message => console.log(JSON.stringify({ type: 'message_end', message }));
emit({ role: 'assistant', content: [{ type: 'toolCall', id: 'record', name: 'record_cycle', arguments: input }] });
emit({ role: 'toolResult', toolCallId: 'record', toolName: 'record_cycle', details: receipt, isError: !receipt.ok, content: [{ type: 'text', text: JSON.stringify(receipt) }] });
emit({ role: 'assistant', content: [{ type: 'text', text: 'Verified frontend fixture output.' }] });
}
`, { mode: 0o755 });
  const before = Object.fromEntries(['PATH', 'HOME', 'QA_FORWARD_VALUE', 'QA_HIDDEN_VALUE'].map(k => [k, process.env[k]]));
  process.env.PATH = `${bin}${path.delimiter}${before.PATH}`; process.env.HOME = path.join(cwd, 'home');
  process.env.QA_FORWARD_VALUE = 'safe-forward-fixture'; process.env.QA_HIDDEN_VALUE = 'safe-hidden-fixture';
  const tools = new Map(), events = new Map(), commands = new Map(), messages = [], notices = [], confirmations = [], updates = [];
  const pi = { on: (name, fn) => events.set(name, fn), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), sendMessage: (...args) => messages.push(args) };
  lifecycleSubagent(pi); planApproval(pi);
  const ctx = { cwd, mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => 'frontend-e2e' }, ui: { confirm: async (...args) => { confirmations.push(args); return true; }, notify: (...args) => notices.push(args) } };
  const invoke = (params, context = ctx) => tools.get('subagent').execute('fixture-call', params, new AbortController().signal, value => updates.push(value), context);
  const run = (extra = {}, context = ctx) => invoke({ action: 'run', agent: 'planner', task: 'fixture-success', cycleId: 'FRONTEND-R1', agentScope: 'project', background: false, ...extra }, context);
  const approve = (params = {}, context = ctx) => tools.get('approve_plan').execute('approval-call', params, new AbortController().signal, undefined, context);
  t.after(async () => {
    try {
      const dir = path.join(cwd, 'data', 'subagent-runs');
      for (const filename of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!/^run_.*\.json$/.test(filename)) continue;
        let record;
        try { record = JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8')); } catch { continue; }
        if (record.status === 'running' || (record.status === 'canceled' && !record.finishedAt)) {
          await invoke({ action: 'cancel', runId: record.runId });
          await until(async () => (await invoke({ action: 'status', runId: record.runId })).details.finishedAt, 'Fixture child did not finish after cancellation');
        }
      }
    } finally {
      for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  return { cwd, tools, events, commands, messages, notices, confirmations, updates, ctx, invoke, run, approve };
}
async function until(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  assert.fail(message);
}

test('pi frontend: registration, catalog, foreground evidence, status/result and cleanup round trip', { timeout: 10000 }, async t => {
  const f = fixture(t);
  assert.deepEqual([...f.tools.keys()], ['subagent', 'approve_plan']);
  assert.ok(f.events.has('session_start')); assert.ok(f.commands.has('subagent-runs'));
  const catalog = await f.invoke({ action: 'catalog', agentScope: 'project' });
  assert.match(catalog.content[0].text, /planner \(project\) - pi/);
  await f.commands.get('subagent-runs').handler('', f.ctx); assert.match(f.notices.at(-1)[0], /No subagent runs/);
  const result = await f.run(); assert.equal(result.details.status, 'completed', JSON.stringify(result));
  assert.ok(f.updates.length); assert.equal(f.messages.length, 0);
  assert.equal(f.confirmations[0][0], 'Run project-local agent?');
  const id = result.details.runId;
  assert.match((await f.invoke({ action: 'status', runId: id })).content[0].text, /completed/);
  assert.match((await f.invoke({ action: 'result', runId: id })).content[0].text, /\[status: completed\].*\n\nVerified frontend fixture output/s);
  await f.commands.get('subagent-runs').handler('', f.ctx); assert.match(f.notices.at(-1)[0], new RegExp(id));
  const spawned = JSON.parse(fs.readFileSync(path.join(f.cwd, 'spawned.json')));
  assert.equal(spawned.args[spawned.args.indexOf('--tools') + 1], 'read,grep,find,ls'); assert.equal(spawned.hidden, null);
  assert.deepEqual((await f.invoke({ action: 'cleanup', runId: id })).details.removed, [id]);
  assert.equal((await f.invoke({ action: 'result', runId: id })).isError, true);
});

test('pi frontend: background handoff, cancellation, live-cleanup guard and bulk cleanup', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const first = await f.run({ background: true });
  await until(() => f.messages.length, 'Expected automatic handoff');
  assert.equal(f.messages[0][0].details.runId, first.details.runId); assert.equal(f.messages[0][0].details.status, 'completed');
  assert.deepEqual(f.messages[0][1], { deliverAs: 'followUp', triggerTurn: true });
  const hanging = await f.run({ background: true, task: 'fixture-hang', autoHandoff: false });
  assert.equal((await f.invoke({ action: 'cleanup', runId: hanging.details.runId })).isError, true);
  await f.invoke({ action: 'cancel', runId: hanging.details.runId });
  await until(async () => (await f.invoke({ action: 'status', runId: hanging.details.runId })).details.finishedAt, 'Expected cancellation process acknowledgement');
  assert.equal((await f.invoke({ action: 'cancel', runId: hanging.details.runId })).details.status, 'canceled');
  assert.equal(f.messages.length, 1, 'autoHandoff false must stay silent');
  assert.equal((await f.invoke({ action: 'cleanup' })).details.removed.length, 2);
});

test('pi frontend: human trust, edit and environment refusals launch nothing', async t => {
  const f = fixture(t);
  const userAgents = path.join(process.env.HOME, '.pi', 'agent', 'agents');
  fs.mkdirSync(userAgents, { recursive: true });
  fs.copyFileSync(path.join(f.cwd, '.pi', 'agents', 'planner.md'), path.join(userAgents, 'planner.md'));
  for (const extra of [{ allowEdits: true }, { envAllowlist: ['QA_FORWARD_VALUE'] }]) {
    const denied = await f.run({ ...extra, agentScope: 'user' }, { ...f.ctx, hasUI: false });
    assert.equal(denied.isError, true); assert.match(denied.content[0].text, /not approved/);
    assert.equal(fs.existsSync(path.join(f.cwd, 'spawned.json')), false);
  }
  for (const [extra, deniedTitle, expected] of [
    [{ confirmProjectAgents: false }, 'Run project-local agent?', /Project-local agent not approved/],
    [{ allowEdits: true }, 'Allow agent edits?', /Mutation-capable tools not approved/],
    [{ envAllowlist: ['QA_FORWARD_VALUE'] }, 'Forward extra environment variables?', /Extra environment forwarding not approved/],
  ]) {
    f.ctx.ui.confirm = async title => title !== deniedTitle;
    const result = await f.run(extra); assert.equal(result.isError, true); assert.match(result.content[0].text, expected);
    assert.equal(fs.existsSync(path.join(f.cwd, 'spawned.json')), false);
  }
});

test('pi frontend: accepted edit/environment gates reach actual subprocess without leaking unlisted values', async t => {
  const f = fixture(t);
  const result = await f.run({ allowEdits: true, envAllowlist: ['QA_FORWARD_VALUE'] });
  assert.equal(result.details.status, 'completed');
  assert.deepEqual(f.confirmations.map(c => c[0]), ['Run project-local agent?', 'Allow agent edits?', 'Forward extra environment variables?']);
  assert.ok(!f.confirmations[2][1].includes('safe-forward-fixture'), 'Consent preview contains names, not values');
  const spawned = JSON.parse(fs.readFileSync(path.join(f.cwd, 'spawned.json')));
  assert.equal(spawned.forwarded, 'safe-forward-fixture'); assert.equal(spawned.hidden, null);
  assert.equal(spawned.args[spawned.args.indexOf('--tools') + 1], 'read,bash,edit,write');
});

test('pi frontend: Developer blocked until real UI plan acceptance; headless and decline cannot approve', async t => {
  const f = fixture(t);
  assert.equal((await f.run({ agent: 'developer', task: 'fixture-developer' })).isError, true);
  const plan = writeCycleRecord({ cwd: f.cwd, stage: 'approach', cycleId: 'FRONTEND-R1', summary: 'This exact reviewed fixture plan authorizes only local offline harness testing.', data: { acceptance: 'No live providers' } });
  assert.equal((await f.approve({}, { ...f.ctx, hasUI: false })).isError, true);
  f.ctx.ui.confirm = async () => false;
  assert.equal((await f.approve()).isError, true); assert.equal(isApproachApproved(f.cwd, plan.rowId), false);
  f.ctx.ui.confirm = async (title, payload) => { if (title.includes('exact plan')) { assert.match(payload, /No live providers/); assert.match(payload, /Digest:/); } return true; };
  assert.equal((await f.approve({ approachRowId: plan.rowId + 1 })).isError, true);
  assert.equal((await f.approve()).isError, undefined); assert.equal(isApproachApproved(f.cwd, plan.rowId), true);
  assert.equal((await f.run({ agent: 'developer', task: 'fixture-developer', allowEdits: true })).details.status, 'completed');
  assert.equal((await f.run({ skipApprovalGuard: true })).isError, true);
});

test('pi frontend: plan changed during dialog is rejected; malformed requests return tool errors', async t => {
  const f = fixture(t);
  writeCycleRecord({ cwd: f.cwd, stage: 'approach', summary: 'Original immutable plan awaiting human review in this offline test.' });
  f.ctx.ui.confirm = async () => { writeCycleRecord({ cwd: f.cwd, stage: 'approach', summary: 'Revised plan replacing the original while human confirmation was pending.' }); return true; };
  assert.equal((await f.approve()).isError, true);
  for (const params of [{ action: 'status' }, { action: 'result' }, { action: 'cancel' }, { action: 'status', runId: '../../outside' }, { action: 'run' }, { action: 'run', agent: 'missing', task: 'fixture' }]) assert.equal((await f.invoke(params)).isError, true, JSON.stringify(params));
});

test('pi frontend: session recovery runs only for interactive host and exposes corrupt-state errors', async t => {
  const f = fixture(t), store = createRunStore(f.cwd);
  const id = 'run_1234567890';
  store.save({ runId: id, status: 'running', createdAt: new Date().toISOString(), ownerPid: 99999999, results: [] });
  await f.events.get('session_start')({}, { ...f.ctx, mode: 'json' });
  assert.equal(store.get(id).status, 'running'); assert.equal(f.notices.length, 0);
  await f.events.get('session_start')({}, f.ctx);
  assert.equal(store.get(id).status, 'orphaned'); assert.match(f.notices.at(-1)[0], /Recovered 1 orphaned/);
  await f.events.get('session_start')({}, f.ctx); assert.equal(f.notices.length, 1, 'recovery is idempotent');
  fs.writeFileSync(path.join(f.cwd, 'data', 'subagent-runs', `${id}.json`), '{');
  await f.events.get('session_start')({}, f.ctx); assert.match(f.notices.at(-1)[0], /Run recovery failed/);
  await f.commands.get('subagent-runs').handler('', f.ctx); assert.equal(f.notices.at(-1)[1], 'error');
  fs.unlinkSync(path.join(f.cwd, 'data', 'subagent-runs', `${id}.json`));
});

test('pi frontend: approval requests canceled before or during confirmation cannot write consent', async t => {
  const f = fixture(t);
  for (const when of ['before', 'during']) {
    const plan = writeCycleRecord({ cwd: f.cwd, stage: 'approach', summary: `Only an uncanceled human request may approve this offline ${when} fixture plan.` });
    const controller = new AbortController(); let confirms = 0;
    if (when === 'before') controller.abort();
    f.ctx.ui.confirm = async () => { confirms++; controller.abort(); return true; };
    const result = await f.tools.get('approve_plan').execute('abort-fixture', {}, controller.signal, undefined, f.ctx);
    assert.equal(isApproachApproved(f.cwd, plan.rowId), false, `${when}: canceled request persisted approval`);
    assert.equal(result.isError, true);
    assert.equal(confirms, when === 'before' ? 0 : 1);
  }
});

test('pi frontend: abort during project trust confirmation prevents subprocess launch', async t => {
  const f = fixture(t), controller = new AbortController();
  f.ctx.ui.confirm = async () => { controller.abort(); return true; };
  const result = await f.tools.get('subagent').execute('abort-run', { action: 'run', agent: 'planner', task: 'fixture-success', agentScope: 'project', background: false }, controller.signal, undefined, f.ctx);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /Canceled while waiting/);
  assert.equal(fs.existsSync(path.join(f.cwd, 'spawned.json')), false);
});

test('pi profile frontend: show, saved selection, dismissed/error menu and explicit clear preserve scope', async t => {
  const f = fixture(t), widgets = [], statuses = []; let command;
  agentSessionProfile({ on() {}, registerCommand(name, value) { assert.equal(name, 'agent-profile'); command = value; }, setWidget: (...v) => widgets.push(v), setStatus: (...v) => statuses.push(v) });
  const profile = { version: 1, updatedAt: new Date().toISOString(), roles: { developer: { runner: 'codex-cli', model: 'fixture-model' } } };
  await command.handler('show', f.ctx); assert.match(f.notices.at(-1)[0], /No saved agent session profile/);
  saveAgentSessionProfile(f.cwd, 'frontend-e2e', profile);
  await command.handler('show', f.ctx); assert.match(widgets.at(-1)[1].join(' '), /codex-cli.*fixture-model/);
  f.ctx.ui.select = async () => 'Use saved profile'; await command.handler('', f.ctx);
  assert.deepEqual(loadAgentSessionProfile(f.cwd, 'frontend-e2e').roles, profile.roles);
  f.ctx.ui.select = async () => undefined; await command.handler('', f.ctx);
  assert.deepEqual(loadAgentSessionProfile(f.cwd, 'frontend-e2e').roles, profile.roles);
  f.ctx.ui.select = async () => { throw new Error('fixture UI unavailable'); };
  await assert.rejects(command.handler('', f.ctx), /fixture UI unavailable/);
  assert.deepEqual(loadAgentSessionProfile(f.cwd, 'frontend-e2e').roles, profile.roles);
  await command.handler('clear', f.ctx); assert.equal(loadAgentSessionProfile(f.cwd, 'frontend-e2e'), null);
  assert.match(statuses.at(-1)[1], /default/);
});

test('pi frontend: actual persisted running run appears only in its owning session ticker', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const started = await f.run({ background: true, task: 'fixture-hang', autoHandoff: false });
  assert.equal(started.details.sessionId, 'frontend-e2e');
  const saved = JSON.parse(fs.readFileSync(started.details.artifactPath, 'utf8'));
  assert.equal(saved.sessionId, 'frontend-e2e'); assert.equal(saved.status, 'running');
  const handlers = new Map(); let tick, rendered, sessionId = 'frontend-e2e';
  registerTicker({ on: (name, fn) => handlers.set(name, fn) });
  const ctx = { ...f.ctx, sessionManager: { getSessionId: () => sessionId }, ui: { ...f.ctx.ui, setWidget(_key, factory) {
    rendered = factory ? factory({ requestRender() {} }, { fg: (_color, text) => text }).render(100) : undefined;
  } } };
  const originalInterval = globalThis.setInterval;
  try {
    globalThis.setInterval = callback => { tick = callback; return 0; };
    await handlers.get('session_start')({}, ctx);
  } finally { globalThis.setInterval = originalInterval; }
  t.after(() => handlers.get('session_shutdown')());
  tick(); assert.match(rendered.join(' '), /Running: planner/);
  sessionId = 'another-session'; tick(); assert.equal(rendered, undefined, 'Another session must not see this run');
  sessionId = 'frontend-e2e'; tick(); assert.match(rendered.join(' '), /Running: planner/);
  await f.invoke({ action: 'cancel', runId: started.details.runId });
  await until(async () => (await f.invoke({ action: 'status', runId: started.details.runId })).details.finishedAt, 'Ticker fixture cancellation did not finish');
  tick(); assert.equal(rendered, undefined, 'Terminal run disappears from live ticker');
  const h = createHarness({ cwd: f.cwd });
  for (const invalid of [null, '', ' ', 7, 'x'.repeat(257), 'bad\nidentity']) {
    assert.throws(() => h.start({ agent: { name: 'planner', runner: 'mock' }, task: 'Offline identity validation', sessionId: invalid }), /Invalid sessionId/);
  }
  const noSession = await h.start({ agent: { name: 'planner', runner: 'mock' }, task: 'Offline CLI-like run without a pi session' }).completion;
  assert.equal(noSession.status, 'completed'); assert.equal(noSession.sessionId, undefined);
});
