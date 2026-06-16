import { Readable } from "node:stream";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createNimClient(config, authLoader, modelInjector, logger) {
  function filterHeaders(responseHeaders) {
    const filtered = {};
    for (const [key, value] of responseHeaders) {
      const lower = key.toLowerCase();
      if (
        lower === "transfer-encoding" ||
        lower === "content-encoding" ||
        lower === "content-length"
      ) {
        continue;
      }
      filtered[key] = value;
    }
    return filtered;
  }

  async function send({ method, path, body, headers }) {
    const apiKey = await authLoader.getApiKey();
    const url = `${config.upstream}${path}`;

    const patchedBody = body?.model
      ? modelInjector.patch(body.model, body)
      : body;

    const contentType = headers["content-type"] ?? "application/json";

    let lastResponse = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay =
          config.retryDelays[attempt - 1] ||
          config.retryDelays[config.retryDelays.length - 1];

        if (logger) {
          logger.info(
            { attempt, delay, model: body?.model, path },
            "retrying after 429"
          );
        }

        await sleep(delay * 1000);
      }

      let response;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);

        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": contentType,
          },
          body:
            method === "GET"
              ? undefined
              : JSON.stringify(patchedBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);
      } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          if (attempt === config.maxRetries) {
            throw new Error('upstream timeout');
          }
          if (logger) {
            logger.warn({ attempt, model: body?.model, path }, 'upstream timeout, retrying');
          }
          continue;
        }
        throw err;
      }

      lastResponse = response;

      if (response.status !== 429) {
        break;
      }

      const respHeaders = {};
      for (const [key, value] of response.headers) {
        respHeaders[key] = value;
      }

      if (logger) {
        logger.warn(
          {
            status: 429,
            attempt,
            maxRetries: config.maxRetries,
            headers: respHeaders,
            model: body?.model,
            path,
          },
          "429 received from upstream"
        );
      }

      if (attempt === config.maxRetries) {
        throw new Error(
          `429 exhausted ${config.maxRetries + 1} attempts`
        );
      }
    }

    return {
      status: lastResponse.status,
      headers: filterHeaders(lastResponse.headers),
      body: lastResponse.body,
      isSSE: (lastResponse.headers.get("content-type") ?? "").includes("text/event-stream"),
    };
  }

  return { send };
}
