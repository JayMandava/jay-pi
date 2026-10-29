#!/usr/bin/env node
// Stand-in for the `claude` CLI: speaks stream-json and (optionally) writes a
// real cycle record, so lifecycle-subagent's proof logic runs against real files.
import { writeCycleRecord } from '../../extensions/cycle-store.mjs';
const scenario = process.env.STUB_SCENARIO || 'good';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const say = (text) => emit({ type: 'assistant', message: { model: 'stub', content: [{ type: 'text', text }] } });
  const SUMMARY = 'Stub tester feedback record with enough characters to be accepted by the store.';
  if (scenario === 'signal') process.kill(process.pid, 'SIGKILL');
  if (scenario === 'hang') { say('working'); setInterval(() => {}, 1000); return; }
  if (scenario === 'prose') { say('record_cycle stage feedback recorded successfully'); emit({ type: 'result', result: 'done', is_error: false }); return; }
  const runId = scenario === 'wrongrun' ? 'run_someoneelse' : process.env.PI_HARNESS_RUN_ID;
  const stage = scenario === 'wrongstage' ? 'review' : 'feedback';
  const receipt = writeCycleRecord({ cwd: process.cwd(), stage, summary: SUMMARY, runId });
  emit({ type: 'assistant', message: { model: 'stub', content: [{ type: 'tool_use', id: 't1', name: 'mcp__record-cycle__record_cycle', input: { stage: 'feedback', summary: SUMMARY } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: JSON.stringify(receipt) }] }] } });
  say('Recorded.');
  emit({ type: 'result', result: 'Recorded.', is_error: false });
});
