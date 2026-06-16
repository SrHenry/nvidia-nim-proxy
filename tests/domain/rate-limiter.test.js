import { describe, it, expect, beforeEach } from "vitest";
import { createRpmEnforcer, createTpmEnforcer, createRateLimiter } from "../../src/domain/rate-limiter.js";

describe("createRpmEnforcer", () => {
  let rpm;

  beforeEach(() => {
    rpm = createRpmEnforcer({ windowMs: 60_000, maxRpm: 10, cooldownMs: 600_000 });
  });

  it("allows dispatch when under limit", () => {
    expect(rpm.canDispatch()).toBe(true);
  });

  it("records dispatch and tracks usage", () => {
    rpm.recordDispatch();
    expect(rpm.currentUsage()).toBe(1);
  });

  it("enters cooldown and decrements adaptive limit", () => {
    const initial = rpm.getState().adaptiveLimit;
    rpm.enterCooldown();
    expect(rpm.getState().adaptiveLimit).toBe(initial - 1);
    expect(rpm.canDispatch()).toBe(false);
  });

  it("does not decrement below floor of 5", () => {
    for (let i = 0; i < 20; i++) {
      rpm.enterCooldown();
    }
    expect(rpm.getState().adaptiveLimit).toBe(5);
  });

  it("loads state from persisted data", () => {
    rpm.loadState({
      dispatchTimestamps: [Date.now()],
      cooldownUntil: 0,
      adaptiveLimit: 8,
    });
    expect(rpm.getState().adaptiveLimit).toBe(8);
    expect(rpm.currentUsage()).toBe(1);
  });
});

describe("createTpmEnforcer", () => {
  let tpm;

  beforeEach(() => {
    tpm = createTpmEnforcer({ windowMs: 60_000, maxTpm: 1000 });
  });

  it("allows dispatch when under limit", () => {
    expect(tpm.canDispatchForModel("test-model", 100)).toBe(true);
  });

  it("blocks when estimated tokens exceed limit", () => {
    expect(tpm.canDispatchForModel("test-model", 2000)).toBe(false);
  });

  it("tracks token usage and pending tokens", () => {
    tpm.reserveTokens("test-model", 300);
    tpm.recordTokenUsage("test-model", 200);
    expect(tpm.currentTokenUsage("test-model")).toBe(200);
  });

  it("accounts for pending tokens in capacity check", () => {
    tpm.reserveTokens("test-model", 800);
    expect(tpm.canDispatchForModel("test-model", 300)).toBe(false);
    tpm.recordTokenUsage("test-model", 800);
    expect(tpm.canDispatchForModel("test-model", 199)).toBe(true);
    expect(tpm.canDispatchForModel("test-model", 201)).toBe(false);
  });

  it("handles multiple models independently", () => {
    tpm.recordTokenUsage("model-a", 600);
    tpm.recordTokenUsage("model-b", 600);
    expect(tpm.canDispatchForModel("model-a", 500)).toBe(false);
    expect(tpm.canDispatchForModel("model-b", 500)).toBe(false);
    expect(tpm.currentTokenUsage("model-a")).toBe(600);
    expect(tpm.currentTokenUsage("model-b")).toBe(600);
  });

  it("returns all model states", () => {
    tpm.recordTokenUsage("m1", 100);
    tpm.recordTokenUsage("m2", 200);
    const states = tpm.getAllModelStates();
    expect(Object.keys(states).sort()).toEqual(["m1", "m2"]);
  });

  it("loads persisted model states", () => {
    tpm.loadModelStates({
      "m1": { tokenTimestamps: [{ ts: Date.now(), tokens: 150 }], pendingTokens: 0 },
    });
    expect(tpm.currentTokenUsage("m1")).toBe(150);
  });

  it("estimates wait time when tokens unavailable", () => {
    tpm.recordTokenUsage("test-model", 1000);
    const wait = tpm.timeUntilModelAllowed("test-model", 100);
    expect(wait).toBeGreaterThan(0);
  });

  it("returns 0 wait when tokens available", () => {
    expect(tpm.timeUntilModelAllowed("test-model", 100)).toBe(0);
  });

  it("caps pendingTokens at floor 0 on over-release", () => {
    tpm.reserveTokens("test-model", 100);
    tpm.recordTokenUsage("test-model", 200);
    expect(tpm.getAllModelStates()["test-model"].pendingTokens).toBe(0);
  });
});

describe("createTpmEnforcer with per-model maxTpm", () => {
  let tpm;
  const resolver = {
    resolve: (model, key) => {
      if (model === "glm-5.1" && key === "maxTpm") return 500;
      if (model === "mini-max" && key === "maxTpm") return 2000;
      return 1000;
    },
    getMatchedOverrides: () => null,
  };

  beforeEach(() => {
    tpm = createTpmEnforcer({ windowMs: 60_000, maxTpm: 1000 }, resolver);
  });

  it("uses per-model maxTpm when set", () => {
    expect(tpm.canDispatchForModel("glm-5.1", 600)).toBe(false);
    expect(tpm.canDispatchForModel("glm-5.1", 400)).toBe(true);
    expect(tpm.canDispatchForModel("mini-max", 1500)).toBe(true);
    expect(tpm.canDispatchForModel("mini-max", 2500)).toBe(false);
  });

  it("falls back to global maxTpm for unconfigured models", () => {
    expect(tpm.canDispatchForModel("unknown", 1100)).toBe(false);
    expect(tpm.canDispatchForModel("unknown", 900)).toBe(true);
  });

  it("timeUntilModelAllowed uses per-model maxTpm", () => {
    tpm.recordTokenUsage("glm-5.1", 500);
    const wait = tpm.timeUntilModelAllowed("glm-5.1", 100);
    expect(wait).toBeGreaterThan(0);
  });
});

