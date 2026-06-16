export function createRateLimiter(config) {
  const state = {
    dispatchTimestamps: [],
    completionTimestamps: [],
    tokenTimestamps: [],
    cooldownUntil: 0,
    adaptiveLimit: config.maxRpm,
  };

  const maxTpm = config.maxTpm || Infinity;

  function now() {
    return Date.now();
  }

  function pruneWindows() {
    const cutoff = now() - config.windowMs;
    state.dispatchTimestamps = state.dispatchTimestamps.filter(
      (ts) => ts > cutoff
    );
    state.completionTimestamps = state.completionTimestamps.filter(
      (ts) => ts > cutoff
    );
  }

  function pruneTokenWindow() {
    const cutoff = now() - config.windowMs;
    state.tokenTimestamps = state.tokenTimestamps.filter(
      (t) => t.ts > cutoff
    );
  }

  function currentUsage() {
    pruneWindows();
    return state.dispatchTimestamps.length;
  }

  function currentTokenUsage() {
    pruneTokenWindow();
    return state.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
  }

  function canDispatch(estimatedTokens = 0) {
    if (state.cooldownUntil > now()) return false;
    pruneWindows();
    pruneTokenWindow();
    if (currentUsage() >= state.adaptiveLimit) return false;
    if (estimatedTokens > 0 && currentTokenUsage() + estimatedTokens > maxTpm) return false;
    return true;
  }

  function timeUntilDispatchAllowed(estimatedTokens = 0) {
    const currentTime = now();

    if (state.cooldownUntil > currentTime) {
      return Math.min(state.cooldownUntil - currentTime, 5000);
    }

    pruneWindows();
    pruneTokenWindow();

    let wait = 0;

    if (currentUsage() >= state.adaptiveLimit) {
      const oldest = state.dispatchTimestamps[0];
      const rpmWait = oldest + config.windowMs - currentTime;
      wait = Math.max(wait, rpmWait > 0 ? rpmWait : 0);
    }

    if (estimatedTokens > 0) {
      const available = maxTpm - currentTokenUsage();
      if (estimatedTokens > available) {
        if (state.tokenTimestamps.length > 0) {
          const oldest = state.tokenTimestamps[0];
          const tpmWait = oldest.ts + config.windowMs - currentTime;
          wait = Math.max(wait, tpmWait > 0 ? tpmWait : 0);
        } else {
          wait = Math.max(wait, 1000);
        }
      }
    }

    return wait;
  }

  function recordDispatch() {
    state.dispatchTimestamps.push(now());
  }

  function recordCompletion() {
    state.completionTimestamps.push(now());
  }

  function recordTokenUsage(tokens) {
    if (tokens > 0) {
      pruneTokenWindow();
      state.tokenTimestamps.push({ ts: now(), tokens });
    }
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
    recordTokenUsage,
    enterCooldown,
    getState,
    loadState,
    currentUsage,
    currentTokenUsage,
  };
}
