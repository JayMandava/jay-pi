// Independent host-boundary regression tests. Every executable on the injected
// PATH is our local refusal stub: these tests cannot contact a real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHarness} from '../extensions/harness/runtime.mjs';
import {buildInvocation,createNormalizer} from '../extensions/harness/adapters.mjs';
import {writeCycleRecord} from '../extensions/cycle-store.mjs';
import {getLatestApproach,approveApproach} from '../extensions/harness/approval-store.mjs';
import {createProviderWorkspace} from './fixtures/provider-workspace.mjs';

function fixture(t) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'jay-provider-boundary-')),bin=path.join(cwd,'bin');fs.mkdirSync(bin);
 for(const name of ['pi','claude','codex'])fs.writeFileSync(path.join(bin,name),`#!${process.execPath}\nrequire('node:fs').writeFileSync('unexpected-dispatch.json',JSON.stringify(process.argv));process.exitCode=4;\n`,{mode:0o755});
 const previous={PATH:process.env.PATH,HOME:process.env.HOME};process.env.PATH=bin;process.env.HOME=path.join(cwd,'empty-home');fs.mkdirSync(process.env.HOME);
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(cwd,{recursive:true,force:true});});
 return {cwd,h:createHarness({cwd}),marker:path.join(cwd,'unexpected-dispatch.json')};
}
function plan(cwd,summary='The approved fixture plan has a concrete acceptance boundary for provider execution.') {
 const receipt=writeCycleRecord({cwd,stage:'approach',summary,cycleId:'BOUNDARY-R1'});assert.equal(receipt.ok,true);
 const current=getLatestApproach(cwd);approveApproach(cwd,current.id,{confirmed:true,actor:'independent-test-fixture, not human consent',expectedDigest:current.digest});return current;
}
async function mustRefuse(h,options,pattern) {
 let handle,error;try{handle=h.start(options);}catch(cause){error=cause;}
 // On regression, drain the local refusal stub instead of leaking a child.
 if(handle)await handle.completion;
 assert.ok(error,'Expected rejection before local provider dispatch');assert.match(error.message,pattern);
}
for(const runner of ['pi','claude-cli','codex-cli']) {
 test(`independent boundary ${runner}: a plan revision invalidates approval before dispatch`,async t=>{
  const {cwd,h,marker}=fixture(t);plan(cwd);
  writeCycleRecord({cwd,stage:'approach',summary:'A revised fixture plan changes acceptance criteria and requires another review.',cycleId:'BOUNDARY-R1'});
  await mustRefuse(h,{agent:{name:'developer',runner},task:'Do not execute stale approval',cycleId:'BOUNDARY-R1'},/approval/);
  assert.equal(fs.existsSync(marker),false);assert.deepEqual(h.list(),[]);
 });
 test(`independent boundary ${runner}: approved plan cannot authorize another cycle`,async t=>{
  const {cwd,h,marker}=fixture(t);plan(cwd);
  await mustRefuse(h,{agent:{name:'developer',runner},task:'Do not execute a different cycle',cycleId:'UNRELATED-R2'},/cycleId.*approved plan/);
  assert.equal(fs.existsSync(marker),false);assert.deepEqual(h.list(),[]);
 });
 test(`independent boundary ${runner}: unsupported capabilities fail before dispatch`,async t=>{
  const {h,marker}=fixture(t);
  for(const extra of [{resume:true},{requireIsolation:true},{permissionProfile:'unsafe'}])await mustRefuse(h,{agent:{name:'planner',runner},task:'Do not downgrade requested capability',...extra},/unsupported|isolation|Unsupported permission/);
  assert.equal(fs.existsSync(marker),false);assert.deepEqual(h.list(),[]);
 });
}
test('independent boundary: prototype property names are never supported providers',async t=>{
 const {cwd,h,marker}=fixture(t);
 for(const runner of ['toString','constructor','__proto__','hasOwnProperty','missing-provider',42,{},[],null,false,0]) {
  assert.throws(()=>buildInvocation({runner,agent:{name:'planner'},prompt:'Safe refusal fixture',runId:'run_12345678',env:{},tempDir:cwd}),/Unsupported runner/);
  assert.throws(()=>createNormalizer(runner),/Unsupported runner/);
  await mustRefuse(h,{agent:{name:'planner',runner},task:'Do not fallback to Codex'},/Unsupported runner/);
 }
 assert.equal(fs.existsSync(marker),false);
});

