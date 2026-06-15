# oc-proxy Architecture

A Fastify-based reverse proxy that sits between OpenCode and NVIDIA NIM's API, serializing and throttling requests to stay under the ~40 rpm rate limit.

## Components

```
OpenCode ──▶ Fastify (127.0.0.1:8765) ──▶ NVIDIA NIM (integrate.api.nvidia.com/v1)
                    │
                    ├── Queue (in-memory)
                    ├── Scheduler (background loop)
                    ├── Rolling Window Limiter
                    ├── Persistent State (JSON file)
                    └── Auth Loader (reads OpenCode's auth.json)
```

## Request Flow

1. **Route** (`/v1/*`): Any request to `/v1/*` is intercepted. The handler calls `reply.hijack()` to take over the response lifecycle, pushes the request details (method, path, body, headers, reply object) into an in-memory queue, and returns a Promise that only resolves when the scheduler processes it.

2. **Scheduler**: A `while(true)` loop that continuously checks four conditions before dequeuing a job. It runs as a fire-and-forget background task.

3. **processJob**: The actual upstream HTTP call. Loads the API key from auth.json, patches the body for model-specific injections (GLM-5.1 thinking), makes the `fetch()` call, and writes the response directly to `reply.raw` (bypassing Fastify's reply lifecycle).

## Throttling Strategies (3 layers)

### Layer 1 — Rolling Window Rate Limiter

- Maintains a list of timestamps of recent requests
- `WINDOW_MS = 60,000` (1 minute window)
- `DEFAULT_LIMIT = 35` requests per window (conservative, 40 rpm limit with 5-rpm safety margin)
- `pruneWindow()` removes timestamps older than 60s before each check
- If `currentUsage() >= adaptiveLimit`, the scheduler sleeps until the oldest timestamp falls out of the window

### Layer 2 — Concurrency Limiter

- `MAX_CONCURRENCY = 2` — at most 2 upstream requests in-flight simultaneously
- Prevents parallel requests from consuming multiple slots in the rolling window concurrently
- The scheduler sleeps 25ms and retries if concurrency is maxed

### Layer 2b — Dispatch Gap

- `MIN_DISPATCH_GAP_MS = 2,000` — minimum 2 seconds between dispatches
- Prevents startup bursts where queued requests are dispatched as fast as concurrency allows
- The scheduler sleeps the remaining gap time if less than 2s has passed since the last dispatch

### Layer 3 — Cooldown + Adaptive Limiting

- When a 429 is received from upstream, the proxy enters **cooldown** for 70 minutes (`COOLDOWN_MS = 70 * 60 * 1000`)
- During cooldown, the scheduler refuses to dequeue any jobs
- The `adaptiveLimit` is permanently decremented by 1 (floor of 5), so the proxy learns from rate limit violations and becomes more conservative over time
- The reduced limit persists across restarts via `nim-throttle-state.json`

## Persistence

- State is saved to `nim-throttle-state.json` when upstream requests complete and on 429 cooldown
- Timestamps are recorded at completion (not dispatch), so the rolling window accurately reflects finished requests
- Loaded at startup — the proxy remembers where it left off (timestamps, cooldown, adaptive limit)
- Uses atomic write (tmp file + rename) to avoid corruption

## Model Injection Layer

`patchBody()` intercepts requests for `z-ai/glm-5.1` and injects `chat_template_kwargs: { enable_thinking: true }` into the request body, enabling the model's thinking/reasoning mode via the NVIDIA NIM API.
