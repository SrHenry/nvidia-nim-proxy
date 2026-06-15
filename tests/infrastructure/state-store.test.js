import { describe, it, expect } from "vitest";
import { createStateStore } from "../../src/infrastructure/state-store.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("createStateStore", () => {
  const tmpDir = os.tmpdir();
  const testFile = path.join(tmpDir, `test-state-${Date.now()}.json`);

  it("loads default state when file does not exist", async () => {
    const store = createStateStore(testFile);
    const state = await store.load();
    expect(state).toHaveProperty("dispatchTimestamps");
    expect(state).toHaveProperty("cooldownUntil");
    expect(state).toHaveProperty("adaptiveLimit");
  });

  it("saves and loads state atomically", async () => {
    const store = createStateStore(testFile);
    const state = {
      timestamps: [],
      dispatchTimestamps: [123],
      cooldownUntil: 456,
      adaptiveLimit: 20,
      tokenUsage: [],
      tokenUsageSummary: {
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalRequests: 10,
        windowTokens: 150,
        windowStart: 123,
      },
    };

    await store.save(state);
    const store2 = createStateStore(testFile);
    const loaded = await store2.load();

    expect(loaded.dispatchTimestamps).toEqual([123]);
    expect(loaded.adaptiveLimit).toBe(20);
    expect(loaded.tokenUsageSummary.totalPromptTokens).toBe(100);

    await fs.unlink(testFile).catch(() => {});
  });
});
