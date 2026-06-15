import { Readable } from "node:stream";
import config from "./config.js";
import { createTokenizer } from "./infrastructure/tokenizer.js";
import { createStateStore } from "./infrastructure/state-store.js";
import { createAuthLoader } from "./infrastructure/auth-loader.js";
import { createNimClient } from "./infrastructure/nim-client.js";
import { createRateLimiter } from "./domain/rate-limiter.js";
import { createTokenTracker } from "./domain/token-tracker.js";
import { createModelInjector } from "./domain/model-injector.js";
import { createScheduler } from "./domain/scheduler.js";
import { registerRoutes } from "./presentation/routes.js";
import { createServer } from "./presentation/server.js";
import { createSSETapStream } from "./presentation/sse-tap.js";

const tokenizer = createTokenizer();
const stateStore = createStateStore(config.stateFile);
const authLoader = createAuthLoader(config.authFile, config.provider);
const modelInjector = createModelInjector(config);
const rateLimiter = createRateLimiter(config);
const tokenTracker = createTokenTracker(tokenizer, rateLimiter, null);

async function processJob(job) {
  const {
    method,
    upstreamPath,
    body,
    headers,
    reply,
    resolve,
  } = job;

  const model = body?.model || "unknown";

  const response = await nimClient.send({
    method,
    path: upstreamPath,
    body,
    headers,
  });

  reply.raw.writeHead(response.status, response.headers);

  if (response.isSSE && response.body) {
    const nodeStream = Readable.fromWeb(response.body);
    const tap = createSSETapStream(model, body, tokenizer, tokenTracker);
    nodeStream.pipe(tap).pipe(reply.raw);
    tap.on("end", () => resolve());
  } else {
    const text = await response.body.text();

    let responseBody = null;
    try {
      responseBody = JSON.parse(text);
    } catch {
      // not JSON
    }

    if (responseBody) {
      const usage = tokenTracker.estimateFromResponse(model, body, responseBody);
      tokenTracker.record(model, usage.promptTokens, usage.completionTokens, usage.source);
    }

    reply.raw.end(text);
    resolve();
  }
}

const nimClient = createNimClient(config, authLoader, modelInjector, null);

const scheduler = createScheduler(config, rateLimiter, processJob, null);

const { app, start: startServer } = createServer();

registerRoutes(app, scheduler, nimClient, tokenTracker, tokenizer, modelInjector);

const loadedState = await stateStore.load();
rateLimiter.loadState(loadedState);
tokenTracker.loadState(loadedState);

const logger = app.log;

nimClient._logger = logger;
scheduler._logger = logger;
tokenTracker._logger = logger;

scheduler.start();

await startServer(config.port);

logger.info(
  {
    port: config.port,
    upstream: config.upstream,
    authFile: config.authFile,
    maxRpm: config.maxRpm,
    cooldownMinutes: config.cooldownMs / 60_000,
    maxRetries: config.maxRetries,
    retryDelays: config.retryDelays,
    minDispatchGapMs: config.minDispatchGapMs,
    maxConcurrency: config.maxConcurrency,
  },
  "proxy started"
);
