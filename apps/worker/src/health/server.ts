import { createServer, type Server } from "node:http";

export interface WorkerReadiness {
  ready: boolean;
  checks: Readonly<Record<string, string>>;
}

export async function startHealthServer(
  port: number,
  readiness: () => WorkerReadiness,
): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (request.url === "/health/live") {
      response.statusCode = 200;
      response.end(
        JSON.stringify({ status: "ok", service: "worker", timestamp: new Date().toISOString() }),
      );
      return;
    }

    if (request.url === "/health/ready") {
      const current = readiness();
      response.statusCode = current.ready ? 200 : 503;
      response.end(
        JSON.stringify({
          status: current.ready ? "ok" : "not_ready",
          service: "worker",
          timestamp: new Date().toISOString(),
          checks: current.checks,
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ status: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

export async function stopHealthServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

// TODO(P5-worker): allow an async readiness probe with a strict timeout once
// Redis is connected; never report cached connectivity as a fresh successful ping.
