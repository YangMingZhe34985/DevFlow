import { Module } from "@nestjs/common";

import { TasksController } from "./tasks.controller.js";
import { TaskBaseCommitResolver } from "./task-base-commit-resolver.js";

@Module({ controllers: [TasksController], providers: [TaskBaseCommitResolver] })
export class TasksModule {}
