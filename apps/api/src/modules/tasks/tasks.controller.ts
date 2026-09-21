import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";

import type { DatabaseAdapter } from "@devflow/database";

import { IdSchema, requiredRecord } from "../../common/validation.js";
import { DATABASE } from "../../infrastructure/tokens.js";
import { TaskBaseCommitResolver } from "./task-base-commit-resolver.js";

const CreateTaskSchema = z.strictObject({
  repositoryId: IdSchema,
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(100_000),
  baseRef: z.string().trim().min(1).max(255).optional(),
});

const UpdateTaskSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().min(1).max(100_000).optional(),
    status: z.enum(["OPEN", "COMPLETED", "CANCELLED", "ARCHIVED"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");

@Controller("tasks")
export class TasksController {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseAdapter,
    @Inject(TaskBaseCommitResolver) private readonly baseCommitResolver: TaskBaseCommitResolver,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const input = CreateTaskSchema.parse(body);
    const repository = requiredRecord(
      await this.database.repositories.findById(input.repositoryId),
      "Repository",
      input.repositoryId,
    );
    const resolved = await this.baseCommitResolver.resolve(repository, input.baseRef);
    return await this.database.tasks.create({ ...input, ...resolved });
  }

  @Get()
  async list(@Query("repositoryId") rawRepositoryId?: string) {
    const repositoryId =
      rawRepositoryId === undefined ? undefined : IdSchema.parse(rawRepositoryId);
    return await this.database.tasks.list(repositoryId);
  }

  @Get(":id")
  async get(@Param("id") rawId: string) {
    const id = IdSchema.parse(rawId);
    return requiredRecord(await this.database.tasks.findById(id), "Task", id);
  }

  @Patch(":id")
  async update(@Param("id") rawId: string, @Body() body: unknown) {
    return await this.database.tasks.update(IdSchema.parse(rawId), UpdateTaskSchema.parse(body));
  }

  @Delete(":id")
  async delete(@Param("id") rawId: string) {
    await this.database.tasks.delete(IdSchema.parse(rawId));
    return { deleted: true };
  }
}
