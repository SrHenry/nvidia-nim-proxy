# oc-proxy

A reverse proxy that serializes and throttles OpenCode requests to the NVIDIA NIM API, tracks token usage, and retries on rate limits.

## Overview

OpenCode's default behavior fires concurrent requests that quickly exceed NVIDIA NIM's rate limit. oc-proxy sits between the two, queuing requests through a rolling-window rate limiter, concurrency cap, dispatch gap smoothing, and 429 retry logic. Token usage is tracked for TPM inference. State persists across restarts.

```
OpenCode ──▶ oc-proxy (localhost) ──▶ NVIDIA NIM (integrate.api.nvidia.com/v1)
```

## Prerequisites

- Node.js >= 18
- An NVIDIA NIM API key stored in OpenCode's auth file (`~/.local/share/opencode/auth.json`)

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
| `STATE_FILE` | `./nim-throttle-state.json` | Persistent throttle state |
| `MAX_RPM` | `25` | Target requests per minute (NIM publishes 40, we stay conservative) |
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

Four layers prevent rate limit violations:

1. **Rolling window (dispatch-based)** -- Tracks when requests leave the proxy (not when they complete). `MAX_RPM` requests per 60-second window.

2. **Concurrency cap** -- Max `MAX_CONCURRENCY` in-flight upstream requests.

3. **Dispatch gap** -- Minimum `MIN_DISPATCH_GAP_MS` between dispatches (~2.4s at 25 RPM).

4. **429 retry + cooldown + adaptive limiting** -- Retries up to `MAX_RETRIES` with exponential backoff. If all fail, halts for `COOLDOWN_MINUTES` and decrements the rate limit by 1 (floor of 5).

## Token Usage Tracking

Every request's token usage is intercepted and logged:

- **Non-SSE responses**: extracts NIM's `usage` field directly. Falls back to `js-tiktoken` estimation.
- **SSE streaming**: transparent `SSETapStream` parses events in-flight without buffering.
- **Estimation**: uses `js-tiktoken` with `cl100k_base` encoding when NIM doesn't provide usage data.

Usage is persisted in `nim-throttle-state.json` and logged at `info` level.

## Model Injection

Config-driven via `thinkingModels` array in `src/config.js`. Add new models by adding a rule:

```js
thinkingModels: [
  {
    pattern: /^z-ai\/glm-?5\.?1/i,
    injection: { chat_template_kwargs: { enable_thinking: true } },
  },
  {
    pattern: /^minimaxai\/minimax-m3$/i,
    injection: { chat_template_kwargs: { enable_thinking: true } },
  },
],
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design documentation.

## Testing

```bash
yarn test        # run all tests
yarn test:watch  # watch mode
```

## License

Private. Not licensed for redistribution.
