import Fastify from "fastify";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { getEncoding } from "js-tiktoken";

// ------------------------------------------------------------------
// Configuration (all env-overridable)
// ------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 4000);

const UPSTREAM =
  process.env.UPSTREAM ??
  "https://integrate.api.nvidia.com/v1";

const PROVIDER = process.env.PROVIDER ?? "nvidia";

const AUTH_FILE =
  process.env.OPENCODE_AUTH ??
  path.join(
    process.env.HOME ?? os.homedir(),
    ".local/share/opencode/auth.json"
  );

const STATE_FILE =
  process.env.STATE_FILE ??
  "./nim-throttle-state.json";

const WINDOW_MS = 60_000;

const MAX_CONCURRENCY = Number(
  process.env.MAX_CONCURRENCY ?? 2
);

const MAX_RPM = Number(process.env.MAX_RPM ?? 25);

const COOLDOWN_MS =
  Number(process.env.COOLDOWN_MINUTES ?? 60) *
  60 *
  1000;

const MAX_RETRIES = Number(
  process.env.MAX_RETRIES ?? 3
);

const RETRY_DELAYS = (
  process.env.RETRY_DELAYS ?? "20,40,60"
)
  .split(",")
  .map(Number);

const MIN_DISPATCH_GAP_MS = Number(
  process.env.MIN_DISPATCH_GAP_MS ??
    Math.floor(60_000 / MAX_RPM)
);

// ------------------------------------------------------------------
// Tokenizer
// ------------------------------------------------------------------

const enc = getEncoding("cl100k_base");

function estimateTokens(text) {
  if (!text || typeof text !== "string") return 0;
  return enc.encode(text).length;
}

function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    if (msg.content) {
      total += estimateTokens(
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)
      );
    }
    if (msg.role) total += 4;
    total += 2;
  }
  return total;
}

// ------------------------------------------------------------------
// Fastify
// ------------------------------------------------------------------

const app = Fastify({
  logger: {
    level: "info",
  },
});

// ------------------------------------------------------------------
// Persistent State
// ------------------------------------------------------------------

let state = {
  timestamps: [],
  dispatchTimestamps: [],
  cooldownUntil: 0,
  adaptiveLimit: MAX_RPM,
  tokenUsage: [],
  tokenUsageSummary: {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalRequests: 0,
    windowTokens: 0,
    windowStart: 0,
  },
};

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const loaded = JSON.parse(raw);

    state = {
      ...state,
      ...loaded,
      tokenUsageSummary: {
        ...state.tokenUsageSummary,
        ...(loaded.tokenUsageSummary || {}),
      },
    };

    pruneWindows();

    app.log.info(
      {
        cooldownUntil: state.cooldownUntil,
        adaptiveLimit: state.adaptiveLimit,
        recentRequests: state.dispatchTimestamps.length,
        totalTokens:
          state.tokenUsageSummary.totalPromptTokens +
          state.tokenUsageSummary.totalCompletionTokens,
      },
      "state loaded"
    );
  } catch {
    app.log.info("no previous state found");
  }
}

async function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify(state, null, 2)
  );
  await fs.rename(tmp, STATE_FILE);
}

// ------------------------------------------------------------------
// Auth Loader
// ------------------------------------------------------------------

let authCache = null;
let authMtime = 0;

async function loadAuth() {
  try {
    const stat = await fs.stat(AUTH_FILE);

    if (authCache && stat.mtimeMs === authMtime) {
      return authCache;
    }

    const raw = await fs.readFile(AUTH_FILE, "utf8");
    authCache = JSON.parse(raw);
    authMtime = stat.mtimeMs;

    app.log.info("reloaded auth.json");
    return authCache;
  } catch (err) {
    throw new Error(
      `Failed to load auth.json from ${AUTH_FILE}: ${err.message}`
    );
  }
}

async function getApiKey() {
  const auth = await loadAuth();
  return extractApiKey(auth);
}

