import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";

import type { DatabaseAdapter } from "@devflow/database";
import { repositoryUriContainsCredentials } from "@devflow/shared";

import { IdSchema, requiredRecord } from "../../common/validation.js";
import { DATABASE } from "../../infrastructure/tokens.js";

const CreateRepositorySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  sourceKind: z.enum(["LOCAL", "GIT"]),
  sourceUri: z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .refine(
      (value) => !repositoryUriContainsCredentials(value),
      "Repository URIs must not contain credentials; configure them at the platform boundary.",
    ),
  defaultBranch: z.string().trim().min(1).max(255).optional(),
});

const UpdateRepositorySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    sourceUri: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine(
        (value) => !repositoryUriContainsCredentials(value),
        "Repository URIs must not contain credentials; configure them at the platform boundary.",
      )
      .optional(),
    defaultBranch: z.string().trim().min(1).max(255).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");

@Controller("repositories")
export class RepositoriesController {
  constructor(@Inject(DATABASE) private readonly database: DatabaseAdapter) {}

  @Post()
  async create(@Body() body: unknown) {
    return await this.database.repositories.create(CreateRepositorySchema.parse(body));
  }

  @Get()
  async list() {
    return await this.database.repositories.list();
  }

  @Get(":id")
  async get(@Param("id") rawId: string) {
    const id = IdSchema.parse(rawId);
    return requiredRecord(await this.database.repositories.findById(id), "Repository", id);
  }

  @Patch(":id")
  async update(@Param("id") rawId: string, @Body() body: unknown) {
    return await this.database.repositories.update(
      IdSchema.parse(rawId),
      UpdateRepositorySchema.parse(body),
    );
  }

  @Delete(":id")
  async delete(@Param("id") rawId: string) {
    await this.database.repositories.delete(IdSchema.parse(rawId));
    return { deleted: true };
  }
}
