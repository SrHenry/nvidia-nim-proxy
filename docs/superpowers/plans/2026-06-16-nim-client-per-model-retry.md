# NIM Client Per-Model Retry Parameters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable per-model retry parameters (`maxRetries`, `retryDelays`) in the NIM client using the model config resolver.

**Architecture:** Add an optional `resolveModelConfig` parameter to `createNimClient`. When provided, use it to resolve per-model values; otherwise fall back to global config. Backward compatible with existing callers that pass 4 arguments.

**Tech Stack:** JavaScript (ES modules), existing codebase patterns.

---

## File Structure

- **Modify:** `src/infrastructure/nim-client.js` — update `createNimClient` signature and `send` function.

## Task 1: Update `createNimClient` signature and implement per-model resolution

**Files:**
- Modify: `src/infrastructure/nim-client.js:7-126`

- [ ] **Step 1: Update function signature and add fallback resolver**

Replace line 7:

```js
export function createNimClient(config, authLoader, modelInjector, logger) {
```

With:

```js
export function createNimClient(config, authLoader, modelInjector, logger, resolveModelConfig) {
  const rmc = resolveModelConfig || { resolve: (m, k) => config[k], getMatchedOverrides: () => null };
```

- [ ] **Step 2: Resolve per-model params in `send` function**

Inside `send`, after line 30 (after `patchedBody`), add:

```js
    const model = body?.model;
    const maxRetries = rmc.resolve(model, 'maxRetries');
    const retryDelays = rmc.resolve(model, 'retryDelays');
```

- [ ] **Step 3: Replace global config references with resolved values**

Replace `config.maxRetries` with `maxRetries` and `config.retryDelays` with `retryDelays` in the following locations:

1. Line 36: `for (let attempt = 0; attempt <= config.maxRetries; attempt++)` → `for (let attempt = 0; attempt <= maxRetries; attempt++)`
2. Line 39: `config.retryDelays[attempt - 1]` → `retryDelays[attempt - 1]`
3. Line 40: `config.retryDelays[config.retryDelays.length - 1]` → `retryDelays[retryDelays.length - 1]`
4. Line 74: `if (attempt === config.maxRetries)` → `if (attempt === maxRetries)`
5. Line 101: `maxRetries: config.maxRetries,` → `maxRetries,` (in the logger.warn object)
6. Line 110: `if (attempt === config.maxRetries)` → `if (attempt === maxRetries)`
7. Line 112: `` `429 exhausted ${config.maxRetries + 1} attempts` `` → `` `429 exhausted ${maxRetries + 1} attempts` ``

- [ ] **Step 4: Verify no remaining references to `config.maxRetries` or `config.retryDelays`**

Search the file for `config.maxRetries` and `config.retryDelays`. Ensure none remain.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/nim-client.js
git commit -m "feat: nim client per-model maxRetries/retryDelays"
```