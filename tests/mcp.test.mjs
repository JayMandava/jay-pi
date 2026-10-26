import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { verifyCycleEvidence } from '../extensions/cycle-store.mjs';

test('real MCP stdio server initializes and returns a persisted correlated receipt', { timeout: 10000 }, async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'jay-mcp-'));
  const runId = 'run_0123456789abcdef';
  const server = spawn(process.execPath, [fileURLToPath(new URL('../extensions/mcp/record-cycle-server/server.mjs', import.meta.url))], {
    cwd, env: { PATH: process.env.PATH, PI_HARNESS_RUN_ID: runId }, stdio: ['pipe','pipe','pipe'],
  });
  let buffer = '', stderr = '', nextId = 1;
  const pending = new Map();
  server.stderr.on('data', data => { stderr += data; });
  server.stdout.on('data', data => {
    buffer += data;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const response = JSON.parse(line), waiter = pending.get(response.id);
      if (waiter) { pending.delete(response.id); response.error ? waiter.reject(new Error(JSON.stringify(response.error))) : waiter.resolve(response.result); }
    }
  });
  server.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
  server.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error(`MCP server exited: ${stderr}`)); });
  const request = (method, params) => new Promise((resolve,reject) => {
    const id = nextId++; pending.set(id,{resolve,reject}); server.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  try {
    const init = await request('initialize', {protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'jay-pi-offline-test',version:'1'}});
    assert.equal(init.serverInfo.name,'record-cycle');
    server.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const catalog = await request('tools/list', {}); assert.equal(catalog.tools[0].name,'record_cycle');
    const result = await request('tools/call', {name:'record_cycle',arguments:{stage:'feedback',cycleId:'MCP-R1',summary:'The actual MCP transport persisted this structured feedback receipt successfully.'}});
    assert.equal(result.isError,undefined);
    const receipt = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.equal(receipt.runId,runId); assert.equal(receipt.stage,'feedback');
    assert.equal(verifyCycleEvidence(cwd,'feedback',receipt.rowId,{runId,cycleId:'MCP-R1'}),true);
    const bad = await request('tools/call', {name:'record_cycle',arguments:{stage:'feedback',summary:'thin'}}); assert.equal(bad.isError,true);
  } finally {
    server.stdin.end(); server.kill('SIGTERM');
    await new Promise(resolve => server.exitCode !== null || server.signalCode !== null ? resolve() : server.once('exit',resolve));
    rmSync(cwd,{recursive:true,force:true});
  }
});
