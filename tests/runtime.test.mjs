import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHarness,hasVerifiedCycleRecord,buildReviewContext} from '../extensions/harness/runtime.mjs';
import {createRunStore} from '../extensions/harness/run-store.mjs';
import {getLatestApproach,approveApproach} from '../extensions/harness/approval-store.mjs';
import {writeCycleRecord} from '../extensions/cycle-store.mjs';
function fixture(t) {const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'harness-runtime-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));return {cwd,h:createHarness({cwd})};}
const opts=(name='planner',mockScenario='success')=>({agent:{name,runner:'mock'},task:'Safe offline fixture task',cycleId:'TEST-R1',mockScenario});
test('full four-role lifecycle uses subprocess receipts and approved plan',async t=>{
 const {cwd,h}=fixture(t);
 assert.throws(()=>h.start(opts('developer')),/approval/);
 const plan=await h.start(opts()).completion;assert.equal(plan.status,'completed');
 const row=getLatestApproach(cwd);approveApproach(cwd,row.id,{confirmed:true,actor:'test human',expectedDigest:row.digest});
 for(const role of ['developer','tester','lead'])assert.equal((await h.start(opts(role)).completion).status,'completed');
 assert.equal(h.list().length,4);
 assert.equal(h.get(plan.runId).results[0].messages[1].details.runId,plan.runId);
});
for(const [scenario,status] of [['incomplete','incomplete'],['wrong-stage','incomplete'],['fail','failed'],['malformed','incomplete'],['signal','failed']])test(`${scenario} never falsely completes`,async t=>{
 const {h}=fixture(t);const record=await h.start(opts('planner',scenario)).completion;assert.equal(record.status,status);
});
test('cancel stays terminal after close and repeated cancellation; live cleanup denied',async t=>{
 const {h}=fixture(t);const run=h.start(opts('planner','hang'));assert.throws(()=>h.cleanup(run.runId),/active/);
 assert.equal(h.cancel(run.runId).status,'canceled');const record=await run.completion;assert.equal(record.status,'canceled');assert.equal(h.get(run.runId).status,'canceled');
 assert.equal(h.cancel(run.runId).status,'canceled');assert.deepEqual(h.cleanup(run.runId),[run.runId]);
});
test('timeout and output overflow terminate instead of hanging',async t=>{
 const {h}=fixture(t);let record=await h.start({...opts('planner','hang'),timeoutMs:30}).completion;assert.equal(record.status,'failed');assert.match(record.statusReason,/Timed out/);
 record=await h.start({...opts('planner','oversize'),maxOutputBytes:1024}).completion;assert.equal(record.status,'failed');assert.match(record.statusReason,/Output limit/);
});
test('path traversal and artifact path tampering cannot delete outside state',t=>{
 const {cwd,h}=fixture(t);for(const id of ['../../outside','run_x/../x','/tmp/x','run_short'])assert.throws(()=>h.get(id),/Invalid runId/);
 const outside=path.join(cwd,'keep.json');fs.writeFileSync(outside,'keep');
 const store=createRunStore(cwd);store.save({runId:'run_12345678',status:'completed',results:[],createdAt:new Date().toISOString(),artifactPath:outside});h.cleanup('run_12345678');assert.equal(fs.readFileSync(outside,'utf8'),'keep');
});
test('recovery never signals stored process IDs or retries work',t=>{
 const {cwd,h}=fixture(t);const store=createRunStore(cwd);store.save({runId:'run_12345678',status:'running',results:[],createdAt:new Date().toISOString(),ownerPid:99999999,pid:process.pid});
 assert.equal(h.recover()[0].status,'orphaned');assert.equal(h.recover().length,0);assert.equal(process.kill(process.pid,0),true);
});
test('proof rejects narration, stale receipts, wrong cycle and untrusted tool names',t=>{
 const {cwd}=fixture(t);const runId='run_12345678';const receipt=writeCycleRecord({cwd,stage:'approach',summary:'This valid record belongs to an explicitly identified test run.',runId,cycleId:'TEST-R1'});
 const trace=[{role:'assistant',content:[{type:'toolCall',name:'record_cycle',id:'x',arguments:{stage:'approach'}}]},{role:'toolResult',toolCallId:'x',toolName:'record_cycle',details:receipt}];
 assert.equal(hasVerifiedCycleRecord(cwd,trace,'approach',runId,'TEST-R1'),true);
 assert.equal(hasVerifiedCycleRecord(cwd,trace,'approach','run_87654321','TEST-R1'),false);
 assert.equal(hasVerifiedCycleRecord(cwd,trace,'approach',runId,'OTHER'),false);
 trace[1].toolName='mcp__evil__record_cycle';assert.equal(hasVerifiedCycleRecord(cwd,trace,'approach',runId,'TEST-R1'),false);
});
test('continuation is explicit terminal context, not automatic replay',async t=>{
 const {h}=fixture(t);const run=h.start(opts('planner','hang'));assert.throws(()=>h.start({...opts(),previousRunId:run.runId}),/terminal/);h.cancel(run.runId);await run.completion;
 const next=await h.start({...opts(),previousRunId:run.runId}).completion;assert.equal(next.previousRunId,run.runId);assert.equal(next.status,'completed');assert.throws(()=>h.start({...opts(),resume:true}),/unsupported/);
});
test('cancel then cleanup must await child completion',async t=>{
 const {h}=fixture(t);const handle=h.start(opts('planner','hang'));h.cancel(handle.runId);assert.throws(()=>h.cleanup(handle.runId),/active run/);await handle.completion;assert.deepEqual(h.cleanup(handle.runId),[handle.runId]);
});
test('single Developer lease refuses concurrent work and releases after cancellation',async t=>{
 const {cwd,h}=fixture(t);await h.start(opts()).completion;const plan=getLatestApproach(cwd);approveApproach(cwd,plan.id,{confirmed:true,actor:'test',expectedDigest:plan.digest});
 const handle=h.start(opts('developer','hang'));assert.throws(()=>h.start(opts('developer')),/Another Developer/);h.cancel(handle.runId);await handle.completion;assert.equal((await h.start(opts('developer')).completion).status,'completed');
});
test('corrupt state while running settles completion as failure instead of unhandled rejection',async t=>{
 const {cwd,h}=fixture(t);const handle=h.start({...opts('planner','hang'),timeoutMs:1000});const file=path.join(cwd,'data','subagent-runs',`${handle.runId}.json`);fs.writeFileSync(file,'broken json');
 const result=await handle.completion;assert.equal(result.status,'failed');assert.match(result.persistenceError,/JSON|Unexpected|token/i);
 assert.throws(()=>h.list(),/Unreadable run artifact/);
});
test('fragmented Unicode stream and trailing non-newline retain verified proof',async t=>{
 const {h}=fixture(t);const result=await h.start(opts('planner','fragmented')).completion;assert.equal(result.status,'completed');assert.match(result.results[0].messages.at(-1).content[0].text,/✓/);
});
test('spawn failure is terminal and never hangs',async t=>{
 const {h}=fixture(t);const old=process.env.PATH;process.env.PATH='/nonexistent/harness-test-path';let handle;
 try{handle=h.start({agent:{name:'planner',runner:'pi'},task:'Never calls a provider because executable is absent'});}finally{process.env.PATH=old;}
 const result=await handle.completion;assert.equal(result.status,'failed');assert.match(result.results[0].errorMessage,/ENOENT/);
});
test('cross-process cancel is requested without signaling persisted PID',async t=>{
 const {cwd,h}=fixture(t);const {spawn}=await import('node:child_process');
 const child=spawn(process.execPath,[new URL('./fixtures/controller.mjs',import.meta.url).pathname,cwd],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 let output='',id;let resolveId;const ready=new Promise(r=>resolveId=r);child.stdout.on('data',data=>{output+=data;const first=output.split('\n')[0];if(!id&&output.includes('\n')){id=JSON.parse(first).runId;resolveId(id);}});
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`controller exit ${code}`)));});
 const runId=await ready;assert.equal(h.cancel(runId).status,'running');await done;assert.equal(h.get(runId).status,'canceled');assert.match(output,/"status":"canceled"/);
});

test('review context hands Tester/Lead the real diff, flags truncation and non-git dirs',t=>{
 const {cwd}=fixture(t);
 assert.match(buildReviewContext(cwd),/unavailable \(not a git repository\)/);
 const g=(...a)=>execFileSync('git',a,{cwd,stdio:'ignore'});
 g('init','-q');g('-c','user.name=t','-c','user.email=t@t','commit','-q','--allow-empty','-m','init');
 fs.writeFileSync(path.join(cwd,'a.txt'),'one\n');g('add','a.txt');g('-c','user.name=t','-c','user.email=t@t','commit','-q','-m','a');
 assert.match(buildReviewContext(cwd),/\(clean working tree\)/);
 fs.writeFileSync(path.join(cwd,'a.txt'),'one\ntwo\n');
 const ctx=buildReviewContext(cwd);assert.match(ctx,/\+two/);assert.match(ctx,/not by a model/);
 fs.writeFileSync(path.join(cwd,'a.txt'),'x'.repeat(70000)+'\n');
 assert.match(buildReviewContext(cwd),/diff truncated: showing 60000 of/);
});
