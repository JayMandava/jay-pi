import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import grill from '../extensions/grill.ts';
import footer from '../extensions/tokens-per-second.ts';
import { patches } from '../patches/core-patches.mjs';

function fixture(t) { const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'jay-legacy-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));return cwd; }
function isolated(t,source) {
 const home=fixture(t);
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict'; import * as fs from 'node:fs'; import * as path from 'node:path'; const home=process.env.HOME; ${source}`],{cwd:home,env:{PATH:process.env.PATH,HOME:home},encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
}
const moduleUrl=name=>new URL(`../extensions/${name}.ts`,import.meta.url).href;

test('legacy grill requires recommendation and interactive UI; logs actual answer or dismissal',async t=>{
 const cwd=fixture(t);let tool;grill({registerTool(value){tool=value;}});
 assert.ok(tool.parameters.required.includes('recommended'));
 const params={question:'Proceed?',options:['Yes','No'],recommended:'Yes',context:'Review is complete.'};
 const invoke=(input,ctx)=>tool.execute('id',input,null,null,{cwd,...ctx});
 assert.equal((await invoke(params,{hasUI:false})).isError,true);
 assert.equal((await invoke({...params,recommended:'Maybe'},{hasUI:true})).isError,true);
 assert.equal(fs.existsSync(path.join(cwd,'data/history.jsonl')),false);
 let displayed;
 const answered=await invoke(params,{hasUI:true,ui:{select:async(title,options)=>{displayed={title,options};return options[0];}}});
 assert.equal(answered.details.answer,'Yes');assert.deepEqual(displayed.options,['Yes (recommended)','No']);assert.match(displayed.title,/Review is complete/);
 assert.equal((await invoke(params,{hasUI:true,ui:{select:async()=>undefined}})).isError,true);
 const events=fs.readFileSync(path.join(cwd,'data/history.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(events.map(e=>e.answer),['Yes',null]);assert.ok(events.every(e=>e.event==='grill'));
});

test('legacy token footer ignores non-assistant and near-zero replies; computes completed throughput',t=>{
 const hooks={};footer({on(name,fn){hooks[name]=fn;}});const outputs=[];const ctx={ui:{setStatus:(...args)=>outputs.push(args)}};
 t.mock.method(Date,'now',()=>1000);hooks.message_start({message:{role:'user'}},ctx);hooks.message_end({message:{role:'assistant',usage:{output:10}}},ctx);assert.equal(outputs.length,0);
 hooks.message_start({message:{role:'assistant'}},ctx);t.mock.method(Date,'now',()=>3000);hooks.message_end({message:{role:'assistant',usage:{output:40}}},ctx);assert.deepEqual(outputs,[['tokens-per-second','20.0 tok/s']]);
 hooks.message_start({message:{role:'assistant'}},ctx);hooks.message_end({message:{role:'assistant',usage:{output:1}}},ctx);assert.equal(outputs.length,1);
});

test('legacy freshness baselines new sessions and warns on changed or untracked resumed contracts',t=>isolated(t,`
 const {default:register}=await import(${JSON.stringify(moduleUrl('agents-md-freshness'))});let handler;register({on(_name,fn){handler=fn;}});
 const warnings=[];const ctx={mode:'tui',sessionManager:{getSessionId:()=> 'safe-session'},ui:{notify:(...args)=>warnings.push(args)}};
 await handler({reason:'new'},ctx);assert.equal(fs.existsSync(path.join(home,'.pi')),false);
 fs.writeFileSync(path.join(home,'AGENTS.md'),'Initial contract');await handler({reason:'new'},ctx);assert.equal(warnings.length,0);
 await handler({reason:'resume'},ctx);assert.equal(warnings.length,0);
 fs.writeFileSync(path.join(home,'AGENTS.md'),'Revised contract');await handler({reason:'resume'},ctx);assert.match(warnings[0][0],/has changed/);
 await handler({reason:'resume'},ctx);assert.equal(warnings.length,1);
 await handler({reason:'resume'},{...ctx,sessionManager:{getSessionId:()=> 'older-session'}});assert.match(warnings[1][0],/untracked/);
 await handler({reason:'resume'},{...ctx,mode:'rpc'});assert.equal(warnings.length,2);
`));

test('legacy console guard redirects only TUI, restores originals and survives extension reload',t=>isolated(t,`
 const {default:register}=await import(${JSON.stringify(moduleUrl('tui-console-guard'))});const hooks={};register({on(name,fn){hooks[name]=fn;}});
 const originals={log:console.log,error:console.error};const notices=[];const ctx={mode:'tui',hasUI:true,ui:{notify:(...args)=>notices.push(args)}};
 await hooks.session_start({}, {...ctx,mode:'rpc'});assert.equal(console.log,originals.log);
 await hooks.session_start({},ctx);console.log('fixture %s','message');console.info('Open this URL: https://example.invalid/local-fixture');
 assert.equal(notices.length,1);assert.match(fs.readFileSync(path.join(home,'.pi/agent/logs/console.log'),'utf8'),/fixture message/);
 const wrapper=console.log;const second={};register({on(name,fn){second[name]=fn;}});await second.session_start({},ctx);assert.equal(console.log,wrapper);
 await hooks.session_shutdown();assert.equal(console.log,wrapper);await second.session_shutdown();assert.equal(console.log,originals.log);assert.equal(console.error,originals.error);
`));

test('legacy Jev is inert without credentials; skips irrelevant/error events before any fetch',t=>isolated(t,`
 const {default:register}=await import(${JSON.stringify(moduleUrl('jev-parallel-check'))});let handler;register({on(_name,fn){handler=fn;}});let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Network forbidden in fixture');};
 const ctx={cwd:home,hasUI:true,ui:{notify(){throw new Error('Inert check must not notify');}}};
 const event={toolName:'record_cycle',input:{stage:'feedback',summary:'Fixture summary'},details:{rowId:1},content:[{type:'text',text:'Original result'}]};
 assert.deepEqual(await handler(event,ctx),{});process.env.JEV_API_KEY='fixture-only-not-a-real-key';
 assert.deepEqual(await handler({...event,isError:true},ctx),{});assert.deepEqual(await handler({...event,input:{stage:'approach'}},ctx),{});assert.deepEqual(await handler({...event,toolName:'other'},ctx),{});
 assert.equal(calls,0);assert.equal(fs.existsSync(path.join(home,'data')),false);
`));

test('legacy Jev mocked timeout and malformed JSON preserve original tool result without live API',t=>isolated(t,`
 const {default:register}=await import(${JSON.stringify(moduleUrl('jev-parallel-check'))});let handler;register({on(_name,fn){handler=fn;}});process.env.JEV_API_KEY='fixture-only-not-a-real-key';const notices=[];
 const ctx={cwd:home,hasUI:true,ui:{notify:(...args)=>notices.push(args)}};const event={toolName:'record_cycle',input:{stage:'feedback',summary:'Tester verdict must not be overwritten'},details:{rowId:1},content:[{type:'text',text:'Original result'}]};
 globalThis.fetch=async()=>{throw new Error('fixture timeout');};assert.deepEqual(await handler(event,ctx),{});assert.match(notices[0][0],/failed or timed out/);
 globalThis.fetch=async()=>({ok:true,json:async()=>{throw new Error('fixture malformed JSON');}});assert.deepEqual(await handler(event,ctx),{});assert.match(notices[1][0],/unexpected failure/);assert.equal(event.content[0].text,'Original result');
`));

test('legacy patcher applies only unique anchors in temporary fixtures; replay idempotent, ambiguous/missing refuse',t=>{
 const patcher=new URL('../patches/apply-patches.mjs',import.meta.url);const cwd=fixture(t),dist=path.join(cwd,'dist');fs.mkdirSync(dist);
 const run=()=>spawnSync(process.execPath,[patcher.pathname,cwd],{encoding:'utf8',timeout:5000});
 const file=path.join(dist,'fixture.js');fs.writeFileSync(file,patches[0].anchor);let result=run();assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(file,'utf8'),patches[0].replacement);
 result=run();assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).alreadyApplied.length,1);
 fs.writeFileSync(file,patches[0].anchor+';'+patches[0].anchor);result=run();assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).failed[0].reason,'ambiguous');assert.equal(fs.readFileSync(file,'utf8'),patches[0].anchor+';'+patches[0].anchor);
 fs.writeFileSync(file,'unrelated');result=run();assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).failed[0].reason,'anchor-not-found');assert.equal(fs.readFileSync(file,'utf8'),'unrelated');
});

