import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createProviderWorkspace } from './fixtures/provider-workspace.mjs';
import { isApproachApproved, getLatestApproach } from '../extensions/harness/approval-store.mjs';

const CLI = fileURLToPath(new URL('../bin/jay-pi.mjs', import.meta.url));
const TTY_DRIVER = fileURLToPath(new URL('./fixtures/cli/tty-driver.py', import.meta.url));
// Resolve before tests replace PATH with fixture-only provider executables.
const pythonProbe = process.platform === 'win32' ? null : spawnSync('python3', ['-c', 'import pty,sys; print(sys.executable)'], { encoding: 'utf8', timeout: 5000 });
const PYTHON = pythonProbe?.status === 0 ? pythonProbe.stdout.trim() : null;
const POSIX = { skip: process.platform === 'win32' ? 'POSIX fake-executable fixture only' : false, timeout: 30000 };
const TTY = { ...POSIX, skip: POSIX.skip || (!PYTHON ? 'Python3 stdlib pty unavailable; interactive coverage not claimed' : false) };
const cycle = 'CLI-E2E-R1';

function cli(workspace, ...args) {
  return spawnSync(process.execPath, [CLI, ...args, '--cwd', workspace.cwd], {
    cwd: workspace.cwd, env: process.env, encoding: 'utf8', timeout: 15000,
  });
}
function json(workspace, ...args) {
  const result = cli(workspace, ...args, '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function run(workspace, role, ...extra) {
  workspace.configure({ role });
  return json(workspace, 'run', '--role', role, '--runner', 'pi', '--model', 'offline-cli-fixture', '--task', `TASK_MARKER ${role} from actual CLI`, '--cycle', cycle, ...extra);
}
function tty(workspace, args, answer = '', action = 'answer', beforeAnswerArgs) {
  assert.ok(PYTHON, 'Test must skip rather than substitute piped input when PTY unavailable');
  const result = spawnSync(PYTHON, [TTY_DRIVER], {
    cwd: workspace.cwd, env: process.env, encoding: 'utf8', timeout: 12000,
    input: JSON.stringify({ command: [process.execPath, CLI, ...args, '--cwd', workspace.cwd], cwd: workspace.cwd, answer, action, beforeAnswerCommand: beforeAnswerArgs && [process.execPath, CLI, ...beforeAnswerArgs, '--cwd', workspace.cwd] }),
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.timedOut, false, report.transcript);
  return report;
}
function captures(workspace) {
  return fs.readdirSync(workspace.cwd).filter(name => /^provider-capture-run_.*\.json$/.test(name));
}
async function waitForRun(workspace) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const records = workspace.h.list();
    if (records.length) {
      await workspace.waitForCapture(records[0].runId);
      return records[0];
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('CLI failed to start fixture run');
}
function backgroundCli(workspace, ...args) {
  const child = spawn(process.execPath, [CLI, ...args, '--cwd', workspace.cwd], {
    cwd: workspace.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}

// This is real terminal transport and exact-phrase gating with test-generated
// keystrokes. It is deliberately not described as a human having approved.
test('CLI E2E: actual PTY approval unlocks Developer and complete cycle is inspectable', TTY, t => {
  const f = createProviderWorkspace(t, 'pi');
  const planner = run(f, 'planner');
  const plan = json(f, 'plan');
  assert.equal(plan.cycle_id, cycle);
  assert.equal(isApproachApproved(f.cwd, plan.id), false);
  const blocked = cli(f, 'run', '--role', 'developer', '--runner', 'pi', '--task', 'TASK_MARKER blocked', '--cycle', cycle);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /requires human approval/);
  assert.equal(captures(f).length, 1, 'blocked Developer must not dispatch');
  const approval = tty(f, ['approve', String(plan.id)], `approve ${plan.id}`);
  assert.equal(approval.returncode, 0, approval.transcript);
  assert.equal(approval.answered, true);
  assert.ok(approval.transcript.includes(plan.summary), 'actual reviewed plan appears in terminal');
  assert.match(approval.transcript, /Approved plan/);
  assert.equal(isApproachApproved(f.cwd, plan.id), true);
  const developer = run(f, 'developer', '--allow-edits', '--previous', planner.runId);
  assert.equal(developer.status, 'completed');
  assert.equal(developer.security.permissionProfile, 'workspace-write');
  assert.ok(f.capture(developer.runId).prompt.includes(plan.summary));
  const tester = run(f, 'tester', '--previous', developer.runId);
  const lead = run(f, 'lead', '--previous', tester.runId);
  const all = json(f, 'list');
  assert.equal(all.length, 4);
  assert.ok(all.every(record => record.status === 'completed'));
  assert.equal(json(f, 'status', lead.runId).runId, lead.runId);
  assert.equal(json(f, 'result', lead.runId).status, 'completed');
  const humanResult = cli(f, 'result', lead.runId);
  assert.equal(humanResult.status, 0);
  assert.match(humanResult.stdout, /\[completed\]/);
  assert.match(humanResult.stdout, /Offline provider fixture completed/);
  const events = json(f, 'events', lead.runId);
  assert.deepEqual(events.map(event => event.type), ['run_started', 'run_finished']);
  assert.deepEqual(events.map(event => event.sequence), [1, 2]);
  assert.equal(events[1].status, 'completed');
  assert.deepEqual(json(f, 'recover'), [], 'completed runs are never replayed');
  assert.match(cli(f, 'list').stdout, new RegExp(lead.runId));
});

for (const [label, answer, action] of [
  ['declined', 'no', 'answer'], ['wrong phrase', 'approve', 'answer'], ['interrupted', '', 'interrupt'],
]) {
  test(`CLI E2E: ${label} real terminal review never grants approval`, TTY, t => {
    const f = createProviderWorkspace(t, 'pi');
    run(f, 'planner');
    const plan = getLatestApproach(f.cwd);
    const review = tty(f, ['approve'], answer, action);
    assert.equal(review.answered, true, review.transcript);
    assert.equal(isApproachApproved(f.cwd, plan.id), false);
    assert.doesNotMatch(review.transcript, /Approved plan/);
    if (action === 'answer') {
      assert.equal(review.returncode, 0);
      assert.match(review.transcript, /Not approved/);
    }
  });
}

test('CLI E2E: JSON mode refuses approval even with real TTY; stale row refuses before prompt', TTY, t => {
  const f = createProviderWorkspace(t, 'pi');
  run(f, 'planner');
  const first = getLatestApproach(f.cwd);
  const jsonReview = tty(f, ['approve', '--json'], `approve ${first.id}`);
  assert.notEqual(jsonReview.returncode, 0);
  assert.equal(jsonReview.answered, false);
  assert.match(jsonReview.transcript, /unattended approval are refused/);
  run(f, 'planner');
  const stale = tty(f, ['approve', String(first.id)], `approve ${first.id}`);
  assert.notEqual(stale.returncode, 0);
  assert.equal(stale.answered, false);
  assert.match(stale.transcript, /Only the latest plan/);
  assert.equal(isApproachApproved(f.cwd, getLatestApproach(f.cwd).id), false);
});

test('CLI E2E: empty list/help/doctor do not invoke providers or create runtime data', POSIX, t => {
  const f = createProviderWorkspace(t, 'pi');
  assert.deepEqual(json(f, 'list'), []);
  assert.match(cli(f, 'list').stdout, /No runs yet/);
  for (const args of [[], ['help'], ['--help']]) {
    const result = cli(f, ...args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /evidence-first/);
  }
  const doctor = json(f, 'doctor');
  assert.ok(doctor.providers.every(provider => provider.installed && !provider.liveValidated));
  assert.match(doctor.note, /no provider was invoked/);
  assert.equal(captures(f).length, 0);
  assert.equal(fs.existsSync(path.join(f.cwd, 'data')), false);
  assert.match(cli(f, 'doctor').stdout, /Presence only/);
});

test('CLI E2E: negative argument and missing-state paths fail without dispatch', POSIX, t => {
  const f = createProviderWorkspace(t, 'pi');
  const cases = [
    ['unknown-command'], ['status'], ['result'], ['events'], ['plan'], ['approve'],
    ['status', 'run_12345678'], ['result', '../outside'], ['events', 'run_12345678'],
    ['run'], ['run', '--role', 'unknown', '--task', 'TASK_MARKER'],
    ['run', '--role', 'tester', '--task', 'TASK_MARKER', '--runner', 'constructor'],
    ['run', '--role', 'tester', '--task', 'TASK_MARKER', '--previous', 'run_12345678'],
    ['run', '--role', 'tester', '--task', 'TASK_MARKER', '--timeout', '0'],
    ['run', '--role', 'tester', '--task', 'TASK_MARKER', '--timeout', '3600001'],
    ['run', '--role', 'tester', '--task', 'TASK_MARKER', '--timeout', '1.5'],
    ['run', '--role', 'tester', '--role', 'planner', '--task', 'TASK_MARKER'],
    ['run', '--role', '--task', 'TASK_MARKER'], ['approve', '--yes'],
    // These are runtime/pi operations, not existing CLI commands.
    ['cancel', 'run_12345678'], ['cleanup', 'run_12345678'],
  ];
  for (const args of cases) {
    const result = cli(f, ...args);
    assert.equal(result.status, 1, JSON.stringify({ args, stdout: result.stdout, stderr: result.stderr }));
    assert.match(result.stderr, /^jay-pi:/);
  }
  assert.equal(captures(f).length, 0);
  assert.deepEqual(f.h.list(), []);
});

for (const [scenario, status, exitCode] of [
  ['missing-evidence', 'incomplete', 2], ['provider-error', 'failed', 1], ['exit-after-evidence', 'failed', 1],
]) {
  test(`CLI E2E: ${scenario} returns ${exitCode} and inspectable ${status}`, POSIX, t => {
    const f = createProviderWorkspace(t, 'pi');
    f.configure({ scenario });
    const result = cli(f, 'run', '--role', 'planner', '--runner', 'pi', '--task', 'TASK_MARKER failure result', '--json');
    assert.equal(result.status, exitCode, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.status, status);
    assert.equal(json(f, 'status', record.runId).status, status);
    assert.match(cli(f, 'result', record.runId).stdout, new RegExp(`\\[${status}\\]`));
  });
}

test('CLI E2E: SIGINT cancels actual foreground provider and preserves inspectable outcome', POSIX, async t => {
  const f = createProviderWorkspace(t, 'pi');
  f.configure({ scenario: 'hang' });
  const owner = backgroundCli(f, 'run', '--role', 'planner', '--runner', 'pi', '--task', 'TASK_MARKER SIGINT cancellation', '--json', '--timeout', '5000');
  try {
    const record = await waitForRun(f);
    owner.child.kill('SIGINT');
    const result = await owner.completion;
    assert.equal(result.code, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'canceled');
    assert.equal(json(f, 'status', record.runId).status, 'canceled');
    assert.deepEqual(json(f, 'recover'), []);
  } finally {
    if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGTERM');
    await owner.completion;
  }
});

test('CLI E2E: recovery marks interrupted controller orphaned without rerun or killing surviving child', POSIX, async t => {
  const f = createProviderWorkspace(t, 'pi');
  f.configure({ scenario: 'hang' });
  const owner = backgroundCli(f, 'run', '--role', 'planner', '--runner', 'pi', '--task', 'TASK_MARKER interrupted CLI', '--json', '--timeout', '5000');
  let record;
  try {
    record = await waitForRun(f);
    const captured = f.capture(record.runId);
    owner.child.kill('SIGKILL');
    await owner.completion;
    const recovered = json(f, 'recover');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].runId, record.runId);
    assert.equal(recovered[0].status, 'orphaned');
    assert.equal(captures(f).length, 1, 'recovery must not dispatch another provider');
    assert.equal(process.kill(captured.pid, 0), true, 'recovery is observation, not arbitrary PID signaling');
    assert.deepEqual(json(f, 'recover'), []);
    assert.equal(json(f, 'status', record.runId).status, 'orphaned');
  } finally {
    if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGKILL');
    await owner.completion;
    // Kill only the child started and captured by this fixture, never a user process.
    const pid = record && f.h.get(record.runId)?.pid;
    if (pid) {
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
});

test('CLI E2E: plan revision while real terminal confirmation is open invalidates answer', TTY, t => {
  const f = createProviderWorkspace(t, 'pi');
  run(f, 'planner');
  const original = getLatestApproach(f.cwd);
  const review = tty(f, ['approve'], `approve ${original.id}`, 'answer', [
    'run', '--role', 'planner', '--runner', 'pi', '--task', 'TASK_MARKER revise while approval awaits', '--cycle', cycle, '--json',
  ]);
  assert.equal(review.answered, true);
  assert.equal(review.beforeAnswerResult.returncode, 0, review.beforeAnswerResult.stderr);
  assert.notEqual(review.returncode, 0, review.transcript);
  assert.match(review.transcript, /latest|changed|revised/i);
  const revised = getLatestApproach(f.cwd);
  assert.notEqual(revised.id, original.id);
  assert.equal(isApproachApproved(f.cwd, original.id), false);
  assert.equal(isApproachApproved(f.cwd, revised.id), false);
});

test('CLI E2E: timeout validation matches shared-engine lower bound', POSIX, t => {
  const f = createProviderWorkspace(t, 'pi');
  f.configure({ scenario: 'hang' });
  for (const timeout of ['1', '9']) {
    const rejected = cli(f, 'run', '--role', 'planner', '--runner', 'pi', '--task', 'TASK_MARKER timeout boundary', '--timeout', timeout);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /--timeout must be an integer from 10 to 3600000/);
  }
  assert.equal(captures(f).length, 0);
  assert.deepEqual(f.h.list(), []);
  const accepted = cli(f, 'run', '--role', 'planner', '--runner', 'pi', '--task', 'TASK_MARKER allowed timeout', '--timeout', '10', '--json');
  assert.equal(accepted.status, 1, accepted.stderr);
  const record = JSON.parse(accepted.stdout);
  assert.equal(record.status, 'failed');
  assert.match(record.statusReason, /Timed out after 10 ms/);
});

// Reproduce Linux PTY EIO before waitpid can observe the child exit. The
// deliberately delayed exit must retain its real status rather than SIGKILL.
test('CLI PTY driver waits for child exit after terminal descriptors close', TTY, t => {
  const f = createProviderWorkspace(t, 'pi');
  const child = 'import os,time; os.write(1,b"terminal closed\\n"); [os.close(fd) for fd in (0,1,2)]; time.sleep(0.25); os._exit(7)';
  const result = spawnSync(PYTHON, [TTY_DRIVER], {
    cwd: f.cwd, env: process.env, encoding: 'utf8', timeout: 12000,
    input: JSON.stringify({ command: [PYTHON, '-c', child], cwd: f.cwd }),
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.match(report.transcript, /terminal closed/);
  assert.equal(report.timedOut, false);
  assert.equal(report.returncode, 7);
  assert.equal(report.answered, false);
});
