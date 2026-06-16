# oc-proxy Architecture

A Fastify-based reverse proxy that sits between OpenCode and NVIDIA NIM's API, serializing and throttling requests to stay under the rate limit. Tracks token usage for TPM inference.

## Structure

```
proxy.mjs                    # Thin entry → src/index.js
runners/
├── migrate.js               # CLI: run/rollback migrations
├── migration.js             # CLI: create migration / status
└── migrate-utils.js         # Shared migration utilities
migrations/                  # Timestamped schema migration files
src/
├── index.js                 # Composition root — wires all dependencies
├── config.js                # Frozen config object from env vars
├── domain/
│   ├── rate-limiter.js      # RPM enforcer + TPM enforcer + composition factory
│   ├── token-tracker.js     # Usage recording, estimation, summary
│   ├── model-injector.js    # Config-driven model rules array
│   └── scheduler.js         # Job queue, concurrency, dispatch gap
├── infrastructure/
│   ├── database/
│   │   ├── connection.js    # SQLite (better-sqlite3) with WAL + ensureInfrastructure()
│   │   ├── snowflake.js     # 64-bit BigInt ID generator
│   │   ├── requests-repository.js  # Request CRUD + aggregations
│   │   ├── throttle-repository.js  # State singleton + events + per-model state
│   │   ├── buffered-repository.js  # Write-behind buffer decorator
│   │   └── legacy-migration.js     # nim-throttle-state.json → SQLite
│   ├── auth-loader.js       # Cached auth.json reader
│   ├── nim-client.js        # HTTP fetch with retry
│   └── tokenizer.js         # js-tiktoken wrapper
└── presentation/
    ├── routes.js            # Fastify route → queue bridge
    ├── sse-tap.js           # Transparent SSE Transform stream
    └── server.js            # Fastify app, listen, startup
```

## Dependency Graph

```
index.js (composition root)
  ├── config.js
  ├── infrastructure/tokenizer.js
  ├── infrastructure/database/connection.js ← config
  ├── infrastructure/database/snowflake.js
  ├── infrastructure/database/requests-repository.js ← connection, snowflake
  ├── infrastructure/database/throttle-repository.js ← connection, snowflake
  ├── infrastructure/database/buffered-repository.js ← requests/throttle repos
  ├── infrastructure/database/legacy-migration.js ← buffered-repo, throttle-repo
  ├── infrastructure/auth-loader.js ← config
  ├── domain/rate-limiter.js ← config
  ├── domain/token-tracker.js ← tokenizer, rate-limiter
  ├── domain/model-injector.js ← config
  ├── domain/scheduler.js ← rate-limiter, config
  ├── infrastructure/nim-client.js ← auth-loader, model-injector, config
  ├── presentation/sse-tap.js ← tokenizer, token-tracker
  ├── presentation/routes.js ← scheduler
  └── presentation/server.js ← fastify
```

## SOLID Principles

| Principle | Application |
|---|---|
| **Single Responsibility** | Each module does one thing. `rate-limiter.js` exposes three functions: `createRpmEnforcer` (global dispatch + cooldown), `createTpmEnforcer` (per-model tokens + pending), and `createRateLimiter` (composition factory). `nim-client.js` doesn't know about state. |
| **Open/Closed** | New model? Add a rule to `config.thinkingModels`. New rate limit strategy? New file in `domain/`. |
| **Liskov Substitution** | `nim-client.js` exposes a `send()` interface. Could swap NIM for any OpenAI-compatible API. |
| **Interface Segregation** | Repositories expose focused methods (`insert()`, `findByModel()`) — not a bloated DB manager. |
| **Dependency Inversion** | `scheduler.js` receives a `processJob` function via constructor. Dependencies are injected in `index.js`. |

## Request Flow

1. **Route** (`/v1/*`): Request intercepted, `reply.hijack()` takes over, job pushed to queue.

