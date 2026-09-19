import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";

import type { DatabaseAdapter } from "@devflow/database";
import type { RunQueuePort } from "@devflow/shared";

import { DATABASE, RUN_QUEUE } from "../../infrastructure/tokens.js";

interface HealthResponse {
  status: "ok" | "not_ready";
  service: "api";
  timestamp: string;
  checks: Readonly<Record<string, string>>;
}

@Controller("health")
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseAdapter,
    @Inject(RUN_QUEUE) private readonly runQueue: RunQueuePort,
  ) {}

  @Get("live")
  live(): HealthResponse {
    return {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
      checks: {},
    };
  }

  @Get("ready")
  async ready(): Promise<HealthResponse> {
    try {
      await Promise.all([this.database.ping(), this.runQueue.ping()]);
      return {
        status: "ok",
        service: "api",
        timestamp: new Date().toISOString(),
        checks: { database: "ok", redis: "ok" },
      };
    } catch {
      throw new ServiceUnavailableException({
        status: "not_ready",
        service: "api",
        timestamp: new Date().toISOString(),
        checks: { database: "failed", redis: "failed" },
      } satisfies HealthResponse);
    }
  }
}
