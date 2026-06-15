# oc-proxy

Reverse proxy between OpenCode and NVIDIA NIM API. Serializes and throttles requests, tracks token usage, and retries on 429s.

## Quick Start

```bash
node proxy.mjs        # default port 4000
PORT=8765 node proxy.mjs  # custom port
```

No build step. Single-file entry (`proxy.mjs` → `src/index.js`). Requires `fastify` and `js-tiktoken` in `node_modules`.

## Key Files

- `proxy.mjs` — thin entry wrapper, imports `src/index.js`
- `src/index.js` — composition root: wires all dependencies
- `src/config.js` — frozen config object from env vars
- `src/domain/` — pure business logic (rate-limiter, token-tracker, model-injector, scheduler)
- `src/infrastructure/` — external concerns (database, auth-loader, nim-client, tokenizer)
- `src/presentation/` — Fastify-specific (routes, sse-tap, server)
- `tests/` — vitest test stubs for domain and infrastructure
- `ARCHITECTURE.md` — detailed design doc (throttling layers, request flow)
- `oc-proxy.db` — SQLite database for persistent state (auto-created, gitignored)
- OpenCode config: `~/.config/opencode/opencode.json` — provider `nvidia-throttle` points here

## Gotchas

- **Fastify v5**: `reply.sent` is read-only. Proxy uses `reply.hijack()` + `reply.raw.writeHead()` / `.pipe()` to bypass Fastify reply lifecycle. Don't try to set `reply.sent` directly.
- **Auth file**: reads API key from `~/.local/share/opencode/auth.json` under provider key matching `PROVIDER` env var (default `nvidia`). The auth entry must have `type: "api"` and a `key` field.
- **Model injection**: config-driven via `thinkingModels` array in `src/config.js`. Add new models by adding a rule — zero code changes.
- **429 handling**: retries up to 3 times with 20s/40s/60s backoff, then enters 60-min cooldown with adaptive limit decrement (floor of 5). All configurable via env vars.
- **Dispatch-based tracking**: rolling window tracks dispatch timestamps (not completion). More accurate against NIM's rate limiting.
- **Dispatch gap**: minimum 2.4s between dispatches at 25 RPM. Prevents startup bursts.
- **Token tracking**: every request's token usage is logged and persisted. Uses NIM's `usage` field when available, falls back to `js-tiktoken` estimation.
- **SSE streaming**: transparent tap stream intercepts SSE for token counting without buffering. Data flows to client in real-time.
- **Content-Encoding**: proxy strips `content-encoding` and `content-length` headers since it re-writes the response body.
- **SQLite persistence**: uses `better-sqlite3` with WAL mode. Snowflake IDs (64-bit BigInt) for requests and throttle_events. Repository pattern with write-behind buffer for high-frequency inserts. `defaultSafeIntegers(true)` means all INTEGER columns return as BigInt — repositories convert to Number where needed.
- **Legacy migration**: on first startup, `nim-throttle-state.json` is auto-migrated to SQLite and renamed to `.migrated`.

## OpenCode Integration

Provider config in `opencode.json` uses `@ai-sdk/openai-compatible` with `baseURL: "http://127.0.0.1:8765/v1/"`. Uses `http://` not `https/` — proxy serves plain HTTP.

## Documentation

When changing behavior, constants, or architecture in `src/`, update `AGENTS.md`, `ARCHITECTURE.md`, and `README.md` to match. These files are the source of truth for how the proxy works.
