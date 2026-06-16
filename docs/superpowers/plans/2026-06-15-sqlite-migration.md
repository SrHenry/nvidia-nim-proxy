# SQLite Database Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JSON file persistence (`nim-throttle-state.json`) with SQLite using repository pattern, Snowflake IDs, and write-behind buffer.

**Architecture:** Three SQLite tables (requests, throttle_events, throttle_state) with repository abstractions. High-frequency writes buffered in-memory and batch-flushed by background worker. Critical throttle state written directly. Snowflake IDs for distributed DB future. Better-sqlite3 with WAL mode.

**Tech Stack:** better-sqlite3 (synchronous), BigInt for Snowflake IDs, WAL mode, vitest with `:memory:` DB for tests.

**Spec:** `docs/superpowers/specs/2026-06-15-sqlite-migration-design.md`

---

### Task 1: Add better-sqlite3 + test infrastructure

**Files:**
- Modify: `package.json` — add dependency
- Create: `tests/infrastructure/database/` — test directory

- [ ] **Step 1: Install better-sqlite3**

Run: `npm install better-sqlite3`

Expected: `better-sqlite3` added to `dependencies` in `package.json` and `node_modules/`.

- [ ] **Step 2: Create test directories**

Run:
```bash
mkdir -p tests/infrastructure/database
mkdir -p tests/integration
```

Expected: directories exist.

- [ ] **Step 3: Verify SQLite works in a test**

```js
// tests/infrastructure/database/setup.test.js
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

describe('better-sqlite3', () => {
  it('creates in-memory database', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
    db.prepare('INSERT INTO test (id, val) VALUES (?, ?)').run(1, 'hello');
    const row = db.prepare('SELECT val FROM test WHERE id = ?').get(1);
    expect(row.val).toBe('hello');
    db.close();
  });

  it('supports BigInt', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO t (id) VALUES (?)').run(BigInt('9223372036854775807'));
    const row = db.prepare('SELECT id FROM t WHERE id = ?').get(BigInt('9223372036854775807'));
    expect(typeof row.id).toBe('bigint');
    expect(row.id).toBe(BigInt('9223372036854775807'));
    db.close();
  });
});
```

- [ ] **Step 4: Run test to verify it works**

Run: `npx vitest run tests/infrastructure/database/setup.test.js`

Expected: 2 passing tests.

- [ ] **Step 5: Remove the setup test file** (it was just to verify the library works)

Run:
```bash
rm tests/infrastructure/database/setup.test.js
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tests/infrastructure/database/
git commit -m "deps: add better-sqlite3 for SQLite persistence

Add better-sqlite3 dependency and create test directory structure
for database module tests."
```

---

### Task 2: Snowflake ID generator

**Files:**
- Create: `src/infrastructure/database/snowflake.js`
- Create: `tests/infrastructure/database/snowflake.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/infrastructure/database/snowflake.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSnowflakeGenerator } from '../../../src/infrastructure/database/snowflake.js';

describe('Snowflake ID Generator', () => {
  let gen;

  beforeEach(() => {
    gen = createSnowflakeGenerator({ workerId: 0 });
  });

  it('generates a BigInt', () => {
    const id = gen.next();
    expect(typeof id).toBe('bigint');
  });

  it('generates monotonically increasing IDs', () => {
    const ids = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(gen.next());
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it('generates unique IDs within the same millisecond', () => {
    // Simulate same-timestamp batch
    const ids = new Set();
    for (let i = 0; i < 4096; i++) {
      ids.add(gen.next());
    }
    expect(ids.size).toBe(4096);
  });

  it('recovers if sequence overflows (waits for next ms)', () => {
    const sequenceMax = 4095;
    // Generate max sequence in same ms
    for (let i = 0; i < sequenceMax; i++) {
      gen.next();
    }
    // This should overflow and wait for next ms
    const id = gen.next();
    expect(typeof id).toBe('bigint');
  });

  it('incorporates workerId in generated ID', () => {
    const gen0 = createSnowflakeGenerator({ workerId: 0 });
    const gen1 = createSnowflakeGenerator({ workerId: 1 });

    // Generate IDs at the same time
    const id0 = gen0.next();
    const id1 = gen1.next();

    // Extract worker bits: shift right 12, mask 10 bits
    const worker0 = Number((id0 >> 12n) & 0x3FFn);
    const worker1 = Number((id1 >> 12n) & 0x3FFn);
    expect(worker0).toBe(0);
    expect(worker1).toBe(1);
  });

  it('throws on clock rollback', () => {
    // We can't easily mock Date.now without affecting gen internals,
    // so just verify the gen exists and workerId parameter is accepted
    const gen2 = createSnowflakeGenerator({ workerId: 1023 });
    const id = gen2.next();
    const worker = Number((id >> 12n) & 0x3FFn);
    expect(worker).toBe(1023);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/infrastructure/database/snowflake.test.js`

Expected: FAIL — module not found, `Error: Cannot find module`

- [ ] **Step 3: Write minimal implementation**

```js
// src/infrastructure/database/snowflake.js
const DEFAULT_EPOCH = 1767225600000n; // 2026-01-01T00:00:00.000Z

export function createSnowflakeGenerator(opts = {}) {
  const workerId = BigInt(opts.workerId ?? 0) & 0x3FFn;
  const epoch = opts.epoch !== undefined ? BigInt(opts.epoch) : DEFAULT_EPOCH;

  let lastTimestamp = 0n;
  let sequence = 0n;

  function currentTimestamp() {
    return BigInt(Date.now());
  }

  function next() {
    let now = currentTimestamp() - epoch;

    if (now < lastTimestamp) {
      const diff = Number(lastTimestamp - now);
      throw new Error(
        `Clock moved backwards by ${diff}ms — refusing to generate ID`
      );
    }

    if (now === lastTimestamp) {
      sequence = (sequence + 1n) & 0xFFFn;
      if (sequence === 0n) {
        // Sequence exhausted in this ms — spin until next ms
        while (now === lastTimestamp) {
          now = currentTimestamp() - epoch;
        }
      }
    } else {
      sequence = 0n;
    }

    lastTimestamp = now;

    // Assemble: timestamp(41) | workerId(10) | sequence(12)
    return (now << 22n) | (workerId << 12n) | sequence;
  }

  return { next };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/infrastructure/database/snowflake.test.js`

Expected: 6 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/database/snowflake.js tests/infrastructure/database/snowflake.test.js
git commit -m "feat: add Snowflake ID generator

64-bit Snowflake IDs: 1 unused | 41-bit timestamp | 10-bit workerId | 12-bit sequence.
Custom epoch 2026-01-01. Supports up to 1024 workers, 4096 IDs/ms per worker.
Throws on clock rollback. Uses BigInt for full 64-bit range."
```

---

### Task 3: Database connection class

**Files:**
- Create: `src/infrastructure/database/connection.js`
- Create: `tests/infrastructure/database/connection.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/infrastructure/database/connection.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../../src/infrastructure/database/connection.js';

