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
const maxTpm = envNumber("MAX_TPM", 250_000);
const completionBuffer = envNumber("COMPLETION_BUFFER", 48000);
const cooldownMinutes = envNumber("COOLDOWN_MINUTES", 60);
const dbRetentionDays = envNumber("DB_RETENTION_DAYS", 365);
const snowflakeWorkerId = envNumber("SNOWFLAKE_WORKER_ID", 0);
const flushIntervalMs = envNumber("FLUSH_INTERVAL_MS", 5000);
const flushBatchSize = envNumber("FLUSH_BATCH_SIZE", 100);

export default Object.freeze({
  port: envNumber("PORT", 4000),
  upstream: env("UPSTREAM", "https://integrate.api.nvidia.com/v1"),
  provider: env("PROVIDER", "nvidia"),
  authFile:
    env("OPENCODE_AUTH", "") ||
    path.join(env("HOME", os.homedir()), ".local/share/opencode/auth.json"),
  stateFile: env("STATE_FILE", "./nim-throttle-state.json"),
  dbPath: env("DB_PATH", "./oc-proxy.db"),
  dbRetentionDays,
  snowflakeWorkerId,
  flushIntervalMs,
  flushBatchSize,
  windowMs: 60_000,
  maxRpm,
  maxTpm,
  completionBuffer,
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
