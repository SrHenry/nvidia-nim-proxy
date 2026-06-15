import Fastify from "fastify";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT ?? 4000);

const UPSTREAM =
  process.env.UPSTREAM ??
  "https://integrate.api.nvidia.com/v1";
const PROVIDER = process.env.PROVIDER ?? 'nvidia'
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

const MAX_CONCURRENCY = 2;

/**
 * Start conservatively.
 * If desired later:
 *   adaptiveLimit--
 * after a 429.
 */
const DEFAULT_LIMIT = 35;

const COOLDOWN_MS =
  70 * 60 * 1000;

const MIN_DISPATCH_GAP_MS = 2_000;

const app = Fastify({
  logger: {
    level: "info",
  },
});

//
// ------------------------------------------------------------------
// Persistent State
// ------------------------------------------------------------------
//

let state = {
  timestamps: [],
  cooldownUntil: 0,
  adaptiveLimit: DEFAULT_LIMIT,
};

async function loadState() {
  try {
    const raw =
      await fs.readFile(
        STATE_FILE,
        "utf8"
      );

    const loaded =
      JSON.parse(raw);

    state = {
      ...state,
      ...loaded,
    };

    pruneWindow();

    app.log.info({
      cooldownUntil:
        state.cooldownUntil,
      adaptiveLimit:
        state.adaptiveLimit,
      recentRequests:
        state.timestamps.length,
    }, "state loaded");
  } catch {
    app.log.info(
      "no previous state found"
    );
  }
}

async function saveState() {
  const tmp =
    `${STATE_FILE}.tmp`;

  await fs.writeFile(
    tmp,
    JSON.stringify(
      state,
      null,
      2
    )
  );

  await fs.rename(
    tmp,
    STATE_FILE
  );
}

//
// ------------------------------------------------------------------
// Auth Loader
// ------------------------------------------------------------------
//

let authCache = null;
let authMtime = 0;

async function loadAuth() {
  try {
    const stat =
      await fs.stat(
        AUTH_FILE
      );

    if (
      authCache &&
      stat.mtimeMs === authMtime
    ) {
      return authCache;
    }

    const raw =
      await fs.readFile(
        AUTH_FILE,
        "utf8"
      );

    authCache =
      JSON.parse(raw);

    authMtime =
      stat.mtimeMs;

    app.log.info(
      "reloaded auth.json"
    );

    return authCache;
  } catch (err) {
    throw new Error(
      `Failed to load auth.json from ${AUTH_FILE}: ${err.message}`
    );
  }
}

/**
 * ADJUST THIS
 * TO MATCH YOUR auth.json.
 */
async function getApiKey() {
  const auth =
    await loadAuth();

  return extractApiKey(auth);
}

function extractApiKey(auth) {
  //
  // Example possibilities:
  //
  // return auth.providers.nvidia.apiKey;
  // return auth.nvidia.apiKey;
  // return auth.providers["nvidia"].token;
  //

  if (auth?.[PROVIDER]?.type !== 'api')
    throw new Error(`Provider "${PROVIDER}" type is not API`);

  const key = auth?.[PROVIDER]?.key;

  if (!key) {
    throw new Error(
      "Could not find NVIDIA API key in auth.json"
    );
  }

  return key;
}

//
// ------------------------------------------------------------------
// Rolling Window Limiter
// ------------------------------------------------------------------
//

function now() {
  return Date.now();
}

function pruneWindow() {
  const cutoff =
    now() - WINDOW_MS;

  state.timestamps =
    state.timestamps.filter(
      ts => ts > cutoff
    );
}

function currentUsage() {
  pruneWindow();

  return state.timestamps.length;
}

function availableSlots() {
  return (
    state.adaptiveLimit -
    currentUsage()
  );
}

//
// ------------------------------------------------------------------
// Queue
// ------------------------------------------------------------------
//

const queue = [];

let active = 0;

let lastDispatchAt = 0;

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

