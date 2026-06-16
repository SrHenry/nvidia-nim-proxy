const INFERENCE_PATHS = ['/v1/chat', '/v1/completions'];

function isInferencePath(path) {
  if (!path) return false;
  return INFERENCE_PATHS.some(p => path.startsWith(p));
}

export function createRpmEnforcer(config) {
  const state = {
    dispatchTimestamps: [],
    completionTimestamps: [],
    cooldownUntil: 0,
    adaptiveLimit: config.maxRpm,
  };

  function now() {
    return Date.now();
  }

  function pruneWindows() {
    const cutoff = now() - config.windowMs;
    state.dispatchTimestamps = state.dispatchTimestamps.filter(ts => ts > cutoff);
    state.completionTimestamps = state.completionTimestamps.filter(ts => ts > cutoff);
  }

  function currentUsage() {
    pruneWindows();
    return state.dispatchTimestamps.length;
  }

  function canDispatch() {
    if (state.cooldownUntil > now()) return false;
    pruneWindows();
    return currentUsage() < state.adaptiveLimit;
  }

  function timeUntilDispatchAllowed() {
    const currentTime = now();
    if (state.cooldownUntil > currentTime) {
      return Math.min(state.cooldownUntil - currentTime, 5000);
    }
    pruneWindows();
    if (currentUsage() >= state.adaptiveLimit) {
      const oldest = state.dispatchTimestamps[0];
      const rpmWait = oldest + config.windowMs - currentTime;
      return rpmWait > 0 ? rpmWait : 0;
    }
    return 0;
  }

  function recordDispatch() {
    state.dispatchTimestamps.push(now());
  }

  function recordCompletion() {
    state.completionTimestamps.push(now());
  }

  function enterCooldown() {
    state.cooldownUntil = now() + config.cooldownMs;
    if (state.adaptiveLimit > 5) {
      state.adaptiveLimit--;
    }
  }

  function getState() {
    return state;
  }

  function loadState(loaded) {
    if (loaded.dispatchTimestamps) {
      state.dispatchTimestamps = loaded.dispatchTimestamps;
    }
    if (loaded.completionTimestamps) {
      state.completionTimestamps = loaded.completionTimestamps;
    }
    if (loaded.cooldownUntil) {
      state.cooldownUntil = loaded.cooldownUntil;
    }
    if (loaded.adaptiveLimit != null) {
      state.adaptiveLimit = loaded.adaptiveLimit;
    }
    pruneWindows();
  }

  return {
    canDispatch,
    timeUntilDispatchAllowed,
    recordDispatch,
    recordCompletion,
    enterCooldown,
    getState,
    loadState,
    currentUsage,
  };
}

export function createTpmEnforcer(config) {
  const maxTpm = config.maxTpm || 250_000;
  const modelStates = new Map();

  function getOrCreateModelState(model) {
    let ms = modelStates.get(model);
    if (!ms) {
      ms = { tokenTimestamps: [], pendingTokens: 0 };
      modelStates.set(model, ms);
    }
    return ms;
  }

  function now() {
    return Date.now();
  }

  function pruneModelTokens(modelState) {
    const cutoff = now() - config.windowMs;
    modelState.tokenTimestamps = modelState.tokenTimestamps.filter(t => t.ts > cutoff);
  }

  function tokensInWindow(modelState) {
    pruneModelTokens(modelState);
    return modelState.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
  }

  function canDispatchForModel(model, estimatedTokens) {
    if (estimatedTokens <= 0) return true;
    const ms = getOrCreateModelState(model);
    pruneModelTokens(ms);
    const inFlight = ms.pendingTokens;
    return tokensInWindow(ms) + inFlight + estimatedTokens <= maxTpm;
  }

  function timeUntilModelAllowed(model, estimatedTokens) {
    if (estimatedTokens <= 0) return 0;
    const ms = getOrCreateModelState(model);
    pruneModelTokens(ms);
    const inFlight = ms.pendingTokens;
    const available = maxTpm - (tokensInWindow(ms) + inFlight);
    if (estimatedTokens <= available) return 0;
    if (ms.tokenTimestamps.length === 0) return 1000;
    const oldest = ms.tokenTimestamps[0];
    const wait = oldest.ts + config.windowMs - now();
    return wait > 0 ? wait : 1000;
  }

  function reserveTokens(model, estimated) {
    if (estimated <= 0) return;
    const ms = getOrCreateModelState(model);
    ms.pendingTokens += estimated;
  }

  function recordTokenUsage(model, tokens) {
    if (tokens <= 0) return;
    const ms = getOrCreateModelState(model);
    pruneModelTokens(ms);
    ms.pendingTokens = Math.max(0, ms.pendingTokens - tokens);
    ms.tokenTimestamps.push({ ts: now(), tokens });
  }

  function currentTokenUsage(model) {
    const ms = modelStates.get(model);
    if (!ms) return 0;
    pruneModelTokens(ms);
    return tokensInWindow(ms);
  }

  function getAllModelStates() {
    const result = {};
    for (const [model, ms] of modelStates) {
      pruneModelTokens(ms);
      result[model] = {
        tokenTimestamps: ms.tokenTimestamps,
        pendingTokens: ms.pendingTokens,
      };
    }
    return result;
  }

  function loadModelStates(states) {
    for (const [model, data] of Object.entries(states)) {
      const ms = getOrCreateModelState(model);
      ms.tokenTimestamps = data.tokenTimestamps || [];
      ms.pendingTokens = data.pendingTokens || 0;
    }
  }

  return {
    canDispatchForModel,
    timeUntilModelAllowed,
    reserveTokens,
    recordTokenUsage,
    currentTokenUsage,
    getAllModelStates,
    loadModelStates,
  };
}

export function createRateLimiter(config) {
  const rpm = createRpmEnforcer(config);
  const tpm = createTpmEnforcer(config);

  function canDispatch(model, path, estimatedTokens = 0) {
    if (!rpm.canDispatch()) return false;
    if (isInferencePath(path)) {
      return tpm.canDispatchForModel(model, estimatedTokens);
    }
    return true;
  }

  function timeUntilDispatchAllowed(model, path, estimatedTokens = 0) {
    const rpmWait = rpm.timeUntilDispatchAllowed();
    let tpmWait = 0;
    if (isInferencePath(path)) {
      tpmWait = tpm.timeUntilModelAllowed(model, estimatedTokens);
    }
    return Math.max(rpmWait, tpmWait);
  }

  function recordDispatch(model, path, estimatedTokens = 0) {
    rpm.recordDispatch();
    if (isInferencePath(path)) {
      tpm.reserveTokens(model, estimatedTokens);
    }
  }

  function recordCompletion(model, path) {
    rpm.recordCompletion();
  }

  function recordTokenUsage(model, tokens) {
    tpm.recordTokenUsage(model, tokens);
  }

  function enterCooldown() {
    rpm.enterCooldown();
  }

  function getState() {
    return rpm.getState();
  }

  function loadState(loaded) {
    rpm.loadState(loaded);
    if (loaded.modelStates) {
      tpm.loadModelStates(loaded.modelStates);
    }
  }

  function currentUsage() {
    return rpm.currentUsage();
  }

  function currentTokenUsage(model) {
    return tpm.currentTokenUsage(model);
  }

  return {
    canDispatch,
    timeUntilDispatchAllowed,
    recordDispatch,
    recordCompletion,
    recordTokenUsage,
    enterCooldown,
    getState,
    loadState,
    currentUsage,
    currentTokenUsage,
  };
}
