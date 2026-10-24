import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
test('installer honors skip, preserves config, copies shared engine; no real globals touched', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jay-install-'));
  try {
    const bin = path.join(dir,'bin'), home = path.join(dir,'home'), agent = path.join(home,'.pi','agent');
    mkdirSync(bin,{recursive:true}); mkdirSync(agent,{recursive:true});
    writeFileSync(path.join(agent,'settings.json'),'preserve-me');
    writeFileSync(path.join(home,'AGENTS.md'),'preserve-contract');
    const calls = path.join(dir,'calls');
    writeFileSync(path.join(bin,'npm'), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 0\n`,{mode:0o755});
    writeFileSync(path.join(bin,'pi'), `#!/bin/sh\necho "pi $*" >> "${calls}"\necho fixture\n`,{mode:0o755});
    const run = spawnSync('bash',['install.sh'],{encoding:'utf8',env:{...process.env,HOME:home,PI_AGENT_DIR:agent,PATH:bin+path.delimiter+process.env.PATH,PI_HARNESS_SKIP_PI_INSTALL:'1',PI_HARNESS_SKIP_LAUNCH:'1',PI_HARNESS_APPLY_PATCHES:'0'}});
    assert.equal(run.status,0,run.stderr); assert.equal(readFileSync(path.join(agent,'settings.json'),'utf8'),'preserve-me'); assert.equal(readFileSync(path.join(home,'AGENTS.md'),'utf8'),'preserve-contract');
    assert.ok(existsSync(path.join(agent,'extensions','harness','runtime.mjs')));
    const log = readFileSync(calls,'utf8'); assert.doesNotMatch(log,/install -g|pi update|self-heal/); assert.match(log,/ci --omit=dev --ignore-scripts/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
