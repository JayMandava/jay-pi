import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import register, { loadGatedTools } from '../extensions/external-sink-gate.ts';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sink-'));
  const file = path.join(root, 'policy.json'); const previous = process.env.PI_EXTERNAL_SINK_CONFIG;
  process.env.PI_EXTERNAL_SINK_CONFIG = file;
  t.after(() => { if (previous === undefined) delete process.env.PI_EXTERNAL_SINK_CONFIG; else process.env.PI_EXTERNAL_SINK_CONFIG = previous; fs.rmSync(root, { recursive: true, force: true }); });
  let hook; register({ on(name, fn) { assert.equal(name, 'tool_call'); hook = fn; } });
  const write = (value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return { root, file, write, hook };
}
test('only absent default config opts out; explicit absent or unreadable fails closed', (t) => {
  const f = fixture(t);
  assert.equal(loadGatedTools(f.file, false).size, 0);
  assert.throws(() => loadGatedTools(f.file, true), /unavailable/);
  assert.throws(() => loadGatedTools(f.root, true), /unavailable/);
});
test('invalid JSON and malformed sink entries never become empty policy', async (t) => {
  const f = fixture(t);
  for (const policy of ['{', {}, [{ label: 'tracker' }], [{ label: '', tools: ['write'] }], [{ label: 'tracker', tools: [7] }], [{ label: 'tracker', tools: ['write', 'write'] }]]) {
    f.write(policy); assert.throws(() => loadGatedTools(f.file, true));
    assert.equal((await f.hook({ toolName: 'any', input: {} }, { hasUI: false })).block, true);
  }
});
test('valid unlisted read passes; gated headless write is blocked', async (t) => {
  const f = fixture(t); f.write([{ label: 'tracker', tools: ['write'] }]);
  assert.deepEqual(await f.hook({ toolName: 'read', input: {} }, { hasUI: false }), {});
  assert.equal((await f.hook({ toolName: 'write', input: {} }, { hasUI: false })).block, true);
});
test('literal payload is confirmed; decline blocks and approval permits', async (t) => {
  const f = fixture(t); f.write([{ label: 'tracker', tools: ['write'] }]);
  const input = { title: 'Exact proposed text', count: 2 };
  for (const approved of [false, true]) {
    let calls = 0;
    const result = await f.hook({ toolName: 'write', input }, { hasUI: true, ui: { confirm: async (title, preview) => { calls++; assert.match(title, /tracker/); assert.equal(preview, JSON.stringify(input, null, 2)); return approved; } } });
    assert.equal(calls, 1); assert.equal(result.block, approved ? undefined : true);
  }
});
test('oversized payload blocked without partial confirmation', async (t) => {
  const f = fixture(t); f.write([{ label: 'tracker', tools: ['write'] }]);
  const result = await f.hook({ toolName: 'write', input: { content: 'x'.repeat(5000) } }, { hasUI: true, ui: { confirm() { assert.fail('must not preview truncated text'); } } });
  assert.equal(result.block, true);
});
test('policy repaired between calls is reread; empty array is deliberate opt-out', async (t) => {
  const f = fixture(t); f.write('{');
  assert.equal((await f.hook({ toolName: 'write', input: {} }, { hasUI: false })).block, true);
  f.write([]); assert.deepEqual(await f.hook({ toolName: 'write', input: {} }, { hasUI: false }), {});
});
