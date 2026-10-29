import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase, validRowId, prepareStorageFile } from './store/sqlite.mjs';

// Shared by the pi tool, MCP server, standalone controller and offline tests.
// Preserve the original per-stage SQLite schema and role-from-stage contract.
export const STAGE_TABLE = Object.freeze({
  approach: { db: 'approach.db', defaultRole: 'planner' },
  implementation: { db: 'implementation.db', defaultRole: 'developer' },
  feedback: { db: 'feedback.db', defaultRole: 'tester' },
  review: { db: 'review.db', defaultRole: 'lead' },
});
export const MIN_SUMMARY_CHARS = 40;

export function appendHistoryEvent(cwd, event) {
  try {
    const dir = path.join(cwd, 'data');
    const filename = prepareStorageFile(path.join(dir, 'history.jsonl'));
    fs.appendFileSync(filename, `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch { /* Best effort timeline; SQLite remains the source of truth. */ }
}

function stageInfo(stage) {
  return typeof stage === 'string' && Object.hasOwn(STAGE_TABLE, stage) ? STAGE_TABLE[stage] : null;
}

/**
 * @param {{cwd: string, stage: string, summary: string, data?: unknown, cycleId?: string, runId?: string}} params
 */
export function writeCycleRecord({ cwd, stage, summary, data, cycleId, runId = process.env.PI_HARNESS_RUN_ID }) {
  const info = stageInfo(stage);
  if (!info) return { ok: false, reason: `Unknown stage: "${String(stage)}". Valid stages: ${Object.keys(STAGE_TABLE).join(', ')}.` };
  if (typeof summary !== 'string') return { ok: false, reason: 'summary must be a string.' };
  const trimmedSummary = summary.trim();
  if (trimmedSummary.length < MIN_SUMMARY_CHARS) return { ok: false, reason: `Rejected: summary is only ${trimmedSummary.length} chars (minimum ${MIN_SUMMARY_CHARS}). Resend the full summary, do not shrink it to fit.` };
  if (cycleId != null && typeof cycleId !== 'string') return { ok: false, reason: 'cycleId must be a string when supplied.' };
  if (runId != null && (typeof runId !== 'string' || !/^run_[a-zA-Z0-9_-]{1,128}$/.test(runId))) return { ok: false, reason: 'Invalid runId.' };
  let payload;
  try {
    payload = JSON.stringify(data ?? {});
    if (payload === undefined) throw new Error('Not JSON serializable');
  } catch { return { ok: false, reason: 'data must be JSON serializable.' }; }
  const dbPath = path.join(cwd, 'data', info.db);
  const db = openDatabase(dbPath);
  const createdAt = new Date().toISOString();
  const trimmedCycleId = cycleId?.trim() || null;
  let rowId;
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec(`CREATE TABLE IF NOT EXISTS cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id TEXT, role TEXT NOT NULL,
      stage TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
    if (!db.prepare('PRAGMA table_info(cycles)').all().some(column => column.name === 'run_id')) db.exec('ALTER TABLE cycles ADD COLUMN run_id TEXT;');
    rowId = Number(db.prepare('INSERT INTO cycles (cycle_id, role, stage, summary, payload, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(trimmedCycleId, info.defaultRole, stage, trimmedSummary, payload, createdAt, runId ?? null).lastInsertRowid);
    db.exec('COMMIT;');
  } catch (error) { db.exec('ROLLBACK;'); throw error; } finally { db.close(); }
  const result = { ok: true, table: 'cycles', dbPath: path.relative(cwd, dbPath), rowId, stage, role: info.defaultRole, cycleId: trimmedCycleId, runId: runId ?? null, createdAt };
  appendHistoryEvent(cwd, { event: 'cycle_record', stage, role: info.defaultRole, rowId, cycleId: trimmedCycleId, summary: trimmedSummary });
  return result;
}

export function listCycleRecords(cwd, stage) {
  const info = stageInfo(stage);
  if (!info) throw new Error(`Unknown stage: ${String(stage)}`);
  const filename = path.join(cwd, 'data', info.db);
  if (!fs.existsSync(filename)) return [];
  const db = openDatabase(filename, { readOnly: true });
  try { return db.prepare('SELECT * FROM cycles ORDER BY id DESC').all().map(row => ({ ...row })); }
  finally { db.close(); }
}

export function readCycleRecord(cwd, stage, rowId) {
  if (!validRowId(rowId)) return null;
  const info = stageInfo(stage);
  if (!info) return null;
  const filename = path.join(cwd, 'data', info.db);
  if (!fs.existsSync(filename)) return null;
  const db = openDatabase(filename, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM cycles WHERE id = ?').get(rowId);
    return row ? { ...row } : null;
  } finally { db.close(); }
}

export function verifyCycleEvidence(cwd, stage, rowId, { runId, cycleId } = {}) {
  try {
    const row = readCycleRecord(cwd, stage, rowId);
    return !!row && row.stage === stage && row.role === STAGE_TABLE[stage].defaultRole
      && (runId === undefined || row.run_id === runId)
      && (cycleId === undefined || row.cycle_id === cycleId);
  } catch { return false; }
}
