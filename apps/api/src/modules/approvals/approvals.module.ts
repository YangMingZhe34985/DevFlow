import { Module } from "@nestjs/common";

import { ApprovalsController } from "./approvals.controller.js";

@Module({ controllers: [ApprovalsController] })
export class ApprovalsModule {}
