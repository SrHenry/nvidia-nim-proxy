export function createScheduler(config, rateLimiter, processJob, estimateJobTokens, logger) {
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
        const cooldownWait = rateLimiter.timeUntilDispatchAllowed();
        if (cooldownWait > 0) {
          await sleep(cooldownWait);
          continue;
        }

        if (queue.length === 0) {
          await sleep(50);
          continue;
        }

        if (active >= config.maxConcurrency) {
          await sleep(25);
          continue;
        }

        const estimated = estimateJobTokens ? estimateJobTokens(queue[0].body) : 0;

        if (!rateLimiter.canDispatch(estimated)) {
          const wait = rateLimiter.timeUntilDispatchAllowed(estimated);
          if (wait > 0) await sleep(wait);
          continue;
        }

        const sinceLastDispatch = now() - lastDispatchAt;
        if (sinceLastDispatch < config.minDispatchGapMs) {
          await sleep(config.minDispatchGapMs - sinceLastDispatch);
        }

        const job = queue.shift();
        active++;
        lastDispatchAt = now();
        rateLimiter.recordDispatch();

        processJob(job)
          .catch((err) => job.reject(err))
          .finally(() => {
            rateLimiter.recordCompletion();
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