test('independent boundary: omitted runner intentionally defaults to isolated pi stub',async t=>{
 const {h,marker}=fixture(t);const record=await h.start({agent:{name:'planner'},task:'Default selection fixture'}).completion;
 assert.equal(record.results[0].runner,'pi');assert.equal(record.status,'failed');
 assert.equal(path.basename(JSON.parse(fs.readFileSync(marker,'utf8'))[1]),'pi');
});
for(const [provider,runner] of [['pi','pi'],['claude','claude-cli'],['codex','codex-cli']]) {
 test(`independent process ${runner}: continuation retains exact approved plan`,async t=>{
  const f=createProviderWorkspace(t,provider);f.configure({role:'tester'});
  const prior=await f.h.start({agent:{name:'tester',runner},task:'TASK_MARKER prior evidence',cycleId:'BOUNDARY-R1'}).completion;
  assert.equal(prior.status,'completed',JSON.stringify(prior));
  const reviewed=plan(f.cwd,'EXACT_PLAN_MARKER: preserve this specifically approved acceptance contract in developer context.');
  f.configure({role:'developer'});
  const record=await f.h.start({agent:{name:'developer',runner},task:'TASK_MARKER continue approved work',cycleId:'BOUNDARY-R1',previousRunId:prior.runId}).completion;
  assert.equal(record.status,'completed',JSON.stringify(record));
  const captured=f.capture(record.runId);assert.match(captured.prompt,/EXACT_PLAN_MARKER/);assert.ok(captured.prompt.includes(reviewed.digest));assert.ok(captured.prompt.includes(prior.runId));
  assert.equal(record.approval.digest,reviewed.digest);assert.equal(record.previousRunId,prior.runId);
 });
 test(`independent process ${runner}: foreign controller requests persisted cancellation`,async t=>{
  const f=createProviderWorkspace(t,provider);f.configure({scenario:'hang'});
  const foreign=await startForeignOwner(f,runner);
  try {
   assert.notEqual(foreign.providerPid,process.pid);
   const requested=f.h.cancel(foreign.runId);
   assert.equal(requested.status,'running','Foreign controller must request cancellation, not claim immediate termination');
   assert.ok(requested.cancellationRequestedAt);
   assert.ok(fs.existsSync(`${f.h.get(foreign.runId).artifactPath}.cancel`));
   const exited=await foreign.exit;assert.equal(exited.code,0,foreign.stderr());
   assert.equal(f.h.get(foreign.runId).status,'canceled');assert.deepEqual(f.h.recover(),[]);
   assert.equal(f.h.cancel(foreign.runId).status,'canceled');
  } finally {await foreign.cleanup();}
 });
}
test('independent process: interrupted Claude adapter controller recovers orphan without replay',async t=>{
 const f=createProviderWorkspace(t,'claude');f.configure({scenario:'hang'});
 const foreign=await startForeignOwner(f,'claude-cli');
 try {
  assert.equal(f.h.get(foreign.runId).status,'running');assert.equal(f.h.get(foreign.runId).results[0].runner,'claude-cli');
  foreign.owner.kill('SIGKILL');await foreign.exit;
  const recovered=f.h.recover();assert.equal(recovered.length,1);assert.equal(recovered[0].runId,foreign.runId);assert.equal(recovered[0].status,'orphaned');
  assert.match(recovered[0].statusReason,/No automatic retry/);assert.equal(f.h.list().length,1);assert.deepEqual(f.h.recover(),[]);
  assert.equal(f.h.cancel(foreign.runId).status,'orphaned');assert.equal(process.kill(foreign.providerPid,0),true,'Recovery must not signal the surviving fixture child');
 } finally {await foreign.cleanup();}
});

async function startForeignOwner(f,runner) {
 const {spawn}=await import('node:child_process');
 const runtimeURL=new URL('../extensions/harness/runtime.mjs',import.meta.url).href;
 const source=`import {createHarness} from ${JSON.stringify(runtimeURL)};const h=createHarness({cwd:${JSON.stringify(f.cwd)}});const handle=h.start({agent:{name:'planner',runner:${JSON.stringify(runner)}},task:'TASK_MARKER foreign controller',cycleId:'BOUNDARY-R1',timeoutMs:4000});console.log(JSON.stringify({runId:handle.runId}));await handle.completion;`;
 const owner=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env},stdio:['ignore','pipe','pipe']});
 let providerPid,runId,stderr='';owner.stderr.on('data',bytes=>{stderr+=bytes;});
 const exit=new Promise(resolve=>owner.once('close',(code,signal)=>resolve({code,signal})));
 const cleanup=async()=>{
  if(owner.exitCode===null&&owner.signalCode===null)owner.kill('SIGKILL');await exit;
  // This run and child PID belong to this isolated test controller, not
  // arbitrary imported state. Cleanup never delegates stale-PID signaling.
  if(!providerPid&&runId){try{providerPid=f.h.get(runId)?.pid;}catch{}}
  let childMaySurvive=true;try{const record=runId&&f.h.get(runId);childMaySurvive=!record?.finishedAt||record.status==='orphaned';}catch{}
  if(providerPid&&childMaySurvive){try{if(process.platform!=='win32')process.kill(-providerPid,'SIGKILL');else process.kill(providerPid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
 };
 try {
  runId=await new Promise((resolve,reject)=>{
   let data='';const timer=setTimeout(()=>reject(new Error(`Controller did not report run: ${stderr}`)),3000);
   owner.once('error',error=>{clearTimeout(timer);reject(error);});
   owner.stdout.on('data',bytes=>{data+=bytes;const newline=data.indexOf('\n');if(newline>=0){clearTimeout(timer);try{resolve(JSON.parse(data.slice(0,newline)).runId);}catch(error){reject(error);}}});
  });
  providerPid=(await f.waitForCapture(runId)).pid;
  return {owner,runId,providerPid,exit,stderr:()=>stderr,cleanup};
 } catch(error) {await cleanup();throw error;}
}
