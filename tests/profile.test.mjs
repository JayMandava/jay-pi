import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgentSessionProfile, getGlobalAgentSessionProfilePath, getSessionAgentSessionProfilePath, clearAgentSessionProfile } from '../extensions/agent-session-profile/profile.ts';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-profile-'));
  const original = process.env.HOME;
  process.env.HOME = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(cwd, '.pi', 'agents'), { recursive: true });
  t.after(() => { if (original === undefined) delete process.env.HOME; else process.env.HOME = original; fs.rmSync(root, { recursive: true, force: true }); });
  const write = (target, value) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); };
  const profile = (roles) => ({ version: 1, updatedAt: '2026-01-01T00:00:00Z', roles });
  return { cwd, write, profile, global: getGlobalAgentSessionProfilePath(), project: path.join(cwd, 'data', 'agent-session-profile.json'), session: getSessionAgentSessionProfilePath('fixture') };
}

test('merges role fields across global, project, and session layers', (t) => {
  const f = fixture(t);
  f.write(f.global, f.profile({ developer: { runner: 'pi', model: 'base', thinking: 'low' }, tester: { model: 'independent' } }));
  f.write(f.project, f.profile({ developer: { thinking: 'high' } }));
  f.write(f.session, f.profile({ developer: { runner: 'codex-cli' } }));
  const result = resolveAgentSessionProfile(f.cwd, 'fixture');
  assert.equal(result.source, 'session'); assert.equal(result.path, f.session);
  assert.deepEqual(result.profile.roles, { developer: { runner: 'codex-cli', model: 'base', thinking: 'high' }, tester: { model: 'independent' } });
});
test('session null clears all inherited overrides', (t) => {
  const f = fixture(t); f.write(f.global, f.profile({ developer: { model: 'base' } }));
  clearAgentSessionProfile(f.cwd, 'fixture');
  const result = resolveAgentSessionProfile(f.cwd, 'fixture');
  assert.equal(result.profile, null); assert.equal(result.source, 'session');
});
test('null project contributes no overrides; global null permits project', (t) => {
  const f = fixture(t); f.write(f.global, f.profile({ tester: { model: 'base' } })); f.write(f.project, null);
  assert.equal(resolveAgentSessionProfile(f.cwd).profile.roles.tester.model, 'base');
  f.write(f.global, null); f.write(f.project, f.profile({ tester: { model: 'project' } }));
  assert.equal(resolveAgentSessionProfile(f.cwd).profile.roles.tester.model, 'project');
});
test('invalid profile or unsupported runner never silently falls back', (t) => {
  const f = fixture(t); f.write(f.global, f.profile({ developer: { runner: 'pi' } }));
  for (const value of ['{', f.profile({ developer: { runner: 'unsupported' } }), { version: 1, roles: [] }, f.profile({ developer: null })]) {
    f.write(f.project, value); assert.throws(() => resolveAgentSessionProfile(f.cwd), /profile/i);
  }
});
test('explicit session clear remains effective over a broken lower layer', (t) => {
  const f = fixture(t); f.write(f.global, '{'); f.write(f.session, null);
  assert.equal(resolveAgentSessionProfile(f.cwd, 'fixture').profile, null);
});
test('no files returns none and does not create state', (t) => {
  const f = fixture(t); assert.equal(resolveAgentSessionProfile(f.cwd).source, 'none');
  assert.equal(fs.existsSync(f.global), false);
});
