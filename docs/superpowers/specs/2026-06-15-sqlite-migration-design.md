# SQLite Database Migration Design

Date: 2026-06-15
Status: Approved Design

## Overview

Replace the current JSON file persistence (`nim-throttle-state.json`) with SQLite using a clean repository abstraction, Snowflake IDs, and a write-behind buffer strategy for high-frequency log writes.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  Composition Root (src/index.js)          │
│                                                           │
│  realRequestsRepo = new RequestsRepository(db)            │
│  bufferedRequestsRepo = new BufferedRepository(realRepo)  │
│  throttleRepo = new ThrottleRepository(db)                │
│                                                           │
│  tokenTracker.record() → bufferedRequestsRepo.insert()    │
│  rateLimiter.enterCooldown() → throttleRepo.setState()    │
│                             → throttleRepo.insertEvent()  │
└──────────┬───────────────────────────────────────────────┘
           │
     ┌─────┴──────────────────┐
     │  BufferedRepository    │  ← flush worker (interval + batch size)
     │  ┌───┬───┬───┐         │
     │  │ r │ r │ r │──→ SQLite (batched TX)
     │  └───┴───┴───┘         │
     └────────────────────────┘

     ThrottleRepository.setState() ──→ SQLite (direct, no buffer)
     ThrottleRepository.getState()  ←── SQLite (read direct)
```

## Schema

```sql
-- Schema version tracking
CREATE TABLE _schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

-- Every proxied request
CREATE TABLE requests (
    id                INTEGER PRIMARY KEY,   -- Snowflake (BigInt)
    model             TEXT NOT NULL,
    status_code       INTEGER,
    latency_ms        INTEGER,
    error             TEXT,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    token_source      TEXT NOT NULL DEFAULT 'estimated',  -- 'nim' | 'estimated'
    model_injection   TEXT,                  -- injection rule name, null if none
    is_sse            INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL       -- unix ms
);

CREATE INDEX idx_requests_created_at ON requests(created_at);
CREATE INDEX idx_requests_model ON requests(model);
CREATE INDEX idx_requests_model_created ON requests(model, created_at);

-- Rate limiter state changes (append-only log)
CREATE TABLE throttle_events (
    id             INTEGER PRIMARY KEY,      -- Snowflake (BigInt)
    event_type     TEXT NOT NULL,            -- 'cooldown_enter' | 'cooldown_expire' | 'limit_decrement' | 'limit_reset' | '429_retry'
    limit_before   INTEGER,
    limit_after    INTEGER,
    cooldown_until INTEGER,
    reason         TEXT,
    metadata       TEXT,                     -- JSON blob (model, attempt, etc)
    created_at     INTEGER NOT NULL
);

CREATE INDEX idx_throttle_events_created ON throttle_events(created_at);

-- Current throttle state (singleton)
CREATE TABLE throttle_state (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    adaptive_limit INTEGER NOT NULL DEFAULT 25,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL
);

INSERT INTO throttle_state (id, adaptive_limit, cooldown_until, updated_at)
VALUES (1, 25, 0, 0);
```

## Snowflake ID Generator

64-bit Snowflake: `0 | timestamp(41) | workerId(10) | sequence(12)`

- Custom epoch: 2026-01-01T00:00:00.000Z
- Worker ID: configurable via `SNOWFLAKE_WORKER_ID` env var (default 0)
- Sequence: per-millisecond counter (0-4095), resets on new ms
- Handles clock rollback: throws error if clock moves backwards
- Stored as BigInt in JS, INTEGER in SQLite

## Repository Interfaces

### RequestsRepository

```js
insert({ model, statusCode, latencyMs, error, promptTokens, completionTokens, totalTokens, tokenSource, modelInjection, isSse, createdAt }) → Snowflake id
insertBatch([records]) → void                                      // used by buffer flush
findByModel(model, { limit, offset, from, to }) → records[]
getTokenUsageByModel({ from, to }) → [{ model, totalTokens, requestCount }]
getSummary({ from, to }) → { totalRequests, totalTokens, avgLatencyMs, errorCount }
prune(beforeTimestamp) → deletedCount
count() → number
```

### ThrottleRepository

```js
insertEvent({ type, limitBefore, limitAfter, cooldownUntil, reason, metadata }) → Snowflake id
getState() → { adaptiveLimit, cooldownUntil, updatedAt } | null
setState({ adaptiveLimit, cooldownUntil }) → void    // upsert, direct write
getRecentEvents(limit) → events[]
prune(beforeTimestamp) → deletedCount
```

## Write-Behind Buffer

### BufferedRepository

Wraps any repository with insert buffering:

- Writes go to an in-memory array
- Two flush triggers: interval (`FLUSH_INTERVAL_MS`, default 5000ms) and batch size (`FLUSH_BATCH_SIZE`, default 100)
- Flush sends all buffered records in a single multi-row INSERT transaction
- Read methods pass through directly (no buffering)
- `drain()` method for graceful shutdown (flushes remaining buffer)
- Error handling: failed flush re-queues batch, logs critical warning on consecutive failures

### What gets buffered

| Data | Repository | Buffered? | Why |
|------|-----------|-----------|-----|
| Request/token records | RequestsRepository | Yes | High frequency, not time-critical |
| Throttle events | ThrottleRepository | Yes | Low frequency but can be buffered |
| Throttle state (cooldown, limit) | ThrottleRepository | No | Must persist immediately |

## Database Connection

- SQLite WAL mode for concurrent reads during writes
- `synchronous = NORMAL` (safe with WAL, good perf)
- `busy_timeout = 5000` (wait during contention)
- `cache_size = -64000` (64MB cache)
- `foreign_keys = ON`
- Multi-row batch inserts via prepared statement within a transaction

## Integration with Existing Code

### Composition root changes (src/index.js)

```js
// Before:
const stateStore = createStateStore(config.stateFile);
const loadedState = await stateStore.load();
rateLimiter.loadState(loadedState);
tokenTracker.loadState(loadedState);