test('legacy console guard batches errors, rotates oversized logs and tolerates stale UI',t=>isolated(t,`
 const {default:register}=await import(${JSON.stringify(moduleUrl('tui-console-guard'))});const hooks={};register({on(name,fn){hooks[name]=fn;}});
 const pending=[];const originalTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,delay)=>{pending.push({fn,delay});return {unref(){}};};
 const notices=[];await hooks.session_start({}, {mode:'tui',hasUI:true,ui:{notify:(...args)=>notices.push(args)}});
 const logfile=path.join(home,'.pi/agent/logs/console.log');fs.mkdirSync(path.dirname(logfile),{recursive:true});fs.writeFileSync(logfile,'x'.repeat(2*1024*1024+1));
 console.error('first fixture error');console.error('second fixture error');assert.equal(pending.length,1);assert.equal(pending[0].delay,1500);pending[0].fn();
 assert.match(notices[0][0],/2 background errors/);console.error('third throttled fixture error');assert.equal(pending.length,2);assert.ok(pending[1].delay>59000 && pending[1].delay<=60000);assert.equal(notices.length,1);assert.ok(fs.statSync(logfile+'.1').size>2*1024*1024);assert.match(fs.readFileSync(logfile,'utf8'),/second fixture error/);
 await hooks.session_shutdown();globalThis.setTimeout=originalTimeout;
 const stale={};register({on(name,fn){stale[name]=fn;}});await stale.session_start({}, {mode:'tui',hasUI:true,ui:{notify(){throw new Error('stale context');}}});console.info('Open this URL: https://example.invalid/stale-fixture');await stale.session_shutdown();
`));

