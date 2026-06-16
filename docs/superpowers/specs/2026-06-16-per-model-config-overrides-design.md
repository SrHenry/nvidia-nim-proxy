# Per-Model Config Overrides

**Date**: 2026-06-16
**Status**: Draft
**Supersedes**: 2026-06-16-per-model-tpm-throttle-design.md (expands with overrides)

## Problem

Different upstream models have different rate limits (NIM TPM caps), concurrency needs,
and retry tolerance. Currently all throttle parameters are global — one size fits all.
GLM-5.1 may be capped at 300K TPM by NIM while mini-max-m3 can handle 500K TPM,
but the proxy enforces a single `maxTpm` for every model.

## Config Schema

Add a `models` array to `config.js` alongside the existing `thinkingModels`:

```js
models: [
  {
    pattern: /^z-ai\/glm-?5\.?1/i,
    config: {
      maxTpm: 250_000,
      maxConcurrency: 1,
      completionBuffer: 64000,
      cooldownMs: 30 * 60 * 1000,
      minDispatchGapMs: 5000,
      maxRetries: 2,
      retryDelays: [20, 40],
    },
  },
],
```

Overridable parameters (throttle/scheduler only):

| Key | Type | Default | Used by |
|-----|------|---------|---------|
| `maxTpm` | number | `config.maxTpm` (250K) | TPM enforcer |
| `maxConcurrency` | number | `config.maxConcurrency` (2) | Scheduler |
| `completionBuffer` | number | `config.completionBuffer` (48000) | Token estimator |
| `cooldownMs` | number | `config.cooldownMs` (60min) | RPM enforcer (per-model) |
| `minDispatchGapMs` | number | `config.minDispatchGapMs` (floor(60K/maxRpm)) | Scheduler |
| `maxRetries` | number | `config.maxRetries` (3) | NIM client |
| `retryDelays` | number[] | `config.retryDelays` ([20,40,60]) | NIM client |

## Model Config Resolver

New file: `src/domain/model-config-resolver.js`

```js
export function createModelConfigResolver(globalConfig) {
  const overrides = (globalConfig.models || []).map(m => ({
    pattern: m.pattern,
    overrides: m.config || {},
  }));

  return {
    resolve(model, key) {
      if (!model) return globalConfig[key];
      for (const o of overrides) {
        if (o.pattern.test(model)) {
          if (o.overrides[key] !== undefined) return o.overrides[key];
        }
      }
      return globalConfig[key];
    },
    getMatchedOverrides(model) {
      if (!model) return null;
      for (const o of overrides) {
        if (o.pattern.test(model)) return o.overrides;
      }
      return null;
    },
  };
}
```

### Resolver API

- `resolve(model, key)` — returns effective value: model override if matched, else global default
- `getMatchedOverrides(model)` — returns the full override object if model matches a rule, else `null`. Used when we need to detect *whether* an override exists (e.g., cooldown bifurcation).

## Component Changes

### rate-limiter.js — createTpmEnforcer

**Change**: Replace captured `const maxTpm = config.maxTpm` with dynamic resolution.

```js
export function createTpmEnforcer(config, resolveModelConfig) {
  // was: const maxTpm = config.maxTpm;

  function canDispatchForModel(model, estimatedTokens) {
    if (estimatedTokens <= 0) return true;
    const ms = getOrCreateModelState(model);
    pruneModelTokens(ms);
    const maxTpm = resolveModelConfig(model, 'maxTpm');
    return tokensInWindow(ms) + ms.pendingTokens + estimatedTokens <= maxTpm;
  }

  function timeUntilModelAllowed(model, estimatedTokens) {
    if (estimatedTokens <= 0) return 0;
    const ms = getOrCreateModelState(model);
    pruneModelTokens(ms);
    const maxTpm = resolveModelConfig(model, 'maxTpm');
    const available = maxTpm - (tokensInWindow(ms) + ms.pendingTokens);
    if (estimatedTokens <= available) return 0;
    if (ms.tokenTimestamps.length === 0) return 1000;
    const wait = ms.tokenTimestamps[0].ts + config.windowMs - now();
    return wait > 0 ? wait : 1000;
  }
}
```

**API surface**: unchanged (already model-aware).

### rate-limiter.js — createRpmEnforcer

**Change**: Accept `resolveModelConfig` param. Add per-model cooldown tracking.

