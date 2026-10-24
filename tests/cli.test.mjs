import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCycleRecord } from '../extensions/cycle-store.mjs';
const cli = (...args) => spawnSync(process.execPath, ['bin/jay-pi.mjs', ...args], { encoding: 'utf8', timeout: 30000 });
test('CLI help and doctor are offline and usable', () => {
  const help = cli('--help'); assert.equal(help.status, 0); assert.match(help.stdout, /evidence-first/);
  const doctor = cli('doctor', '--json'); assert.equal(doctor.status, 0); const data = JSON.parse(doctor.stdout); assert.equal(data.nodeSupported, true); assert.ok(data.providers.every(p => p.liveValidated === false));
});
test('CLI rejects unknown and incomplete options', () => {
  for (const args of [['--bogus'], ['run', '--task'], ['run', '--role', 'tester', '--task', 'x', '--timeout', 'NaN']]) {
    assert.notEqual(cli(...args).status, 0);
  }
});
test('CLI never approves a plan from piped input', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'jay-cli-test-'));
  try {
    writeCycleRecord({cwd, stage:'approach', summary:'A sufficiently detailed human review plan for the CLI approval boundary.'});
    const result = cli('approve', '--cwd', cwd); assert.notEqual(result.status, 0); assert.match(result.stderr, /interactive terminal/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('CLI offline demo exercises actual persisted lifecycle and failure outcomes', () => {
  const result = cli('demo', '--json'); assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  try { assert.equal(report.passed, true); assert.equal(report.syntheticApproval, true); assert.equal(report.steps.length, 9); }
  finally { rmSync(report.cwd, { recursive: true, force: true }); }
});
