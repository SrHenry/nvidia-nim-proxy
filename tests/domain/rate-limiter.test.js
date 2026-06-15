import { describe, it, expect, beforeEach } from "vitest";
import { createRateLimiter } from "../../src/domain/rate-limiter.js";

describe("createRateLimiter", () => {
  let limiter;

  beforeEach(() => {
    limiter = createRateLimiter({
      windowMs: 60_000,
      maxRpm: 10,
      cooldownMs: 600_000,
    });
  });

  it("allows dispatch when under limit", () => {
    expect(limiter.canDispatch()).toBe(true);
  });

  it("records dispatch and tracks usage", () => {
    limiter.recordDispatch();
    expect(limiter.currentUsage()).toBe(1);
  });

  it("enters cooldown and decrements adaptive limit", () => {
    const initial = limiter.getState().adaptiveLimit;
    limiter.enterCooldown();
    expect(limiter.getState().adaptiveLimit).toBe(initial - 1);
    expect(limiter.canDispatch()).toBe(false);
  });

  it("does not decrement below floor of 5", () => {
    for (let i = 0; i < 20; i++) {
      limiter.enterCooldown();
    }
    expect(limiter.getState().adaptiveLimit).toBe(5);
  });

  it("loads state from persisted data", () => {
    limiter.loadState({
      dispatchTimestamps: [Date.now()],
      cooldownUntil: 0,
      adaptiveLimit: 8,
    });
    expect(limiter.getState().adaptiveLimit).toBe(8);
    expect(limiter.currentUsage()).toBe(1);
  });
});
