import { Readable } from "node:stream";
import config from "./config.js";
import { createTokenizer } from "./infrastructure/tokenizer.js";
import { createAuthLoader } from "./infrastructure/auth-loader.js";
import { createNimClient } from "./infrastructure/nim-client.js";
import { createRateLimiter } from "./domain/rate-limiter.js";
import { createTokenTracker } from "./domain/token-tracker.js";
import { createModelInjector } from "./domain/model-injector.js";
import { createScheduler } from "./domain/scheduler.js";
import { registerRoutes } from "./presentation/routes.js";
import { createServer } from "./presentation/server.js";
import { createSSETapStream } from "./presentation/sse-tap.js";
import { Database } from "./infrastructure/database/connection.js";
import { createSnowflakeGenerator } from "./infrastructure/database/snowflake.js";
import { RequestsRepository } from "./infrastructure/database/requests-repository.js";
import { ThrottleRepository } from "./infrastructure/database/throttle-repository.js";
import { BufferedRepository } from "./infrastructure/database/buffered-repository.js";
import { maybeMigrateFromJson } from "./infrastructure/database/legacy-migration.js";

const tokenizer = createTokenizer();
const authLoader = createAuthLoader(config.authFile, config.provider);
const modelInjector = createModelInjector(config);
const rateLimiter = createRateLimiter(config);
const tokenTracker = createTokenTracker(tokenizer, rateLimiter, null);

const db = new Database(config.dbPath);
await db.migrate();
const snowflake = createSnowflakeGenerator({ workerId: config.snowflakeWorkerId });

const realRequestsRepo = new RequestsRepository(db, snowflake);
const requestsRepo = new BufferedRepository(realRequestsRepo, {
  flushIntervalMs: config.flushIntervalMs,
  batchSize: config.flushBatchSize,
});
const throttleRepo = new ThrottleRepository(db, snowflake);

const loadedState = throttleRepo.getState();
if (loadedState) {
  rateLimiter.loadState({
    cooldownUntil: loadedState.cooldownUntil,
    adaptiveLimit: loadedState.adaptiveLimit,
  });
}

await maybeMigrateFromJson(config.stateFile, requestsRepo, throttleRepo);

async function processJob(job) {
  const { method, upstreamPath, body, headers, reply, resolve } = job;

  const model = body?.model || "unknown";
  const startTime = Date.now();

  let statusCode = 0;
  let errorMessage = null;
  let isSse = false;

  try {
    const response = await nimClient.send({
      method,
      path: upstreamPath,
      body,
      headers,
    });

    statusCode = response.status;
    isSse = response.isSSE;

    reply.raw.writeHead(response.status, response.headers);

    if (response.isSSE && response.body) {
      const nodeStream = Readable.fromWeb(response.body);
      const tap = createSSETapStream(model, body, tokenizer, tokenTracker);
      nodeStream.pipe(tap).pipe(reply.raw);
      tap.on("end", () => {
        const { promptTokens, completionTokens, source } =
          tokenTracker.estimateFromResponse(model, body, null);
        const totalTokens = promptTokens + completionTokens;
        tokenTracker.record(model, promptTokens, completionTokens, source);
        requestsRepo.insert({
          model,
          statusCode,
          latencyMs: Date.now() - startTime,
          error: null,
          promptTokens,
          completionTokens,
          totalTokens,
          tokenSource: source,
          modelInjection: modelInjector.getMatchedRule(model),
          isSse: true,
          createdAt: startTime,
        });
        resolve();
      });
    } else {
      const text = await new Response(response.body).text();

      let responseBody = null;
      try {
        responseBody = JSON.parse(text);
      } catch {
        // not JSON
      }

      let promptTokens = 0;
      let completionTokens = 0;
      let tokenSource = "estimated";

      if (responseBody) {
        const usage = tokenTracker.estimateFromResponse(model, body, responseBody);
        promptTokens = usage.promptTokens;
        completionTokens = usage.completionTokens;
        tokenSource = usage.source;
      }

      tokenTracker.record(model, promptTokens, completionTokens, tokenSource);
      requestsRepo.insert({
        model,
        statusCode,
        latencyMs: Date.now() - startTime,
        error: null,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        tokenSource,
        modelInjection: modelInjector.getMatchedRule(model),
        isSse: false,
        createdAt: startTime,
      });

      reply.raw.end(text);
      resolve();
    }
  } catch (err) {
    errorMessage = err.message;
    statusCode = statusCode || 500;

    const is429Exhausted = errorMessage.includes("429 exhausted");
    if (is429Exhausted) {
      rateLimiter.enterCooldown();
      const state = rateLimiter.getState();
      throttleRepo.setState({
        adaptiveLimit: state.adaptiveLimit,
        cooldownUntil: state.cooldownUntil,
      });
      throttleRepo.insertEvent({
        type: "cooldown_enter",
        limitBefore: state.adaptiveLimit + 1,
        limitAfter: state.adaptiveLimit,
        cooldownUntil: state.cooldownUntil,
        reason: errorMessage,
        metadata: JSON.stringify({ model, path: upstreamPath }),
      });
    }

    requestsRepo.insert({
      model,
      statusCode,
      latencyMs: Date.now() - startTime,
      error: errorMessage,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokenSource: "estimated",
      modelInjection: modelInjector.getMatchedRule(model),
      isSse: false,
      createdAt: startTime,
    });

    try {
      reply.raw.writeHead(statusCode, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: errorMessage }));
    } catch {
      // reply may already be sent
    }
    job.reject ? job.reject(err) : resolve();
  }
}

const nimClient = createNimClient(config, authLoader, modelInjector, null);
const scheduler = createScheduler(config, rateLimiter, processJob, null);

const pruneInterval = setInterval(() => {
  const cutoff = Date.now() - config.dbRetentionDays * 86400000;
  try {
    const deletedRequests = requestsRepo.prune(cutoff);
    const deletedEvents = throttleRepo.prune(cutoff);
    if (deletedRequests > 0 || deletedEvents > 0) {
      const log = app.log;
      if (log) log.info({ deletedRequests, deletedEvents }, "pruned old records");
    }
  } catch (err) {
    const log = app.log;
    if (log) log.error(err, "prune error");
  }
}, 3600000);
pruneInterval.unref();

async function shutdown() {
  clearInterval(pruneInterval);
  await requestsRepo.drain();
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const { app, start: startServer } = createServer();
registerRoutes(app, scheduler, nimClient, tokenTracker, tokenizer, modelInjector);

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
    dbPath: config.dbPath,
    dbRetentionDays: config.dbRetentionDays,
    snowflakeWorkerId: config.snowflakeWorkerId,
    flushIntervalMs: config.flushIntervalMs,
    flushBatchSize: config.flushBatchSize,
    maxRpm: config.maxRpm,
    cooldownMinutes: config.cooldownMs / 60_000,
    maxRetries: config.maxRetries,
    retryDelays: config.retryDelays,
    minDispatchGapMs: config.minDispatchGapMs,
    maxConcurrency: config.maxConcurrency,
  },
  "proxy started"
);
