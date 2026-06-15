import fs from "node:fs/promises";

export async function maybeMigrateFromJson(jsonPath, requestsRepo, throttleRepo) {
  const migratedMarker = `${jsonPath}.migrated`;
  let raw;
  try {
    raw = await fs.readFile(jsonPath, "utf8");
  } catch {
    return;
  }

  let legacy;
  try {
    legacy = JSON.parse(raw);
  } catch {
    return;
  }

  if (Array.isArray(legacy.tokenUsage) && legacy.tokenUsage.length > 0) {
    const batch = legacy.tokenUsage.map((entry) => ({
      model: entry.model || "unknown",
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      totalTokens: entry.totalTokens ?? (entry.promptTokens || 0) + (entry.completionTokens || 0),
      tokenSource: entry.source || "estimated",
      createdAt: entry.ts ?? Date.now(),
    }));
    requestsRepo.insertBatch(batch);
  }

  if (legacy.cooldownUntil != null || legacy.adaptiveLimit != null) {
    throttleRepo.setState({
      cooldownUntil: legacy.cooldownUntil ?? 0,
      adaptiveLimit: legacy.adaptiveLimit ?? 25,
    });

    if (legacy.cooldownUntil > Date.now()) {
      throttleRepo.insertEvent({
        type: "cooldown_enter",
        limitBefore: (legacy.adaptiveLimit ?? 25) + 1,
        limitAfter: legacy.adaptiveLimit ?? 25,
        cooldownUntil: legacy.cooldownUntil,
        reason: "Migrated from legacy JSON state",
        createdAt: Date.now(),
      });
    }
  }

  if (Array.isArray(legacy.timestamps) && legacy.timestamps.length > 0) {
    const batch = legacy.timestamps.map((ts) => ({
      model: "unknown",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokenSource: "estimated",
      createdAt: ts,
    }));
    requestsRepo.insertBatch(batch);
  }

  try {
    await fs.rename(jsonPath, migratedMarker);
  } catch {
    await fs.writeFile(migratedMarker, raw);
    await fs.unlink(jsonPath).catch(() => {});
  }
}