```js
export function createRpmEnforcer(config, resolveModelConfig) {
  const state = {
    dispatchTimestamps: [],
    completionTimestamps: [],
    cooldownUntil: 0,       // global cooldown
    adaptiveLimit: config.maxRpm,
    modelCooldowns: {},     // { modelName: untilMs }
  };

  function getCooldownForModel(model) {
    const overrides = resolveModelConfig.getMatchedOverrides(model);
    const hasOverride = overrides && 'cooldownMs' in overrides;
    if (hasOverride && state.modelCooldowns[model]) {
      return state.modelCooldowns[model];
    }
    return state.cooldownUntil;
  }

  function canDispatch(model) {
    if (getCooldownForModel(model) > now()) return false;
    pruneWindows();
    return currentUsage() < state.adaptiveLimit;
  }

  function timeUntilDispatchAllowed(model) {
    const cd = getCooldownForModel(model);
    if (cd > now()) return Math.min(cd - now(), 5000);
    pruneWindows();
    if (currentUsage() >= state.adaptiveLimit) {
      const wait = state.dispatchTimestamps[0] + config.windowMs - now();
      return wait > 0 ? wait : 0;
    }
    return 0;
  }

  function enterCooldown(model) {
    const overrides = resolveModelConfig.getMatchedOverrides(model);
    const hasOverride = overrides && 'cooldownMs' in overrides;

    if (hasOverride) {
      state.modelCooldowns[model] = now() + overrides.cooldownMs;
      // NO adaptiveLimit decrement for per-model cooldown
    } else {
      state.cooldownUntil = now() + config.cooldownMs;
      if (state.adaptiveLimit > 5) state.adaptiveLimit--;
    }
  }

  function getState() {
    return {
      ...state,
      dispatchTimestamps: [...state.dispatchTimestamps],
      completionTimestamps: [...state.completionTimestamps],
      modelCooldowns: { ...state.modelCooldowns },
    };
  }

  function loadState(loaded) {
    if (loaded.dispatchTimestamps) state.dispatchTimestamps = loaded.dispatchTimestamps;
    if (loaded.completionTimestamps) state.completionTimestamps = loaded.completionTimestamps;
    if (loaded.cooldownUntil) state.cooldownUntil = loaded.cooldownUntil;
    if (loaded.adaptiveLimit != null) state.adaptiveLimit = loaded.adaptiveLimit;
    if (loaded.modelCooldowns) state.modelCooldowns = loaded.modelCooldowns;
    pruneWindows();
  }
}
```

**API surface change**: `canDispatch()` → `canDispatch(model)`, `timeUntilDispatchAllowed()` → `timeUntilDispatchAllowed(model)`, `enterCooldown()` → `enterCooldown(model)`. Backwards compat via optional param defaulting to `''`.

### rate-limiter.js — createRateLimiter

Thread `model` through to all RPM calls:

```js
export function createRateLimiter(config, resolveModelConfig) {
  const rpm = createRpmEnforcer(config, resolveModelConfig);
  const tpm = createTpmEnforcer(config, resolveModelConfig);

  function canDispatch(model, path, estimatedTokens = 0) {
    if (!rpm.canDispatch(model)) return false;
    if (isInferencePath(path)) {
      return tpm.canDispatchForModel(model, estimatedTokens);
    }
    return true;
  }

  function timeUntilDispatchAllowed(model, path, estimatedTokens = 0) {
    return Math.max(
      rpm.timeUntilDispatchAllowed(model),
      isInferencePath(path) ? tpm.timeUntilModelAllowed(model, estimatedTokens) : 0
    );
  }

  function recordDispatch(model, path, estimatedTokens = 0) {
    rpm.recordDispatch();
    if (isInferencePath(path)) tpm.reserveTokens(model, estimatedTokens);
  }

  function recordCompletion(model, path) {
    rpm.recordCompletion();
  }

  function enterCooldown(model) {
    rpm.enterCooldown(model);
  }

  // ... rest unchanged (getState, loadState, etc.)
}
```

### scheduler.js

Accept `resolveModelConfig`, use resolved values for per-model parameters:

```js
export function createScheduler(config, rateLimiter, processJob, estimateJobTokens, logger, resolveModelConfig) {
  // In the loop:
  const model = job.body?.model || 'unknown';
  const maxConc = resolveModelConfig(model, 'maxConcurrency');
  if (active >= maxConc) { await sleep(25); continue; }

  // Gap calculation:
  const gapMs = resolveModelConfig(model, 'minDispatchGapMs');
  const modelMaxTpm = resolveModelConfig(model, 'maxTpm');
  const gap = Math.max(
    gapMs,
    Math.ceil(estimated * config.windowMs / Math.max(modelMaxTpm, 1))
  );
}
```

### nim-client.js

Accept `resolveModelConfig`, use resolved values for retry params:

```js
export function createNimClient(config, authLoader, modelInjector, logger, resolveModelConfig) {
  async function send({ method, path, body, headers }) {
    const model = body?.model;
    const maxRetries = resolveModelConfig(model, 'maxRetries');
    const retryDelays = resolveModelConfig(model, 'retryDelays');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = retryDelays[attempt - 1] ?? retryDelays[retryDelays.length - 1];
        await sleep(delay * 1000);
      }
      // ...
    }
  }
}
```

### index.js — estimateJobTokens

Currently uses `config.completionBuffer`. Change to use resolver:

```js
function estimateJobTokens(body, resolveModelConfig) {
  if (!body?.messages) return 0;
  const buffer = resolveModelConfig(body?.model, 'completionBuffer');
  return tokenizer.estimateMessageTokens(body.messages) + buffer;
}
```

