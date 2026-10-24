// Offline executable fixture. It never invokes a model, network or user command.
import { writeCycleRecord } from '../cycle-store.mjs';
const [role, scenario = 'success'] = process.argv.slice(2);
const stage = {
    planner: 'approach', developer: 'implementation', tester: 'feedback', lead: 'review'
}[role] || 'approach';
const emit = async (message, last = false) => {
    const bytes = Buffer.from(JSON.stringify({ type: 'message_end', message }) + (last && scenario === 'fragmented' ? '' : '\n'));
    if (scenario !== 'fragmented') {process.stdout.write(bytes);return;}
    const unicode = bytes.indexOf(Buffer.from('✓'));
    const split = unicode < 0 ? Math.floor(bytes.length / 2) : unicode + 1;
    process.stdout.write(bytes.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 10));
    process.stdout.write(bytes.subarray(split));
};
if (scenario === 'hang') {
    setInterval(() => { }, 1000);
}
else if (scenario === 'fail') {
    process.stderr.write('Deliberate offline fixture failure\n');
    process.exitCode = 2;
}
else if (scenario === 'signal') {
    process.kill(process.pid, 'SIGTERM');
}
else if (scenario === 'oversize') {
    process.stdout.write('x'.repeat(2 * 1024 * 1024));
}
else if (scenario === 'malformed') {
    process.stdout.write('not-json: record_cycle completed\n');
}
else {
    if (scenario !== 'incomplete') {
        const actualStage = scenario === 'wrong-stage' ? (stage === 'feedback' ? 'approach' : 'feedback') : stage;
        const summary = `Offline ${role} fixture: the ${actualStage} stage was recorded through the shared cycle store with verifiable run identity.`;
        const args = {
            stage: actualStage, summary, cycleId: process.env.PI_HARNESS_CYCLE_ID, data: { fixture: true, scenario, role }
        };
        const receipt = writeCycleRecord({ cwd: process.cwd(), ...args });
        await emit({ role: 'assistant', content: [{
                    type: 'toolCall', id: 'fixture_record', name: 'record_cycle', arguments: args
                }] });
        await emit({
            role: 'toolResult', toolCallId: 'fixture_record', toolName: 'record_cycle', isError: !receipt.ok, details: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }]
        });
    }
    await emit({ role: 'assistant', content: [{ type: 'text', text: `Offline ${role} fixture finished (${scenario}). This is simulated work, not model output. ✓` }] }, true);
}
