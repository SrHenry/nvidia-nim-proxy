import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const LOCK_TIMEOUT_MS = 30000;

export function findMigrations() {
  let entries;
  try {
    entries = fs.readdirSync(MIGRATIONS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => ({
      file: f,
      filepath: path.join(MIGRATIONS_DIR, f),
    }));
}

export async function loadMigration(filepath) {
  const mod = await import(filepath);
  return {
    version: mod.version,
    description: mod.description,
    up: mod.up,
    down: mod.down,
  };
}

export function acquireLock(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migration_lock (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      locked_at  INTEGER NOT NULL,
      hostname   TEXT NOT NULL DEFAULT '',
      pid        INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  const expiresAt = Date.now() + LOCK_TIMEOUT_MS;
  const result = db.prepare(`
    INSERT INTO _migration_lock (id, pid, hostname, locked_at, expires_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      pid = excluded.pid,
      hostname = excluded.hostname,
      locked_at = excluded.locked_at,
      expires_at = excluded.expires_at
    WHERE _migration_lock.expires_at < ?
  `).run(process.pid, os.hostname(), Date.now(), expiresAt, Date.now());
  return result.changes > 0;
}

export function releaseLock(db) {
  db.prepare('DELETE FROM _migration_lock WHERE id = 1').run();
}

export function getCurrentVersion(db) {
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) as v FROM _schema_version').get();
  return row.v; // BigInt
}

export function validateStepCount(raw) {
  if (raw === undefined || raw === null) return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || !Number.isFinite(n)) {
    throw new Error(`step count must be a positive integer, got "${raw}"`);
  }
  if (n < 0) {
    throw new Error(`step count must be a positive integer, got ${n}`);
  }
  return n;
}
