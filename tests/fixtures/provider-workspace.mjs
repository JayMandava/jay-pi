import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../../extensions/harness/runtime.mjs';

// The test process is serial within each test file. PATH has no fallback to
// the machine's provider executables; HOME is an empty, disposable directory.
export function createProviderWorkspace(t, provider) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-provider-process-'));
  const bin = path.join(cwd, 'bin');
  const home = path.join(cwd, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const moduleUrl = new URL('./provider-process.mjs', import.meta.url).href;
  for (const command of ['pi', 'claude', 'codex']) {
    fs.writeFileSync(path.join(bin, command),
      `#!${process.execPath}\nimport { runProviderFixture } from ${JSON.stringify(moduleUrl)};\nawait runProviderFixture(${JSON.stringify(command)});\n`,
      { mode: 0o700 });
  }
  const updates = {
    PATH: bin, HOME: home,
    QA_PROVIDER_ALLOWED: 'explicit-fixture-value',
    QA_PROVIDER_DENIED: 'unrelated-fixture-value',
  };
  const before = Object.fromEntries(Object.keys(updates).map(key => [key, process.env[key]]));
  Object.assign(process.env, updates);
  const h = createHarness({ cwd });
  const pending = new Set();
  const start = h.start;
  h.start = (...arguments_) => {
    const handle = start(...arguments_);
    pending.add(handle);
    void handle.completion.then(() => pending.delete(handle));
    return handle;
  };
  t.after(async () => {
    // Assertions can fail before a caller awaits completion. Still cancel
    // and join owned fixtures before removing their state directory.
    const unsettled = [...pending];
    for (const handle of unsettled) {
      try { h.cancel(handle.runId); } catch { /* Runtime timeout remains a backstop. */ }
    }
    await Promise.all(unsettled.map(handle => handle.completion));
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const configure = ({ role = 'planner', scenario = 'success', taskMarker = 'TASK_MARKER' } = {}) => {
    fs.writeFileSync(path.join(cwd, 'provider-fixture-request.json'), JSON.stringify({
      fixture: 'jay-pi-offline-provider', provider, role, scenario, taskMarker,
    }));
  };
  configure();
  const capturePath = runId => path.join(cwd, `provider-capture-${runId}.json`);
  const capture = runId => JSON.parse(fs.readFileSync(capturePath(runId), 'utf8'));
  const waitForCapture = async (runId, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(capturePath(runId))) {
      if (Date.now() >= deadline) throw new Error(`Fixture did not capture run ${runId}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return capture(runId);
  };
  return { cwd, bin, home, h, configure, capture, waitForCapture };
}
