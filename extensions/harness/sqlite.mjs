import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

function statIfPresent(filename) {
  try { return fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Refuse accidental redirection of project data. This is a preflight check,
// not protection against a hostile same-user process racing filesystem calls.
export function validateStoragePath(filename) {
  const directory = path.dirname(filename);
  const dirStat = statIfPresent(directory);
  if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) throw new Error('Storage directory must be an ordinary directory, not a symlink.');
  const fileStat = statIfPresent(filename);
  if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile())) throw new Error('Storage file must be an ordinary file, not a symlink.');
}

export function prepareStorageFile(filename) {
  validateStoragePath(filename);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  // Exclusive creation makes new files private without changing permissions
  // of existing ordinary user files. Recheck an EEXIST race before opening.
  try { fs.closeSync(fs.openSync(filename, 'wx', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  validateStoragePath(filename);
  return filename;
}

// Node 24+ is the supported runtime. No shell interpolation or global sqlite3
// installation is needed. Each operation owns and closes its connection.
export function openDatabase(filename, { readOnly = false } = {}) {
  validateStoragePath(filename);
  // SQLite may touch these alongside the main file. Never follow an existing
  // linked journal/WAL supplied in the project either.
  for (const suffix of ['-journal', '-wal', '-shm']) validateStoragePath(filename + suffix);
  if (!readOnly) prepareStorageFile(filename);
  const db = new DatabaseSync(filename, { readOnly });
  try { db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;'); }
  catch (error) { db.close(); throw error; }
  return db;
}

export function validRowId(value) {
  return Number.isSafeInteger(value) && value > 0;
}
