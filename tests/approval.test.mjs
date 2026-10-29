import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCycleRecord } from '../extensions/cycle-store.mjs';
import { getLatestApproach, approveApproach, isApproachApproved } from '../extensions/store/approval-store.mjs';
import { openDatabase } from '../extensions/store/sqlite.mjs';
const summary='This plan has enough detail to review and explicitly approve its implementation.';
function fixture(t) { const cwd=mkdtempSync(join(tmpdir(),'jay-approval-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));return cwd; }
function plan(cwd) {writeCycleRecord({cwd,stage:'approach',summary}); return getLatestApproach(cwd);}
function approve(cwd,p) {return approveApproach(cwd,p.id,{confirmed:true,actor:'test-human',expectedDigest:p.digest});}

test('requires explicit confirmation, actor, existing latest row and exact digest', t => {
 const cwd=fixture(t);assert.equal(getLatestApproach(cwd),null);const p=plan(cwd);
 for(const opts of [{},{confirmed:true},{confirmed:true,actor:'human'},{confirmed:false,actor:'human',expectedDigest:p.digest}]) assert.throws(()=>approveApproach(cwd,p.id,opts));
 assert.throws(()=>approve(cwd,{...p,id:999}));assert.equal(isApproachApproved(cwd,999),false);
 approve(cwd,p);assert.equal(isApproachApproved(cwd,p.id),true);
 const p2=plan(cwd);assert.equal(isApproachApproved(cwd,p.id),false);assert.equal(isApproachApproved(cwd,p2.id),false);assert.throws(()=>approve(cwd,p));
 approve(cwd,p2);assert.equal(isApproachApproved(cwd,p2.id),true);
});

test('in-place mutation after review or approval invalidates content binding',t=>{
 const cwd=fixture(t),p=plan(cwd);approve(cwd,p);
 const db=openDatabase(join(cwd,'data/approach.db'));db.prepare('UPDATE cycles SET summary = ? WHERE id = ?').run(summary+' Changed',p.id);db.close();
 assert.equal(isApproachApproved(cwd,p.id),false);assert.throws(()=>approve(cwd,p));
});

test('migrates legacy approvals but never trusts row-only permission; replay idempotent',t=>{
 const cwd=fixture(t),p=plan(cwd),file=join(cwd,'data/approvals.db');
 let db=openDatabase(file);db.exec("CREATE TABLE approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, approach_row_id INTEGER NOT NULL, approved_at TEXT NOT NULL); INSERT INTO approvals VALUES(1,1,'2026-01-01');");db.close();
 assert.equal(isApproachApproved(cwd,p.id),false);const first=approve(cwd,p);const second=approve(cwd,p);assert.deepEqual(first,second);
 db=openDatabase(file,{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) AS count FROM approvals').get().count,2);db.close();
 assert.equal(isApproachApproved(cwd,p.id),true);
});

test('pi approval tool: background cannot self-approve; interactive call records approval without a second dialog',async t=>{
 const {default: register}=await import('../extensions/plan-approval.ts');
 const cwd=fixture(t),p=plan(cwd);let tool;register({registerTool(value){tool=value;}});
 const invoke=(ctx,signal=null)=>tool.execute('test',{},signal,null,{cwd,...ctx});
 assert.equal((await invoke({hasUI:false})).isError,true);assert.equal(isApproachApproved(cwd,p.id),false);
 let dialogs=0;
 assert.equal((await invoke({hasUI:true,ui:{confirm:async()=>{dialogs++;return true;}}},{aborted:true})).isError,true);assert.equal(isApproachApproved(cwd,p.id),false);
 const result=await invoke({hasUI:true,ui:{confirm:async()=>{dialogs++;return true;}}});
 assert.equal(result.isError,undefined);assert.equal(isApproachApproved(cwd,p.id),true);assert.equal(dialogs,0,'no extra confirmation layer on top of the grill review');
 const p2=plan(cwd);assert.equal(isApproachApproved(cwd,p2.id),false,'a revised plan needs a fresh approval');
 assert.equal((await tool.execute('test',{approachRowId:999},null,null,{cwd,hasUI:true})).isError,true,'nonexistent row rejected');
});

test('approval ATTACH refuses linked database and leaves its target untouched', async t=>{
 const {symlinkSync,writeFileSync,readFileSync}=await import('node:fs');
 const cwd=fixture(t),outside=fixture(t),p=plan(cwd),target=join(outside,'outside.db');writeFileSync(target,'unchanged');
 symlinkSync(target,join(cwd,'data/approvals.db'));
 assert.throws(()=>approve(cwd,p),/symlink/);assert.equal(isApproachApproved(cwd,p.id),false);
 assert.equal(readFileSync(target,'utf8'),'unchanged');
});