function extractApiKey(auth) {
  if (auth?.[PROVIDER]?.type !== "api")
    throw new Error(
      `Provider "${PROVIDER}" type is not API`
    );

  const key = auth?.[PROVIDER]?.key;

  if (!key) {
    throw new Error(
      "Could not find API key in auth.json"
    );
  }

  return key;
}

// ------------------------------------------------------------------
// Rolling Window Limiter (dispatch-based)
// ------------------------------------------------------------------

function now() {
  return Date.now();
}

function pruneWindows() {
  const cutoff = now() - WINDOW_MS;
  state.dispatchTimestamps =
    state.dispatchTimestamps.filter((ts) => ts > cutoff);
  state.timestamps = state.timestamps.filter(
    (ts) => ts > cutoff
  );
}

function currentUsage() {
  pruneWindows();
  return state.dispatchTimestamps.length;
}

// ------------------------------------------------------------------
// Token Usage Tracker
// ------------------------------------------------------------------

const MAX_TOKEN_USAGE_ENTRIES = 500;

function recordTokenUsage(model, promptTokens, completionTokens, source) {
  const entry = {
    ts: now(),
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    source,
  };

  state.tokenUsage.push(entry);

  if (state.tokenUsage.length > MAX_TOKEN_USAGE_ENTRIES) {
    state.tokenUsage = state.tokenUsage.slice(
      -MAX_TOKEN_USAGE_ENTRIES
    );
  }

  state.tokenUsageSummary.totalPromptTokens += promptTokens;
  state.tokenUsageSummary.totalCompletionTokens += completionTokens;
  state.tokenUsageSummary.totalRequests++;

  const summaryCutoff = now() - WINDOW_MS;
  const recentUsage = state.tokenUsage.filter(
    (e) => e.ts > summaryCutoff
  );
  state.tokenUsageSummary.windowTokens = recentUsage.reduce(
    (sum, e) => sum + e.totalTokens,
    0
  );
  state.tokenUsageSummary.windowStart = recentUsage.length
    ? recentUsage[0].ts
    : 0;

  app.log.info(
    {
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      source,
      windowTokens:
        state.tokenUsageSummary.windowTokens,
    },
    "token usage"
  );
}

function estimateFromResponse(model, body, responseBody) {
  let promptTokens = 0;
  let completionTokens = 0;
  let source = "estimated";

  if (body?.messages) {
    promptTokens = estimateMessageTokens(body.messages);
  }

  if (responseBody?.usage?.prompt_tokens != null) {
    promptTokens = responseBody.usage.prompt_tokens;
    source = "nim";
  }
  if (responseBody?.usage?.completion_tokens != null) {
    completionTokens =
      responseBody.usage.completion_tokens;
    source = "nim";
  }

  if (completionTokens === 0 && responseBody?.choices) {
    for (const choice of responseBody.choices) {
      const content =
        choice?.message?.content ||
        choice?.delta?.content ||
        "";
      if (content) {
        completionTokens += estimateTokens(content);
      }
    }
  }

  if (source === "estimated") {
    if (responseBody?.choices) {
      for (const choice of responseBody.choices) {
        const content =
          choice?.message?.content ||
          choice?.delta?.content ||
          "";
        if (content) {
          completionTokens = estimateTokens(content);
          break;
        }
      }
    }
  }

  return { promptTokens, completionTokens, source };
}

// ------------------------------------------------------------------
// Queue
// ------------------------------------------------------------------

const queue = [];

let active = 0;

let lastDispatchAt = 0;

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

