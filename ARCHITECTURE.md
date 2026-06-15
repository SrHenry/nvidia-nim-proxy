# oc-proxy Architecture

A Fastify-based reverse proxy that sits between OpenCode and NVIDIA NIM's API, serializing and throttling requests to stay under the rate limit. Tracks token usage for TPM inference.

## Structure

```
proxy.mjs                    # Thin entry → src/index.js
src/
├── index.js                 # Composition root — wires all dependencies
├── config.js                # Frozen config object from env vars
├── domain/
│   ├── rate-limiter.js      # Rolling window, dispatch tracking, cooldown
│   ├── token-tracker.js     # Usage recording, estimation, summary
│   ├── model-injector.js    # Config-driven model rules array
│   └── scheduler.js         # Job queue, concurrency, dispatch gap
├── infrastructure/
│   ├── state-store.js       # Atomic JSON read/write
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
  ├── infrastructure/state-store.js ← config
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
| **Single Responsibility** | Each module does one thing. `rate-limiter.js` doesn't know about tokens. `nim-client.js` doesn't know about state. |
| **Open/Closed** | New model? Add a rule to `config.thinkingModels`. New rate limit strategy? New file in `domain/`. |
| **Liskov Substitution** | `nim-client.js` exposes a `send()` interface. Could swap NIM for any OpenAI-compatible API. |
| **Interface Segregation** | `state-store.js` exposes `load()` and `save()` — not a bloated state manager. |
| **Dependency Inversion** | `scheduler.js` receives a `processJob` function via constructor. Dependencies are injected in `index.js`. |

## Request Flow

1. **Route** (`/v1/*`): Request intercepted, `reply.hijack()` takes over, job pushed to queue.

2. **Scheduler**: Background loop checks cooldown, concurrency, rolling window, and dispatch gap before dequeuing.

3. **processJob** (composition root): Loads API key, patches body via model injector, sends upstream via nim-client with retry logic.

4. **Response**: SSE responses piped through transparent `SSETapStream` for token counting. Non-SSE responses parsed for usage data.

5. **Token tracking**: Usage recorded with NIM's `usage` field or `js-tiktoken` estimation. Persisted in state, logged at info level.

## Throttling (4 layers)

### Layer 1 — Rolling Window (dispatch-based)
`dispatchTimestamps[]` tracks when requests leave the proxy. `MAX_RPM` (default 25) per 60-second window.

### Layer 2 — Concurrency Limiter
`MAX_CONCURRENCY` (default 2) in-flight upstream requests max.

### Layer 3 — Dispatch Gap
`MIN_DISPATCH_GAP_MS` (~2.4s at 25 RPM) enforced between dispatches.

### Layer 4 — 429 Retry + Cooldown
Retries up to `MAX_RETRIES` (default 3) with `RETRY_DELAYS` (20s, 40s, 60s). If all fail: `COOLDOWN_MINUTES` (default 60) cooldown + `adaptiveLimit--` (floor 5).

## Token Usage Tracking

Every request's token usage is intercepted and logged:
- **Non-SSE**: extracts NIM's `usage` field. Falls back to `js-tiktoken` estimation.
- **SSE streaming**: transparent `SSETapStream` parses events in-flight. No buffering.
- **Estimation**: `js-tiktoken` with `cl100k_base` encoding.

Persisted in `nim-throttle-state.json` under `tokenUsage[]` and `tokenUsageSummary`.

## Configuration

All constants configurable via env vars. See README.md for the full list.

## Testing

```bash
yarn test        # run all tests
yarn test:watch  # watch mode
```

Tests in `tests/domain/` and `tests/infrastructure/` use vitest.
