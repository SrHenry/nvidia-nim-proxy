import fs from "node:fs/promises";

export function createAuthLoader(filePath, provider) {
  let cache = null;
  let mtime = 0;

  async function getApiKey() {
    try {
      const stat = await fs.stat(filePath);

      if (cache && stat.mtimeMs === mtime) {
        return extractKey(cache);
      }

      const raw = await fs.readFile(filePath, "utf8");
      cache = JSON.parse(raw);
      mtime = stat.mtimeMs;

      return extractKey(cache);
    } catch (err) {
      throw new Error(
        `Failed to load auth.json from ${filePath}: ${err.message}`
      );
    }
  }

  function extractKey(auth) {
    if (auth?.[provider]?.type !== "api")
      throw new Error(`Provider "${provider}" type is not API`);

    const key = auth?.[provider]?.key;

    if (!key) {
      throw new Error("Could not find API key in auth.json");
    }

    return key;
  }

  return { getApiKey };
}
