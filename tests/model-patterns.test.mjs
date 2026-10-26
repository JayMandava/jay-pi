import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedModelRefs } from '../extensions/agent-session-profile/model-patterns.mjs';
test('enabled model scope handles exact refs, wildcards, thinking suffix and literal regex syntax', () => {
  const models = [{provider:'a',id:'m.1'}, {provider:'a',id:'mx1'}, {provider:'b',id:'m2'}];
  assert.deepEqual(scopedModelRefs(['a/m.1:high'],models),['a/m.1']);
  assert.deepEqual(scopedModelRefs(['a/*','m?'],models),['a/m.1','a/mx1','b/m2']);
  assert.deepEqual(scopedModelRefs(['a/m.1','a/m.1'],models),['a/m.1']);
  assert.deepEqual(scopedModelRefs([],models),[]);
});
