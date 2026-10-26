import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHarness,hasVerifiedCycleRecord} from '../extensions/harness/runtime.mjs';
import {createRunStore} from '../extensions/harness/run-store.mjs';
import {writeCycleRecord} from '../extensions/cycle-store.mjs';
const runtimeURL = new URL('../extensions/harness/runtime.mjs',import.meta.url).href;
function fixture(t) {const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'jay-independent-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));return cwd;}
test('independent: canceled child cannot be cleaned before actual close',async t=>{
 const cwd=fixture(t),h=createHarness({cwd});const handle=h.start({agent:{name:'planner',runner:'mock'},task:'Safe independent fixture',mockScenario:'hang'});
 h.cancel(handle.runId);
 try {assert.throws(()=>h.cleanup(handle.runId),/active|running|terminat|finish/i);}finally{await handle.completion;}
 assert.deepEqual(h.cleanup(handle.runId),[handle.runId]);assert.equal(h.get(handle.runId),null);
});
test('independent: snapshot corruption during owned run settles instead of crashing controller',t=>{
 const cwd=fixture(t);
 const source=`import fs from 'node:fs';import {createHarness} from ${JSON.stringify(runtimeURL)};const h=createHarness({cwd:${JSON.stringify(cwd)}});const handle=h.start({agent:{name:'planner',runner:'mock'},task:'safe fixture',mockScenario:'hang',timeoutMs:3000});fs.writeFileSync(h.get(handle.runId).artifactPath,'{broken');const record=await handle.completion;if(record.status!=='failed')throw new Error('Expected controlled failure');console.log('settled');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:6000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/settled/);
});
test('independent: symlinked run files and state directories are refused',t=>{
 const cwd=fixture(t),outside=fixture(t),h=createHarness({cwd});const store=createRunStore(cwd);
 fs.mkdirSync(path.join(cwd,'data','subagent-runs'),{recursive:true});const target=path.join(outside,'keep.json');fs.writeFileSync(target,'keep');
 fs.symlinkSync(target,store.file('run_12345678'));assert.throws(()=>h.get('run_12345678'),/symlink/);assert.throws(()=>h.cleanup('run_12345678'),/symlink/);assert.equal(fs.readFileSync(target,'utf8'),'keep');
 fs.unlinkSync(store.file('run_12345678'));fs.rmdirSync(path.join(cwd,'data','subagent-runs'));fs.symlinkSync(outside,path.join(cwd,'data','subagent-runs'));assert.throws(()=>h.list(),/symlink/);
});
test('independent: receipt cannot prove nonexistent or wrong-stage persisted row',t=>{
 const cwd=fixture(t),runId='run_12345678';const receipt=writeCycleRecord({cwd,stage:'feedback',runId,cycleId:'QA-R1',summary:'Independent fixture records the tester stage with exact run correlation.'});
 const trace=(details,stage='feedback')=>[{role:'assistant',content:[{type:'toolCall',name:'record_cycle',id:'a',arguments:{stage}}]},{role:'toolResult',toolCallId:'a',toolName:'record_cycle',details}];
 assert.equal(hasVerifiedCycleRecord(cwd,trace({...receipt,rowId:999}), 'feedback',runId,'QA-R1'),false);
 assert.equal(hasVerifiedCycleRecord(cwd,trace({...receipt,stage:'approach'},'approach'),'approach',runId,'QA-R1'),false);
 assert.equal(hasVerifiedCycleRecord(cwd,trace(receipt),'feedback',runId,'QA-R1'),true);
});
test('independent: dead Developer lease before first snapshot is recoverable',t=>{
 const cwd=fixture(t);const storeURL=new URL('../extensions/harness/run-store.mjs',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {createRunStore} from ${JSON.stringify(storeURL)};createRunStore(${JSON.stringify(cwd)}).acquireDeveloperLease('run_12345678');`],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 const store=createRunStore(cwd);assert.equal(store.get('run_12345678'),null);store.recoverDeveloperLease();
 assert.doesNotThrow(()=>store.acquireDeveloperLease('run_87654321'));store.releaseDeveloperLease('run_87654321');
});
test('independent: live Developer lease without snapshot is not stolen by recovery',t=>{
 const cwd=fixture(t),store=createRunStore(cwd);store.acquireDeveloperLease('run_12345678');store.recoverDeveloperLease();
 assert.throws(()=>store.acquireDeveloperLease('run_87654321'),/Developer|workspace/);store.releaseDeveloperLease('run_12345678');
});
test('independent: orphan recovery does not release workspace while recorded child may live',t=>{
 const cwd=fixture(t),store=createRunStore(cwd),h=createHarness({cwd});
 store.save({schemaVersion:1,runId:'run_12345678',status:'running',results:[],createdAt:new Date().toISOString(),ownerPid:99999999,pid:process.pid});
 fs.writeFileSync(path.join(cwd,'data','subagent-runs','developer.lock'),JSON.stringify({runId:'run_12345678',ownerPid:99999999}));
 assert.equal(h.recover()[0].status,'orphaned');
 assert.throws(()=>store.acquireDeveloperLease('run_87654321'),/Developer|workspace|orphan/i);
});
