import Fastify from "fastify";

export function createServer() {
  const app = Fastify({
    logger: {
      level: "info",
    },
  });

  async function start(port, host = "0.0.0.0") {
    await app.listen({ host, port });
  }

  return { app, start };
}
