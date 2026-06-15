import fs from "node:fs/promises";

export function createStateStore(filePath) {
  let state = {
    timestamps: [],
    dispatchTimestamps: [],
    cooldownUntil: 0,
    adaptiveLimit: 0,
    tokenUsage: [],
    tokenUsageSummary: {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalRequests: 0,
      windowTokens: 0,
      windowStart: 0,
    },
  };

  async function load() {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const loaded = JSON.parse(raw);

      state = {
        ...state,
        ...loaded,
        tokenUsageSummary: {
          ...state.tokenUsageSummary,
          ...(loaded.tokenUsageSummary || {}),
        },
      };

      return state;
    } catch {
      return state;
    }
  }

  async function save(s) {
    state = s;
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s, null, 2));
    await fs.rename(tmp, filePath);
  }

  function get() {
    return state;
  }

  return { load, save, get };
}
