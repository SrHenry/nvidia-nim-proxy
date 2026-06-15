# oc-proxy Architecture

A Fastify-based reverse proxy that sits between OpenCode and NVIDIA NIM's API, serializing and throttling requests to stay under the rate limit. Tracks token usage for TPM inference.

## Components

```
OpenCode ──▶ Fastify (127.0.0.1:8765) ──▶ NVIDIA NIM (integrate.api.nvidia.com/v1)
                    │
                    ├── Queue (in-memory)
                    ├── Scheduler (background loop)
                    ├── Rolling Window Limiter (dispatch-based)
                    ├── Token Usage Tracker (js-tiktoken)
                    ├── Persistent State (JSON file)
                    └── Auth Loader (reads OpenCode's auth.json)
```

## Request Flow

1. **Route** (`/v1/*`): Any request to `/v1/*` is intercepted. The handler calls `reply.hijack()` to take over the response lifecycle, pushes the request details into an in-memory queue, and returns a Promise that resolves when the scheduler processes it.

2. **Scheduler**: A `while(true)` loop that checks cooldown, concurrency, rolling window, and dispatch gap before dequeuing. Records dispatch timestamp when job is sent upstream.

3. **processJob**: The upstream HTTP call. Loads API key, patches body for model-specific injections, makes the `fetch()` call with retry logic on 429, and pipes the response to `reply.raw`. Token usage is intercepted transparently.

## Throttling Strategies (4 layers)

### Layer 1 — Rolling Window Rate Limiter (dispatch-based)

- Maintains `dispatchTimestamps[]` — records when requests leave the proxy (not when they complete)
- `WINDOW_MS = 60,000` (1 minute window)
- `MAX_RPM = 25` (configurable, conservative against NIM's 40 RPM published limit)
- `pruneWindows()` removes timestamps older than 60s
- If `currentUsage() >= adaptiveLimit`, scheduler sleeps until the oldest dispatch falls out of the window

### Layer 2 — Concurrency Limiter

- `MAX_CONCURRENCY = 2` — at most 2 upstream requests in-flight simultaneously
- Prevents parallel requests from consuming multiple window slots concurrently
- The scheduler sleeps 25ms and retries if concurrency is maxed

### Layer 3 — Dispatch Gap

- `MIN_DISPATCH_GAP_MS` = calculated from `60,000 / MAX_RPM` (~2.4s at 25 RPM)
- Enforces minimum time between dispatches to smooth traffic and avoid burst patterns
- Prevents startup bursts where queued requests are dispatched as fast as concurrency allows

### Layer 4 — 429 Retry + Cooldown + Adaptive Limiting

- On HTTP 429, retries up to `MAX_RETRIES` (default 3) with exponential backoff (`RETRY_DELAYS`: 20s, 40s, 60s)
- Logs NIM response headers on 429 for debugging
- If all retries exhausted: enters `COOLDOWN_MS` (default 60 min) cooldown
- `adaptiveLimit` permanently decremented by 1 (floor of 5) on cooldown entry
- Reduced limit persists across restarts via `nim-throttle-state.json`

## Token Usage Tracking

Every request's token usage is intercepted and logged:

- **Non-SSE responses**: parses response body, extracts NIM's `usage.prompt_tokens` / `usage.completion_tokens` directly. Falls back to `js-tiktoken` estimation if NIM doesn't provide usage.
- **SSE streaming responses**: transparent `SSETapStream` (Transform stream) passes data to client unchanged while parsing SSE events in-flight. Extracts usage from NIM's final chunk. Counts content tokens for estimation.
- **Estimation**: uses `js-tiktoken` with `cl100k_base` encoding to approximate token counts from message content.

Usage is persisted in `nim-throttle-state.json` under `tokenUsage[]` and `tokenUsageSummary`. Logged at `info` level for each request.

## Persistence

- State saved to `nim-throttle-state.json` on dispatch and on cooldown
- Contains: `dispatchTimestamps[]`, `timestamps[]`, `cooldownUntil`, `adaptiveLimit`, `tokenUsage[]`, `tokenUsageSummary`
- Loaded at startup — proxy remembers where it left off
- Atomic write (tmp file + rename) to avoid corruption

## Model Injection Layer

`patchBody()` intercepts requests for `z-ai/glm-5.1` and `minimaxai/minimax-m3`, injecting `chat_template_kwargs: { enable_thinking: true }` into the request body to enable thinking/reasoning mode via the NVIDIA NIM API.

## Configuration

All constants are configurable via environment variables. See README.md for the full list.
