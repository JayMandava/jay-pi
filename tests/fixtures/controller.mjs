import {createHarness} from '../../extensions/harness/runtime.mjs';
const h=createHarness({cwd:process.argv[2]});
const handle=h.start({agent:{name:'planner',runner:'mock'},task:'Cross-process cancellation fixture',mockScenario:'hang',timeoutMs:5000});
console.log(JSON.stringify({runId:handle.runId}));
console.log(JSON.stringify({status:(await handle.completion).status}));
