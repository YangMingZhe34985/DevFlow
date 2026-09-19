import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type DynamicModule,
  type OnModuleInit,
  type Provider,
} from "@nestjs/common";

import { PrismaDatabaseAdapter, type DatabaseAdapter } from "@devflow/database";
import type { RunQueuePort } from "@devflow/shared";

import { loadApiEnvironment } from "../config/env.js";
import { BullRunQueue } from "./bull-run-queue.js";
import { DATABASE, RUN_QUEUE } from "./tokens.js";

export interface InfrastructureOverrides {
  database?: DatabaseAdapter;
  runQueue?: RunQueuePort;
}

@Injectable()
class InfrastructureLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseAdapter,
    @Inject(RUN_QUEUE) private readonly runQueue: RunQueuePort,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.database.connect();
    await Promise.all([this.database.ping(), this.runQueue.ping()]);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.runQueue.close(), this.database.disconnect()]);
  }
}

@Global()
@Module({})
export class InfrastructureModule {
  static register(overrides: InfrastructureOverrides = {}): DynamicModule {
    const environment = loadApiEnvironment();
    const providers: Provider[] = [
      {
        provide: DATABASE,
        useValue:
          overrides.database ??
          PrismaDatabaseAdapter.fromConnectionString(environment.DATABASE_URL),
      },
      {
        provide: RUN_QUEUE,
        useValue:
          overrides.runQueue ?? new BullRunQueue(environment.RUN_QUEUE_NAME, environment.REDIS_URL),
      },
      InfrastructureLifecycle,
    ];
    return {
      global: true,
      module: InfrastructureModule,
      providers,
      exports: [DATABASE, RUN_QUEUE],
    };
  }
}