async function scheduler() {
  while (true) {
    try {
      const currentTime =
        now();

      //
      // cooldown
      //
      if (
        state.cooldownUntil >
        currentTime
      ) {
        const waitFor =
          Math.min(
            state.cooldownUntil -
              currentTime,
            5000
          );

        await sleep(waitFor);
        continue;
      }

      //
      // no jobs
      //
      if (
        queue.length === 0
      ) {
        await sleep(50);
        continue;
      }

      //
      // concurrency
      //
      if (
        active >=
        MAX_CONCURRENCY
      ) {
        await sleep(25);
        continue;
      }

      pruneWindow();

      //
      // rolling window full
      //
      if (
        currentUsage() >=
        state.adaptiveLimit
      ) {
        const oldest =
          state.timestamps[0];

        const waitFor =
          oldest +
          WINDOW_MS -
          currentTime;

        if (waitFor > 0) {
          await sleep(
            waitFor
          );
        }

        continue;
      }

      //
      // enforce minimum gap between dispatches
      //
      const sinceLastDispatch =
        currentTime - lastDispatchAt;

      if (
        sinceLastDispatch <
        MIN_DISPATCH_GAP_MS
      ) {
        await sleep(
          MIN_DISPATCH_GAP_MS -
            sinceLastDispatch
        );
      }

      const job =
        queue.shift();

      active++;

      lastDispatchAt = now();

      processJob(job)
        .catch(err =>
          job.reject(err)
        )
        .finally(() => {
          state.timestamps.push(
            now()
          );

          saveState().catch(
            err => app.log.error(err, "failed to save state")
          );

          active--;
        });
    } catch (err) {
      app.log.error(err);

      await sleep(1000);
    }
  }
}

//
// ------------------------------------------------------------------
// Model-Specific Injections
// ------------------------------------------------------------------
//

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

  return body;
}

//
// ------------------------------------------------------------------
// Upstream Request
// ------------------------------------------------------------------
//

async function processJob(
  job
) {
  const {
    method,
    upstreamPath,
    body,
    headers,
    reply,
    resolve,
  } = job;

  const apiKey =
    await getApiKey();

  const url =
    `${UPSTREAM}${upstreamPath}`;

  const patchedBody = body?.model
    ? patchBody(body.model, body)
    : body;

  app.log.info({
    method,
    path:
      upstreamPath,
    queueDepth:
      queue.length,
    active,
    usage:
      currentUsage(),
    limit:
      state.adaptiveLimit,
  });

  const response =
    await fetch(url, {
      method,
      headers: {
        Authorization:
          `Bearer ${apiKey}`,
        "Content-Type":
          headers[
            "content-type"
          ] ??
          "application/json",
      },
      body:
        method === "GET"
          ? undefined
          : JSON.stringify(
              patchedBody
            ),
    });

  //
  // Cooldown mode
  //
  if (
    response.status === 429
  ) {
    state.cooldownUntil =
      now() +
      COOLDOWN_MS;

    //
    // Optional adaptive learning
    //
    if (
      state.adaptiveLimit >
      5
    ) {
      state.adaptiveLimit--;
    }

    await saveState();

    throw new Error(
      `429 received. Entering cooldown until ${new Date(
        state.cooldownUntil
      ).toISOString()}`
    );
  }

  const respHeaders = {};

  for (const [
    key,
    value,
  ] of response.headers) {
    const lower =
      key.toLowerCase();

    if (
      lower === "transfer-encoding" ||
      lower === "content-encoding" ||
      lower === "content-length"
    ) {
      continue;
    }

    respHeaders[key] = value;
  }

  const accept =
    headers.accept ?? "";

  const isSSE =
    accept.includes(
      "text/event-stream"
    );

  reply.raw.writeHead(
    response.status,
    respHeaders
  );

  if (
    isSSE &&
    response.body
  ) {
    const nodeStream =
      Readable.fromWeb(
        response.body
      );

    nodeStream.pipe(reply.raw);
  } else {
    const text =
      await response.text();

    reply.raw.end(text);
  }

  resolve();
}

//
// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------
//

app.all(
  "/v1/*",
  async (
    request,
    reply
  ) => {
    reply.hijack();

    return new Promise(
      (
        resolve,
        reject
      ) => {
        queue.push({
          method:
            request.method,
          upstreamPath:
            request.url.replace(
              /^\/v1/,
              ""
            ),
          body:
            request.body,
          headers:
            request.headers,
          reply,
          resolve,
          reject,
        });
      }
    );
  }
);

//
// ------------------------------------------------------------------
// Startup
// ------------------------------------------------------------------
//

await loadState();

scheduler().catch(
  err =>
    app.log.error(err)
);

await app.listen({
  host: "0.0.0.0",
  port: PORT,
});

app.log.info({
  port: PORT,
  upstream:
    UPSTREAM,
  authFile:
    AUTH_FILE,
}, "proxy started");