Call site in scheduler:
```js
const estimated = estimateJobTokens(job.body, resolveModelConfig);
```

### index.js — cooldown persistence

```js
// When 429 exhausted:
rateLimiter.enterCooldown(model);
const state = rateLimiter.getState();
throttleRepo.setState({
  adaptiveLimit: state.adaptiveLimit,
  cooldownUntil: state.cooldownUntil,
  modelCooldowns: state.modelCooldowns,
});
throttleRepo.saveAllModelStates(rateLimiter.getAllModelStates());
```

### index.js — startup state load

```js
const loadedState = throttleRepo.getState();
if (loadedState) {
  rateLimiter.loadState({
    cooldownUntil: loadedState.cooldownUntil,
    adaptiveLimit: loadedState.adaptiveLimit,
    modelCooldowns: loadedState.modelCooldowns || {},
  });
}
```

## Data Persistence

### throttle_state table

Current columns:
- `id` (INTEGER PK)
- `adaptive_limit` (INTEGER)
- `cooldown_until` (INTEGER — BigInt ms timestamp)
- `updated_at` (INTEGER)

**Change**: Add `model_cooldowns` column (TEXT — JSON blob). Stores `{"modelName": untilMs}`.

### model_throttle_state table

Current columns: `model`, `token_timestamps` (TEXT — JSON), `pending_tokens` (INTEGER), `updated_at` (INTEGER).

No schema change needed — per-model cooldowns are stored in `throttle_state.model_cooldowns` JSON blob.

### throttle-repository.js changes

`getState()` — add `modelCooldowns` parse:
```js
const modelCooldowns = row.model_cooldowns
  ? JSON.parse(row.model_cooldowns)
  : {};
return { adaptiveLimit: Number(row.adaptive_limit), cooldownUntil: Number(row.cooldown_until), modelCooldowns, updatedAt: Number(row.updated_at) };
```

`setState()` — add `modelCooldowns` upsert:
```js
INSERT INTO throttle_state (id, adaptive_limit, cooldown_until, model_cooldowns, updated_at)
VALUES (1, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  adaptive_limit = excluded.adaptive_limit,
  cooldown_until = excluded.cooldown_until,
  model_cooldowns = excluded.model_cooldowns,
  updated_at = excluded.updated_at
```

### Migration V3

New migration: `migrations/<ts>-model-config-overrides.js`

```sql
ALTER TABLE throttle_state ADD COLUMN model_cooldowns TEXT NOT NULL DEFAULT '{}';
```

## Cooldown Semantics

| Scenario | Behavior | adaptiveLimit |
|----------|----------|---------------|
| No override, 429 exhausted | Global cooldown, everything stops | Decremented (floor 5) |
| Has cooldownMs override, 429 exhausted | Only that model enters cooldown. Other models unaffected. | NOT decremented |
| Both global + per-model cooldown active | Model passes only if BOTH cooldowns expired (AND gate) | N/A |

## Test Strategy

1. **Unit: model-config-resolver.test.js** — match by model name, fallback to global, case insensitivity, no match, null model
2. **Unit: rate-limiter.test.js** — TPM enforcer with per-model maxTpm (different models get different limits), RPM enforcer with per-model cooldown (independent timers, global fallback), enterCooldown per-model vs global, enterCooldown preserves adaptiveLimit for per-model
3. **Unit: scheduler.test.js** — per-model maxConcurrency and minDispatchGapMs (create new or extend existing)
4. **Unit: nim-client.test.js** — per-model maxRetries and retryDelays
5. **Integration: index.js wiring test** — resolveModelConfig created and threaded correctly

## Files Changed

| File | Change |
|------|--------|
| `src/config.js` | Add `models` array |
| `src/domain/model-config-resolver.js` | **NEW** |
| `src/domain/rate-limiter.js` | createTpmEnforcer: dynamic maxTpm; createRpmEnforcer: per-model cooldown, model param |
| `src/domain/scheduler.js` | Accept resolver, per-model maxConcurrency/minDispatchGapMs/maxTpm |
| `src/infrastructure/nim-client.js` | Accept resolver, per-model maxRetries/retryDelays |
| `src/infrastructure/database/throttle-repository.js` | Persist/load modelCooldowns JSON |
| `src/index.js` | Wire resolver, per-model completionBuffer, pass model to enterCooldown |
| `migrations/<ts>-model-config-overrides.js` | V3: add model_cooldowns column to throttle_state |
| `tests/domain/model-config-resolver.test.js` | **NEW** |
| `tests/domain/rate-limiter.test.js` | Extend for per-model TPM + cooldown tests |
| `tests/domain/scheduler.test.js` | Extend for per-model concurrency/gap tests |
| `tests/infrastructure/nim-client.test.js` | Extend for per-model retry tests |
| `docs/ARCHITECTURE.md` | Update |
| `docs/AGENTS.md` | Update |
| `README.md` | Update |
