> [Ver também em pt-BR](README.pt-BR.md)

# NVIDIA NIM Proxy

A reverse proxy that serializes and throttles OpenCode requests to the NVIDIA NIM API, tracks token usage, and retries on rate limits.

## Overview

OpenCode's default behavior fires concurrent requests that quickly exceed NVIDIA NIM's rate limit. oc-proxy sits between the two, queuing requests through a rolling-window rate limiter, concurrency cap, dispatch gap smoothing, and 429 retry logic. Token usage is tracked for TPM inference. State persists in SQLite across restarts.

```
OpenCode ──▶ oc-proxy (localhost) ──▶ NVIDIA NIM (integrate.api.nvidia.com/v1)
```

## Prerequisites

- Node.js >= 18
- An NVIDIA NIM API key stored in OpenCode's auth file (`~/.local/share/opencode/auth.json`)
- System build tools for `better-sqlite3` native addon (Python, C++ compiler)

## Installation

```bash
npm install
```

## Usage

```bash
node proxy.mjs              # default port 4000
PORT=8765 node proxy.mjs    # custom port
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Local listen port |
| `UPSTREAM` | `https://integrate.api.nvidia.com/v1` | Upstream API base URL |
| `PROVIDER` | `nvidia` | Key name in auth.json |
| `AUTH_FILE` | `~/.local/share/opencode/auth.json` | Path to auth credentials |
| `DB_PATH` | `./oc-proxy.db` | SQLite database file path |
| `DB_RETENTION_DAYS` | `365` | Days to retain request/event history |
| `SNOWFLAKE_WORKER_ID` | `0` | Unique worker ID (0-1023) for Snowflake IDs |
| `FLUSH_INTERVAL_MS` | `5000` | Write-behind buffer flush interval |
| `FLUSH_BATCH_SIZE` | `100` | Write-behind buffer batch size trigger |
| `MAX_RPM` | `25` | Target requests per minute (NIM publishes 40, we stay conservative) |
| `MAX_TPM` | `250000` | Target tokens per minute (proactive throttle, composes with RPM) |
| `COMPLETION_BUFFER` | `48000` | Completion overhead added to prompt tokens for TPM check (high for thinking models with large reasoning output) |
| `COOLDOWN_MINUTES` | `60` | Minutes to wait after exhausted 429 retries |
| `MAX_CONCURRENCY` | `2` | Max in-flight upstream requests |
| `MAX_RETRIES` | `3` | Retries on 429 before entering cooldown |
| `RETRY_DELAYS` | `20,40,60` | Comma-separated retry delays in seconds |
| `MIN_DISPATCH_GAP_MS` | auto | Calculated from `60000 / MAX_RPM` if not set |

## Auth File Format

The proxy reads the API key from OpenCode's auth file. The entry must match the `PROVIDER` env var:

```json
{
  "nvidia": {
    "type": "api",
    "key": "nvapi-..."
  }
}
```

## Throttling

Five layers prevent rate limit violations:

1. **Rolling window (dispatch-based)** -- Tracks when requests leave the proxy (not when they complete). `MAX_RPM` requests per 60-second window.

2. **Token window (TPM, per-model)** -- Each model gets its own 60-second rolling token window. Before dispatch, estimated token cost (prompt + `COMPLETION_BUFFER`) plus in-flight pending tokens is checked against `MAX_TPM`. Both RPM and per-model TPM gates must pass. Non-inference paths (e.g. `/v1/models`) skip the TPM check. Pending tokens are reduced on completion (floor 0).

3. **Concurrency cap** -- Max `MAX_CONCURRENCY` in-flight upstream requests.

4. **Dispatch gap (token-proportional)** -- Minimum gap between dispatches calculated as `max(MIN_DISPATCH_GAP_MS, ceil(estimated * 60000 / MAX_TPM))`. Larger token costs push dispatches further apart.

5. **429 retry + cooldown + adaptive limiting** -- Retries up to `MAX_RETRIES` with exponential backoff. If all fail, halts for `COOLDOWN_MINUTES`, decrements the rate limit by 1 (floor of 5), and persists all per-model TPM state.

## Token Usage Tracking

Every request's token usage is intercepted and logged:

- **SSE streaming**: transparent `SSETapStream` parses events in-flight without buffering. Counts both `delta.content` and `delta.reasoning_content` tokens. Also parses NIM's non-standard `:` comment lines for exact `input_tokens`/`output_tokens`.
- **Non-SSE responses**: extracts NIM's `usage` field directly. Falls back to `js-tiktoken` estimation (also checks `reasoning_content` for thinking models).
- **SSE detection**: reads response `content-type` header (not request `Accept`) to correctly handle NIM's streaming responses.
- **Estimation**: uses `js-tiktoken` with `cl100k_base` encoding when NIM doesn't provide usage data.

Usage is persisted in SQLite (`requests` table) via write-behind buffer and logged at `info` level.

## Per-Model Config Overrides + Injection

The unified `models` array in `src/config.js` handles both request body injection and per-model throttle/scheduler overrides:

```js
models: [
  {
    pattern: /^z-ai\/glm-?5\.?1/i,
    injection: { chat_template_kwargs: { enable_thinking: true } },
    override: { maxTpm: 250000, cooldownMs: 120000 },
  },
  {
    pattern: /^minimaxai\/minimax-m3$/i,
    injection: { chat_template_kwargs: { enable_thinking: true } },
  },
  {
    pattern: /^nvidia\/llama-3\.3/i,
    override: { maxTpm: 100000, maxConcurrency: 3 },
  },
],
```

- **`injection`** — patches request body before sending upstream
- **`override`** — per-model throttle/scheduler params: `maxTpm`, `maxConcurrency`, `completionBuffer`, `cooldownMs`, `minDispatchGapMs`, `maxRetries`, `retryDelays`

First matching pattern wins. Resolver threaded through rate-limiter, scheduler, NIM client, and index.js.

## Schema Migrations

Database schema changes are managed via timestamped migration files in `migrations/`:

```bash
npm run migrate                        # apply all pending
npm run migrate -- --dry-run           # preview only
npm run migrate -- 3                   # apply next 3
npm run migrate -- --rollback          # revert last
npm run migrate -- --rollback 2 --dry-run  # preview revert of 2
npm run migration create "add widgets"  # create new migration
npm run migration status               # show applied/pending
```

Migrations do NOT auto-run on startup — run `npm run migrate` manually after deploying new code.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design documentation.

## Testing

```bash
yarn test        # run all tests
yarn test:watch  # watch mode
```

## License

[MIT](LICENSE)
