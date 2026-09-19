import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import type { DatabaseAdapter } from "@devflow/database";
import type { RunQueuePort } from "@devflow/shared";

import { IdSchema, requiredRecord } from "../../common/validation.js";
import { DATABASE, RUN_QUEUE } from "../../infrastructure/tokens.js";

const CreateApprovalSchema = z.strictObject({
  runId: IdSchema,
  kind: z.enum(["PLAN", "TOOL_CALL"]),
  request: z.json(),
});

const ResolveApprovalSchema = z.strictObject({
  status: z.enum(["APPROVED", "REJECTED", "CANCELLED"]),
  resolution: z.json().optional(),
  comment: z.string().trim().max(10_000).optional(),
  actorId: z.string().trim().min(1).max(255).optional(),
});

@Controller("approvals")
export class ApprovalsController {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseAdapter,
    @Inject(RUN_QUEUE) private readonly runQueue: RunQueuePort,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    return await this.database.approvals.create(CreateApprovalSchema.parse(body));
  }

  @Get()
  async list(@Query("runId") rawRunId?: string) {
    const runId = rawRunId === undefined ? undefined : IdSchema.parse(rawRunId);
    return await this.database.approvals.list(runId);
  }

  @Get(":id")
  async get(@Param("id") rawId: string) {
    const id = IdSchema.parse(rawId);
    return requiredRecord(await this.database.approvals.findById(id), "Approval", id);
  }

  @Post(":id/resolve")
  @HttpCode(HttpStatus.OK)
  async resolve(@Param("id") rawId: string, @Body() body: unknown) {
    const outcome = await this.database.approvals.resolveForWorkflow(
      IdSchema.parse(rawId),
      ResolveApprovalSchema.parse(body),
    );
    if (outcome.shouldEnqueue && outcome.run !== undefined) {
      await this.runQueue.enqueue({
        version: 1,
        runId: outcome.run.id,
        dispatchRevision: outcome.run.dispatchRevision,
      });
    }
    return outcome.approval;
  }
}
