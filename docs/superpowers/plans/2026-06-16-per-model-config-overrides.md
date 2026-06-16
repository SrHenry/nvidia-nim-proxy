# Per-Model Config Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-model override capability for throttle/scheduler parameters via `models` config array + `createModelConfigResolver`.

**Architecture:** `createModelConfigResolver(globalConfig)` → `{ resolve(model, key), getMatchedOverrides(model) }`. Threaded through rate-limiter (TPM dynamic maxTpm, RPM per-model cooldown), scheduler (per-model maxConcurrency/minDispatchGapMs/maxTpm), NIM client (per-model maxRetries/retryDelays), index.js (per-model completionBuffer). V3 migration adds `model_cooldowns` TEXT JSON column. All resolver params optional — fallback returns global config when no override matches.

**Tech Stack:** Node.js, Fastify v5, better-sqlite3, vitest

---

### Task 1: Model Config Resolver + Tests

**Files:**
- Create: `src/domain/model-config-resolver.js`
- Create: `tests/domain/model-config-resolver.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/domain/model-config-resolver.test.js
import { describe, it, expect } from 'vitest';
import { createModelConfigResolver } from '../../src/domain/model-config-resolver.js';

function makeConfig(overrides = []) {
  return {
    maxTpm: 250000,
    maxConcurrency: 2,
    cooldownMs: 3600000,
    models: overrides.map(o => ({ pattern: new RegExp(o.pattern, 'i'), config: o.config })),
  };
}

describe('createModelConfigResolver', () => {
  it('returns global default when no models configured', () => {
    const r = createModelConfigResolver(makeConfig());
    expect(r.resolve('any-model', 'maxTpm')).toBe(250000);
  });

  it('returns override when model matches pattern', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve('z-ai/glm-5.1', 'maxTpm')).toBe(100000);
  });

  it('returns global default when model does not match any pattern', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve('other-model', 'maxTpm')).toBe(250000);
  });

  it('returns override for multi-key config', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000, maxConcurrency: 1 } },
    ]));
    expect(r.resolve('z-ai/glm-5.1', 'maxTpm')).toBe(100000);
    expect(r.resolve('z-ai/glm-5.1', 'maxConcurrency')).toBe(1);
    expect(r.resolve('z-ai/glm-5.1', 'cooldownMs')).toBe(3600000);
  });

  it('is case insensitive via i flag in pattern', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve('Z-AI/GLM-5.1', 'maxTpm')).toBe(100000);
  });

  it('returns null from getMatchedOverrides when no match', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.getMatchedOverrides('other-model')).toBeNull();
  });

  it('returns override object from getMatchedOverrides on match', () => {
    const cfg = { maxTpm: 100000, cooldownMs: 600000 };
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: cfg },
    ]));
    expect(r.getMatchedOverrides('z-ai/glm-5.1')).toEqual(cfg);
  });

  it('returns global default when model is null/undefined', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai/glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve(null, 'maxTpm')).toBe(250000);
    expect(r.resolve(undefined, 'maxTpm')).toBe(250000);
  });

  it('first matching pattern wins', () => {
    const r = createModelConfigResolver(makeConfig([
      { pattern: '^z-ai', config: { maxTpm: 50000 } },
      { pattern: 'glm', config: { maxTpm: 100000 } },
    ]));
    expect(r.resolve('z-ai/glm-5.1', 'maxTpm')).toBe(50000);
  });
});
```

Run: `npx vitest run tests/domain/model-config-resolver.test.js`
Expected: FAIL (module not found)

- [ ] **Step 2: Write implementation**

```js
// src/domain/model-config-resolver.js
export function createModelConfigResolver(globalConfig) {
  const overrides = (globalConfig.models || []).map(m => ({
    pattern: m.pattern,
    overrides: m.config || {},
  }));

  function resolve(model, key) {
    if (!model) return globalConfig[key];
    for (const o of overrides) {
      if (o.pattern.test(model)) {
        if (o.overrides[key] !== undefined) return o.overrides[key];
      }
    }
    return globalConfig[key];
  }

  function getMatchedOverrides(model) {
    if (!model) return null;
    for (const o of overrides) {
      if (o.pattern.test(model)) return o.overrides;
    }
    return null;
  }

  return { resolve, getMatchedOverrides };
}
```

