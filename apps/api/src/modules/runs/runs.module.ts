import { Module } from "@nestjs/common";

import { RunEventStreamService } from "./run-event-stream.service.js";
import { RunsController } from "./runs.controller.js";

@Module({ controllers: [RunsController], providers: [RunEventStreamService] })
export class RunsModule {}
