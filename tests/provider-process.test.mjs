import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getLatestApproach, approveApproach } from '../extensions/harness/approval-store.mjs';
import { readCycleRecord, verifyCycleEvidence } from '../extensions/cycle-store.mjs';
import { createProviderWorkspace } from './fixtures/provider-workspace.mjs';

// This suite runs production adapter commands against deliberately fake
// executable providers. It does not assert vendor CLI or model compatibility.
const providers = [
  { command: 'pi', runner: 'pi' },
  { command: 'claude', runner: 'claude-cli' },
  { command: 'codex', runner: 'codex-cli' },
];
const stages = { planner: 'approach', developer: 'implementation', tester: 'feedback', lead: 'review' };
const task = 'TASK_MARKER ; $(touch ./must-not-be-executed) "literal quoted task"';
// Quotes, backslashes and colons exercise both JSON MCP config and Codex's
// independently decoded TOML table without simplifying production arguments.
const cycleId = 'STUB:R1"quoted\\cycle';
const supported = { skip: process.platform === 'win32' ? 'POSIX executable fixture; Windows launcher coverage not claimed' : false, timeout: 30000 };
const options = (runner, role = 'planner', extra = {}) => ({
  agent: {
    name: role, runner, model: 'offline-fixture-model', thinking: 'medium',
    tools: ['read', 'edit', 'write'], systemPrompt: `ROLE_MARKER_${role}`,
  },
  task, cycleId, timeoutMs: 10000, envAllowlist: ['QA_PROVIDER_ALLOWED'],
  ...extra,
});
const value = (args, flag) => {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `Expected ${flag}`);
  return args[index + 1];
};

