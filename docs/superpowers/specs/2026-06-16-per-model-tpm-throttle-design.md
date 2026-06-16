# Per-Model TPM Throttle with In-Flight Token Tracking

## Problem

The proxy hits HTTP 429 from NVIDIA NIM despite token-per-minute (TPM) throttling. Analysis of 161 requests over 12 hours revealed:

- Rolling 60s token window exceeded the 350K TPM limit by up to 57% (peaked at 548K)
- In-flight tokens (from concurrent requests) are invisible to the dispatch check — with `maxConcurrency=2`, 150K-170K tokens can be committed but unaccounted
- TPM and concurrency limits are global, not per-model, so one model's burst can exhaust shared budget
- Fixed 2.4s dispatch gap doesn't scale with request size (80K-token requests need wider spacing)

## Scope

Changes to `src/config.js`, `src/domain/rate-limiter.js`, `src/domain/scheduler.js`, `src/index.js`, `src/infrastructure/database/connection.js`, `src/infrastructure/database/throttle-repository.js`, and corresponding test stubs. New `runners/` and `migrations/` directories.

---

## Part 1: Rate Limiter Decoupling

### Architecture

```
rate-limiter.js (composition factory)
├── createRpmEnforcer(config)   ← global: dispatchTimestamps, maxRpm (no cooldown, no adaptive)
└── createTpmEnforcer(config)   ← per-model: Map<model → {tokenTimestamps, pendingTokens, activeCount, cooldownUntil, adaptiveLimit}>
```

### Path Awareness

TPM enforcer (token tracking, concurrency, cooldown) only applies to inference paths:

```js
isInferencePath(path) → path starts with /v1/chat/ or /v1/completions
```

Non-inference routes (`/v1/models`, etc.) only hit the global RPM enforcer.

### RPM Enforcer (`createRpmEnforcer`)

Pure global request-per-minute tracking. No cooldown, no adaptive limit.

```
state: { dispatchTimestamps[], maxRpm }
```

- `canDispatch()` — `currentUsage() < maxRpm`
- `recordDispatch()` — push timestamp
- `timeUntilDispatchAllowed()` — wait until RPM slot available (0 if allowed)
- `currentUsage()` — count of dispatch timestamps in rolling window

### TPM Enforcer (`createTpmEnforcer`)

Per-model rolling token windows, concurrency tracking, and cooldown.

```
state: Map<model → {
  tokenTimestamps: [{ts, tokens}],   // rolling 60s actual token usage
  pendingTokens: number,              // sum of estimated tokens for in-flight reqs
  activeCount: number,                // concurrent requests in-flight
  cooldownUntil: number,              // 0 = not in cooldown
  adaptiveLimit: number               // starts at maxConcurrency, decrements on cooldown (floor 1)
}>
```

- `canDispatch(model, estimated)` — checks cooldown? activeCount < adaptiveLimit? tokenWindow + pending + estimated ≤ maxTpm?
- `recordDispatch(model, estimated)` — activeCount++, pendingTokens += estimated
- `recordCompletion(model)` — activeCount--
- `recordTokenUsage(model, actual)` — push to tokenTimestamps, pendingTokens = max(0, pending - actual)
- `enterCooldown(model)` — set cooldownUntil, adaptiveLimit = max(1, adaptiveLimit - 1)
- `timeUntilDispatchAllowed(model, estimated)` — returns cooldown wait or TPM wait
- `getModelState(model)` — returns {adaptiveLimit, cooldownUntil} for persistence
- `loadModelState(model, {adaptiveLimit, cooldownUntil})` — restore from DB

Model state is created lazily on first access. When loading from DB, values are injected before use.

### Rate Limiter Factory

Composes RPM and TPM enforcers with path awareness:

```
canDispatch(model, path, estimated) →
  rpm.canDispatch() && (!isInferencePath(path) || tpm.canDispatch(model, estimated))

recordDispatch(model, estimated) →
  rpm.recordDispatch(); tpm.recordDispatch(model, estimated)

recordCompletion(model) →
  tpm.recordCompletion(model)

recordTokenUsage(model, actual) →
  tpm.recordTokenUsage(model, actual)

timeUntilDispatchAllowed(model, path, estimated) →
  isInferencePath(path) ? max(rpm.tuda(), tpm.tuda(model, estimated)) : rpm.tuda()

enterCooldown(model) →
  tpm.enterCooldown(model)

rpmTimeUntilDispatchAllowed() →
  rpm.timeUntilDispatchAllowed()

currentUsage() →
  rpm.currentUsage()

getModelState(model) →
  tpm.getModelState(model)

loadModelStates(map<model, state>) →
  tpm.loadModelStates(map)
```

---

## Part 2: Scheduler Changes

### `src/domain/scheduler.js`