test('legacy grill preserves literal recommended suffix, refuses ambiguous labels and unrecognized selections',async t=>{
 const cwd=fixture(t);let tool;grill({registerTool(value){tool=value;}});
 const params={question:'Which label?',options:['Keep (recommended)','Replace'],recommended:'Replace'};
 const call=(input,select)=>tool.execute('id',input,null,null,{cwd,hasUI:true,ui:{select}});
 const result=await call(params,async(_title,options)=>options[0]);assert.equal(result.details.answer,'Keep (recommended)');
 const event=JSON.parse(fs.readFileSync(path.join(cwd,'data/history.jsonl'),'utf8').trim());assert.equal(event.answer,'Keep (recommended)');
 assert.equal((await call({...params,options:['Keep','Keep (recommended)'],recommended:'Keep'},async()=>{throw new Error('Ambiguous UI must not open');})).isError,true);
 assert.equal((await call(params,async()=> 'Invented answer')).isError,true);
 assert.equal(fs.readFileSync(path.join(cwd,'data/history.jsonl'),'utf8').trim().split('\n').length,1);
});

test('legacy status widget filters sessions, shows fixed-height feed, refreshes and removes after completion',async t=>{
 const {default:register}=await import('../extensions/subagent-status.ts');const hooks={};register({on(name,fn){hooks[name]=fn;}});
 const cwd=fixture(t),dir=path.join(cwd,'data/subagent-runs');fs.mkdirSync(dir,{recursive:true});
 let poll,cleared=false;t.mock.method(globalThis,'setInterval',(fn,delay)=>{assert.equal(delay,700);poll=fn;return 42;});t.mock.method(globalThis,'clearInterval',id=>{assert.equal(id,42);cleared=true;});
 const calls=[];let component,redraw=0;const ctx={cwd,mode:'tui',sessionManager:{getSessionId:()=> 'ours'},ui:{setWidget:(key,factory,options)=>{calls.push({key,factory,options});if(factory)component=factory({requestRender:()=>redraw++},{fg:(_color,text)=>text});}}};
 const record={status:'running',sessionId:'ours',results:[{agent:'tester',messages:[{role:'assistant',timestamp:1,content:[{type:'toolCall',name:'bash',arguments:{command:'echo safe\nfixture'}}]},{role:'toolResult',timestamp:2,toolName:'bash'}]}]};
 fs.writeFileSync(path.join(dir,'ours.json'),JSON.stringify(record));fs.writeFileSync(path.join(dir,'other.json'),JSON.stringify({...record,sessionId:'theirs'}));fs.writeFileSync(path.join(dir,'corrupt.json'),'{');
 await hooks.session_start({},ctx);poll();assert.equal(calls.length,1);assert.equal(calls[0].options.placement,'aboveEditor');const lines=component.render(80);assert.equal(lines.length,4);assert.equal(lines[0],'Running: tester');assert.ok(lines.some(line=>line.includes('echo safe fixture')));
 poll();assert.equal(redraw,1);fs.writeFileSync(path.join(dir,'ours.json'),JSON.stringify({...record,status:'completed'}));poll();assert.equal(calls[1].factory,undefined);
 component.dispose();await hooks.session_shutdown();assert.equal(cleared,true);
});

test('legacy grill rejects concurrent questions and never records an answer after cancellation',async t=>{
 const cwd=fixture(t);let tool;grill({registerTool(value){tool=value;}});const params={question:'Continue?',options:['Yes','No'],recommended:'Yes'};
 const aborted=new AbortController();aborted.abort();assert.equal((await tool.execute('a',params,aborted.signal,null,{cwd,hasUI:true,ui:{select(){throw new Error('Canceled UI must not open');}}})).isError,true);
 let resolve,opened=0;const controller=new AbortController();const ctx={cwd,hasUI:true,ui:{select:()=>{opened++;return new Promise(r=>resolve=r);}}};
 const first=tool.execute('b',params,controller.signal,null,ctx);const second=await tool.execute('c',params,null,null,ctx);assert.equal(second.isError,true);assert.equal(opened,1);
 controller.abort();resolve('Yes (recommended)');assert.equal((await first).isError,true);assert.equal(fs.existsSync(path.join(cwd,'data/history.jsonl')),false);
 const result=await tool.execute('d',params,null,null,{cwd,hasUI:true,ui:{select:async()=> 'No'}});assert.equal(result.details.answer,'No');
 await assert.rejects(tool.execute('e',params,null,null,{cwd,hasUI:true,ui:{select:async()=>{throw new Error('fixture UI failure');}}}),/fixture UI failure/);
 const retry=await tool.execute('f',params,null,null,{cwd,hasUI:true,ui:{select:async()=> 'No'}});assert.equal(retry.details.answer,'No');
});