function assertInvocation(capture, provider, role, workspace) {
  const edit = role === 'developer';
  assert.equal(capture.provider, provider.command);
  assert.equal(capture.home, workspace.home);
  assert.equal(capture.forwardedValue, 'explicit-fixture-value');
  assert.equal(capture.deniedValue, null);
  assert.ok(!capture.environmentKeys.includes('QA_PROVIDER_DENIED'));
  assert.equal(capture.cycleId, cycleId);
  assert.equal(value(capture.args, '--model'), 'offline-fixture-model');
  assert.ok(capture.prompt.includes(task));
  const roleText = `${capture.prompt}${capture.systemPrompt ?? ''}`;
  assert.equal(roleText.split(`ROLE_MARKER_${role}`).length - 1, 1, 'role instructions must not be duplicated');
  assert.ok(!fs.existsSync(path.join(workspace.cwd, 'must-not-be-executed')), 'task text must never become shell syntax');
  if (provider.command === 'pi') {
    assert.equal(value(capture.args, '--mode'), 'json');
    assert.ok(capture.args.includes('-p'));
    assert.ok(capture.args.includes('--no-session'));
    assert.equal(value(capture.args, '--thinking'), 'medium');
    assert.equal(value(capture.args, '--tools'), edit ? 'read,edit,write' : 'read,grep,find,ls');
    assert.equal(capture.stdin, '');
    assert.equal(capture.systemPrompt, `ROLE_MARKER_${role}`);
    assert.ok(!fs.existsSync(value(capture.args, '--append-system-prompt')), 'temporary prompt must be cleaned after close');
    assert.equal(capture.transport, 'supported-cycle-store');
  } else if (provider.command === 'claude') {
    assert.equal(capture.prompt, capture.stdin);
    assert.equal(value(capture.args, '--output-format'), 'stream-json');
    assert.equal(value(capture.args, '--permission-mode'), 'dontAsk');
    assert.equal(value(capture.args, '--setting-sources'), '');
    assert.equal(value(capture.args, '--tools'), edit ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep');
    assert.equal(value(capture.args, '--allowedTools'), edit
      ? 'Read,Glob,Grep,Edit,Write,mcp__record-cycle__record_cycle'
      : 'Read,Glob,Grep,mcp__record-cycle__record_cycle');
    assert.ok(capture.args.includes('--strict-mcp-config'));
    assert.ok(!capture.args.includes('--dangerously-skip-permissions'));
    assert.ok(!fs.existsSync(capture.mcp.configPath), 'temporary MCP config must be cleaned after close');
  } else {
    assert.equal(capture.args[0], 'exec');
    assert.equal(capture.args.at(-1), '-');
    assert.equal(capture.prompt, capture.stdin);
    for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules']) assert.ok(capture.args.includes(flag));
    assert.equal(value(capture.args, '--sandbox'), edit ? 'workspace-write' : 'read-only');
    assert.ok(capture.args.includes('approval_policy="never"'));
    assert.ok(capture.args.includes('mcp_servers={}'));
    assert.ok(!capture.args.some(arg => arg.includes('dangerously')));
  }
  if (provider.command !== 'pi') {
    assert.equal(capture.transport, 'actual-mcp-stdio');
    assert.notEqual(capture.serverPid, capture.pid, 'MCP receipt must come from another actual process');
    assert.equal(capture.mcp.env.PI_HARNESS_RUN_ID, capture.runId);
    assert.equal(capture.mcp.env.PI_HARNESS_CYCLE_ID, cycleId);
  }
}

for (const provider of providers) {
  test(`${provider.command} fake executable: approved four-stage lifecycle crosses actual adapter and persistence boundaries`, supported, async t => {
    const workspace = createProviderWorkspace(t, provider.command);
    const { h, cwd } = workspace;
    assert.throws(() => h.start(options(provider.runner, 'developer')), /approval/);
    assert.equal(h.list().length, 0, 'unapproved Developer must not dispatch');
    let previousRunId;
    for (const role of ['planner', 'developer', 'tester', 'lead']) {
      workspace.configure({ role });
      const handle = h.start(options(provider.runner, role, {
        permissionProfile: role === 'developer' ? 'workspace-write' : 'read-only', previousRunId,
      }));
      const record = await handle.completion;
      assert.equal(record.status, 'completed', record.statusReason ?? record.results[0].stderr);
      assert.equal(record.results[0].exitCode, 0);
      assert.equal(record.parseErrors, 0, 'fragmented Unicode and final line without newline must parse');
      assert.equal(record.results[0].usage.input, 12);
      assert.equal(record.results[0].usage.output, 3);
      assert.equal(record.results[0].usage.cacheRead, 2);
      assert.equal(record.results[0].usage.cost, provider.command === 'codex' ? null : 0.01);
      assert.equal(h.get(handle.runId).status, 'completed');
      const capture = workspace.capture(handle.runId);
      assertInvocation(capture, provider, role, workspace);
      const receipt = capture.toolResult.structuredContent ?? JSON.parse(capture.toolResult.content[0].text);
      assert.equal(receipt.runId, handle.runId);
      assert.equal(verifyCycleEvidence(cwd, stages[role], receipt.rowId, { runId: handle.runId, cycleId }), true);
      const row = readCycleRecord(cwd, stages[role], receipt.rowId);
      assert.equal(row.stage, stages[role]);
      assert.equal(row.run_id, handle.runId);
      if (previousRunId) assert.ok(capture.prompt.includes(`Prior run ${previousRunId}`));
      if (role === 'developer') {
        assert.ok(capture.prompt.includes('Approved plan row'));
        assert.ok(capture.prompt.includes('Offline fake'), 'approved plan content must survive continuation');
      }
      if (role === 'planner') {
        const plan = getLatestApproach(cwd);
        approveApproach(cwd, plan.id, { confirmed: true, actor: 'synthetic test fixture', expectedDigest: plan.digest });
      }
      previousRunId = handle.runId;
    }
    assert.equal(h.list().length, 4);
  });

  for (const [scenario, expected] of [
    ['missing-evidence', 'incomplete'], ['wrong-stage', 'incomplete'],
    ['rejected-record', 'incomplete'], ['malformed', 'incomplete'],
    ['exit', 'failed'], ['exit-after-evidence', 'failed'], ['provider-error', 'failed'], ['signal', 'failed'],
  ]) {
    test(`${provider.command} fake executable: ${scenario} cannot become completed`, supported, async t => {
      const workspace = createProviderWorkspace(t, provider.command);
      workspace.configure({ scenario });
      const handle = workspace.h.start(options(provider.runner));
      const record = await handle.completion;
      assert.equal(record.status, expected, record.statusReason ?? record.results[0].stderr);
      assert.equal(workspace.h.get(handle.runId).status, expected);
      const capture = workspace.capture(handle.runId);
      assert.equal(capture.provider, provider.command, 'expected fake executable actually ran');
      if (scenario === 'provider-error' || scenario === 'exit-after-evidence') {
        assert.equal(record.results[0].exitCode, scenario === 'provider-error' ? 0 : 23, 'provider or process failure must override otherwise valid proof');
        const receipt = capture.toolResult.structuredContent ?? JSON.parse(capture.toolResult.content[0].text);
        assert.equal(verifyCycleEvidence(workspace.cwd, 'approach', receipt.rowId, { runId: handle.runId, cycleId }), true, 'valid evidence must not mask provider failure');
      }
      if (scenario === 'rejected-record') assert.equal(capture.toolResult.isError, true);
      if (scenario === 'malformed') assert.equal(record.parseErrors, 1);
      if (scenario === 'exit') assert.equal(record.results[0].exitCode, 23);
      if (scenario === 'signal') assert.equal(record.results[0].signal, 'SIGTERM');
    });
  }

  test(`${provider.command} fake executable: cancellation after dispatch and timeout are terminal`, supported, async t => {
    const workspace = createProviderWorkspace(t, provider.command);
    workspace.configure({ scenario: 'hang' });
    const canceled = workspace.h.start(options(provider.runner));
    await workspace.waitForCapture(canceled.runId);
    assert.equal(workspace.h.cancel(canceled.runId).status, 'canceled');
    assert.throws(() => workspace.h.cleanup(canceled.runId), /active/);
    assert.equal((await canceled.completion).status, 'canceled');
    assert.equal(workspace.h.get(canceled.runId).status, 'canceled');
    const timedOut = workspace.h.start(options(provider.runner, 'planner', { timeoutMs: 1500 }));
    await workspace.waitForCapture(timedOut.runId);
    const result = await timedOut.completion;
    assert.equal(result.status, 'failed');
    assert.match(result.statusReason, /Timed out/);
  });
}