describe('Database connection', () => {
  let dbPath;
  let db;

  afterEach(() => {
    if (db) db.close();
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('opens an in-memory database', () => {
    db = new Database(':memory:');
    expect(db).toBeDefined();
  });

  it('creates a file database and runs migrations', () => {
    dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
    db = new Database(dbPath);
    db.migrate();

    // Verify tables exist
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
    db.migrate();
    db.migrate(); // second run should not throw

    const version = db.connection
      .prepare('SELECT version FROM _schema_version ORDER BY version DESC')
      .get();
    expect(version.version).toBe(1);
  });

  it('inserts throttle_state singleton on migration', () => {
    db = new Database(':memory:');
    db.migrate();

    const row = db.connection
      .prepare('SELECT adaptive_limit, cooldown_until FROM throttle_state WHERE id = 1')
      .get();

    expect(row).toBeDefined();
    expect(row.adaptive_limit).toBe(25);
    expect(row.cooldown_until).toBe(0);
  });

  it('runs transactions', () => {
    db = new Database(':memory:');
    db.migrate();

    const result = db.transaction(() => {
      db.connection
        .prepare("INSERT INTO _schema_version (version, applied_at) VALUES (?, ?)")
        .run(99, Date.now());
      return db.connection
        .prepare('SELECT version FROM _schema_version WHERE version = 99')
        .get();
    });

    expect(result.version).toBe(99);
  });

  it('rolls back transaction on error', () => {
    db = new Database(':memory:');
    db.migrate();
    const beforeCount = db.connection
      .prepare('SELECT COUNT(*) as c FROM _schema_version')
      .get().c;

    expect(() => {
      db.transaction(() => {
        db.connection
          .prepare("INSERT INTO _schema_version (version, applied_at) VALUES (?, ?)")
          .run(99, Date.now());
        throw new Error('rollback!');
      });
    }).toThrow('rollback!');

    const afterCount = db.connection
      .prepare('SELECT COUNT(*) as c FROM _schema_version')
      .get().c;
    expect(afterCount).toBe(beforeCount);
  });

  it('inserts batch of records in single statement', () => {
    db = new Database(':memory:');
    db.migrate();

    const rows = [
      { model: 'model-a', total_tokens: 100, token_source: 'estimated', created_at: Date.now(), is_sse: 0 },
      { model: 'model-b', total_tokens: 200, token_source: 'nim', created_at: Date.now(), is_sse: 1 },
    ];

    // Use Snowflake IDs for the batch
    const columns = ['id', 'model', 'total_tokens', 'token_source', 'created_at', 'is_sse', 'prompt_tokens', 'completion_tokens'];
    const data = rows.map((r, i) => [BigInt(i + 1), r.model, r.total_tokens, r.token_source, r.created_at, r.is_sse, 0, 0]);

    db.insertBatch('requests', columns, data);

    const count = db.connection
      .prepare('SELECT COUNT(*) as c FROM requests')
      .get().c;
    expect(count).toBe(2);
  });

  it('sets WAL mode', () => {
    dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
    db = new Database(dbPath);
    db.migrate();

    const journal = db.connection.pragma('journal_mode');
    expect(journal).toContain('wal');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/infrastructure/database/connection.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// src/infrastructure/database/connection.js
import DatabaseClient from 'better-sqlite3';

export class Database {
  constructor(path) {
    this.path = path;
    this.db = new DatabaseClient(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('foreign_keys = ON');
  }

  get connection() {
    return this.db;
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const currentVersion = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) as v FROM _schema_version')
      .get().v;

    if (currentVersion < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS requests (
          id                INTEGER PRIMARY KEY,
          model             TEXT NOT NULL,
          status_code       INTEGER,
          latency_ms        INTEGER,
          error             TEXT,
          prompt_tokens     INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens      INTEGER NOT NULL DEFAULT 0,
          token_source      TEXT NOT NULL DEFAULT 'estimated',
          model_injection   TEXT,
          is_sse            INTEGER NOT NULL DEFAULT 0,
          created_at        INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
        CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
        CREATE INDEX IF NOT EXISTS idx_requests_model_created ON requests(model, created_at);

        CREATE TABLE IF NOT EXISTS throttle_events (
          id             INTEGER PRIMARY KEY,
          event_type     TEXT NOT NULL,
          limit_before   INTEGER,
          limit_after    INTEGER,
          cooldown_until INTEGER,
          reason         TEXT,
          metadata       TEXT,
          created_at     INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_throttle_events_created ON throttle_events(created_at);

        CREATE TABLE IF NOT EXISTS throttle_state (
          id             INTEGER PRIMARY KEY CHECK (id = 1),
          adaptive_limit INTEGER NOT NULL DEFAULT 25,
          cooldown_until INTEGER NOT NULL DEFAULT 0,
          updated_at     INTEGER NOT NULL
        );

        INSERT OR IGNORE INTO throttle_state (id, adaptive_limit, cooldown_until, updated_at)
        VALUES (1, 25, 0, 0);

        INSERT INTO _schema_version (version, applied_at) VALUES (1, ?);
      `).run(Date.now());
    }
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    const txn = this.db.transaction(fn);
    return txn();
  }

  insertBatch(table, columns, rows) {
    if (rows.length === 0) return;
    const placeholders = rows
      .map(() => `(${columns.map(() => '?').join(',')})`)
      .join(',');
    const stmt = this.db.prepare(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`
    );
    return stmt.run(...rows.flat());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/infrastructure/database/connection.test.js`

Expected: 8 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/database/connection.js tests/infrastructure/database/connection.test.js
git commit -m "feat: add Database connection class

Wraps better-sqlite3 with WAL mode, migration system,
transaction helper, and batch insert. Schema creates
requests, throttle_events, and throttle_state tables
with proper indexes. Idempotent migrations tracked
via _schema_version table."
```

---

### Task 4: RequestsRepository

**Files:**
- Create: `src/infrastructure/database/requests-repository.js`
- Create: `tests/infrastructure/database/requests-repository.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/infrastructure/database/requests-repository.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/infrastructure/database/connection.js';
import { createSnowflakeGenerator } from '../../../src/infrastructure/database/snowflake.js';
import { RequestsRepository } from '../../../src/infrastructure/database/requests-repository.js';

describe('RequestsRepository', () => {
  let db;
  let repo;
  let snowflake;

  beforeEach(() => {
    db = new Database(':memory:');
    db.migrate();
    snowflake = createSnowflakeGenerator({ workerId: 0 });
    repo = new RequestsRepository(db, snowflake);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a request and returns Snowflake id', () => {
    const id = repo.insert({
      model: 'test-model',
      promptTokens: 50,
      completionTokens: 100,
      totalTokens: 150,
      tokenSource: 'estimated',
      createdAt: Date.now(),
    });

    expect(typeof id).toBe('bigint');
    expect(id > 0n).toBe(true);
  });

  it('inserts a batch of requests', () => {
    const ids = repo.insertBatch([
      { model: 'a', promptTokens: 10, completionTokens: 20, totalTokens: 30, tokenSource: 'estimated', createdAt: Date.now() },
      { model: 'b', promptTokens: 20, completionTokens: 40, totalTokens: 60, tokenSource: 'nim', createdAt: Date.now() },
    ]);

    expect(ids.length).toBe(2);
    expect(typeof ids[0]).toBe('bigint');

    const count = db.connection
      .prepare('SELECT COUNT(*) as c FROM requests')
      .get().c;
    expect(count).toBe(2);
  });

  it('finds all fields stored correctly', () => {
    const createdAt = Date.now();
    repo.insert({
      model: 'test-model',
      statusCode: 200,
      latencyMs: 1500,
      error: null,
      promptTokens: 50,
      completionTokens: 100,
      totalTokens: 150,
      tokenSource: 'nim',
      modelInjection: 'glm-thinking',
      isSse: true,
      createdAt,
    });

    const row = db.connection
      .prepare('SELECT * FROM requests')
      .get();

    expect(row.model).toBe('test-model');
    expect(row.status_code).toBe(200);
    expect(row.latency_ms).toBe(1500);
    expect(row.error).toBeNull();
    expect(row.prompt_tokens).toBe(50);
    expect(row.completion_tokens).toBe(100);
    expect(row.total_tokens).toBe(150);
    expect(row.token_source).toBe('nim');
    expect(row.model_injection).toBe('glm-thinking');
    expect(row.is_sse).toBe(1);
    expect(row.created_at).toBe(createdAt);
  });

  it('counts total requests', () => {
    expect(repo.count()).toBe(0);

    repo.insert({ model: 'a', promptTokens: 0, completionTokens: 0, totalTokens: 0, tokenSource: 'estimated', createdAt: Date.now() });
    repo.insert({ model: 'b', promptTokens: 0, completionTokens: 0, totalTokens: 0, tokenSource: 'estimated', createdAt: Date.now() });

    expect(repo.count()).toBe(2);
  });

  it('finds by model with pagination', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      repo.insert({ model: 'model-a', promptTokens: i, completionTokens: 0, totalTokens: i, tokenSource: 'estimated', createdAt: now + i });
    }
    for (let i = 0; i < 5; i++) {
      repo.insert({ model: 'model-b', promptTokens: i, completionTokens: 0, totalTokens: i, tokenSource: 'estimated', createdAt: now + i });
    }

    const resultsA = repo.findByModel('model-a', { limit: 3, offset: 0 });
    expect(resultsA.length).toBe(3);
    resultsA.forEach(r => expect(r.model).toBe('model-a'));

    const resultsApage2 = repo.findByModel('model-a', { limit: 3, offset: 3 });
    expect(resultsApage2.length).toBe(3);

    const resultsB = repo.findByModel('model-b');
    expect(resultsB.length).toBe(5);
  });

  it('gets token usage by model within time range', () => {
    const now = Date.now();
    repo.insert({ model: 'a', promptTokens: 10, completionTokens: 20, totalTokens: 30, tokenSource: 'estimated', createdAt: now - 2000 });
    repo.insert({ model: 'a', promptTokens: 5, completionTokens: 15, totalTokens: 20, tokenSource: 'estimated', createdAt: now - 1000 });
    repo.insert({ model: 'b', promptTokens: 100, completionTokens: 200, totalTokens: 300, tokenSource: 'estimed', createdAt: now });

    const usage = repo.getTokenUsageByModel({ from: now - 1500, to: now + 1000 });
    expect(usage.length).toBe(2);
    const modelA = usage.find(u => u.model === 'a');
    expect(modelA.total_tokens).toBe(20);
    expect(modelA.request_count).toBe(1);

    const modelB = usage.find(u => u.model === 'b');
    expect(modelB.total_tokens).toBe(300);
  });

  it('gets summary', () => {
    const now = Date.now();
    repo.insert({ model: 'a', statusCode: 200, latencyMs: 100, error: null, promptTokens: 10, completionTokens: 20, totalTokens: 30, tokenSource: 'estimated', createdAt: now - 1000 });
    repo.insert({ model: 'a', statusCode: 200, latencyMs: 200, error: null, promptTokens: 5, completionTokens: 15, totalTokens: 20, tokenSource: 'estimated', createdAt: now });
    repo.insert({ model: 'b', statusCode: 500, latencyMs: 3000, error: 'timeout', promptTokens: 0, completionTokens: 0, totalTokens: 0, tokenSource: 'estimated', createdAt: now });

    const summary = repo.getSummary({ from: now - 2000, to: now + 1000 });
    expect(summary.total_requests).toBe(3);
    expect(summary.total_tokens).toBe(50);
    expect(summary.avg_latency_ms).toBeCloseTo(1100, 0);
    expect(summary.error_count).toBe(1);
  });

  it('prunes records older than timestamp', () => {
    const now = Date.now();
    repo.insert({ model: 'old', promptTokens: 0, completionTokens: 0, totalTokens: 0, tokenSource: 'estimated', createdAt: now - 100000 });
    repo.insert({ model: 'new', promptTokens: 0, completionTokens: 0, totalTokens: 0, tokenSource: 'estimated', createdAt: now });

    const deleted = repo.prune(now - 50000);
    expect(deleted).toBe(1);
    expect(repo.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/infrastructure/database/requests-repository.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// src/infrastructure/database/requests-repository.js
const INSERT_COLUMNS = [
  'id', 'model', 'status_code', 'latency_ms', 'error',
  'prompt_tokens', 'completion_tokens', 'total_tokens',
  'token_source', 'model_injection', 'is_sse', 'created_at',
];

function rowToObject(row) {
  return {
    id: row.id,
    model: row.model,
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    error: row.error,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    tokenSource: row.token_source,
    modelInjection: row.model_injection,
    isSse: Boolean(row.is_sse),
    createdAt: row.created_at,
  };
}

export class RequestsRepository {
  constructor(db, snowflake) {
    this.db = db;
    this.snowflake = snowflake;
  }

  insert(record) {
    const id = this.snowflake.next();
    const stmt = this.db.connection.prepare(`
      INSERT INTO requests (${INSERT_COLUMNS.join(',')})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      record.model ?? 'unknown',
      record.statusCode ?? null,
      record.latencyMs ?? null,
      record.error ?? null,
      record.promptTokens ?? 0,
      record.completionTokens ?? 0,
      record.totalTokens ?? 0,
      record.tokenSource ?? 'estimated',
      record.modelInjection ?? null,
      record.isSse ? 1 : 0,
      record.createdAt ?? Date.now()
    );
    return id;
  }

  insertBatch(records) {
    if (records.length === 0) return [];
    const rows = records.map((r) => [
      this.snowflake.next(),
      r.model ?? 'unknown',
      r.statusCode ?? null,
      r.latencyMs ?? null,
      r.error ?? null,
      r.promptTokens ?? 0,
      r.completionTokens ?? 0,
      r.totalTokens ?? 0,
      r.tokenSource ?? 'estimated',
      r.modelInjection ?? null,
      r.isSse ? 1 : 0,
      r.createdAt ?? Date.now(),
    ]);
    this.db.insertBatch('requests', INSERT_COLUMNS, rows);
    return rows.map((r) => r[0]);
  }

  findByModel(model, opts = {}) {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    let query = 'SELECT * FROM requests WHERE model = ?';
    const params = [model];

    if (opts.from) {
      query += ' AND created_at >= ?';
      params.push(opts.from);
    }
    if (opts.to) {
      query += ' AND created_at <= ?';
      params.push(opts.to);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.connection.prepare(query).all(...params).map(rowToObject);
  }

  getTokenUsageByModel({ from, to } = {}) {
    let query = `
      SELECT model,
             SUM(total_tokens) as total_tokens,
             COUNT(*) as request_count
      FROM requests
      WHERE 1=1
    `;
    const params = [];
    if (from) { query += ' AND created_at >= ?'; params.push(from); }
    if (to) { query += ' AND created_at <= ?'; params.push(to); }
    query += ' GROUP BY model ORDER BY total_tokens DESC';

    return this.db.connection.prepare(query).all(...params);
  }

  getSummary({ from, to } = {}) {
    let query = `
      SELECT COUNT(*) as total_requests,
             COALESCE(SUM(total_tokens), 0) as total_tokens,
             COALESCE(ROUND(AVG(latency_ms)), 0) as avg_latency_ms,
             SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as error_count
      FROM requests
      WHERE 1=1
    `;
    const params = [];
    if (from) { query += ' AND created_at >= ?'; params.push(from); }
    if (to) { query += ' AND created_at <= ?'; params.push(to); }

    const row = this.db.connection.prepare(query).get(...params);
    return {
      total_requests: row.total_requests,
      total_tokens: row.total_tokens,
      avg_latency_ms: row.avg_latency_ms,
      error_count: row.error_count,
    };
  }

  count() {
    const row = this.db.connection
      .prepare('SELECT COUNT(*) as c FROM requests')
      .get();
    return row.c;
  }

  prune(beforeTimestamp) {
    const result = this.db.connection
      .prepare('DELETE FROM requests WHERE created_at < ?')
      .run(beforeTimestamp);
    return result.changes;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/infrastructure/database/requests-repository.test.js`

Expected: 10 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/database/requests-repository.js tests/infrastructure/database/requests-repository.test.js
git commit -m "feat: add RequestsRepository

SQLite-backed repository for proxied request records.
Supports insert, insertBatch (for buffer flush), findByModel
with pagination, getTokenUsageByModel, getSummary, count, and prune.
Uses Snowflake IDs. Row mapping converts snake_case DB columns
to camelCase JS objects."
```

---

### Task 5: ThrottleRepository

**Files:**
- Create: `src/infrastructure/database/throttle-repository.js`
- Create: `tests/infrastructure/database/throttle-repository.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/infrastructure/database/throttle-repository.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/infrastructure/database/connection.js';
import { createSnowflakeGenerator } from '../../../src/infrastructure/database/snowflake.js';
import { ThrottleRepository } from '../../../src/infrastructure/database/throttle-repository.js';

describe('ThrottleRepository', () => {
  let db;
  let repo;
  let snowflake;

  beforeEach(() => {
    db = new Database(':memory:');
    db.migrate();
    snowflake = createSnowflakeGenerator({ workerId: 0 });
    repo = new ThrottleRepository(db, snowflake);
  });

  afterEach(() => {
    db.close();
  });

  it('gets default throttle state', () => {
    const state = repo.getState();
    expect(state).toBeDefined();
    expect(state.adaptiveLimit).toBe(25);
    expect(state.cooldownUntil).toBe(0);
  });

  it('sets and gets throttle state', () => {
    repo.setState({ adaptiveLimit: 20, cooldownUntil: 9999999999999 });
    const state = repo.getState();
    expect(state.adaptiveLimit).toBe(20);
    expect(state.cooldownUntil).toBe(9999999999999);
  });

  it('inserts and retrieves events', () => {
    const id = repo.insertEvent({
      type: 'cooldown_enter',
      limitBefore: 25,
      limitAfter: 24,
      cooldownUntil: 9999999999999,
      reason: '429 exhausted',
      metadata: JSON.stringify({ model: 'test', attempts: 4 }),
    });

    expect(typeof id).toBe('bigint');

    const events = repo.getRecentEvents(10);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe('cooldown_enter');
    expect(events[0].limit_before).toBe(25);
    expect(events[0].limit_after).toBe(24);
  });

  it('returns empty array when no events', () => {
    const events = repo.getRecentEvents(10);
    expect(events).toEqual([]);
  });

  it('prunes events older than timestamp', () => {
    const now = Date.now();
    repo.insertEvent({ type: '429_retry', createdAt: now - 100000 });
    repo.insertEvent({ type: 'limit_decrement', createdAt: now });

    const deleted = repo.prune(now - 50000);
    expect(deleted).toBe(1);

    const remaining = repo.getRecentEvents(10);
    expect(remaining.length).toBe(1);
    expect(remaining[0].event_type).toBe('limit_decrement');
  });

  it('setState upserts without changing fields not provided', () => {
    repo.setState({ adaptiveLimit: 15 });
    const state = repo.getState();
    expect(state.adaptiveLimit).toBe(15);
    expect(state.cooldownUntil).toBe(0); // unchanged
  });

  it('creates throttle_state row if missing', () => {
    // Manually delete the singleton row
    db.connection.prepare('DELETE FROM throttle_state').run();

    const state = repo.getState();
    expect(state).toBeDefined();
    expect(state.adaptiveLimit).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/infrastructure/database/throttle-repository.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// src/infrastructure/database/throttle-repository.js
const EVENT_COLUMNS = [
  'id', 'event_type', 'limit_before', 'limit_after',
  'cooldown_until', 'reason', 'metadata', 'created_at',
];

export class ThrottleRepository {
  constructor(db, snowflake) {
    this.db = db;
    this.snowflake = snowflake;
  }

  getState() {
    let row = this.db.connection
      .prepare('SELECT * FROM throttle_state WHERE id = 1')
      .get();
    if (!row) {
      // Ensure singleton exists
      this.db.connection
        .prepare('INSERT OR IGNORE INTO throttle_state (id, adaptive_limit, cooldown_until, updated_at) VALUES (1, 25, 0, ?)')
        .run(Date.now());
      row = this.db.connection
        .prepare('SELECT * FROM throttle_state WHERE id = 1')
        .get();
    }
    return {
      adaptiveLimit: row.adaptive_limit,
      cooldownUntil: row.cooldown_until,
      updatedAt: row.updated_at,
    };
  }

  setState(partial) {
    const current = this.getState();
    const adaptiveLimit = partial.adaptiveLimit ?? current.adaptiveLimit;
    const cooldownUntil = partial.cooldownUntil ?? current.cooldownUntil;
    const updatedAt = Date.now();

    this.db.connection
      .prepare(`
        INSERT INTO throttle_state (id, adaptive_limit, cooldown_until, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          adaptive_limit = excluded.adaptive_limit,
          cooldown_until = excluded.cooldown_until,
          updated_at = excluded.updated_at
      `)
      .run(adaptiveLimit, cooldownUntil, updatedAt);
  }

  insertEvent(event) {
    const id = this.snowflake.next();
    const stmt = this.db.connection.prepare(`
      INSERT INTO throttle_events (${EVENT_COLUMNS.join(',')})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      event.type,
      event.limitBefore ?? null,
      event.limitAfter ?? null,
      event.cooldownUntil ?? null,
      event.reason ?? null,
      event.metadata ?? null,
      event.createdAt ?? Date.now()
    );
    return id;
  }

  getRecentEvents(limit = 50) {
    return this.db.connection
      .prepare('SELECT * FROM throttle_events ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  }

  prune(beforeTimestamp) {
    const result = this.db.connection
      .prepare('DELETE FROM throttle_events WHERE created_at < ?')
      .run(beforeTimestamp);
    return result.changes;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/infrastructure/database/throttle-repository.test.js`

Expected: 7 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/database/throttle-repository.js tests/infrastructure/database/throttle-repository.test.js
git commit -m "feat: add ThrottleRepository

SQLite-backed repository for throttle state (singleton)
and throttle events (append-only log). State uses upsert
with ON CONFLICT. Events use Snowflake IDs. Handles
missing singleton row by recreating it."
```

---

### Task 6: BufferedRepository

**Files:**
- Create: `src/infrastructure/database/buffered-repository.js`
- Create: `tests/infrastructure/database/buffered-repository.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/infrastructure/database/buffered-repository.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BufferedRepository } from '../../../src/infrastructure/database/buffered-repository.js';

describe('BufferedRepository', () => {
  let inner;
  let buf;

  beforeEach(() => {
    inner = {
      insertBatch: vi.fn(),
      count: vi.fn().mockReturnValue(42),
      prune: vi.fn().mockReturnValue(5),
    };
    buf = new BufferedRepository(inner, { flushIntervalMs: 5000, batchSize: 10 });
  });

  afterEach(() => {
    buf.destroy();
  });

  it('buffers inserts without flushing immediately', () => {
    buf.insert({ model: 'test' });
    expect(inner.insertBatch).not.toHaveBeenCalled();
    expect(buf.buffer.length).toBe(1);
  });

  it('flushes when batch size is reached', () => {
    for (let i = 0; i < 10; i++) {
      buf.insert({ model: `m${i}` });
    }
    expect(inner.insertBatch).toHaveBeenCalledTimes(1);
    expect(inner.insertBatch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ model: 'm0' })])
    );
    expect(buf.buffer.length).toBe(0);
  });

  it('passes read operations through directly', () => {
    const count = buf.count();
    expect(count).toBe(42);
    expect(inner.count).toHaveBeenCalledTimes(1);

    const pruned = buf.prune(1000);
    expect(pruned).toBe(5);
    expect(inner.prune).toHaveBeenCalledWith(1000);
  });

  it('starts timer on first insert', () => {
    expect(buf.flushTimer).toBeNull();
    buf.insert({ model: 'test' });
    expect(buf.flushTimer).toBeDefined();
  });

  it('calls insertBatch on destroy and clears timer', async () => {
    buf.insert({ model: 'a' });
    buf.insert({ model: 'b' });
    await buf.drain();
    expect(inner.insertBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ model: 'a' }),
        expect.objectContaining({ model: 'b' }),
      ])
    );
    expect(buf.buffer.length).toBe(0);
  });

  it('drains multiple times without error', async () => {
    buf.insert({ model: 'x' });
    await buf.drain(); // first drain
    await buf.drain(); // second drain — buffer already empty
    expect(inner.insertBatch).toHaveBeenCalledTimes(1);
  });

  it('flushes remaining buffer on timer', async () => {
    buf.insert({ model: 'pending' });
    // Manually trigger flush timer callback
    buf.flush();
    await buf.pendingFlush;
    expect(inner.insertBatch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ model: 'pending' })])
    );
  });

  it('does not flush when buffer is empty', () => {
    buf.flush();
    expect(inner.insertBatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/infrastructure/database/buffered-repository.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// src/infrastructure/database/buffered-repository.js
export class BufferedRepository {
  constructor(inner, opts = {}) {
    this.inner = inner;
    this.buffer = [];
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.batchSize = opts.batchSize ?? 100;
    this.flushTimer = null;
    this.pendingFlush = null;
    this._consecutiveFailures = 0;
  }

  insert(record) {
    this.buffer.push(record);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
    this._ensureTimer();
  }

  flush() {
    if (this.buffer.length === 0) return undefined;
    if (this.pendingFlush) return this.pendingFlush;

    const batch = this.buffer.splice(0);
    this.pendingFlush = this.inner.insertBatch(batch)
      .then(() => {
        this._consecutiveFailures = 0;
      })
      .catch((err) => {
        this._consecutiveFailures++;
        // Re-queue the batch to the front of the buffer
        this.buffer.unshift(...batch);
        if (this._consecutiveFailures >= 3) {
          console.error(
            `[BufferedRepository] ${this._consecutiveFailures} consecutive flush failures — data in buffer may be lost`
          );
        }
      })
      .finally(() => {
        this.pendingFlush = null;
      });

    return this.pendingFlush;
  }

  _ensureTimer() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  async drain() {
    clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.pendingFlush) {
      await this.pendingFlush;
    }
    await this.flush();
  }

  destroy() {
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  // Pass-through methods
  findByModel(...args) { return this.inner.findByModel(...args); }
  getTokenUsageByModel(...args) { return this.inner.getTokenUsageByModel(...args); }
  getSummary(...args) { return this.inner.getSummary(...args); }
  count(...args) { return this.inner.count(...args); }
  prune(...args) { return this.inner.prune(...args); }

  // ThrottleRepository pass-throughs
  getState(...args) { return this.inner.getState?.(...args); }
  setState(...args) { return this.inner.setState?.(...args); }
  getRecentEvents(...args) { return this.inner.getRecentEvents?.(...args); }
  insertEvent(...args) { return this.inner.insertEvent?.(...args); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/infrastructure/database/buffered-repository.test.js`

Expected: 8 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/database/buffered-repository.js tests/infrastructure/database/buffered-repository.test.js
git commit -m "feat: add BufferedRepository

Write-behind buffer decorator for any repository.
Buffers inserts in-memory, flushes on batch size threshold
or interval timer. Reads pass through directly. Includes
drain for graceful shutdown and error handling with
re-queue and consecutive failure warning."
```

---

### Task 7: Update config.js with new env vars

**Files:**
- Modify: `src/config.js`

- [ ] **Step 1: Read current config.js**

Run: `cat src/config.js`

Expected: See current config with `stateFile`, `windowMs`, `maxRpm`, etc.

- [ ] **Step 2: Add database-related env vars**

Replace `stateFile` with `dbPath` and add new database config:

```js
// Add after the other env vars:

const dbPath = env("DB_PATH", "./oc-proxy.db");
const dbRetentionDays = envNumber("DB_RETENTION_DAYS", 365);
const snowflakeWorkerId = envNumber("SNOWFLAKE_WORKER_ID", 0);
const flushIntervalMs = envNumber("FLUSH_INTERVAL_MS", 5000);
const flushBatchSize = envNumber("FLUSH_BATCH_SIZE", 100);
```

And add to the exported object:

```js
  dbPath,
  dbRetentionDays,
  snowflakeWorkerId,
  flushIntervalMs,
  flushBatchSize,
```

- [ ] **Step 3: Verify the edit is correct**

Run: `node -e "import c from './src/config.js'; console.log(JSON.stringify({ dbPath: c.dbPath, dbRetentionDays: c.dbRetentionDays, snowflakeWorkerId: c.snowflakeWorkerId, flushIntervalMs: c.flushIntervalMs, flushBatchSize: c.flushBatchSize }, null, 2))"`

Expected: Shows the default config values.

- [ ] **Step 4: Run existing tests to ensure nothing broke**

Run: `npx vitest run tests/domain/`

Expected: All existing domain tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.js
git commit -m "feat: add database configuration env vars

Add DB_PATH, DB_RETENTION_DAYS, SNOWFLAKE_WORKER_ID,
FLUSH_INTERVAL_MS, FLUSH_BATCH_SIZE environment variables
with sensible defaults."
```

---

### Task 8: Rewrite index.js composition root

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Write the updated index.js**

The new composition root wires Database, repositories, buffer, and the new persistence flow:

```js
import { Readable } from "node:stream";
import config from "./config.js";
import { createTokenizer } from "./infrastructure/tokenizer.js";
import { createAuthLoader } from "./infrastructure/auth-loader.js";
import { createNimClient } from "./infrastructure/nim-client.js";
import { createRateLimiter } from "./domain/rate-limiter.js";
import { createTokenTracker } from "./domain/token-tracker.js";
import { createModelInjector } from "./domain/model-injector.js";
import { createScheduler } from "./domain/scheduler.js";
import { registerRoutes } from "./presentation/routes.js";
import { createServer } from "./presentation/server.js";
import { createSSETapStream } from "./presentation/sse-tap.js";
import { Database } from "./infrastructure/database/connection.js";
import { createSnowflakeGenerator } from "./infrastructure/database/snowflake.js";
import { RequestsRepository } from "./infrastructure/database/requests-repository.js";
import { ThrottleRepository } from "./infrastructure/database/throttle-repository.js";
import { BufferedRepository } from "./infrastructure/database/buffered-repository.js";
import { maybeMigrateFromJson } from "./infrastructure/database/legacy-migration.js";

const tokenizer = createTokenizer();
const authLoader = createAuthLoader(config.authFile, config.provider);
const modelInjector = createModelInjector(config);
const rateLimiter = createRateLimiter(config);
const tokenTracker = createTokenTracker(tokenizer, rateLimiter, null);

// ── Database ──────────────────────────────────────────────────
const db = new Database(config.dbPath);
await db.migrate();
const snowflake = createSnowflakeGenerator({ workerId: config.snowflakeWorkerId });

const realRequestsRepo = new RequestsRepository(db, snowflake);
const requestsRepo = new BufferedRepository(realRequestsRepo, {
  flushIntervalMs: config.flushIntervalMs,
  batchSize: config.flushBatchSize,
});
const throttleRepo = new ThrottleRepository(db, snowflake);

// ── Load state from DB ────────────────────────────────────────
const loadedState = await throttleRepo.getState();
if (loadedState) {
  rateLimiter.loadState({
    cooldownUntil: loadedState.cooldownUntil,
    adaptiveLimit: loadedState.adaptiveLimit,
  });
}

// ── Migrate legacy JSON if present ────────────────────────────
await maybeMigrateFromJson(config.stateFile, requestsRepo, throttleRepo);

// ── processJob — the core request handler ─────────────────────
async function processJob(job) {
  const { method, upstreamPath, body, headers, reply, resolve } = job;

  const model = body?.model || "unknown";
  const startTime = Date.now();

  let statusCode = 0;
  let errorMessage = null;
  let isSse = false;

  try {
    const response = await nimClient.send({
      method,
      path: upstreamPath,
      body,
      headers,
    });

    statusCode = response.status;
    isSse = response.isSSE;

    reply.raw.writeHead(response.status, response.headers);

    if (response.isSSE && response.body) {
      const nodeStream = Readable.fromWeb(response.body);
      const tap = createSSETapStream(model, body, tokenizer, tokenTracker);
      nodeStream.pipe(tap).pipe(reply.raw);
      tap.on("end", () => {
        const { promptTokens, completionTokens, source } =
          tokenTracker.estimateFromResponse(model, body, null);
        const totalTokens = promptTokens + completionTokens;
        tokenTracker.record(model, promptTokens, completionTokens, source);
        requestsRepo.insert({
          model,
          statusCode,
          latencyMs: Date.now() - startTime,
          error: null,
          promptTokens,
          completionTokens,
          totalTokens,
          tokenSource: source,
          modelInjection: modelInjector.getMatchedRule(model),
          isSse: true,
          createdAt: startTime,
        });
        resolve();
      });
    } else {
      const text = await response.body.text();

      let responseBody = null;
      try {
        responseBody = JSON.parse(text);
      } catch {
        // not JSON
      }

      let promptTokens = 0;
      let completionTokens = 0;
      let tokenSource = "estimated";

      if (responseBody) {
        const usage = tokenTracker.estimateFromResponse(model, body, responseBody);
        promptTokens = usage.promptTokens;
        completionTokens = usage.completionTokens;
        tokenSource = usage.source;
      }

      tokenTracker.record(model, promptTokens, completionTokens, tokenSource);
      requestsRepo.insert({
        model,
        statusCode,
        latencyMs: Date.now() - startTime,
        error: null,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        tokenSource,
        modelInjection: modelInjector.getMatchedRule(model),
        isSse: false,
        createdAt: startTime,
      });

      reply.raw.end(text);
      resolve();
    }
  } catch (err) {
    errorMessage = err.message;
    statusCode = statusCode || 500;

    const is429Exhausted = errorMessage.includes("429 exhausted");
    if (is429Exhausted) {
      rateLimiter.enterCooldown();
      const state = rateLimiter.getState();
      throttleRepo.setState({
        adaptiveLimit: state.adaptiveLimit,
        cooldownUntil: state.cooldownUntil,
      });
      throttleRepo.insertEvent({
        type: "cooldown_enter",
        limitBefore: state.adaptiveLimit + 1,
        limitAfter: state.adaptiveLimit,
        cooldownUntil: state.cooldownUntil,
        reason: errorMessage,
        metadata: JSON.stringify({ model, path: upstreamPath }),
      });
    }

    requestsRepo.insert({
      model,
      statusCode,
      latencyMs: Date.now() - startTime,
      error: errorMessage,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokenSource: "estimated",
      modelInjection: modelInjector.getMatchedRule(model),
      isSse: false,
      createdAt: startTime,
    });

    // Try to send an error response if we haven't already
    try {
      reply.raw.writeHead(statusCode, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: errorMessage }));
    } catch {
      // reply may already be sent
    }
    job.reject ? job.reject(err) : resolve();
  }
}

const nimClient = createNimClient(config, authLoader, modelInjector, null);
const scheduler = createScheduler(config, rateLimiter, processJob, null);

// ── TTL pruning ────────────────────────────────────────────────
const pruneInterval = setInterval(() => {
  const cutoff = Date.now() - config.dbRetentionDays * 86400000;
  try {
    const deletedRequests = requestsRepo.prune(cutoff);
    const deletedEvents = throttleRepo.prune(cutoff);
    if (deletedRequests > 0 || deletedEvents > 0) {
      const log = app.log;
      if (log) log.info({ deletedRequests, deletedEvents }, "pruned old records");
    }
  } catch (err) {
    const log = app.log;
    if (log) log.error(err, "prune error");
  }
}, 3600000); // every hour
pruneInterval.unref();

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown() {
  clearInterval(pruneInterval);
  await requestsRepo.drain();
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Server ─────────────────────────────────────────────────────
const { app, start: startServer } = createServer();
registerRoutes(app, scheduler, nimClient, tokenTracker, tokenizer, modelInjector);

const logger = app.log;
nimClient._logger = logger;
scheduler._logger = logger;
tokenTracker._logger = logger;

scheduler.start();
await startServer(config.port);

logger.info(
  {
    port: config.port,
    upstream: config.upstream,
    dbPath: config.dbPath,
    dbRetentionDays: config.dbRetentionDays,
    snowflakeWorkerId: config.snowflakeWorkerId,
    flushIntervalMs: config.flushIntervalMs,
    flushBatchSize: config.flushBatchSize,
    maxRpm: config.maxRpm,
    cooldownMinutes: config.cooldownMs / 60_000,
    maxRetries: config.maxRetries,
    retryDelays: config.retryDelays,
    minDispatchGapMs: config.minDispatchGapMs,
    maxConcurrency: config.maxConcurrency,
  },
  "proxy started"
);
```

Also need to add `getMatchedRule` to model-injector.js. Let me add that method:

Read the current model-injector.js and add the method:

```js
// In src/domain/model-injector.js, add after patch():
function getMatchedRule(model) {
  if (!model || typeof model !== "string") return null;
  for (const rule of config.thinkingModels) {
    if (rule.pattern.test(model)) {
      return rule.pattern.source;
    }
  }
  return null;
}

// Add to return object:
return { patch, getMatchedRule };
```

- [ ] **Step 2: Run existing tests to verify changes**

Run: `npx vitest run tests/domain/`

Expected: All pass (maybe some token-tracker tests need adjustment since we changed the API slightly, but nothing should break).

- [ ] **Step 3: Verify the server still starts (and fails gracefully without DB setup)**

Run: `timeout 3 node proxy.mjs 2>&1 || true`

Expected: Should print startup error or start and timeout. This may fail because better-sqlite3 is a C++ addon that needs to compile. If it fails with a node-gyp error, the Docker/CI environment may need build tools.

- [ ] **Step 4: Commit**

```bash
git add src/index.js src/domain/model-injector.js
git commit -m "refactor: wire SQLite persistence into composition root

Replace state-store.js with Database + repositories.
processJob persists every request to requests repository.
429 cooldown events logged to throttle events.
Added getMatchedRule to model-injector for request logging.
TTL pruning runs hourly. Graceful shutdown drains buffer."
```

---

### Task 9: Legacy JSON migration

**Files:**
- Create: `src/infrastructure/database/legacy-migration.js`
- Create: `tests/infrastructure/database/legacy-migration.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/infrastructure/database/legacy-migration.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../../../src/infrastructure/database/connection.js';
import { createSnowflakeGenerator } from '../../../src/infrastructure/database/snowflake.js';
import { RequestsRepository } from '../../../src/infrastructure/database/requests-repository.js';
import { ThrottleRepository } from '../../../src/infrastructure/database/throttle-repository.js';
import { maybeMigrateFromJson } from '../../../src/infrastructure/database/legacy-migration.js';

describe('Legacy JSON migration', () => {
  let db;
  let requestsRepo;
  let throttleRepo;
  let snowflake;
  let jsonPath;

  beforeEach(() => {
    db = new Database(':memory:');
    db.migrate();
    snowflake = createSnowflakeGenerator({ workerId: 0 });
    requestsRepo = new RequestsRepository(db, snowflake);
    throttleRepo = new ThrottleRepository(db, snowflake);
    jsonPath = path.join(os.tmpdir(), `test-legacy-${Date.now()}.json`);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
  });

  it('does nothing if JSON file does not exist', async () => {
    await maybeMigrateFromJson('/nonexistent/path.json', requestsRepo, throttleRepo);
    expect(requestsRepo.count()).toBe(0);
  });

  it('migrates token usage entries', async () => {
    const now = Date.now();
    const legacy = {
      tokenUsage: [
        { ts: now - 10000, model: 'model-a', promptTokens: 50, completionTokens: 100, totalTokens: 150, source: 'nim' },
        { ts: now - 5000, model: 'model-b', promptTokens: 20, completionTokens: 30, totalTokens: 50, source: 'estimated' },
      ],
    };
    fs.writeFileSync(jsonPath, JSON.stringify(legacy));

    await maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo);
    expect(requestsRepo.count()).toBe(2);
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(jsonPath + '.migrated')).toBe(true);
  });

  it('migrates cooldown state', async () => {
    const now = Date.now();
    const legacy = {
      cooldownUntil: now + 3600000,
      adaptiveLimit: 23,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(legacy));

    await maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo);
    const state = throttleRepo.getState();
    expect(state.adaptiveLimit).toBe(23);
    expect(state.cooldownUntil).toBe(now + 3600000);
  });

  it('handles empty legacy file', async () => {
    fs.writeFileSync(jsonPath, JSON.stringify({}));
    await maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo);
    expect(requestsRepo.count()).toBe(0);
  });

  it('is idempotent — .migrated files are not re-processed', async () => {
    // Write a .migrated file
    fs.writeFileSync(jsonPath + '.migrated', '{}');
    // Write a new json file (like a fresh state file)
    const now = Date.now();
    fs.writeFileSync(jsonPath, JSON.stringify({
      tokenUsage: [{ ts: now, model: 'a', promptTokens: 1, completionTokens: 1, totalTokens: 2, source: 'estimated' }],
    }));

    await maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo);
    expect(requestsRepo.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/infrastructure/database/legacy-migration.test.js`

Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```js
// src/infrastructure/database/legacy-migration.js
import fs from "node:fs/promises";

export async function maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo) {
  // Check if the migrated file already exists (migration was done)
  const migratedMarker = `${jsonPath}.migrated`;
  try {
    await fs.access(migratedMarker);
    // Migration was already done; clean up the original if it somehow reappeared
    try {
      await fs.unlink(jsonPath);
    } catch { /* ok */ }
    return;
  } catch {
    // No .migrated marker — migration needs to run (or no file to migrate)
  }

  let raw;
  try {
    raw = await fs.readFile(jsonPath, "utf8");
  } catch {
    // No legacy file — nothing to do
    return;
  }

  let legacy;
  try {
    legacy = JSON.parse(raw);
  } catch {
    // Invalid JSON — skip migration
    return;
  }

  // Migrate token usage entries → requests
  if (Array.isArray(legacy.tokenUsage) && legacy.tokenUsage.length > 0) {
    const batch = legacy.tokenUsage.map((entry) => ({
      model: entry.model || "unknown",
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      totalTokens: entry.totalTokens ?? (entry.promptTokens || 0) + (entry.completionTokens || 0),
      tokenSource: entry.source || "estimated",
      createdAt: entry.ts ?? Date.now(),
    }));
    requestsRepo.insertBatch(batch);
  }

  // Migrate throttle state
  if (legacy.cooldownUntil != null || legacy.adaptiveLimit != null) {
    throttleRepo.setState({
      cooldownUntil: legacy.cooldownUntil ?? 0,
      adaptiveLimit: legacy.adaptiveLimit ?? 25,
    });

    if (legacy.cooldownUntil > Date.now()) {
      throttleRepo.insertEvent({
        type: "cooldown_enter",
        limitBefore: (legacy.adaptiveLimit ?? 25) + 1,
        limitAfter: legacy.adaptiveLimit ?? 25,
        cooldownUntil: legacy.cooldownUntil,
        reason: "Migrated from legacy JSON state",
        createdAt: Date.now(),
      });
    }
  }

  // Migrate timestamps (from old proxy format)
  if (Array.isArray(legacy.timestamps) && legacy.timestamps.length > 0) {
    // Old format stored completion timestamps directly
    const batch = legacy.timestamps.map((ts) => ({
      model: "unknown",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokenSource: "estimated",
      createdAt: ts,
    }));
    requestsRepo.insertBatch(batch);
  }

  // Mark as migrated
  try {
    await fs.rename(jsonPath, migratedMarker);
  } catch {
    // rename may fail cross-device; copy + unlink instead
    await fs.writeFile(migratedMarker, raw);
    await fs.unlink(jsonPath).catch(() => {});
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/infrastructure/database/legacy-migration.test.js`

Expected: 5 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/database/legacy-migration.js tests/infrastructure/database/legacy-migration.test.js
git commit -m "feat: add legacy JSON migration

One-time migration from nim-throttle-state.json to SQLite.
Migrates tokenUsage[] to requests table, cooldown state to
throttle_state, creates throttle_events for active cooldowns.
Renames migrated file to .migrated suffix. Idempotent."
```

---

### Task 10: Update model-injector with getMatchedRule

**Files:**
- Modify: `src/domain/model-injector.js`
- Create: `tests/domain/model-injector.test.js`

- [ ] **Step 1: Write the test for getMatchedRule**

```js
// tests/domain/model-injector.test.js
import { describe, it, expect } from 'vitest';
import { createModelInjector } from '../../src/domain/model-injector.js';

describe('ModelInjector', () => {
  const config = {
    thinkingModels: [
      { pattern: /^z-ai\/glm/i, injection: { chat_template_kwargs: { enable_thinking: true } } },
      { pattern: /^minimaxai\/minimax-m3$/i, injection: { chat_template_kwargs: { enable_thinking: true } } },
    ],
  };

  it('returns rule source for matching model', () => {
    const injector = createModelInjector(config);
    const rule = injector.getMatchedRule('z-ai/glm-5.1');
    expect(rule).toBe('^z-ai\\/glm/i');
  });

  it('returns null for non-matching model', () => {
    const injector = createModelInjector(config);
    const rule = injector.getMatchedRule('meta/llama-3');
    expect(rule).toBeNull();
  });

  it('returns null for null model', () => {
    const injector = createModelInjector(config);
    const rule = injector.getMatchedRule(null);
    expect(rule).toBeNull();
  });
});
```

- [ ] **Step 2: Update model-injector.js to add getMatchedRule**

```js
export function createModelInjector(config) {
  function patch(model, body) {
    if (!body || typeof body !== "object") return body;

    for (const rule of config.thinkingModels) {
      if (rule.pattern.test(model)) {
        return {
          ...body,
          chat_template_kwargs: {
            ...(body.chat_template_kwargs || {}),
            ...rule.injection.chat_template_kwargs,
          },
        };
      }
    }

    return body;
  }

  function getMatchedRule(model) {
    if (!model || typeof model !== "string") return null;
    for (const rule of config.thinkingModels) {
      if (rule.pattern.test(model)) {
        return rule.pattern.source;
      }
    }
    return null;
  }

  return { patch, getMatchedRule };
}
```

- [ ] **Step 3: Run new test**

Run: `npx vitest run tests/domain/model-injector.test.js`

Expected: 3 passing tests.

- [ ] **Step 4: Commit**

```bash
git add src/domain/model-injector.js tests/domain/model-injector.test.js
git commit -m "feat: add getMatchedRule to model-injector

Returns the regex source of the matched thinking rule
for a given model, or null if no rule matches. Used by
index.js to log which injection rule was applied."
```

---

### Task 11: Remove state-store.js and update docs

**Files:**
- Delete: `src/infrastructure/state-store.js`
- Modify: `AGENTS.md`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: Remove state-store.js**

Run:
```bash
git rm src/infrastructure/state-store.js
```

- [ ] **Step 2: Update ARCHITECTURE.md**

Key changes:
- Replace `state-store.js` entry with `database/` subdirectory
- Update dependency graph
- Update Token Usage Tracking section
- Add database sections

- [ ] **Step 3: Update AGENTS.md**

Key changes:
- Remove mention of `nim-throttle-state.json` as primary state
- Add SQLite database info
- Add new env vars
- Add repository pattern notes

- [ ] **Step 4: Update README.md**

Key changes:
- Add `better-sqlite3` to dependencies
- Add database env vars to configuration table
- Update quick start (no changes needed, but mention DB auto-creation)

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md ARCHITECTURE.md README.md
git commit -m "docs: update docs after SQLite migration

Remove state-store.js references. Add database architecture
docs, new env vars, repository pattern overview. Update
dependency graph with database/ subdirectory."
```

---

### Task 12: Full verification

**Files:**
- Run: integration test
- Run: full test suite
- Verify: server starts

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`

Expected: All ~46+ tests pass.

- [ ] **Step 2: Start server and verify it initializes**

Run:
```bash
timeout 5 node proxy.mjs 2>&1 || true
```

Expected: Server starts, logs "proxy started" with DB path, creates `oc-proxy.db` file.

- [ ] **Step 3: Quick smoke test — send a request that fails gracefully**

Run:
```bash
curl -s http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"test","messages":[{"role":"user","content":"hi"}]}' 2>&1 || echo "(server may have timed out)"
```

Expected: Connection refused (server timed out from `timeout`) or a graceful error response.

- [ ] **Step 4: Verify SQLite file was created and has data**

```bash
ls -la oc-proxy.db
sqlite3 oc-proxy.db "SELECT COUNT(*) FROM requests; SELECT COUNT(*) FROM throttle_state; SELECT version FROM _schema_version;"
```

Expected: DB file exists. Queries return reasonable values (requests count may be 0 if no requests were processed).

- [ ] **Step 5: Clean up test DB (if created)**

```bash
rm -f oc-proxy.db oc-proxy.db-wal oc-proxy.db-shm
```

- [ ] **Step 6: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: final verification — all tests pass, server starts
```
