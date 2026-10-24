import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createRunStore, newRunId, TERMINAL } from './run-store.mjs';
import { buildInvocation, createNormalizer, scopedEnvironment, PROVIDERS } from './adapters.mjs';
import { getLatestApproach, isApproachApproved } from './approval-store.mjs';
import { verifyCycleEvidence } from '../cycle-store.mjs';
const STAGES = {
    planner: 'approach', developer: 'implementation', tester: 'feedback', lead: 'review'
};
const active = new Map();
const now = () => new Date().toISOString();
const isAlive = pid => {
    if (!Number.isSafeInteger(pid) || pid < 1) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
};
export function finalOutput(messages = []) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant') {
            const text = (messages[i].content || []).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
            if (text) {
                return text;
            }
        }
    }
    return '';
}
const isRecordTool = name => name === 'record_cycle' || name === 'mcp__record-cycle__record_cycle';
function receiptOf(message) {
    if (message.details?.ok === true) {
        return message.details;
    }
    for (const part of message.content || []) {
        if (part?.type === 'text' && typeof part.text === 'string') {
            try {
                const value = JSON.parse(part.text);
                if (value?.ok === true) {
                    return value;
                }
            }
            catch { }
        }
    }
    return null;
}
export function hasVerifiedCycleRecord(cwd, messages, stage, runId, cycleId) {
    const calls = new Map();
    for (const msg of messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const p of msg.content) {
                if (p.type === 'toolCall' && isRecordTool(p.name) && typeof p.id === 'string') {
                    calls.set(p.id, p.arguments?.stage);
                }
            }
        }
        if (msg.role === 'toolResult' && !msg.isError && isRecordTool(msg.toolName) && calls.get(msg.toolCallId) === stage) {
            const receipt = receiptOf(msg);
            if (receipt?.stage === stage && receipt.runId === runId && verifyCycleEvidence(cwd, stage, receipt.rowId, { runId, cycleId })) {
                return true;
            }
        }
    }
    return false;
}
/** Shared trusted-local-controller API. It is not a sandbox or a remote service. */
export function createHarness({ cwd }) {
    cwd = fs.realpathSync(path.resolve(cwd));
    const store = createRunStore(cwd);
    const key = id => `${cwd}\0${id}`;
    function start(options) {
        const { agent, task, previousRunId, cycleId, sessionId, onUpdate } = options;
        if (!agent || typeof agent.name !== 'string' || !agent.name.trim()) {
            throw new Error('Agent name is required');
        }
        if (typeof task !== 'string' || !task.trim() || task.length > 1000000) {
            throw new Error('Task must be nonempty and at most 1 MB');
        }
        if (cycleId !== undefined && (typeof cycleId !== 'string' || !cycleId.trim() || cycleId.length > 200)) {
            throw new Error('Invalid cycleId');
        }
        if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256 || /[\x00-\x1f\x7f]/.test(sessionId))) {
            throw new Error('Invalid sessionId');
        }
        if (options.requireIsolation) {
            throw new Error('This local harness cannot guarantee hostile-code isolation; use an externally provisioned sandbox');
        }
        if (options.resume) {
            throw new Error('Provider session resume is unsupported; use previousRunId for explicit context-only continuation');
        }
        const runner = agent.runner === undefined ? 'pi' : agent.runner;
        if (typeof runner !== 'string' || !Object.hasOwn(PROVIDERS, runner)) {
            throw new Error(`Unsupported runner: ${runner}`);
        }
        const timeoutMs = options.timeoutMs ?? 15 * 60000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 24 * 60 * 60000) {
            throw new Error('timeoutMs must be between 10 and 86400000');
        }
        const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
        if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 64 * 1024 * 1024) {
            throw new Error('Invalid maxOutputBytes');
        }
        let approval;
        if (agent.name === 'developer') {
            const row = getLatestApproach(cwd);
            if (!row || !isApproachApproved(cwd, row.id)) {
                throw new Error('Developer requires human approval of the latest plan');
            }
            if (cycleId && row.cycle_id !== cycleId) {
                throw new Error('Developer cycleId must match the approved plan');
            }
            approval = {
                approachRowId: row.id, digest: row.digest, summary: row.summary, payload: row.payload
            };
        }
        let effectiveTask = task;
        if (approval) {
            effectiveTask = `Approved plan row ${approval.approachRowId} (digest ${approval.digest}):\n${approval.summary}\n${approval.payload}\n\nTask: ${task}`;
        }
        if (previousRunId) {
            const prior = store.get(previousRunId);
            if (!prior || !TERMINAL.has(prior.status)) {
                throw new Error('previousRunId must identify a terminal saved run');
            }
            effectiveTask = `Prior run ${previousRunId} (${prior.status}), context only; no provider session resumed:\n${finalOutput(prior.results[0]?.messages)}\n\n${effectiveTask}`;
        }
        const runId = newRunId();
        const record = {
            schemaVersion: 1, runId, status: 'running', mode: 'single', createdAt: now(), updatedAt: now(), cwd, artifactPath: store.file(runId), ownerPid: process.pid, background: options.background ?? false, autoHandoff: options.autoHandoff ?? false, previousRunId, cycleId, sessionId, approval, events: [], results: [{
                    agent: agent.name, agentSource: agent.source || 'unknown', task, runner, model: agent.model, exitCode: null, messages: [], stderr: '', usage: {
                        input: null, output: null, cacheRead: null, cacheWrite: null, cost: null, contextTokens: null, turns: 0
                    }
                }]
        };
        const result = record.results[0];
        const env = scopedEnvironment(process.env, options.envAllowlist || []);
        const secrets = Object.entries(env).filter(([k, v]) => /key|token|secret|password/i.test(k) && v.length >= 6).map(([, v]) => v);
        const redact = text => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text);
        function redactValue(value) {
            if (typeof value === 'string') return redact(value);
            if (Array.isArray(value)) return value.map(redactValue);
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
            return value;
        }
        result.task = redact(task);
        // Never persist forwarded secret values, only their variable names.
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-harness-'));
        const prompt = `${runner === 'pi' ? '' : agent.systemPrompt || ''}\n\nTask: ${effectiveTask}\n\nRun identity: ${runId}.${cycleId ? ` Use cycleId ${JSON.stringify(cycleId)} in record_cycle.` : ''} Record your ${STAGES[agent.name] || 'appropriate'} stage through record_cycle; narration is not evidence.`;
        let invocation;
        try {
            invocation = buildInvocation({
                runner, agent, prompt, runId, cycleId, mockScenario: options.mockScenario, env, tempDir, permissionProfile: options.permissionProfile
            });
        }
        catch (e) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            throw e;
        }
        record.security = { ...invocation.security, environmentKeys: Object.keys(invocation.env).sort() };
        function event(type, details = {}) { record.events.push({
            sequence: record.events.length + 1, at: now(), type, ...details
        }); }
        function save() { Object.assign(record, store.save(record)); }
        function update() { try {
            onUpdate?.(structuredClone(record));
        }
        catch {
            event('observer_error');
        } }
        event('run_started', { runner });
        try {
            if (agent.name === 'developer') {
                store.acquireDeveloperLease(runId);
            }
            // Recheck after preparing invocation and acquiring the workspace lease.
            if (approval) {
                const currentPlan = getLatestApproach(cwd);
                if (!currentPlan || currentPlan.id !== approval.approachRowId || currentPlan.digest !== approval.digest || !isApproachApproved(cwd, approval.approachRowId)) {
                    throw new Error('Plan changed before launch; review and approve it again');
                }
            }
            save();
        }
        catch (error) {
            if (agent.name === 'developer') {
                store.releaseDeveloperLease(runId);
            }
            fs.rmSync(tempDir, { recursive: true, force: true });
            throw error;
        }
        let resolve;
        const completion = new Promise(r => resolve = r);
        let child, timer, poll, killTimer, killRequested = false, finished = false, outputBytes = 0, parseErrors = 0, failed = false, buffer = '';
        const decoder = new StringDecoder('utf8');
        const normalize = createNormalizer(runner);
        function kill() {
            if (!child || !child.pid || finished || killRequested) {
                return;
            }
            killRequested = true;
            const signalOwned = (signal) => { try {
                if (process.platform !== 'win32') {
                    process.kill(-child.pid, signal);
                }
                else {
                    child.kill(signal);
                }
            }
            catch (error) {
                if (error.code !== 'ESRCH') {
                    record.terminationError = error.message;
                }
            } };
            signalOwned('SIGTERM');
            killTimer = setTimeout(() => { if (!finished) {
                signalOwned('SIGKILL');
            } }, 1000);
            killTimer.unref();
        }
        function fail(reason) { if (finished) {
            return;
        } failed = true; record.statusReason = reason; kill(); }
        function persistUpdate() {
            try {
                save();
                update();
            }
            catch (error) {
                record.persistenceError = error.message;
                fail(`Cannot persist run state: ${error.message}`);
            }
        }
        function cancelActive() {
            if (finished) {
                return record;
            }
            record.status = 'canceled';
            record.statusReason = 'Canceled by controller; process termination requested';
            event('cancel_requested');
            try {
                save();
            }
            catch (error) {
                record.persistenceError = error.message;
            }
            finally {
                kill();
                update();
            }
            return structuredClone(record);
        }
        function line(value) {
            if (!value.trim()) {
                return;
            }
            let decoded;
            try {
                decoded = JSON.parse(value);
            }
            catch {
                parseErrors++;
                return;
            }
            if (!decoded || typeof decoded !== 'object') {
                parseErrors++;
                return;
            }
            let normalized;
            try {
                normalized = normalize(decoded);
            }
            catch {
                parseErrors++;
                return;
            }
            if (normalized.failed) {
                failed = true;
            }
            for (const message of normalized.messages) {
                // Redact explicitly forwarded credentials in all persisted stream content.
                result.messages.push(redactValue(message));
                if (message.role === 'assistant') {
                    result.usage.turns++;
                }
            }
            for (const field of ['input','output','cacheRead','cacheWrite','cost']) {
                const value=normalized.usage?.[field];
                if(Number.isFinite(value)&&value>=0) result.usage[field]=(result.usage[field]??0)+value;
            }
            for (const [source,target] of [['contextTokens','contextTokens'],['costTotal','cost']]) {
                const value=normalized.usage?.[source];
                if(Number.isFinite(value)&&value>=0) result.usage[target]=value;
            }
            if (normalized.messages.length) {
                persistUpdate();
            }
        }
        function finish(code, signal, error) {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            clearInterval(poll);
            clearTimeout(killTimer);
            try {
                buffer += decoder.end();
                if (buffer.trim()) {
                    line(buffer);
                }
                result.exitCode = code;
                result.signal = signal || undefined;
                if (error) {
                    result.errorMessage = redact(error.message);
                }
                const disk = store.get(runId);
                if (disk?.cancellationRequestedAt || disk?.status === 'canceled') {
                    record.status = 'canceled';
                }
                if (record.status !== 'canceled') {
                    if (error || signal || code !== 0 || failed) {
                        record.status = 'failed';
                        record.statusReason ||= error ? `Process could not start: ${redact(error.message)}` : signal ? `Process exited on signal ${signal}` : `Provider failed (exit ${code})`;
                    }
                    else {
                        const stage = STAGES[agent.name];
                        const proof = stage && hasVerifiedCycleRecord(cwd, result.messages, stage, runId, cycleId);
                        record.status = proof ? 'completed' : 'incomplete';
                        record.statusReason = proof ? undefined : `No verified ${stage || 'lifecycle'} record for this run; a clean exit or success narration is not completion evidence`;
                    }
                }
                record.finishedAt = now();
                record.parseErrors = parseErrors;
                event('run_finished', { status: record.status, exitCode: code, signal: signal || null });
                save();
                update();
            }
            catch (error) {
                record.status = record.status === 'canceled' ? 'canceled' : 'failed';
                record.statusReason = `Run state could not be finalized: ${error.message}`;
                record.persistenceError = error.message;
                record.finishedAt = now();
            }
            finally {
                active.delete(key(runId));
                try {
                    if (agent.name === 'developer') {
                        store.releaseDeveloperLease(runId);
                    }
                }
                catch (error) {
                    record.cleanupError = error.message;
                }
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
                catch (error) {
                    record.cleanupError = error.message;
                }
                resolve(structuredClone(record));
            }
        }
        try {
            child = spawn(invocation.command, invocation.args, {
                cwd, shell: false, detached: process.platform !== 'win32', env: invocation.env, stdio: ['pipe', 'pipe', 'pipe']
            });
            record.pid = child.pid;
            active.set(key(runId), { record, child, cancel: cancelActive });
            child.stdout.on('data', data => {
                outputBytes += data.length;
                if (outputBytes > maxOutputBytes) {
                    buffer = '';
                    fail('Output limit exceeded; inspect partial artifacts before retrying');
                    return;
                }
                buffer += decoder.write(data);
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const value of lines) {
                    line(value);
                }
            });
            child.stderr.on('data', data => {
                outputBytes += data.length;
                if (outputBytes > maxOutputBytes) {
                    fail('Output limit exceeded; inspect partial artifacts before retrying');
                    return;
                }
                result.stderr = redact((result.stderr + data.toString()).slice(-64 * 1024));
                persistUpdate();
            });
            child.on('error', error => finish(null, null, error));
            child.on('close', (code, signal) => finish(code, signal));
            child.stdin.on('error', () => { });
            child.stdin.end(invocation.stdin || '');
            timer = setTimeout(() => fail(`Timed out after ${timeoutMs} ms; side effects may exist, inspect before retrying`), timeoutMs);
            poll = setInterval(() => { try {
                const saved = store.get(runId);
                if (saved?.cancellationRequestedAt && record.status !== 'canceled') {
                    cancelActive();
                }
            }
            catch (error) {
                fail(`Run state unreadable: ${error.message}`);
            } }, 200);
            persistUpdate();
        }
        catch (error) {
            finish(null, null, error);
        }
        return { runId, completion };
    }
    function cancel(runId) {
        const record = store.get(runId);
        if (!record) {
            throw new Error(`Unknown runId: ${runId}`);
        }
        if (TERMINAL.has(record.status)) {
            return record;
        }
        const live = active.get(key(runId));
        if (live) {
            return live.cancel();
        }
        if (!isAlive(record.ownerPid)) {
            throw new Error('Run controller is not alive; recover and inspect instead of signaling an unverified PID');
        }
        return store.requestCancel(runId);
    }
    function recover() {
        const recovered = [];
        for (const record of store.list()) {
            if (TERMINAL.has(record.status) || active.has(key(record.runId))) {
                continue;
            }
            if (isAlive(record.ownerPid) || (record.ownerPid === undefined && isAlive(record.pid))) {
                continue;
            }
            record.status = 'orphaned';
            record.statusReason = 'Controller no longer alive; child work may still exist. No automatic retry or PID signaling was performed.';
            record.finishedAt = now();
            record.events ||= [];
            record.events.push({ sequence: record.events.length + 1, at: now(), type: 'run_recovered' });
            recovered.push(store.save(record));
        }
        store.recoverDeveloperLease();
        return recovered;
    }
    function cleanup(runId) {
        const ids = runId ? [runId] : store.list()
            .filter(record => TERMINAL.has(record.status))
            .map(record => record.runId);
        for (const id of ids) {
            const record = store.get(id);
            const canceledBeforeClose = record?.ownerPid && record.status === 'canceled' && !record.finishedAt;
            const possibleOrphanChild = record?.status === 'orphaned' && isAlive(record.pid);
            if (active.has(key(id)) || canceledBeforeClose || possibleOrphanChild) {
                throw new Error('Cannot remove an active run before process completion');
            }
            store.remove(id);
        }
        return ids;
    }
    return { start, get: store.get, list: store.list, cancel, recover, cleanup };
}
