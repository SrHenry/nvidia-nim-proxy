export function registerRoutes(app, scheduler, nimClient, tokenTracker, tokenizer, modelInjector) {
  app.all("/v1/*", async (request, reply) => {
    reply.hijack();

    return new Promise((resolve, reject) => {
      scheduler.enqueue({
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
}
