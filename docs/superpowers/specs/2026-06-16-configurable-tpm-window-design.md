# Configurable TPM Rolling Window

## Problem

NIM's token rate limit operates on a 5-minute rolling window, but the proxy's TPM enforcer uses a 1-minute window. This mismatch causes:
- Under-utilization: proxy limits to 250K/min when NIM allows ~1.25M per 5 min
- Premature throttling: bursts that fit in 5 min get rejected by 1 min window

## Solution

Decouple TPM window from RPM window. Make TPM window configurable (default 5 min) with per-model override.

### Behavior Change

| Before | After |
|--------|-------|
| `windowMs = 60,000` (shared) | RPM: 60,000ms, TPM: 300,000ms (default) |
| `maxTpm` = absolute limit | `maxTpm` = tokens/minute (rate) |
| Budget = `maxTpm` | Budget = `maxTpm * (tokenWindowMs / 60000)` |

### Example

```
maxTpm = 250,000 (tokens/min)
tokenWindowMs = 300,000 (5 min)
Budget = 250K * 5 = 1,250,000 tokens in window
```

## Changes

### 1. config.js

Add `tpmWindowMs` env var:

```js
const tpmWindowMs = envNumber("TPM_WINDOW_MS", 300_000);

export default Object.freeze({
  // ... existing
  windowMs: 60_000,        // RPM window (unchanged)
  tpmWindowMs,             // TPM window (new, default 5 min)
  // ...
});
```

### 2. rate-limiter.js — createTpmEnforcer

**Window resolution:**
```js
function getWindowMs(model) {
  return resolve(model, "tokenWindowMs") || config.tpmWindowMs;
}
```

**Budget calculation:**
```js
function canDispatchForModel(model, estimatedTokens) {
  if (estimatedTokens <= 0) return true;
  const ms = getOrCreateModelState(model);
  pruneModelTokens(ms, getWindowMs(model));
  const maxTpm = resolve(model, "maxTpm");
  const windowMs = getWindowMs(model);
  const budget = maxTpm * (windowMs / 60_000);
  return tokensInWindow(ms) + ms.pendingTokens + estimatedTokens <= budget;
}
```

**Pruning uses model-specific window:**
```js
function pruneModelTokens(modelState, windowMs) {
  const cutoff = now() - windowMs;
  modelState.tokenTimestamps = modelState.tokenTimestamps.filter(t => t.ts > cutoff);
}
```

**Wait time calculation:**
```js
function timeUntilModelAllowed(model, estimatedTokens) {
  if (estimatedTokens <= 0) return 0;
  const ms = getOrCreateModelState(model);
  const windowMs = getWindowMs(model);
  pruneModelTokens(ms, windowMs);
  const maxTpm = resolve(model, "maxTpm");
  const budget = maxTpm * (windowMs / 60_000);
  const available = budget - (tokensInWindow(ms) + ms.pendingTokens);
  if (estimatedTokens <= available) return 0;
  if (ms.tokenTimestamps.length === 0) return 1000;
  const oldest = ms.tokenTimestamps[0];
  const wait = oldest.ts + windowMs - now();
  return wait > 0 ? wait : 1000;
}
```

### 3. Per-model override

Add `tokenWindowMs` to override keys in config.js models array:

```js
models: [
  {
    pattern: /^z-ai\/glm-?5\.?1/i,
    override: {
      maxTpm: 250_000,
      tokenWindowMs: 300_000,  // 5 min (default)
    },
  },
],
```

### 4. Documentation updates

- AGENTS.md: add `tokenWindowMs` to override keys list
- ARCHITECTURE.md: update TPM layer description
- README.md: add `tokenWindowMs` to override examples
- README.pt-BR.md: same

## Testing

- TPM budget scales with window size
- Per-model window override works
- RPM window unaffected
- Existing tests pass with new defaults

## Migration

None. New env var `TPM_WINDOW_MS` is optional with safe default.
