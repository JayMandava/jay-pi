import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import lifecycleSubagent from '../extensions/lifecycle-subagent/index.ts';
function host() {let tool; lifecycleSubagent({on(){},registerTool(value){tool=value;},registerCommand(){},sendMessage(){}});return tool;}
function fixture(t) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'jay-pi-frontend-')),bin=path.join(cwd,'bin');fs.mkdirSync(bin);fs.mkdirSync(path.join(cwd,'.pi','agents'),{recursive:true});
 fs.writeFileSync(path.join(cwd,'.pi','agents','planner.md'),'---\nname: planner\ndescription: safe fixture\nrunner: pi\n---\nFixture role.');
 fs.writeFileSync(path.join(bin,'pi'),`#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync('spawned.marker','fixture');setTimeout(()=>{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'fixture output'}]}}));},100);`,{mode:0o755});
 fs.writeFileSync(path.join(bin,'package.json'),'{"type":"module"}');
 const before={PATH:process.env.PATH,HOME:process.env.HOME};process.env.PATH=bin+path.delimiter+before.PATH;process.env.HOME=path.join(cwd,'home');
 t.after(()=>{process.env.PATH=before.PATH;process.env.HOME=before.HOME;fs.rmSync(cwd,{recursive:true,force:true});});return cwd;
}
const context=(cwd,hasUI=true)=>({cwd,hasUI,sessionManager:{getSessionId:()=> 'fixture-session'},ui:{confirm:async()=>true,notify(){}}});
test('independent: already-aborted foreground invocation must not launch provider',async t=>{
 const cwd=fixture(t),controller=new AbortController();controller.abort();
 const result=await host().execute('id',{action:'run',agent:'planner',task:'Safe local fixture',agentScope:'project',background:false},controller.signal,()=>{},context(cwd));
 assert.equal(fs.existsSync(path.join(cwd,'spawned.marker')),false,JSON.stringify(result));
});
test('independent: headless project trust cannot be bypassed by confirmProjectAgents false',async t=>{
 const cwd=fixture(t);const result=await host().execute('id',{action:'run',agent:'planner',task:'Safe local fixture',agentScope:'project',background:false,confirmProjectAgents:false},new AbortController().signal,()=>{},context(cwd,false));
 assert.equal(result.isError,true);assert.match(result.content[0].text,/not approved/i);assert.equal(fs.existsSync(path.join(cwd,'spawned.marker')),false);
});
test('independent: forwarded secret containing JSON escapes is redacted from retained messages',async t=>{
 const cwd=fixture(t),secret='fixture"secret\\with-escapes';const before=process.env.QA_SECRET_VALUE;process.env.QA_SECRET_VALUE=secret;t.after(()=>{if(before===undefined)delete process.env.QA_SECRET_VALUE;else process.env.QA_SECRET_VALUE=before;});
 fs.writeFileSync(path.join(cwd,'bin','pi'),`#!${process.execPath}\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:process.env.QA_SECRET_VALUE}]}}));`,{mode:0o755});
 const {createHarness}=await import('../extensions/harness/runtime.mjs');const h=createHarness({cwd});
 const record=await h.start({agent:{name:'planner',runner:'pi'},task:'Safe secret redaction fixture',envAllowlist:['QA_SECRET_VALUE']}).completion;
 assert.equal(record.results[0].messages[0].content[0].text.includes(secret),false);
 assert.equal(h.get(record.runId).results[0].messages[0].content[0].text.includes(secret),false);
});
