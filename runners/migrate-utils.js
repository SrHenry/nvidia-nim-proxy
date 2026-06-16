import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const LOCK_TIMEOUT_MS = 30000;

export function findMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();
  return files.map(f => ({
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
  const result = db.prepare(`
    INSERT INTO _migration_lock (id, pid, host, locked_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      pid = excluded.pid,
      host = excluded.host,
      locked_at = excluded.locked_at
    WHERE _migration_lock.locked_at < ?
  `).run(process.pid, os.hostname(), Date.now(), Date.now() - LOCK_TIMEOUT_MS);
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
    console.error(`Error: step count must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  if (n < 0) {
    console.error(`Error: step count must be a positive integer, got ${n}`);
    process.exit(1);
  }
  if (n === 0) {
    console.warn('Warning: 0 steps requested — nothing to do');
    process.exit(0);
  }
  return n;
}
