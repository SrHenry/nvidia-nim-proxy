export function createScheduler(config, rateLimiter, processJob, estimateJobTokens, logger, resolveModelConfig) {
  const rmc = resolveModelConfig || { resolve: (m, k) => config[k], getMatchedOverrides: () => null };
  const queue = [];
  let active = 0;
  let lastDispatchAt = 0;
  let running = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function now() {
    return Date.now();
  }

  function enqueue(job) {
    queue.push(job);
  }

  function queueDepth() {
    return queue.length;
  }

  function activeCount() {
    return active;
  }

  async function loop() {
    running = true;

    while (running) {
      try {
        if (queue.length === 0) {
          await sleep(50);
          continue;
        }

        const job = queue[0];
        const model = job.body?.model || 'unknown';
        const path = job.upstreamPath || '';
        const estimated = estimateJobTokens ? estimateJobTokens(job.body) : 0;

        if (active >= rmc.resolve(model, 'maxConcurrency')) {
          await sleep(25);
          continue;
        }

        const cooldownWait = rateLimiter.timeUntilDispatchAllowed(model, path, estimated);
        if (cooldownWait > 0) {
          await sleep(cooldownWait);
          continue;
        }

        if (!rateLimiter.canDispatch(model, path, estimated)) {
          const wait = rateLimiter.timeUntilDispatchAllowed(model, path, estimated);
          if (wait > 0) await sleep(wait);
          continue;
        }

        const gap = Math.max(
          rmc.resolve(model, 'minDispatchGapMs'),
          Math.ceil(estimated * config.windowMs / Math.max(rmc.resolve(model, 'maxTpm'), 1))
        );
        const sinceLastDispatch = now() - lastDispatchAt;
        if (sinceLastDispatch < gap) {
          await sleep(gap - sinceLastDispatch);
        }

        queue.shift();
        active++;
        lastDispatchAt = now();
        rateLimiter.recordDispatch(model, path, estimated);

        processJob(job)
          .catch((err) => job.reject(err))
          .finally(() => {
            rateLimiter.recordCompletion(model, path);
            active--;
          });
      } catch (err) {
        if (logger) logger.error(err);
        await sleep(1000);
      }
    }
  }

  function start() {
    if (!running) {
      loop().catch((err) => {
        if (logger) logger.error(err);
      });
    }
  }

  return { enqueue, start, queueDepth, activeCount };
}
