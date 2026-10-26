import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const TERMINAL = new Set(['completed', 'incomplete', 'failed', 'canceled', 'orphaned']);
export const newRunId = () => `run_${randomUUID().replaceAll('-', '')}`;
export function assertRunId(id) {
    if (typeof id !== 'string' || !/^run_[a-z0-9]{8,64}$/.test(id)) {
        throw new Error('Invalid runId');
    }
    return id;
}
export function createRunStore(cwd) {
    const root = path.resolve(cwd);
    const dir = path.join(root, 'data', 'subagent-runs');
    function checkDirectories() {
        for (const p of [path.join(root, 'data'), dir]) {
            if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) {
                throw new Error('Run state directory must not be a symlink');
            }
        }
    }
    function ensure() {
        checkDirectories();
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // Do not follow redirected state directories. This is defense in depth,
        // not protection from code running as the same operating-system user.
        for (const p of [path.join(root, 'data'), dir]) {
            if (fs.lstatSync(p).isSymbolicLink()) {
                throw new Error('Run state directory must not be a symlink');
            }
        }
    }
    function file(id) { assertRunId(id); return path.join(dir, `${id}.json`); }
    function get(id) {
        checkDirectories();
        const p = file(id);
        if (!fs.existsSync(p)) {
            return null;
        }
        if (fs.lstatSync(p).isSymbolicLink()) {
            throw new Error('Run artifact must not be a symlink');
        }
        const record = JSON.parse(fs.readFileSync(p, 'utf8'));
        if ((record.schemaVersion !== undefined && record.schemaVersion !== 1) || record.runId !== id || !Array.isArray(record.results) || !['running', ...TERMINAL].includes(record.status) || typeof record.createdAt !== 'string') {
            throw new Error('Invalid run artifact');
        }
        // Never trust writable paths stored in an imported/legacy artifact.
        return {
            ...record, ...(fs.existsSync(`${p}.cancel`) ? { cancellationRequestedAt: record.cancellationRequestedAt || 'requested' } : {}), cwd: root, artifactPath: p
        };
    }
    function save(record) {
        ensure();
        const p = file(record.runId);
        if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) {
            throw new Error('Run artifact must not be a symlink');
        }
        const previous = get(record.runId);
        if (previous && TERMINAL.has(previous.status) && previous.status !== record.status) {
            return previous;
        }
        const next = {
            ...record, ...(previous?.cancellationRequestedAt ? { cancellationRequestedAt: previous.cancellationRequestedAt } : {}), cwd: root, artifactPath: p, updatedAt: new Date().toISOString()
        };
        const tmp = `${p}.${randomUUID()}.tmp`;
        let fd;
        try {
            fd = fs.openSync(tmp, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify(next, null, 2));
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(tmp, p);
        }
        finally {
            if (fd !== undefined) {
                fs.closeSync(fd);
            }
            fs.rmSync(tmp, { force: true });
        }
        return next;
    }
    function list() {
        if (!fs.existsSync(dir)) {
            return [];
        }
        ensure();
        return fs.readdirSync(dir).filter(n => /^run_[a-z0-9]{8,64}\.json$/.test(n)).flatMap(n => {
            try {
                return [get(n.slice(0, -5))];
            }
            catch (error) {
                throw new Error(`Unreadable run artifact ${n}: ${error.message}`);
            }
        }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    function remove(id) {
        const record = get(id);
        if (!record) {
            throw new Error(`Unknown runId: ${id}`);
        }
        if (!TERMINAL.has(record.status)) {
            throw new Error('Cannot remove an active run');
        }
        fs.unlinkSync(file(id));
        fs.rmSync(`${file(id)}.cancel`, { force: true });
    }
    function requestCancel(id) {
        const record = get(id);
        if (!record) {
            throw new Error(`Unknown runId: ${id}`);
        }
        if (TERMINAL.has(record.status)) {
            return record;
        }
        try {
            fs.writeFileSync(`${file(id)}.cancel`, 'cancel requested\n', { flag: 'wx', mode: 0o600 });
        }
        catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        }
        return get(id);
    }
    const leasePath = path.join(dir, 'developer.lock');
    function acquireDeveloperLease(runId) {
        ensure();
        assertRunId(runId);
        try {
            fs.writeFileSync(leasePath, JSON.stringify({ runId, ownerPid: process.pid }), { flag: 'wx', mode: 0o600 });
        }
        catch (error) {
            if (error.code === 'EEXIST') {
                throw new Error('Another Developer owns this workspace; inspect running work or recover an orphan before starting');
            }
            throw error;
        }
    }
    function releaseDeveloperLease(runId) {
        if (!fs.existsSync(leasePath)) {
            return;
        }
        if (fs.lstatSync(leasePath).isSymbolicLink()) {
            throw new Error('Developer lease must not be a symlink');
        }
        const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
        if (lease.runId === runId) {
            fs.unlinkSync(leasePath);
        }
    }
    function recoverDeveloperLease() {
        if (!fs.existsSync(leasePath)) {
            return;
        }
        if (fs.lstatSync(leasePath).isSymbolicLink()) {
            throw new Error('Developer lease must not be a symlink');
        }
        const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
        const record = get(lease.runId);
        // An orphan observation is not evidence that its child exited. Keep
        // mutation ownership until the possible surviving child disappears.
        if (record && (record.status === 'orphaned' || (record.status === 'canceled' && !record.finishedAt)) && Number.isSafeInteger(record.pid) && record.pid > 0) {
            try { process.kill(record.pid, 0); return; }
            catch (error) { if (error.code !== 'ESRCH') return; }
        }
        let ownerAlive = true;
        if (Number.isSafeInteger(lease.ownerPid) && lease.ownerPid > 0) {
            try { process.kill(lease.ownerPid, 0); }
            catch (error) { if (error.code === 'ESRCH') ownerAlive = false; }
        }
        // A crash between lease creation and the first snapshot is recoverable.
        // A canceled snapshot alone is not proof its child process has closed.
        if ((!record && !ownerAlive) || (record && TERMINAL.has(record.status) && (record.finishedAt || !ownerAlive))) {
            releaseDeveloperLease(lease.runId);
        }
    }
    return {
        get, save, list, remove, file, requestCancel, acquireDeveloperLease, releaseDeveloperLease, recoverDeveloperLease
    };
}
