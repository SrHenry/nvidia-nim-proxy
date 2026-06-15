# oc-proxy

Reverse proxy between OpenCode and NVIDIA NIM API. Serializes and throttles requests to stay under ~40 rpm.

## Quick Start

```bash
node proxy.mjs        # default port 4000
PORT=8765 node proxy.mjs  # custom port
```

No build step. Single-file Node app (`proxy.mjs`). Requires `fastify` in `node_modules`.

## Key Files

- `proxy.mjs` — entire app: Fastify server, queue, scheduler, auth, model injection
- `ARCHITECTURE.md` — detailed design doc (throttling layers, request flow)
- `nim-throttle-state.json` — persistent throttle state (auto-created, gitignored)
- OpenCode config: `~/.config/opencode/opencode.json` — provider `nvidia-throttle` points here

## Gotchas

- **Fastify v5**: `reply.sent` is read-only. Proxy uses `reply.hijack()` + `reply.raw.writeHead()` / `.pipe()` to bypass Fastify reply lifecycle. Don't try to set `reply.sent` directly.
- **Auth file**: reads API key from `~/.local/share/opencode/auth.json` under provider key matching `PROVIDER` env var (default `nvidia`). The auth entry must have `type: "api"` and a `key` field.
- **Model injection**: `z-ai/glm-5.1` gets `chat_template_kwargs: { enable_thinking: true }` injected automatically by `patchBody()`.
- **429 cooldown**: 70 minutes, with adaptive limit decrement (floor of 5). State persists across restarts.
- **Dispatch gap**: minimum 2s between dispatches (`MIN_DISPATCH_GAP_MS`). Prevents startup bursts from hitting the rate limit.
- **Timestamps at completion**: rolling window records timestamps when upstream requests finish, not when dispatched. Keeps the window accurate under variable latency.
- **SSE streaming**: upstream responses with `text/event-stream` are piped via `Readable.fromWeb()` — don't use `response.text()` for streaming responses.
- **Content-Encoding**: proxy strips `content-encoding` and `content-length` headers since it re-writes the response body.

## OpenCode Integration

Provider config in `opencode.json` uses `@ai-sdk/openai-compatible` with `baseURL: "http://127.0.0.1:8765/v1/"`. Uses `http://` not `https://` — proxy serves plain HTTP.

## Documentation

When changing behavior, constants, or architecture in `proxy.mjs`, update `AGENTS.md`, `ARCHITECTURE.md`, and `README.md` to match. These files are the source of truth for how the proxy works.