async function scheduler() {
  while (true) {
    try {
      const currentTime = now();

      if (state.cooldownUntil > currentTime) {
        const waitFor = Math.min(
          state.cooldownUntil - currentTime,
          5000
        );
        await sleep(waitFor);
        continue;
      }

      if (queue.length === 0) {
        await sleep(50);
        continue;
      }

      if (active >= MAX_CONCURRENCY) {
        await sleep(25);
        continue;
      }

      pruneWindows();

      if (currentUsage() >= state.adaptiveLimit) {
        const oldest = state.dispatchTimestamps[0];
        const waitFor =
          oldest + WINDOW_MS - currentTime;

        if (waitFor > 0) {
          await sleep(waitFor);
        }
        continue;
      }

      const sinceLastDispatch =
        currentTime - lastDispatchAt;

      if (sinceLastDispatch < MIN_DISPATCH_GAP_MS) {
        await sleep(
          MIN_DISPATCH_GAP_MS - sinceLastDispatch
        );
      }

      const job = queue.shift();
      active++;
      lastDispatchAt = now();

      state.dispatchTimestamps.push(now());

      processJob(job)
        .catch((err) => job.reject(err))
        .finally(() => {
          state.timestamps.push(now());
          saveState().catch((err) =>
            app.log.error(err, "failed to save state")
          );
          active--;
        });
    } catch (err) {
      app.log.error(err);
      await sleep(1000);
    }
  }
}

// ------------------------------------------------------------------
// Model-Specific Injections
// ------------------------------------------------------------------

function patchBody(model, body) {
  if (!body || typeof body !== "object") return body;

  if (/^z-ai\/glm-?5\.?1/i.test(model)) {
    return {
      ...body,
      chat_template_kwargs: {
        ...(body.chat_template_kwargs || {}),
        enable_thinking: true,
      },
    };
  }

  if (/^minimaxai\/minimax-m3$/i.test(model)) {
    return {
      ...body,
      chat_template_kwargs: {
        ...(body.chat_template_kwargs || {}),
        enable_thinking: true,
      },
    };
  }

  return body;
}

// ------------------------------------------------------------------
// SSE Tap Stream (transparent — passes data through)
// ------------------------------------------------------------------

class SSETapStream extends Transform {
  constructor(model, body, logger) {
    super();
    this._model = model;
    this._body = body;
    this._logger = logger;
    this._lineBuffer = "";
    this._usage = null;
    this._contentTokens = 0;
    this._chunkCount = 0;
  }

  _transform(chunk, encoding, cb) {
    this.push(chunk);
    this._chunkCount++;

    this._lineBuffer += chunk.toString();

    const lines = this._lineBuffer.split("\n");
    this._lineBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);

        if (parsed.usage) {
          this._usage = parsed.usage;
        }

        if (parsed.choices) {
          for (const choice of parsed.choices) {
            const content =
              choice?.delta?.content || "";
            if (content) {
              this._contentTokens +=
                estimateTokens(content);
            }
          }
        }
      } catch {
        // not JSON, skip
      }
    }

    cb();
  }

  _flush(cb) {
    if (this._lineBuffer.trim()) {
      const line = this._lineBuffer.trim();
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) {
              this._usage = parsed.usage;
            }
          } catch {
            // ignore
          }
        }
      }
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let source = "estimated";

    if (this._body?.messages) {
      promptTokens = estimateMessageTokens(
        this._body.messages
      );
    }

    if (this._usage) {
      if (this._usage.prompt_tokens != null) {
        promptTokens = this._usage.prompt_tokens;
        source = "nim";
      }
      if (this._usage.completion_tokens != null) {
        completionTokens =
          this._usage.completion_tokens;
        source = "nim";
      }
    }

    if (source === "estimated") {
      completionTokens = this._contentTokens;
    }

    recordTokenUsage(
      this._model,
      promptTokens,
      completionTokens,
      source
    );

    cb();
  }
}

// ------------------------------------------------------------------
// Upstream Request (with retry logic)
// ------------------------------------------------------------------

async function sendUpstream(method, url, apiKey, contentType, patchedBody) {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": contentType,
    },
    body:
      method === "GET"
        ? undefined
        : JSON.stringify(patchedBody),
  });
}