2. **Scheduler**: Background loop checks cooldown, concurrency, rolling window (RPM + TPM), and dispatch gap before dequeuing.

3. **processJob** (composition root): Loads API key, patches body via model injector, sends upstream via nim-client with retry logic. Every request (success or error) is persisted to SQLite via the buffered repository.

4. **Response**: SSE responses piped through transparent `SSETapStream` for token counting. Non-SSE responses parsed for usage data.

5. **Token tracking**: Usage recorded with NIM's `usage` field or `js-tiktoken` estimation. Persisted in SQLite `requests` table, logged at info level.

## Throttling (5 layers)

### Layer 1 — Rolling Window (dispatch-based)
`dispatchTimestamps[]` tracks when requests leave the proxy. `MAX_RPM` (default 25) per 60-second window.

### Layer 2 — Token Window (TPM, per-model)
Each model gets its own `tokenTimestamps[]` in a 60-second rolling window. `MAX_TPM` (default 350K) per model per window. Before dispatch, estimated cost (prompt tokens from `js-tiktoken` + `COMPLETION_BUFFER`) **plus in-flight pending tokens** is checked against available budget. Pending tokens are subtracted on completion (floor 0, so over-release doesn't create negative pending). Non-inference paths (`/v1/models`, etc.) skip TPM check entirely. Composes as AND gate with RPM — both must pass.

### Layer 3 — Concurrency Limiter
`MAX_CONCURRENCY` (default 2) in-flight upstream requests max.

### Layer 4 — Dispatch Gap (token-proportional)
Minimum gap = `max(MIN_DISPATCH_GAP_MS, ceil(estimated * 60000 / MAX_TPM))`. Larger token costs push dispatches further apart, smoothing bursts of expensive requests.

### Layer 5 — 429 Retry + Cooldown + State Persistence
Retries up to `MAX_RETRIES` (default 3) with `RETRY_DELAYS` (20s, 40s, 60s). If all fail: `COOLDOWN_MINUTES` (default 60) cooldown + `adaptiveLimit--` (floor 5) + persists all per-model TPM states to `model_throttle_state` table.

## Token Usage Tracking

Every request's token usage is intercepted and logged:
- **SSE streaming**: transparent `SSETapStream` parses events in-flight. Counts `delta.content` and `delta.reasoning_content`. Also parses NIM's `:` comment lines for exact `input_tokens`/`output_tokens`.
- **Non-SSE**: extracts NIM's `usage` field. Falls back to `js-tiktoken` (checks `reasoning_content` for thinking models).
- **SSE detection**: reads response `content-type` header, not request `Accept`.
- **Estimation**: `js-tiktoken` with `cl100k_base` encoding.

Persisted in SQLite `requests` table. Written via `BufferedRepository` (write-behind buffer with batch flush). See `src/infrastructure/database/` for the repository implementations.

## Persistence Layer

Config-driven via env vars. Key tables:

- **`requests`** — every proxied request with model, tokens, latency, error status, SSE flag. Snowflake IDs.
- **`throttle_events`** — append-only log of cooldown events and limit changes. Snowflake IDs.
- **`throttle_state`** — singleton row with current `adaptiveLimit` and `cooldownUntil`.
- **`model_throttle_state`** — per-model rolling window state (`token_timestamps`, `pending_tokens`, `updated_at`). Persisted on cooldown, loaded on startup.
- **`_schema_version`** — tracks applied migration versions (BigInt).
- **`_migration_lock`** — atomic lock for concurrent migration safety.

Schema changes are managed via timestamped migration files in `migrations/`. Apply with `npm run migrate`. See README for CLI usage.

TTL pruning runs every hour; retention configured via `DB_RETENTION_DAYS`.

## Configuration

All constants configurable via env vars. See README.md for the full list.

## Testing

```bash
yarn test        # run all tests
yarn test:watch  # watch mode
```

Tests in `tests/domain/` and `tests/infrastructure/` use vitest.
