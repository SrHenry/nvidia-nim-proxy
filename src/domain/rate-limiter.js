const INFERENCE_PATHS = ['/chat', '/completions'];

function isInferencePath(path) {
  if (!path) return false;
  return INFERENCE_PATHS.some(p => path.startsWith(p));
}

export function createRpmEnforcer(config, resolveModelConfig) {
  const resolve = resolveModelConfig || { resolve: (m, k) => config[k], getMatchedOverrides: () => null };
  const state = {
    dispatchTimestamps: [],
    completionTimestamps: [],
    cooldownUntil: 0,
    adaptiveLimit: config.maxRpm,
    modelCooldowns: {},
  };

  function getCooldownForModel(model) {
    const overrides = resolve.getMatchedOverrides(model);
    const hasOverride = overrides && 'cooldownMs' in overrides;
    if (hasOverride && state.modelCooldowns[model]) {
      return state.modelCooldowns[model];
    }
    return state.cooldownUntil;
  }

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

  function canDispatch(model = '') {
    if (getCooldownForModel(model) > now()) return false;
    pruneWindows();
    return currentUsage() < state.adaptiveLimit;
  }

  function timeUntilDispatchAllowed(model = '') {
    const cd = getCooldownForModel(model);
    if (cd > now()) return Math.min(cd - now(), 5000);
    pruneWindows();
    if (currentUsage() >= state.adaptiveLimit) {
      const wait = state.dispatchTimestamps[0] + config.windowMs - now();
      return wait > 0 ? wait : 0;
    }
    return 0;
  }

  function recordDispatch() {
    state.dispatchTimestamps.push(now());
  }

  function recordCompletion() {
    state.completionTimestamps.push(now());
  }

  function enterCooldown(model = '') {
    const overrides = resolve.getMatchedOverrides(model);
    const hasOverride = overrides && 'cooldownMs' in overrides;
    if (hasOverride) {
      state.modelCooldowns[model] = now() + overrides.cooldownMs;
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

export function createTpmEnforcer(config, resolveModelConfig) {
  const fallback = { resolve: (m, k) => config[k], getMatchedOverrides: () => null };
  const resolver = resolveModelConfig || fallback;
  const resolve = resolver.resolve.bind(resolver);
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

  function getWindowMs(model) {
    return resolve(model, "tokenWindowMs") ?? config.tpmWindowMs;
  }

  function getBudget(model) {
    const maxTpm = resolve(model, "maxTpm") ?? config.maxTpm;
    const windowMs = getWindowMs(model);
    return maxTpm * (windowMs / 60_000);
  }

  function pruneModelTokens(modelState, windowMs) {
    const cutoff = now() - windowMs;
    modelState.tokenTimestamps = modelState.tokenTimestamps.filter(t => t.ts > cutoff);
  }

  function sumTokens(modelState) {
    return modelState.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
  }

  function canDispatchForModel(model, estimatedTokens) {
    if (estimatedTokens <= 0) return true;
    const ms = getOrCreateModelState(model);
    const windowMs = getWindowMs(model);
    pruneModelTokens(ms, windowMs);
    return sumTokens(ms) + ms.pendingTokens + estimatedTokens <= getBudget(model);
  }

  function timeUntilModelAllowed(model, estimatedTokens) {
    if (estimatedTokens <= 0) return 0;
    const ms = getOrCreateModelState(model);
    const windowMs = getWindowMs(model);
    pruneModelTokens(ms, windowMs);
    const available = getBudget(model) - (sumTokens(ms) + ms.pendingTokens);
    if (estimatedTokens <= available) return 0;
    if (ms.tokenTimestamps.length === 0) return 1000;
    const oldest = ms.tokenTimestamps[0];
    const wait = oldest.ts + windowMs - now();
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
    pruneModelTokens(ms, getWindowMs(model));
    ms.pendingTokens = Math.max(0, ms.pendingTokens - tokens);
    ms.tokenTimestamps.push({ ts: now(), tokens });
  }

  function currentTokenUsage(model) {
    const ms = modelStates.get(model);
    if (!ms) return 0;
    pruneModelTokens(ms, getWindowMs(model));
    return sumTokens(ms);
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

  function recordTokenUsage(model, tokens) {
    tpm.recordTokenUsage(model, tokens);
  }

  function enterCooldown(model) {
    rpm.enterCooldown(model);
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

  function getAllModelStates() {
    return tpm.getAllModelStates();
  }

  function loadModelStates(states) {
    tpm.loadModelStates(states);
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
    getAllModelStates,
    loadModelStates,
  };
}
