import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../../src/infrastructure/database/connection.js';
import { up as migrateV1 } from '../../../migrations/1781555473000000000-initial-schema.js';

describe('Database connection', () => {
  let dbPath;
  let db;

  afterEach(() => {
    if (db) db.close();
    if (dbPath) fs.rmSync(dbPath, { force: true });
  });

  it('close is idempotent', () => {
    db = new Database(':memory:');
    db.close();
    expect(() => db.close()).not.toThrow();
  });

  it('opens an in-memory database', () => {
    db = new Database(':memory:');
    expect(db).toBeDefined();
  });

  it('creates a file database and runs migrations', () => {
    dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
    db = new Database(dbPath);
    db.ensureInfrastructure(); migrateV1(db.connection);

    const tables = db.connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(r => r.name);

    expect(tables).toContain('_schema_version');
    expect(tables).toContain('requests');
    expect(tables).toContain('throttle_events');
    expect(tables).toContain('throttle_state');
  });

  it('migration is idempotent', () => {
    dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
    db = new Database(dbPath);
    db.ensureInfrastructure();
    migrateV1(db.connection);
    expect(() => migrateV1(db.connection)).not.toThrow();
  });

  it('inserts throttle_state singleton on migration', () => {
    db = new Database(':memory:');
    db.ensureInfrastructure(); migrateV1(db.connection);

    const row = db.connection
      .prepare('SELECT adaptive_limit, cooldown_until FROM throttle_state WHERE id = 1')
      .get();

    expect(row).toBeDefined();
    expect(row.adaptive_limit).toBe(25n);
    expect(row.cooldown_until).toBe(0n);
  });

  it('runs transactions', () => {
    db = new Database(':memory:');
    db.ensureInfrastructure(); migrateV1(db.connection);

    const result = db.transaction(() => {
      db.connection
        .prepare('INSERT INTO _schema_version (version, applied_at) VALUES (?, ?)')
        .run(99, Date.now());
      return db.connection
        .prepare('SELECT version FROM _schema_version WHERE version = 99')
        .get();
    });

    expect(result.version).toBe(99n);
  });

  it('rolls back transaction on error', () => {
    db = new Database(':memory:');
    db.ensureInfrastructure(); migrateV1(db.connection);
    const beforeCount = Number(
      db.connection.prepare('SELECT COUNT(*) as c FROM _schema_version').get().c
    );

    expect(() => {
      db.transaction(() => {
        db.connection
          .prepare('INSERT INTO _schema_version (version, applied_at) VALUES (?, ?)')
          .run(99, Date.now());
        throw new Error('rollback!');
      });
    }).toThrow('rollback!');

    const afterCount = Number(
      db.connection.prepare('SELECT COUNT(*) as c FROM _schema_version').get().c
    );
    expect(afterCount).toBe(beforeCount);
  });

  it('inserts batch of records in single statement', () => {
    db = new Database(':memory:');
    db.ensureInfrastructure(); migrateV1(db.connection);

    const columns = ['id', 'model', 'total_tokens', 'token_source', 'created_at', 'is_sse', 'prompt_tokens', 'completion_tokens'];
    const data = [
      [1n, 'model-a', 100n, 'estimated', Date.now(), 0n, 0n, 0n],
      [2n, 'model-b', 200n, 'nim', Date.now(), 1n, 0n, 0n],
    ];

    db.insertBatch('requests', columns, data);

    const count = db.connection
      .prepare('SELECT COUNT(*) as c FROM requests')
      .get().c;
    expect(count).toBe(2n);
  });

  it('rejects invalid table name in insertBatch', () => {
    db = new Database(':memory:');
    db.ensureInfrastructure(); migrateV1(db.connection);
    expect(() => {
      db.insertBatch('nonexistent', ['id'], [[1n]]);
    }).toThrow('Invalid table name: nonexistent');
  });

  it('sets WAL mode', () => {
    dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
    db = new Database(dbPath);
    db.ensureInfrastructure(); migrateV1(db.connection);

    const journal = db.connection.pragma('journal_mode');
    expect(journal[0].journal_mode).toBe('wal');
  });
});
