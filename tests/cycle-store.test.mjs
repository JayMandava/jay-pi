import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCycleRecord, readCycleRecord, listCycleRecords, verifyCycleEvidence } from '../extensions/cycle-store.mjs';
import { openDatabase } from '../extensions/store/sqlite.mjs';

const summary = "A complete test plan with enough meaningful detail to pass validation.";
function fixture(t) { const cwd = mkdtempSync(join(tmpdir(), 'jay-cycle-')); t.after(() => rmSync(cwd,{recursive:true,force:true})); return cwd; }

test('records all stages with derived roles and exact JSON/string round-trip', t => {
  const cwd = fixture(t);
  for (const [stage, role] of Object.entries({approach:'planner',implementation:'developer',feedback:'tester',review:'lead'})) {
    const receipt = writeCycleRecord({cwd,stage,summary: summary + " It's quoted ☃",data:{ nested: ['a', "b'c"] },cycleId:"story'1",runId:'run_test'});
    assert.equal(receipt.ok,true); assert.equal(receipt.role,role); assert.equal(receipt.rowId,1);
    const row = readCycleRecord(cwd,stage,1);
    assert.deepEqual(JSON.parse(row.payload),{nested:['a',"b'c"]});
    assert.equal(row.run_id,'run_test');
    assert.equal(verifyCycleEvidence(cwd,stage,1,{runId:'run_test',cycleId:"story'1"}),true);
    assert.equal(verifyCycleEvidence(cwd,stage,1,{runId:'run_other'}),false);
  }
  assert.equal(readFileSync(join(cwd,'data/history.jsonl'),'utf8').trim().split('\n').length,4);
});

test('rejects malformed input without recording a row', t => {
  const cwd=fixture(t);
  for(const input of [{stage:'__proto__'},{stage:'constructor'},{summary:2},{summary:'short'},{data:1n},{cycleId:4},{runId:'../bad'}]) {
    assert.equal(writeCycleRecord({cwd,stage:'approach',summary,...input}).ok,false);
  }
  assert.deepEqual(listCycleRecords(cwd,'approach'),[]);
  assert.equal(readCycleRecord(cwd,'approach',NaN),null);
});

test('additively migrates original cycle schema and keeps existing rows', t => {
  const cwd=fixture(t), db=openDatabase(join(cwd,'data/approach.db'));
  db.exec("CREATE TABLE cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id TEXT, role TEXT NOT NULL, stage TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO cycles VALUES(1,NULL,'planner','approach','Legacy row','{}','2026-01-01');"); db.close();
  const result=writeCycleRecord({cwd,stage:'approach',summary,runId:'run_new'});
  assert.equal(result.rowId,2); assert.equal(readCycleRecord(cwd,'approach',1).summary,'Legacy row');
  assert.equal(readCycleRecord(cwd,'approach',1).run_id,null);
});

test('concurrent controller processes serialize migrations and append unique rows', async t => {
  const cwd=fixture(t);
  const { spawn }=await import('node:child_process');
  const moduleUrl=new URL('../extensions/cycle-store.mjs',import.meta.url).href;
  await Promise.all(Array.from({length:6},(_,index)=>new Promise((resolve,reject)=>{
    const source=`import { writeCycleRecord } from ${JSON.stringify(moduleUrl)}; const r=writeCycleRecord(${JSON.stringify({cwd,stage:'approach',summary,runId:`run_concurrent_${index}`})}); if(!r.ok)throw new Error(r.reason);`;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
    let stderr=''; child.stderr.on('data',d=>stderr+=d); child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(stderr)));
  })));
  const rows=listCycleRecords(cwd,'approach'); assert.equal(rows.length,6);assert.equal(new Set(rows.map(row=>row.id)).size,6);
});

test('refuses linked data directories, database files and journals without outside mutation', async t => {
  const { symlinkSync, writeFileSync, readFileSync, mkdirSync } = await import('node:fs');
  const outside=fixture(t),target=join(outside,'target.db');writeFileSync(target,'unchanged');
  const linkedDir=fixture(t);symlinkSync(outside,join(linkedDir,'data'),'dir');
  assert.throws(()=>writeCycleRecord({cwd:linkedDir,stage:'approach',summary}),/symlink/);
  const linkedDb=fixture(t);mkdirSync(join(linkedDb,'data'));symlinkSync(target,join(linkedDb,'data/approach.db'));
  assert.throws(()=>writeCycleRecord({cwd:linkedDb,stage:'approach',summary}),/symlink/);
  assert.throws(()=>readCycleRecord(linkedDb,'approach',1),/symlink/);
  const linkedJournal=fixture(t);mkdirSync(join(linkedJournal,'data'));symlinkSync(target,join(linkedJournal,'data/approach.db-journal'));
  assert.throws(()=>writeCycleRecord({cwd:linkedJournal,stage:'approach',summary}),/symlink/);
  assert.equal(readFileSync(target,'utf8'),'unchanged');
});

test('new data and database files are private; existing permissions are preserved', async t => {
  const { statSync, chmodSync }=await import('node:fs');
  const cwd=fixture(t);writeCycleRecord({cwd,stage:'approach',summary});
  assert.equal(statSync(join(cwd,'data')).mode&0o777,0o700);
  assert.equal(statSync(join(cwd,'data/approach.db')).mode&0o777,0o600);
  chmodSync(join(cwd,'data/approach.db'),0o640);writeCycleRecord({cwd,stage:'approach',summary});
  assert.equal(statSync(join(cwd,'data/approach.db')).mode&0o777,0o640);
});
