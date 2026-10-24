import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildInvocation,createNormalizer,scopedEnvironment,PROVIDERS} from '../extensions/harness/adapters.mjs';
function invocation(t,runner,extra={}) {const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'adapter-test-'));t.after(()=>fs.rmSync(tempDir,{recursive:true,force:true}));return buildInvocation({runner,agent:{name:'planner'},prompt:'Task; $(echo never execute)',runId:'run_12345678',cycleId:'TEST-R1',env:{PATH:'/bin'},tempDir,...extra});}
test('environment is allowlisted, not copied; injection variables absent',()=>{
 const source={PATH:'/bin',HOME:'/home/example',EXAMPLE_SECRET:'never-forward',NODE_OPTIONS:'--require evil',PI_HARNESS_RUN_ID:'forged',ANTHROPIC_API_KEY:'explicit-key'};
 assert.deepEqual(scopedEnvironment(source),{PATH:'/bin',HOME:'/home/example'});
 assert.equal(scopedEnvironment(source,['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY,'explicit-key');
 assert.equal(scopedEnvironment(source,['PI_HARNESS_RUN_ID']).PI_HARNESS_RUN_ID,undefined);
 assert.throws(()=>scopedEnvironment(source,['oops=value']),/variable names/);
});
test('pi policy and prompt use argv without a shell',t=>{
 const read=invocation(t,'pi');assert.deepEqual(read.args.slice(read.args.indexOf('--tools'),read.args.indexOf('--tools')+2),['--tools','read,grep,find,ls']);
 assert.equal(read.args.at(-1),'Task; $(echo never execute)');assert.equal(read.env.PI_HARNESS_RUN_ID,'run_12345678');
 const write=invocation(t,'pi',{permissionProfile:'workspace-write'});assert.ok(write.args.includes('read,bash,edit,write'));
});
test('Claude MCP path exists and default permissions never bypass',t=>{
 const config=invocation(t,'claude-cli');assert.equal(config.command,'claude');assert.ok(config.args.includes('dontAsk'));assert.ok(!config.args.includes('--dangerously-skip-permissions'));
 assert.ok(config.args.includes('--strict-mcp-config'));assert.ok(config.args.includes('Read,Glob,Grep'));
 const mcp=JSON.parse(fs.readFileSync(config.args[config.args.indexOf('--mcp-config')+1],'utf8'));assert.ok(fs.existsSync(mcp.mcpServers['record-cycle'].args[0]));assert.equal(mcp.mcpServers['record-cycle'].env.PI_HARNESS_RUN_ID,'run_12345678');
});
test('Codex read-only and explicit edit profiles never imply bypass/resume',t=>{
 const config=invocation(t,'codex-cli');assert.ok(config.args.includes('read-only'));assert.ok(config.args.includes('--ignore-user-config'));assert.ok(config.args.includes('approval_policy="never"'));assert.equal(config.args.at(-1),'-');
 assert.ok(!config.args.some(a=>a.includes('dangerously')));assert.equal(PROVIDERS['codex-cli'].resume,false);
 assert.ok(invocation(t,'codex-cli',{permissionProfile:'workspace-write'}).args.includes('workspace-write'));
 assert.throws(()=>invocation(t,'no-such-provider'),/Unsupported runner/);assert.throws(()=>invocation(t,'pi',{permissionProfile:'unsafe'}),/Unsupported permission/);
});
test('Claude tool calls and actual results preserve structured proof, error terminal',()=>{
 const parse=createNormalizer('claude-cli');const call=parse({type:'assistant',message:{content:[{type:'tool_use',id:'a',name:'mcp__record-cycle__record_cycle',input:{stage:'approach'}}]}});
 assert.equal(call.messages[0].content[0].arguments.stage,'approach');
 const result=parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'a',content:[{type:'text',text:'{"ok":true}'}]}]}});
 assert.equal(result.messages[0].toolName,'mcp__record-cycle__record_cycle');assert.equal(result.messages[0].isError,false);
 assert.equal(parse({type:'result',is_error:true,result:'failed'}).failed,true);
});
test('Codex MCP completion normalizes proof and failures',()=>{
 const parse=createNormalizer('codex-cli');const out=parse({type:'item.completed',item:{type:'mcp_tool_call',id:'a',server:'record-cycle',tool:'record_cycle',arguments:{stage:'feedback'},status:'completed',result:{content:[{type:'text',text:'{}'}],structuredContent:{ok:true}}}});
 assert.equal(out.messages[0].content[0].arguments.stage,'feedback');assert.equal(out.messages[1].details.ok,true);assert.equal(out.messages[1].isError,false);
 assert.equal(parse({type:'turn.failed'}).failed,true);assert.equal(parse({type:'item.completed',item:{type:'agent_message',text:'done'}}).messages[0].content[0].text,'done');
});
test('pi provider error remains failure despite clean process exit',()=>{assert.equal(createNormalizer('pi')({type:'message_end',message:{role:'assistant',stopReason:'error',content:[]}}).failed,true);});
test('provider usage normalizes token metrics and preserves unknown costs',()=>{
 const pi=createNormalizer('pi')({type:'message_end',message:{role:'assistant',content:[],usage:{input:12,output:3,cacheRead:2,cacheWrite:1,totalTokens:15,cost:{total:0.01}}}});
 assert.deepEqual(pi.usage,{input:12,output:3,cacheRead:2,cacheWrite:1,contextTokens:15,cost:0.01});
 const claude=createNormalizer('claude-cli');assert.equal(claude({type:'assistant',message:{content:[],usage:{input_tokens:8,output_tokens:2,cache_read_input_tokens:4}}}).usage.input,8);assert.equal(claude({type:'result',total_cost_usd:0.2}).usage.costTotal,0.2);
 const codex=createNormalizer('codex-cli')({type:'turn.completed',usage:{input_tokens:20,output_tokens:5,cached_input_tokens:10}});assert.equal(codex.usage.input,20);assert.equal(codex.usage.cacheRead,10);assert.equal(codex.usage.cost,undefined);
});
