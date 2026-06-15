# oc-proxy

A reverse proxy that serializes and throttles OpenCode requests to the NVIDIA NIM API, staying within the ~40 requests-per-minute rate limit.

## Overview

OpenCode's default behavior fires concurrent requests that quickly exceed NVIDIA NIM's rate limit. oc-proxy sits between the two, queuing requests through a rolling-window rate limiter, concurrency cap, and adaptive cooldown mechanism. State persists across restarts.

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

Three layers prevent rate limit violations:

1. **Rolling window** -- 35 requests per 60-second window (configurable via `DEFAULT_LIMIT`). Timestamps are pruned on each scheduler tick.

2. **Concurrency cap** -- Max 2 in-flight upstream requests. Prevents parallel calls from consuming multiple window slots simultaneously.

3. **Cooldown + adaptive limiting** -- On HTTP 429, the proxy halts all requests for 70 minutes and permanently decrements the rate limit by 1 (floor of 5). This persists across restarts via `nim-throttle-state.json`.

## SSE Streaming

Streaming responses (`text/event-stream`) are piped directly from upstream to the client using `Readable.fromWeb()`. The proxy strips `content-encoding` and `content-length` headers since it rewrites the response body.

## Model Injection

Requests to `z-ai/glm-5.1` are automatically patched with `chat_template_kwargs: { enable_thinking: true }`, enabling the model's thinking mode via NVIDIA NIM.

## OpenCode Integration

Add to `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "nvidia-throttle": {
      "name": "Nvidia (proxy)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:4000/v1/"
      },
      "models": {
        "z-ai/glm-5.1": {
          "name": "GLM 5.1"
        }
      }
    }
  }
}
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design documentation.

## License

Private. Not licensed for redistribution.
