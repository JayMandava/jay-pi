// Deliberate controller interruption used only by the offline demonstration.
// The spawned fixture is finite; no real provider or persistent worker runs.
import { createHarness } from '../extensions/harness/runtime.mjs';
const handle = createHarness({ cwd: process.cwd() }).start({
  agent: { name: 'tester', runner: 'mock' },
  task: 'Finite offline fixture interrupted before the controller observes completion.',
  mockScenario: 'incomplete',
  timeoutMs: 1000,
});
process.stdout.write(handle.runId + '\n', () => process.exit(0));
