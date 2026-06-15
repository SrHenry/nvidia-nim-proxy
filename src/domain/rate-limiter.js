export function createRateLimiter(config) {
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
    state.dispatchTimestamps = state.dispatchTimestamps.filter(
      (ts) => ts > cutoff
    );
    state.completionTimestamps = state.completionTimestamps.filter(
      (ts) => ts > cutoff
    );
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
      const waitFor = oldest + config.windowMs - currentTime;
      return waitFor > 0 ? waitFor : 0;
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