async function processJob(job) {
  const {
    method,
    upstreamPath,
    body,
    headers,
    reply,
    resolve,
  } = job;

  const apiKey = await getApiKey();
  const url = `${UPSTREAM}${upstreamPath}`;

  const patchedBody = body?.model
    ? patchBody(body.model, body)
    : body;

  const model = body?.model || "unknown";

  const accept = headers.accept ?? "";
  const isSSE = accept.includes("text/event-stream");

  const contentType =
    headers["content-type"] ?? "application/json";

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay =
        RETRY_DELAYS[attempt - 1] ||
        RETRY_DELAYS[RETRY_DELAYS.length - 1];
      app.log.info(
        {
          attempt,
          delay,
          model,
          path: upstreamPath,
        },
        "retrying after 429"
      );
      await sleep(delay * 1000);
    }

    app.log.info({
      method,
      path: upstreamPath,
      model,
      attempt,
      queueDepth: queue.length,
      active,
      usage: currentUsage(),
      limit: state.adaptiveLimit,
    });

    const response = await sendUpstream(
      method,
      url,
      apiKey,
      contentType,
      patchedBody
    );

    if (response.status !== 429) {
      lastError = null;
      break;
    }

    lastError = new Error(
      `429 on attempt ${attempt + 1}/${MAX_RETRIES + 1}`
    );

    const respHeaders = {};
    for (const [key, value] of response.headers) {
      respHeaders[key] = value;
    }

    app.log.warn(
      {
        status: 429,
        attempt,
        maxRetries: MAX_RETRIES,
        headers: respHeaders,
        model,
        path: upstreamPath,
      },
      "429 received from upstream"
    );

    if (attempt === MAX_RETRIES) {
      state.cooldownUntil = now() + COOLDOWN_MS;

      if (state.adaptiveLimit > 5) {
        state.adaptiveLimit--;
      }

      await saveState();

      throw new Error(
        `429 exhausted ${MAX_RETRIES + 1} attempts. Cooldown until ${new Date(
          state.cooldownUntil
        ).toISOString()}`
      );
    }
  }

  const respHeaders = {};
  for (const [key, value] of response.headers) {
    const lower = key.toLowerCase();
    if (
      lower === "transfer-encoding" ||
      lower === "content-encoding" ||
      lower === "content-length"
    ) {
      continue;
    }
    respHeaders[key] = value;
  }

  reply.raw.writeHead(response.status, respHeaders);

  if (isSSE && response.body) {
    const nodeStream = Readable.fromWeb(response.body);
    const tap = new SSETapStream(model, body, app.log);
    nodeStream.pipe(tap).pipe(reply.raw);

    tap.on("end", () => {
      resolve();
    });
  } else {
    const text = await response.text();

    let responseBody = null;
    try {
      responseBody = JSON.parse(text);
    } catch {
      // not JSON
    }

    if (responseBody) {
      const usage = estimateFromResponse(
        model,
        body,
        responseBody
      );
      recordTokenUsage(
        model,
        usage.promptTokens,
        usage.completionTokens,
        usage.source
      );
    }

    reply.raw.end(text);
    resolve();
  }
}

// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------

app.all("/v1/*", async (request, reply) => {
  reply.hijack();

  return new Promise((resolve, reject) => {
    queue.push({
      method: request.method,
      upstreamPath: request.url.replace(/^\/v1/, ""),
      body: request.body,
      headers: request.headers,
      reply,
      resolve,
      reject,
    });
  });
});

// ------------------------------------------------------------------
// Startup
// ------------------------------------------------------------------

await loadState();

scheduler().catch((err) => app.log.error(err));

await app.listen({
  host: "0.0.0.0",
  port: PORT,
});

app.log.info(
  {
    port: PORT,
    upstream: UPSTREAM,
    authFile: AUTH_FILE,
    maxRpm: MAX_RPM,
    cooldownMinutes: COOLDOWN_MS / 60_000,
    maxRetries: MAX_RETRIES,
    retryDelays: RETRY_DELAYS,
    minDispatchGapMs: MIN_DISPATCH_GAP_MS,
    maxConcurrency: MAX_CONCURRENCY,
  },
  "proxy started"
);
