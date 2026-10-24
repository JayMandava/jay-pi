import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, validRowId, prepareStorageFile, validateStoragePath } from './sqlite.mjs';
import { appendHistoryEvent } from '../cycle-store.mjs';

function withDigest(row) {
  if (!row) return null;
  const content = [row.id, row.cycle_id, row.role, row.stage, row.summary, row.payload, row.created_at];
  return { ...row, digest: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
}

export function getLatestApproach(cwd) {
  const filename = path.join(cwd, 'data', 'approach.db');
  if (!fs.existsSync(filename)) return null;
  const db = openDatabase(filename, { readOnly: true });
  try { return withDigest(db.prepare('SELECT * FROM cycles ORDER BY id DESC LIMIT 1').get()); }
  finally { db.close(); }
}

function ensureApprovals(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS approval_store.approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, approach_row_id INTEGER NOT NULL,
    approved_at TEXT NOT NULL, plan_digest TEXT, actor TEXT
  );`);
  const columns = db.prepare('PRAGMA approval_store.table_info(approvals)').all().map(row => row.name);
  if (!columns.includes('plan_digest')) db.exec('ALTER TABLE approval_store.approvals ADD COLUMN plan_digest TEXT;');
  if (!columns.includes('actor')) db.exec('ALTER TABLE approval_store.approvals ADD COLUMN actor TEXT;');
}

// Controller-only operation: confirmed is an explicit API contract, not proof
// of human identity. Local agents with filesystem/shell access can edit these
// files. Real isolation/identity must be supplied by the embedding application.
export function approveApproach(cwd, rowId, { confirmed, actor, expectedDigest } = {}) {
  if (confirmed !== true || typeof actor !== 'string' || !actor.trim()) throw new Error('Explicit controller confirmation and actor are required.');
  if (!validRowId(rowId) || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('A valid reviewed row ID and digest are required.');
  const filename = path.join(cwd, 'data', 'approach.db');
  if (!fs.existsSync(filename)) throw new Error('No plan exists to approve.');
  const db = openDatabase(filename);
  let result;
  try {
    const approvalPath = path.join(cwd, 'data', 'approvals.db');
    for (const suffix of ['-journal', '-wal', '-shm']) validateStoragePath(approvalPath + suffix);
    prepareStorageFile(approvalPath);
    db.prepare('ATTACH DATABASE ? AS approval_store').run(approvalPath);
    db.exec('BEGIN IMMEDIATE;');
    try {
      const row = withDigest(db.prepare('SELECT * FROM cycles ORDER BY id DESC LIMIT 1').get());
      if (!row || row.id !== rowId || row.digest !== expectedDigest) throw new Error('Plan changed or is not the latest reviewed plan. Review it again.');
      ensureApprovals(db);
      const prior = db.prepare('SELECT approved_at FROM approval_store.approvals WHERE approach_row_id = ? AND plan_digest = ? ORDER BY id DESC LIMIT 1').get(rowId, expectedDigest);
      const approvedAt = prior?.approved_at || new Date().toISOString();
      if (!prior) db.prepare('INSERT INTO approval_store.approvals (approach_row_id, approved_at, plan_digest, actor) VALUES (?, ?, ?, ?)').run(rowId, approvedAt, expectedDigest, actor.trim());
      db.exec('COMMIT;');
      result = { approachRowId: rowId, approvedAt, digest: expectedDigest };
    } catch (error) { db.exec('ROLLBACK;'); throw error; }
  } finally { db.close(); }
  appendHistoryEvent(cwd, { event: 'plan_approved', ...result, actor: actor.trim() });
  return result;
}

export function isApproachApproved(cwd, rowId) {
  if (!validRowId(rowId)) return false;
  const filename = path.join(cwd, 'data', 'approvals.db');
  if (!fs.existsSync(filename)) return false;
  let db;
  try {
    const row = getLatestApproach(cwd);
    if (!row || row.id !== rowId) return false;
    db = openDatabase(filename, { readOnly: true });
    // Legacy row-only approvals intentionally do not authorize revised code.
    return !!db.prepare('SELECT 1 FROM approvals WHERE approach_row_id = ? AND plan_digest = ? LIMIT 1').get(rowId, row.digest);
  } catch { return false; }
  finally { db?.close(); }
}