// After:
const db = new Database(config.dbPath);
await db.migrate();
const realRequestsRepo = new RequestsRepository(db);
const requestsRepo = new BufferedRepository(realRequestsRepo, config);
const throttleRepo = new ThrottleRepository(db);

const loadedState = await throttleRepo.getState();
if (loadedState) rateLimiter.loadState(loadedState);

// Migrate legacy JSON
await maybeMigrateFromJson(config.stateFile, requestsRepo, throttleRepo);

// Graceful shutdown
process.on('SIGINT', async () => {
  await requestsRepo.drain();
  db.close();
  process.exit(0);
});

// TTL pruning
const pruneInterval = setInterval(() => {
  const cutoff = Date.now() - config.dbRetentionDays * 86400000;
  requestsRepo.prune(cutoff);
  throttleRepo.prune(cutoff);
}, 3600000);  // every hour
pruneInterval.unref();

// processJob now persists after completing:
async function processJob(job) {
  // ... existing code ...
  // After response handling, persist:
  requestsRepo.insert({
    model, statusCode, latencyMs, error,
    promptTokens, completionTokens, totalTokens,
    tokenSource, modelInjection, isSse,
    createdAt: Date.now()
  });
}
```

### Config additions (src/config.js)

```js
dbPath: env("DB_PATH", "./oc-proxy.db"),
dbRetentionDays: envNumber("DB_RETENTION_DAYS", 365),
snowflakeWorkerId: envNumber("SNOWFLAKE_WORKER_ID", 0),
flushIntervalMs: envNumber("FLUSH_INTERVAL_MS", 5000),
flushBatchSize: envNumber("FLUSH_BATCH_SIZE", 100),
```

### Removed

- `src/infrastructure/state-store.js`

### Unchanged

- `src/domain/rate-limiter.js` (still in-memory rolling window)
- `src/domain/scheduler.js`
- `src/domain/model-injector.js`
- `src/infrastructure/auth-loader.js`
- `src/infrastructure/nim-client.js`
- `src/infrastructure/tokenizer.js`
- `src/presentation/routes.js`
- `src/presentation/sse-tap.js`
- `src/presentation/server.js`

## JSON → SQLite Migration

On first startup with DB enabled, if `nim-throttle-state.json` exists:
1. Read JSON state
2. Insert each `tokenUsage[]` entry into `requests`
3. Insert throttle cooldown event if `cooldownUntil > 0`
4. Set `throttle_state` from `cooldownUntil` and `adaptiveLimit`
5. Rename `nim-throttle-state.json` → `nim-throttle-state.json.migrated`

## TTL Pruning

- Configurable `DB_RETENTION_DAYS` (default 365)
- Hourly background job prunes `requests` and `throttle_events` older than retention period
- Uses indexed `created_at` column for efficient range deletes
- Prune runs as background `setInterval` with `.unref()` (won't delay shutdown)

## File Structure

```
src/
├── index.js                         # Updated wiring
├── config.js                        # + DB config vars
├── domain/                          # unchanged
├── infrastructure/
│   ├── database/
│   │   ├── connection.js            # Database class (open, migrate, close, batch insert)
│   │   ├── snowflake.js             # Snowflake ID generator
│   │   ├── requests-repository.js   # RequestsRepository
│   │   ├── throttle-repository.js   # ThrottleRepository
│   │   └── buffered-repository.js   # BufferedRepository wrapper
│   ├── auth-loader.js               # unchanged
│   ├── nim-client.js                # unchanged
│   └── tokenizer.js                 # unchanged
├── presentation/                    # unchanged
tests/
├── domain/                          # unchanged
├── infrastructure/
│   └── database/
│       ├── connection.test.js
│       ├── snowflake.test.js
│       ├── requests-repository.test.js
│       ├── throttle-repository.test.js
│       └── buffered-repository.test.js
└── integration/
    └── persistence.test.js
```

## Testing

| Component | Approach | DB |
|-----------|----------|-----|
| Snowflake generator | Pure unit tests | none |
| Database connection | Open/close/migrate on temp file | temp file |
| RequestsRepository | CRUD, find, aggregate, prune | `:memory:` |
| ThrottleRepository | CRUD, state upsert, events | `:memory:` |
| BufferedRepository | Buffer→flush, batch sizing, drain | Fake inner repo + `:memory:` |
| Integration | Full cycle: insert→buffer→flush→read | `:memory:` |

## Dependencies

- Runtime: `better-sqlite3` (added to `dependencies` in `package.json`)
- Dev: none new (vitest already available)