- Remove global `maxConcurrency` check (now per-model in TPM enforcer)
- Pass `model` (from `queue[0].body.model`) and `path` (from `job.upstreamPath`) to rate limiter methods
- Token-proportional gap: `gapMs = max(minDispatchGapMs, ceil(estimated * windowMs / maxTpm))`
- Pass `estimated` to `recordDispatch(model, estimated)` for pending tracking
- Pass `model` to `recordCompletion(model)` in `.finally()` (from `job.body?.model`)

**Scheduler loop:**

```
1. rpmTimeUntilDispatchAllowed() → sleep if RPM window full
2. Check queue
3. For queue[0]: get model + path, estimate tokens
4. canDispatch(model, path, estimated) → sleep if blocked
5. Token-proportional gap → sleep if too soon
6. Dequeue, recordDispatch(model, estimated), processJob
7. finally: recordCompletion(model), active--
```

---

## Part 3: Config Changes

### `src/config.js`

- `maxTpm` default: `350000` → `250000` (env `MAX_TPM` still overrides)

---

## Part 4: Wiring Changes

### `src/index.js`

- Pass `model` to `rateLimiter.recordCompletion(model)` in `.finally()`
- Pass `model` to `rateLimiter.recordTokenUsage(model, totalTokens)` in SSE and non-SSE paths
- On 429 exhaustion: call `rateLimiter.enterCooldown(model)`, persist via `throttleRepo.setModelState(model, ...)`
- On startup: call `throttleRepo.getAllModelStates()` → `rateLimiter.loadModelStates(map)`
- Remove `migrate()` call (migrations are manual now)
- Remove `rateLimiter.currentTokenUsage()` usage

### `src/infrastructure/database/throttle-repository.js`

- Add `getAllModelStates()` — returns `Map<model, {adaptiveLimit, cooldownUntil}>`
- Add `setModelState(model, {adaptiveLimit, cooldownUntil})` — upserts row

---

## Part 5: Migration System

### Directory structure

```
runners/
  migrate.js              ← npm run migrate [--dry-run] [steps] [--rollback [N]]
  migration.js             ← npm run migration create <name> | status [--dry-run]
  migrate-utils.js         ← shared: discover, sort, lock, execute, validate-step

migrations/
  1781555473000000000-initial-schema.js    ← extracted v1 (applied in existing DBs)
  <nanos>-<name>.js                        ← created via migration create
```

### npm scripts

```json
"migrate": "node runners/migrate.js",
"migration": "node runners/migration.js"
```

| Command | Behavior |
|---------|----------|
| `npm run migrate` | Runs ALL pending migrations |
| `npm run migrate -- 3` | Runs next 3 pending only |
| `npm run migrate -- --dry-run` | Show what would run, don't apply |
| `npm run migrate -- --rollback` | Roll back 1 step |
| `npm run migrate -- --rollback 2` | Roll back 2 steps |
| `npm run migrate -- --rollback --dry-run` | Show what would roll back, don't apply |
| `npm run migration create "name"` | Create migration file with boilerplate |
| `npm run migration status` | List applied + pending migrations |
| `npm run migration status --dry-run` | Same as status (read-only, flag optional) |

### Step argument validation

- Must be a positive integer
- If `0` is given: warn `"No-op: 0 steps requested"` and exit 0
- If negative, non-integer, or NaN: error `"Invalid step count: must be a positive integer"` and exit 1

### Migration file contract

```js
// migrations/<nanos>-<name>.js
export const version = 1781555473000000000n;
export const description = 'Human-readable summary';

export function up(db) {
  // raw better-sqlite3 Database instance
  db.exec(`CREATE TABLE ...`);
}

export function down(db) {
  // exactly mirrors up()
  db.exec(`DROP TABLE IF EXISTS ...`);
}
```

The `create` subcommand receives the name as a single argument (spaces require shell quoting). If the user passes multiple unquoted words, they're joined with space before processing.

Name validation:
- Required: error if missing or empty after trim
- Must contain at least one alphanumeric character
- Allowed characters: letters, digits, spaces, hyphens, underscores

Name transformation:
1. Trim whitespace
2. Collapse runs of `[\s_-]+` into a single `-`
3. Strip leading/trailing `-`
4. lowercase

Examples:
| User input | Filename slug | File description |
|---|---|---|
| `add-model-throttle-state` | `add-model-throttle-state` | `add-model-throttle-state` |
| `"add model throttle state"` | `add-model-throttle-state` | `add model throttle state` |
| `"Add  Model   Throttle"` | `add-model-throttle` | `Add  Model   Throttle` |

The generated file uses:
- Version: `BigInt(Date.now()) * 1_000_000n`
- Filename slug: kebab-case of transformed name
- Description: raw user input (trimmed, not kebab-cased)
- Boilerplate `up()` and `down()` stubs

### Atomic locking mechanism

Uses `INSERT ... ON CONFLICT DO UPDATE ... WHERE` — a single atomic SQL statement:

```sql
INSERT INTO _migration_lock (id, pid, host, locked_at)
VALUES (1, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  pid = excluded.pid, host = excluded.host, locked_at = excluded.locked_at
WHERE _migration_lock.locked_at < ?
```