- [ ] **Step 3: Run tests to verify pass**

Run: `npx vitest run tests/domain/model-config-resolver.test.js`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/domain/model-config-resolver.js tests/domain/model-config-resolver.test.js
git commit -m "feat: add createModelConfigResolver"
```

### Task 2: Rate-Limiter — TPM dynamic maxTpm

**Files:**
- Modify: `src/domain/rate-limiter.js`
- Modify: `tests/domain/rate-limiter.test.js`

- [ ] **Step 1: Add per-model maxTpm tests to rate-limiter.test.js**

After the existing `createTpmEnforcer` describe block, add:

```js
describe('createTpmEnforcer with per-model maxTpm', () => {
  let tpm;
  const resolver = {
    resolve: (model, key) => {
      if (model === 'glm-5.1' && key === 'maxTpm') return 500;
      if (model === 'mini-max' && key === 'maxTpm') return 2000;
      return 1000;
    },
    getMatchedOverrides: () => null,
  };

  beforeEach(() => {
    tpm = createTpmEnforcer({ windowMs: 60_000, maxTpm: 1000 }, resolver);
  });

  it('uses per-model maxTpm when set', () => {
    expect(tpm.canDispatchForModel('glm-5.1', 600)).toBe(false);
    expect(tpm.canDispatchForModel('glm-5.1', 400)).toBe(true);
    expect(tpm.canDispatchForModel('mini-max', 1500)).toBe(true);
    expect(tpm.canDispatchForModel('mini-max', 2500)).toBe(false);
  });

  it('falls back to global maxTpm for unconfigured models', () => {
    expect(tpm.canDispatchForModel('unknown', 1100)).toBe(false);
    expect(tpm.canDispatchForModel('unknown', 900)).toBe(true);
  });

  it('timeUntilModelAllowed uses per-model maxTpm', () => {
    tpm.recordTokenUsage('glm-5.1', 500);
    const wait = tpm.timeUntilModelAllowed('glm-5.1', 100);
    expect(wait).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Update `createTpmEnforcer` to accept resolver param**

Change `createTpmEnforcer` in `src/domain/rate-limiter.js`:

Replace:
```js
export function createTpmEnforcer(config) {
```
With:
```js
export function createTpmEnforcer(config, resolveModelConfig) {
  const resolve = resolveModelConfig || { resolve: (m, k) => config[k], getMatchedOverrides: () => null };
```

Replace `const maxTpm = config.maxTpm;` in `canDispatchForModel` and `timeUntilModelAllowed` with dynamic `resolve(model, 'maxTpm')`.

Change `canDispatchForModel`:
```js
  function canDispatchForModel(model, estimatedTokens) {
    if (estimatedTokens <= 0) return true;
    const ms = getOrCreateModelState(model);
    pruneModelTokens(ms);
    const maxTpm = resolve(model, 'maxTpm');
    return tokensInWindow(ms) + ms.pendingTokens + estimatedTokens <= maxTpm;
  }
```

Change `timeUntilModelAllowed`:
```js
  function timeUntilModelAllowed(model, estimatedTokens) {
    if (estimatedTokens <= 0) return 0;
    const ms = getOrCreateModelState(model);
    pruneModelTokens(ms);
    const maxTpm = resolve(model, 'maxTpm');
    const available = maxTpm - (tokensInWindow(ms) + ms.pendingTokens);
    if (estimatedTokens <= available) return 0;
    if (ms.tokenTimestamps.length === 0) return 1000;
    const wait = ms.tokenTimestamps[0].ts + config.windowMs - now();
    return wait > 0 ? wait : 1000;
  }
```

- [ ] **Step 3: Run all rate-limiter tests**

Run: `npx vitest run tests/domain/rate-limiter.test.js`
Expected: All PASS (including new per-model tests, existing tests unchanged)

- [ ] **Step 4: Commit**

```bash
git add src/domain/rate-limiter.js tests/domain/rate-limiter.test.js
git commit -m "feat: tpm enforcer per-model maxTpm via resolver"
```

### Task 3: Rate-Limiter — RPM per-model cooldown

**Files:**
- Modify: `src/domain/rate-limiter.js`
- Modify: `tests/domain/rate-limiter.test.js`

- [ ] **Step 1: Add per-model cooldown tests**

After the existing `createRpmEnforcer` tests, add:

```js
describe('createRpmEnforcer with per-model cooldown', () => {
  let rpm;
  const resolver = {
    resolve: (model, key) => {
      if (model === 'glm-5.1' && key === 'cooldownMs') return 10000;
      return 600000;
    },
    getMatchedOverrides: (model) => {
      if (model === 'glm-5.1') return { cooldownMs: 10000 };
      return null;
    },
  };

  beforeEach(() => {
    rpm = createRpmEnforcer({ windowMs: 60_000, maxRpm: 10, cooldownMs: 600000 }, resolver);
  });

  it('global cooldown blocks all models', () => {
    rpm.enterCooldown('unknown');
    expect(rpm.canDispatch('unknown')).toBe(false);
    expect(rpm.canDispatch('glm-5.1')).toBe(false);
  });

  it('per-model cooldown only blocks that model', () => {
    rpm.enterCooldown('glm-5.1');
    expect(rpm.canDispatch('glm-5.1')).toBe(false);
    expect(rpm.canDispatch('other')).toBe(true);
  });

  it('per-model cooldown does not decrement adaptiveLimit', () => {
    const before = rpm.getState().adaptiveLimit;
    rpm.enterCooldown('glm-5.1');
    expect(rpm.getState().adaptiveLimit).toBe(before);
  });

  it('global cooldown decrements adaptiveLimit', () => {
    const before = rpm.getState().adaptiveLimit;
    rpm.enterCooldown('other');
    expect(rpm.getState().adaptiveLimit).toBe(before - 1);
  });

  it('per-model cooldown timeUntilDispatchAllowed returns per-model wait', () => {
    rpm.enterCooldown('glm-5.1');
    const glmWait = rpm.timeUntilDispatchAllowed('glm-5.1');
    const otherWait = rpm.timeUntilDispatchAllowed('other');
    expect(glmWait).toBeGreaterThan(0);
    expect(otherWait).toBe(0);
  });

  it('persists and restores modelCooldowns in getState/loadState', () => {
    rpm.enterCooldown('glm-5.1');
    const state = rpm.getState();
    expect(state.modelCooldowns['glm-5.1']).toBeGreaterThan(0);

    const rpm2 = createRpmEnforcer({ windowMs: 60_000, maxRpm: 10, cooldownMs: 600000 }, resolver);
    rpm2.loadState(state);
    expect(rpm2.canDispatch('glm-5.1')).toBe(false);
    expect(rpm2.canDispatch('other')).toBe(true);
  });
});
```

- [ ] **Step 2: Update `createRpmEnforcer` for per-model cooldown**

In `createRpmEnforcer`:

Replace signature and add fallback:
```js
export function createRpmEnforcer(config, resolveModelConfig) {
  const resolve = resolveModelConfig || { resolve: (m, k) => config[k], getMatchedOverrides: () => null };
```

Update state to include `modelCooldowns`:
```js
  const state = {
    dispatchTimestamps: [],
    completionTimestamps: [],
    cooldownUntil: 0,
    adaptiveLimit: config.maxRpm,
    modelCooldowns: {},
  };
```

Add helper:
```js
  function getCooldownForModel(model) {
    const overrides = resolve.getMatchedOverrides(model);
    const hasOverride = overrides && 'cooldownMs' in overrides;
    if (hasOverride && state.modelCooldowns[model]) {
      return state.modelCooldowns[model];
    }
    return state.cooldownUntil;
  }
```

Change `canDispatch`:
```js
  function canDispatch(model) {
    if (getCooldownForModel(model) > now()) return false;
    pruneWindows();
    return currentUsage() < state.adaptiveLimit;
  }
```

Change `timeUntilDispatchAllowed`:
```js
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
```

Change `enterCooldown`:
```js
  function enterCooldown(model) {
    const overrides = resolve.getMatchedOverrides(model);
    const hasOverride = overrides && 'cooldownMs' in overrides;
    if (hasOverride) {
      state.modelCooldowns[model] = now() + overrides.cooldownMs;
    } else {
      state.cooldownUntil = now() + config.cooldownMs;
      if (state.adaptiveLimit > 5) state.adaptiveLimit--;
    }
  }
```

Update `getState`:
```js
  function getState() {
    return {
      ...state,
      dispatchTimestamps: [...state.dispatchTimestamps],
      completionTimestamps: [...state.completionTimestamps],
      modelCooldowns: { ...state.modelCooldowns },
    };
  }
```

Update `loadState`:
```js
  function loadState(loaded) {
    if (loaded.dispatchTimestamps) state.dispatchTimestamps = loaded.dispatchTimestamps;
    if (loaded.completionTimestamps) state.completionTimestamps = loaded.completionTimestamps;
    if (loaded.cooldownUntil) state.cooldownUntil = loaded.cooldownUntil;
    if (loaded.adaptiveLimit != null) state.adaptiveLimit = loaded.adaptiveLimit;
    if (loaded.modelCooldowns) state.modelCooldowns = loaded.modelCooldowns;
    pruneWindows();
  }
```

- [ ] **Step 3: Update `createRateLimiter` composition factory**

Replace signature and pass resolver to enforcers:
```js
export function createRateLimiter(config, resolveModelConfig) {
  const rpm = createRpmEnforcer(config, resolveModelConfig);
  const tpm = createTpmEnforcer(config, resolveModelConfig);
```

Thread model param:
```js
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
```

- [ ] **Step 4: Run all rate-limiter tests**

Run: `npx vitest run tests/domain/rate-limiter.test.js`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/rate-limiter.js tests/domain/rate-limiter.test.js
git commit -m "feat: rpm enforcer per-model cooldown via resolver"
```

### Task 4: Scheduler — per-model params

**Files:**
- Modify: `src/domain/scheduler.js`

- [ ] **Step 1: Update `createScheduler` to accept and use resolver**

Replace `createScheduler` signature:

```js
export function createScheduler(config, rateLimiter, processJob, estimateJobTokens, logger, resolveModelConfig) {
  const rmc = resolveModelConfig || { resolve: (m, k) => config[k], getMatchedOverrides: () => null };
```

In the loop body, replace `config.maxConcurrency` usage:

```js
        if (active >= rmc.resolve(model, 'maxConcurrency')) {
          await sleep(25);
          continue;
        }
```

Replace gap calculation:

```js
        const gap = Math.max(
          rmc.resolve(model, 'minDispatchGapMs'),
          Math.ceil(estimated * config.windowMs / Math.max(rmc.resolve(model, 'maxTpm'), 1))
        );
```

- [ ] **Step 2: Update `estimateJobTokens` call to pass resolver**

The line `const estimated = estimateJobTokens(job.body);` — no need to change in scheduler.js since estimateJobTokens is passed in as a function. The change to `estimateJobTokens` happens in index.js (Task 6).

- [ ] **Step 3: Commit**

```bash
git add src/domain/scheduler.js
git commit -m "feat: scheduler per-model maxConcurrency/minDispatchGapMs/maxTpm"
```

### Task 5: NIM Client — per-model retry params

**Files:**
- Modify: `src/infrastructure/nim-client.js`

- [ ] **Step 1: Update `createNimClient` to accept and use resolver**

Replace signature:

```js
export function createNimClient(config, authLoader, modelInjector, logger, resolveModelConfig) {
  const rmc = resolveModelConfig || { resolve: (m, k) => config[k], getMatchedOverrides: () => null };
```

In `send`, resolve per-model params:

```js
    const model = body?.model;
    const maxRetries = rmc.resolve(model, 'maxRetries');
    const retryDelays = rmc.resolve(model, 'retryDelays');
```

Then use `maxRetries` and `retryDelays` instead of `config.maxRetries` and `config.retryDelays` throughout the function.

- [ ] **Step 2: Commit**

```bash
git add src/infrastructure/nim-client.js
git commit -m "feat: nim client per-model maxRetries/retryDelays"
```

### Task 6: Throttle Repository — modelCooldowns persistence

**Files:**
- Modify: `src/infrastructure/database/throttle-repository.js`

- [ ] **Step 1: Update `getState` to return modelCooldowns**

Replace the return in `getState`:

```js
    const modelCooldowns = row.model_cooldowns
      ? JSON.parse(row.model_cooldowns)
      : {};
    return {
      adaptiveLimit: Number(row.adaptive_limit),
      cooldownUntil: Number(row.cooldown_until),
      modelCooldowns,
      updatedAt: Number(row.updated_at),
    };
```

- [ ] **Step 2: Update `setState` to persist modelCooldowns**

Replace the INSERT...ON CONFLICT query:

```js
    this.db.connection
      .prepare(`
        INSERT INTO throttle_state (id, adaptive_limit, cooldown_until, model_cooldowns, updated_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          adaptive_limit = excluded.adaptive_limit,
          cooldown_until = excluded.cooldown_until,
          model_cooldowns = excluded.model_cooldowns,
          updated_at = excluded.updated_at
      `)
      .run(adaptiveLimit, cooldownUntil, JSON.stringify(modelCooldowns), updatedAt);
```

And add `modelCooldowns` to the destructure:

```js
    const modelCooldowns = partial.modelCooldowns ?? current.modelCooldowns;
```

- [ ] **Step 3: Run existing throttle-repository tests**

Run: `npx vitest run tests/infrastructure/database/throttle-repository.test.js`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/database/throttle-repository.js
git commit -m "feat: persist modelCooldowns in throttle_state"
```

### Task 7: V3 Migration — add model_cooldowns column

**Files:**
- Create: `migrations/<ts>-model-config-overrides.js`

- [ ] **Step 1: Generate migration timestamp**

Run: `node -e "console.log(BigInt(Date.now())*1000000n + BigInt(process.hrtime().bigint%1000000n))"`
Use the output as the version number.

- [ ] **Step 2: Create migration file**

```js
// migrations/<ts>-model-config-overrides.js
export const version = <ts>n;
export const description = 'add model_cooldowns to throttle_state';

export function up(db) {
  db.exec(`
    ALTER TABLE throttle_state ADD COLUMN model_cooldowns TEXT NOT NULL DEFAULT '{}';
  `);
}

export function down(db) {
  // SQLite does not support DROP COLUMN before 3.35.0.
  // Create new table without the column, copy data, drop old, rename.
  db.exec(`
    CREATE TABLE IF NOT EXISTS throttle_state_new (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      adaptive_limit INTEGER NOT NULL DEFAULT 25,
      cooldown_until INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL
    );
    INSERT INTO throttle_state_new (id, adaptive_limit, cooldown_until, updated_at)
      SELECT id, adaptive_limit, cooldown_until, updated_at FROM throttle_state;
    DROP TABLE throttle_state;
    ALTER TABLE throttle_state_new RENAME TO throttle_state;
  `);
}
```

- [ ] **Step 3: Apply migration**

Run: `npm run migrate`
Expected: Applies V3

- [ ] **Step 4: Verify migration**

Run: `sqlite3 oc-proxy.db "PRAGMA table_info(throttle_state);" | grep model_cooldowns`
Expected: Shows model_cooldowns column

- [ ] **Step 5: Commit**

```bash
git add migrations/<ts>-model-config-overrides.js
git commit -m "feat: v3 migration add model_cooldowns column"
```

### Task 8: Config + Index wiring

**Files:**
- Modify: `src/config.js`
- Modify: `src/index.js`

- [ ] **Step 1: Add `models` array to config**

In `src/config.js`, add after the `thinkingModels` array:

```js
  models: [],
```

- [ ] **Step 2: Wire resolver in index.js**

After `const modelInjector = createModelInjector(config);`, add:

```js
import { createModelConfigResolver } from './domain/model-config-resolver.js';
```

```js
const modelConfigResolver = createModelConfigResolver(config);
```

Replace `const rateLimiter = createRateLimiter(config);` with:

```js
const rateLimiter = createRateLimiter(config, modelConfigResolver);
```

Replace `const nimClient = createNimClient(config, authLoader, modelInjector, null);` with:

```js
const nimClient = createNimClient(config, authLoader, modelInjector, null, modelConfigResolver);
```

Replace scheduler creation:
```js
const scheduler = createScheduler(config, rateLimiter, processJob, estimateJobTokens, null, modelConfigResolver);
```

- [ ] **Step 3: Update `estimateJobTokens` for per-model completionBuffer**

```js
function estimateJobTokens(body, resolveModelConfig) {
  if (!body?.messages) return 0;
  const buffer = resolveModelConfig(body?.model, 'completionBuffer');
  return tokenizer.estimateMessageTokens(body.messages) + buffer;
}
```

Update call site in scheduler — move the resolver from createScheduler to the call:
Actually, `estimateJobTokens` is passed as a function reference to `createScheduler`. The scheduler calls it with `job.body`. We need the resolver in scope where `estimateJobTokens` is defined, and the scheduler needs to pass model context.

Better approach: keep `estimateJobTokens` capturing `resolveModelConfig` from closure:

```js
function estimateJobTokens(body) {
  if (!body?.messages) return 0;
  const buffer = modelConfigResolver.resolve(body?.model, 'completionBuffer');
  return tokenizer.estimateMessageTokens(body.messages) + buffer;
}
```

This way the scheduler's call site doesn't change:
```js
const estimated = estimateJobTokens(job.body);
```

- [ ] **Step 4: Update cooldown persistence in processJob**

Replace:
```js
      rateLimiter.enterCooldown();
      const state = rateLimiter.getState();
      throttleRepo.setState({
        adaptiveLimit: state.adaptiveLimit,
        cooldownUntil: state.cooldownUntil,
      });
```

With:
```js
      rateLimiter.enterCooldown(model);
      const state = rateLimiter.getState();
      throttleRepo.setState({
        adaptiveLimit: state.adaptiveLimit,
        cooldownUntil: state.cooldownUntil,
        modelCooldowns: state.modelCooldowns,
      });
```

- [ ] **Step 5: Update startup state load**

Replace:
```js
  rateLimiter.loadState({
    cooldownUntil: loadedState.cooldownUntil,
    adaptiveLimit: loadedState.adaptiveLimit,
  });
```

With:
```js
  rateLimiter.loadState({
    cooldownUntil: loadedState.cooldownUntil,
    adaptiveLimit: loadedState.adaptiveLimit,
    modelCooldowns: loadedState.modelCooldowns || {},
  });
```

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/index.js
git commit -m "feat: wire per-model config resolver in index.js"
```

### Task 9: Docs update

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AGENTS.md`
- Modify: `README.md`
- Modify: `README.pt-BR.md` (if exists)
- Modify: `docs/ARCHITECTURE.pt-BR.md` (if exists)

- [ ] **Step 1: Update AGENTS.md**

Add model config resolver to Key Files section, add per-model overrides to Gotchas.

- [ ] **Step 2: Update ARCHITECTURE.md**

Add section describing model config resolver pattern, per-model override flow.

- [ ] **Step 3: Update README.md**

Add `models` config option to documentation.

- [ ] **Step 4: Commit**

```bash
git add docs/AGENTS.md docs/ARCHITECTURE.md README.md
git commit -m "docs: per-model config overrides"
```

### Task 10: Verify all tests pass

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Quick smoke test**

Run: `node -e "import('./src/domain/model-config-resolver.js').then(m => console.log('module OK'))"`
Expected: module OK
