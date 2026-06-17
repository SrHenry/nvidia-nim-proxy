# Configurable TPM Rolling Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple TPM window from RPM window, default TPM to 5 minutes, scale budget by window size, add per-model `tokenWindowMs` override.

**Architecture:** Add `tpmWindowMs` config, modify TPM enforcer to use model-specific window, calculate budget as `maxTpm * (windowMs / 60000)`, add `tokenWindowMs` to override keys.

**Tech Stack:** JavaScript (ES modules), vitest, existing rate-limiter.js pattern

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/config.js` | Modify | Add `tpmWindowMs` env var |
| `src/domain/rate-limiter.js` | Modify | TPM window logic + budget calculation |
| `src/domain/model-config-resolver.js` | Modify | Add `tokenWindowMs` to valid override keys |
| `tests/domain/rate-limiter.test.js` | Modify | Add tests for new window behavior |
| `AGENTS.md` | Modify | Document `tokenWindowMs` override |
| `ARCHITECTURE.md` | Modify | Update TPM layer description |
| `README.md` | Modify | Add `tokenWindowMs` to override examples |
| `README.pt-BR.md` | Modify | Same |

---

### Task 1: Add tpmWindowMs to config.js

**Files:**
- Modify: `src/config.js:26-48`

- [ ] **Step 1: Add tpmWindowMs env var**

```js
const tpmWindowMs = envNumber("TPM_WINDOW_MS", 300_000);
```

- [ ] **Step 2: Add to config export**

In the frozen config object, add after `windowMs`:

```js
windowMs: 60_000,
tpmWindowMs,
```

- [ ] **Step 3: Update models array example**

Update the GLM-5.1 model entry to include `tokenWindowMs` in override:

```js
{
  pattern: /^z-ai\/glm-?5\.?1/i,
  injection: {
    chat_template_kwargs: { enable_thinking: true },
  },
  override: {
    maxTpm: 250_000,
    completionBuffer: 15_000,
    tokenWindowMs: 300_000,
  },
},
```

- [ ] **Step 4: Commit**

```bash
git add src/config.js
git commit -m "feat: add tpmWindowMs config (default 5 min)"
```

---

### Task 2: Modify TPM enforcer to use model-specific window

**Files:**
- Modify: `src/domain/rate-limiter.js:108-208`

- [ ] **Step 1: Write failing test for 5-min window budget scaling**

Add new test block after existing `createTpmEnforcer with per-model maxTpm`:

```js
describe("createTpmEnforcer with configurable window", () => {
  it("scales budget by window size", () => {
    const tpm = createTpmEnforcer({ windowMs: 60_000, tpmWindowMs: 300_000, maxTpm: 1000 });
    // 1-min window: budget = 1000
    // 5-min window: budget = 1000 * (300000/60000) = 5000
    expect(tpm.canDispatchForModel("m", 4000)).toBe(true);
    expect(tpm.canDispatchForModel("m", 6000)).toBe(false);
  });

  it("uses per-model tokenWindowMs override", () => {
    const resolver = {
      resolve: (model, key) => {
        if (model === "short-window" && key === "tokenWindowMs") return 60_000;
        if (model === "long-window" && key === "tokenWindowMs") return 600_000;
        return undefined;
      },
      getMatchedOverrides: () => null,
    };
    const tpm = createTpmEnforcer({ windowMs: 60_000, tpmWindowMs: 300_000, maxTpm: 1000 }, resolver);
    // short-window: 1 min → budget = 1000
    // long-window: 10 min → budget = 10000
    expect(tpm.canDispatchForModel("short-window", 900)).toBe(true);
    expect(tpm.canDispatchForModel("short-window", 1100)).toBe(false);
    expect(tpm.canDispatchForModel("long-window", 9000)).toBe(true);
    expect(tpm.canDispatchForModel("long-window", 11000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/rate-limiter.test.js`
Expected: FAIL — budget not scaled, `tokenWindowMs` not read

- [ ] **Step 3: Add getWindowMs helper to createTpmEnforcer**

Inside `createTpmEnforcer`, after the resolver binding:

```js
function getWindowMs(model) {
  return resolve(model, "tokenWindowMs") || config.tpmWindowMs;
}
```

- [ ] **Step 4: Update pruneModelTokens to accept windowMs parameter**

Change signature and body:

```js
function pruneModelTokens(modelState, windowMs) {
  const cutoff = now() - windowMs;
  modelState.tokenTimestamps = modelState.tokenTimestamps.filter(t => t.ts > cutoff);
}
```

- [ ] **Step 5: Update all pruneModelTokens callers**

Replace every `pruneModelTokens(ms)` call with `pruneModelTokens(ms, getWindowMs(model))`:

- `tokensInWindow` → add `model` parameter: `function tokensInWindow(modelState, model)`
- `canDispatchForModel` → pass model to pruneModelTokens and tokensInWindow
- `timeUntilModelAllowed` → pass model to pruneModelTokens and tokensInWindow
- `recordTokenUsage` → pass model to pruneModelTokens
- `currentTokenUsage` → pass model to pruneModelTokens
- `getAllModelStates` → iterate with model key

Updated functions:

```js
function tokensInWindow(modelState, model) {
  pruneModelTokens(modelState, getWindowMs(model));
  return modelState.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
}

function canDispatchForModel(model, estimatedTokens) {
  if (estimatedTokens <= 0) return true;
  const ms = getOrCreateModelState(model);
  const windowMs = getWindowMs(model);
  pruneModelTokens(ms, windowMs);
  const maxTpm = resolve(model, "maxTpm");
  const budget = maxTpm * (windowMs / 60_000);
  return tokensInWindow(ms, model) + ms.pendingTokens + estimatedTokens <= budget;
}

function timeUntilModelAllowed(model, estimatedTokens) {
  if (estimatedTokens <= 0) return 0;
  const ms = getOrCreateModelState(model);
  const windowMs = getWindowMs(model);
  pruneModelTokens(ms, windowMs);
  const maxTpm = resolve(model, "maxTpm");
  const budget = maxTpm * (windowMs / 60_000);
  const available = budget - (tokensInWindow(ms, model) + ms.pendingTokens);
  if (estimatedTokens <= available) return 0;
  if (ms.tokenTimestamps.length === 0) return 1000;
  const oldest = ms.tokenTimestamps[0];
  const wait = oldest.ts + windowMs - now();
  return wait > 0 ? wait : 1000;
}

function recordTokenUsage(model, tokens) {
  if (tokens <= 0) return;
  const ms = getOrCreateModelState(model);
  pruneModelTokens(ms, getWindowMs(model));
  ms.pendingTokens = Math.max(0, ms.pendingTokens - tokens);
  ms.tokenTimestamps.push({ ts: now(), tokens });
}

function currentTokenUsage(model) {
  const ms = modelStates.get(model);
  if (!ms) return 0;
  pruneModelTokens(ms, getWindowMs(model));
  return tokensInWindow(ms, model);
}

function getAllModelStates() {
  const result = {};
  for (const [model, ms] of modelStates) {
    pruneModelTokens(ms, getWindowMs(model));
    result[model] = {
      tokenTimestamps: ms.tokenTimestamps,
      pendingTokens: ms.pendingTokens,
    };
  }
  return result;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/domain/rate-limiter.test.js`
Expected: All tests pass

- [ ] **Step 7: Update existing tests for new signature**

Update `createTpmEnforcer` beforeEach to include `tpmWindowMs`:

```js
beforeEach(() => {
  tpm = createTpmEnforcer({ windowMs: 60_000, tpmWindowMs: 60_000, maxTpm: 1000 });
});
```

Update `createTpmEnforcer with per-model maxTpm` beforeEach:

```js
beforeEach(() => {
  tpm = createTpmEnforcer({ windowMs: 60_000, tpmWindowMs: 60_000, maxTpm: 1000 }, resolver);
});
```

Update `createRateLimiter (composition)` beforeEach:

```js
beforeEach(() => {
  limiter = createRateLimiter({
    windowMs: 60_000,
    tpmWindowMs: 60_000,
    maxRpm: 10,
    maxTpm: 1000,
    cooldownMs: 600_000,
  });
});
```

- [ ] **Step 8: Run all tests to verify no regressions**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add src/domain/rate-limiter.js tests/domain/rate-limiter.test.js
git commit -m "feat: configurable TPM window with budget scaling and per-model override"
```

---

### Task 3: Add tokenWindowMs to model-config-resolver valid keys

**Files:**
- Modify: `src/domain/model-config-resolver.js`

- [ ] **Step 1: Check current resolver implementation**

Read `src/domain/model-config-resolver.js` to see if it has a valid keys list.

- [ ] **Step 2: Add tokenWindowMs to valid override keys if list exists**

If resolver has explicit valid keys list, add `tokenWindowMs`. Otherwise skip — resolver already passes through any override key.

- [ ] **Step 3: Commit**

```bash
git add src/domain/model-config-resolver.js
git commit -m "feat: add tokenWindowMs to valid override keys"
```

---

### Task 4: Update documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `README.pt-BR.md`

- [ ] **Step 1: Update AGENTS.md override keys list**

In the "Model injection + per-model overrides" gotcha, add `tokenWindowMs` to the override keys:

```
Override keys: `maxTpm`, `maxConcurrency`, `completionBuffer`, `cooldownMs`, `minDispatchGapMs`, `maxRetries`, `retryDelays`, `tokenWindowMs`.
```

- [ ] **Step 2: Update ARCHITECTURE.md TPM layer description**

In "Layer 2 — Token Window (TPM, per-model)", update:

```
Each model gets its own `tokenTimestamps[]` in a configurable rolling window (default 5 min via `tpmWindowMs`). `MAX_TPM` (default 250K) is a per-minute rate — actual budget scales with window: `maxTpm * (tokenWindowMs / 60000)`. Per-model override: `tokenWindowMs`.
```

- [ ] **Step 3: Update README.md override examples**

Add `tokenWindowMs` to the override keys list and example:

```js
models: [
  {
    pattern: /^z-ai\/glm-5\.1$/i,
    override: { maxTpm: 250_000, tokenWindowMs: 300_000 },
  },
],
```

- [ ] **Step 4: Update README.pt-BR.md same changes**

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md ARCHITECTURE.md README.md README.pt-BR.md
git commit -m "docs: document configurable TPM window and tokenWindowMs override"
```

---

### Task 5: Verify and push

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run lint/typecheck if available**

Run: `npm run lint 2>/dev/null || echo "no lint script"`

- [ ] **Step 3: Push to origin**

```bash
git push origin master
```

---

## Self-Review Checklist

- [ ] Spec coverage: all requirements have tasks
- [ ] No placeholders in plan
- [ ] Type consistency: `getWindowMs` used consistently
- [ ] Backward compatibility: `tpmWindowMs` defaults to 5 min, existing behavior changes safely