describe("createRpmEnforcer with per-model cooldown", () => {
  let rpm;
  const resolver = {
    resolve: (model, key) => {
      if (model === "glm-5.1" && key === "cooldownMs") return 10000;
      return 600000;
    },
    getMatchedOverrides: (model) => {
      if (model === "glm-5.1") return { cooldownMs: 10000 };
      return null;
    },
  };

  beforeEach(() => {
    rpm = createRpmEnforcer({ windowMs: 60_000, maxRpm: 10, cooldownMs: 600000 }, resolver);
  });

  it("global cooldown blocks all models", () => {
    rpm.enterCooldown("unknown");
    expect(rpm.canDispatch("unknown")).toBe(false);
    expect(rpm.canDispatch("glm-5.1")).toBe(false);
  });

  it("per-model cooldown only blocks that model", () => {
    rpm.enterCooldown("glm-5.1");
    expect(rpm.canDispatch("glm-5.1")).toBe(false);
    expect(rpm.canDispatch("other")).toBe(true);
  });

  it("per-model cooldown does not decrement adaptiveLimit", () => {
    const before = rpm.getState().adaptiveLimit;
    rpm.enterCooldown("glm-5.1");
    expect(rpm.getState().adaptiveLimit).toBe(before);
  });

  it("global cooldown decrements adaptiveLimit", () => {
    const before = rpm.getState().adaptiveLimit;
    rpm.enterCooldown("other");
    expect(rpm.getState().adaptiveLimit).toBe(before - 1);
  });

  it("per-model cooldown timeUntilDispatchAllowed returns per-model wait", () => {
    rpm.enterCooldown("glm-5.1");
    const glmWait = rpm.timeUntilDispatchAllowed("glm-5.1");
    const otherWait = rpm.timeUntilDispatchAllowed("other");
    expect(glmWait).toBeGreaterThan(0);
    expect(otherWait).toBe(0);
  });

  it("persists and restores modelCooldowns in getState/loadState", () => {
    rpm.enterCooldown("glm-5.1");
    const state = rpm.getState();
    expect(state.modelCooldowns["glm-5.1"]).toBeGreaterThan(0);

    const rpm2 = createRpmEnforcer({ windowMs: 60_000, maxRpm: 10, cooldownMs: 600000 }, resolver);
    rpm2.loadState(state);
    expect(rpm2.canDispatch("glm-5.1")).toBe(false);
    expect(rpm2.canDispatch("other")).toBe(true);
  });
});

describe("createRateLimiter (composition)", () => {
  let limiter;

  beforeEach(() => {
    limiter = createRateLimiter({
      windowMs: 60_000,
      maxRpm: 10,
      maxTpm: 1000,
      cooldownMs: 600_000,
    });
  });

  it("allows dispatch when under both limits", () => {
    expect(limiter.canDispatch("m", "/chat/completions", 100)).toBe(true);
  });

  it("blocks on RPM when over limit", () => {
    for (let i = 0; i < 10; i++) {
      limiter.recordDispatch("m", "/chat/completions", 10);
    }
    expect(limiter.canDispatch("m", "/chat/completions", 10)).toBe(false);
  });

  it("blocks on TPM when over limit", () => {
    limiter.recordDispatch("m", "/chat/completions", 950);
    limiter.recordCompletion("m", "/chat/completions");
    limiter.recordTokenUsage("m", 950);
    expect(limiter.canDispatch("m", "/chat/completions", 100)).toBe(false);
  });

  it("skips TPM check for non-inference paths", () => {
    expect(limiter.canDispatch("m", "/models", 999999)).toBe(true);
  });

  it("records token usage per model", () => {
    limiter.recordTokenUsage("m1", 300);
    limiter.recordTokenUsage("m2", 500);
    expect(limiter.currentTokenUsage("m1")).toBe(300);
    expect(limiter.currentTokenUsage("m2")).toBe(500);
  });

  it("loads state with modelStates", () => {
    limiter.loadState({
      dispatchTimestamps: [],
      cooldownUntil: 0,
      adaptiveLimit: 5,
      modelStates: {
        "m1": { tokenTimestamps: [{ ts: Date.now(), tokens: 400 }], pendingTokens: 0 },
      },
    });
    expect(limiter.getState().adaptiveLimit).toBe(5);
    expect(limiter.currentTokenUsage("m1")).toBeCloseTo(400, -1);
  });

  it("backward compatibility: canDispatch() without args", () => {
    expect(limiter.canDispatch()).toBe(true);
  });

  it("backward compatibility: enterCooldown", () => {
    const initial = limiter.getState().adaptiveLimit;
    limiter.enterCooldown();
    expect(limiter.getState().adaptiveLimit).toBe(initial - 1);
    expect(limiter.canDispatch()).toBe(false);
  });

  it("backward compatibility: currentUsage", () => {
    limiter.recordDispatch();
    expect(limiter.currentUsage()).toBeGreaterThanOrEqual(1);
  });
});
