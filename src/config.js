import os from "node:os";
import path from "node:path";

function env(key, fallback) {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  return val;
}

function envNumber(key, fallback) {
  const raw = env(key, String(fallback));
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
}

function envCsv(key, fallback) {
  const raw = env(key, fallback.join(","));
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
}

const maxRpm = envNumber("MAX_RPM", 25);
const cooldownMinutes = envNumber("COOLDOWN_MINUTES", 60);

export default Object.freeze({
  port: envNumber("PORT", 4000),
  upstream: env("UPSTREAM", "https://integrate.api.nvidia.com/v1"),
  provider: env("PROVIDER", "nvidia"),
  authFile:
    env("OPENCODE_AUTH", "") ||
    path.join(env("HOME", os.homedir()), ".local/share/opencode/auth.json"),
  stateFile: env("STATE_FILE", "./nim-throttle-state.json"),
  windowMs: 60_000,
  maxRpm,
  maxConcurrency: envNumber("MAX_CONCURRENCY", 2),
  cooldownMs: cooldownMinutes * 60 * 1000,
  maxRetries: envNumber("MAX_RETRIES", 3),
  retryDelays: envCsv("RETRY_DELAYS", [20, 40, 60]),
  minDispatchGapMs: envNumber(
    "MIN_DISPATCH_GAP_MS",
    Math.floor(60_000 / maxRpm)
  ),
  thinkingModels: [
    {
      pattern: /^z-ai\/glm-?5\.?1/i,
      injection: {
        chat_template_kwargs: { enable_thinking: true },
      },
    },
    {
      pattern: /^minimaxai\/minimax-m3$/i,
      injection: {
        chat_template_kwargs: { enable_thinking: true },
      },
    },
  ],
});