- `changes > 0`: lock acquired (inserted or reclaimed stale 30s+ lock)
- `changes === 0`: another process holds a valid lock → print error and exit 1

### Migration execution

```
run(steps = Infinity):
  BEGIN IMMEDIATE via better-sqlite3 transaction
  Acquire lock atomically (or fail)
  Read MAX(version) FROM _schema_version  → currentVersion
  Sort migration files by version ascending
  Filter to version > currentVersion
  Take first `steps` items → pending
  If pending is empty: print "Already up to date" and exit 0
  If --dry-run: print pending list and exit 0
  For each: up(db), INSERT INTO _schema_version (version, applied_at)
  Release lock (DELETE FROM _migration_lock)

rollback(steps = 1):
  BEGIN IMMEDIATE via better-sqlite3 transaction
  Acquire lock atomically (or fail)
  SELECT version FROM _schema_version ORDER BY version DESC LIMIT steps → applied
  If applied is empty: print "Nothing to roll back" and exit 0
  If --dry-run: print list and exit 0
  For each (in DESC order): down(db), DELETE FROM _schema_version WHERE version = ?
  Release lock
```

### connection.js changes

- Remove `migrate()` method entirely
- Add constructor call to `ensureInfrastructure()`
- `ensureInfrastructure()` creates only `_schema_version` and `_migration_lock` tables
- Update `VALID_TABLES` to include `model_throttle_state`

```js
ensureInfrastructure() {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _migration_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pid INTEGER NOT NULL,
      host TEXT NOT NULL,
      locked_at INTEGER NOT NULL
    );
  `);
}
```

### V1 migration file

Extracted from current `connection.js` `migrate()` method:

```js
// migrations/1781555473000000000-initial-schema.js
export const version = 1781555473000000000n;
export const description = 'Initial schema: requests, throttle_events, throttle_state';

export function up(db) {
  // CREATE TABLE requests, throttle_events, throttle_state + indexes
  // INSERT OR IGNORE INTO throttle_state (id=1)
}

export function down(db) {
  db.exec(`DROP TABLE IF EXISTS requests; DROP TABLE IF EXISTS throttle_events; DROP TABLE IF EXISTS throttle_state;`);
}
```

Existing databases already have this version in `_schema_version` — the runner skips it.
Fresh databases run it as the first step of `npm run migrate`.

---

## Data Flow

```
Request arrives (inference path)
  ↓
Scheduler loop:
  1. rpm.tuda() → window full? wait
  2. Dequeue first job
  3. estimateJobTokens(body) → estimated
  4. rateLimiter.canDispatch(model, path, estimated)
     ├── rpm.canDispatch() → RPM budget?
     └── tpm.canDispatch(model, estimated) → cooldown? concurrency? TPM budget?
  ↓ (if allowed)
  5. Token-proportional gap → wait if needed
  6. rateLimiter.recordDispatch(model, estimated)
     ├── rpm.recordDispatch() → push timestamp
     └── tpm.recordDispatch(model, estimated) → activeCount++, pendingTokens += estimated
  ↓
  processJob → NIM
  ↓ (on completion)
  rateLimiter.recordTokenUsage(model, actual) → push to window, reduce pending
  rateLimiter.recordCompletion(model) → activeCount--
  ↓ (on 429 exhaust)
  rateLimiter.enterCooldown(model) → set cooldownUntil, decrement adaptiveLimit
  throttleRepo.setModelState(model, {adaptiveLimit, cooldownUntil})
```

```
Request arrives (non-inference path, e.g. /v1/models)
  ↓
rpm.canDispatch() → only global RPM check
  ↓
Sends directly to NIM (no TPM tracking, no cooldown)
```

---

## Edge Cases

- **Unknown model**: Defaults to `"unknown"` string — gets its own budget bucket
- **Estimated vs actual mismatch**: Pending tracks estimated at dispatch; actual reduces pending on completion. If actual > estimated, pending goes to 0 but actual tokens are in the window — the next dispatch sees the full window. Slightly permissive, bounded by actual usage.
- **Concurrent models**: Model A in cooldown doesn't affect Model B's requests (separate cooldownUntil, separate adaptiveLimit). Both still count toward global RPM.
- **Non-inference during cooldown**: `/v1/models` works even when a model is in cooldown. RPM still applies globally.
- **Startup with stale cooldown**: On restart, `model_throttle_state` is loaded. If `cooldownUntil` is in the past, it's ignored (the TPM enforcer's `canDispatch` check naturally returns true when `now() > cooldownUntil`).
- **Empty steps argument**: `npm run migrate` with no arguments runs all pending (steps = Infinity).
- **`--dry-run`**: Applies to both `migrate` and `rollback` modes. Shows what would change without touching the database.
- **Stale migration lock**: Auto-reclaimed after 30s. Manual recovery via `DELETE FROM _migration_lock WHERE id = 1` if needed.
