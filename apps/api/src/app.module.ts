import { Module, type DynamicModule } from "@nestjs/common";

import {
  InfrastructureModule,
  type InfrastructureOverrides,
} from "./infrastructure/infrastructure.module.js";
import { ApprovalsModule } from "./modules/approvals/approvals.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { RepositoriesModule } from "./modules/repositories/repositories.module.js";
import { RunsModule } from "./modules/runs/runs.module.js";
import { TasksModule } from "./modules/tasks/tasks.module.js";

@Module({})
export class AppModule {
  static register(overrides: InfrastructureOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfrastructureModule.register(overrides),
        HealthModule,
        RepositoriesModule,
        TasksModule,
        RunsModule,
        ApprovalsModule,
      ],
    };
  }
}
