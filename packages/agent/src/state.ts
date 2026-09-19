import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AgentPlanSchema,
  DevflowError,
  DevflowErrorShapeSchema,
  RunResultSchema,
  TokenUsageSchema,
  type AgentPlan,
  type DevflowErrorShape,
  type RunId,
  type RunResult,
  type TokenUsage,
} from "@devflow/shared";
import { z } from "zod";

import type { ModelMessage } from "./model.js";

export const AgentPhaseSchema = z.enum([
  "IDLE",
  "THINKING",
  "CALLING_TOOL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);
export type AgentPhase = z.infer<typeof AgentPhaseSchema>;

const ModelToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

const ModelMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.enum(["SYSTEM", "USER"]), content: z.string() }),
  z.object({
    role: z.literal("ASSISTANT"),
    content: z.string(),
    toolCalls: z.array(ModelToolCallSchema).optional(),
  }),
  z.object({
    role: z.literal("TOOL"),
    content: z.unknown(),
    toolCallId: z.string(),
    toolName: z.string(),
    isError: z.boolean(),
  }),
]);

export const AgentStateMetricsSchema = z.object({
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  modelLatencyMs: z.number().int().nonnegative(),
  toolLatencyMs: z.number().int().nonnegative(),
  tokenUsage: TokenUsageSchema,
});
export interface AgentStateMetrics {
  modelCalls: number;
  toolCalls: number;
  retries: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  tokenUsage: TokenUsage;
}

export const AgentStateSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  phase: AgentPhaseSchema,
  stepCount: z.number().int().nonnegative(),
  messages: z.array(ModelMessageSchema),
  metrics: AgentStateMetricsSchema,
  startedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  plan: AgentPlanSchema.optional(),
  lastError: DevflowErrorShapeSchema.optional(),
  finalResult: RunResultSchema.optional(),
});
export interface AgentState {
  schemaVersion: 1;
  runId: RunId;
  phase: AgentPhase;
  stepCount: number;
  messages: readonly ModelMessage[];
  metrics: AgentStateMetrics;
  startedAt: string;
  updatedAt: string;
  plan?: AgentPlan;
  lastError?: DevflowErrorShape;
  finalResult?: RunResult;
}

export interface AgentStateStore {
  load(runId: RunId): Promise<AgentState | undefined>;
  save(state: AgentState): Promise<void>;
}

export class AgentStateSerializer {
  serialize(state: AgentState): string {
    return JSON.stringify(AgentStateSchema.parse(state));
  }

  deserialize(serialized: string): AgentState {
    try {
      return AgentStateSchema.parse(JSON.parse(serialized)) as AgentState;
    } catch (error) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Persisted AgentState is invalid.",
        cause: error,
      });
    }
  }
}

export class InMemoryAgentStateStore implements AgentStateStore {
  private readonly states = new Map<RunId, string>();

  constructor(private readonly serializer = new AgentStateSerializer()) {}

  async load(runId: RunId): Promise<AgentState | undefined> {
    const serialized = this.states.get(runId);
    return serialized === undefined ? undefined : this.serializer.deserialize(serialized);
  }

  async save(state: AgentState): Promise<void> {
    this.states.set(state.runId, this.serializer.serialize(state));
  }
}

export class JsonFileAgentStateStore implements AgentStateStore {
  constructor(
    private readonly directory: string,
    private readonly serializer = new AgentStateSerializer(),
  ) {}

  async load(runId: RunId): Promise<AgentState | undefined> {
    const filePath = this.filePath(runId);
    try {
      return this.serializer.deserialize(await readFile(filePath, "utf8"));
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      if (error instanceof DevflowError) throw error;
      throw new DevflowError({
        code: "INTERNAL_ERROR",
        message: `Could not load AgentState for run '${runId}'.`,
        cause: error,
      });
    }
  }

  async save(state: AgentState): Promise<void> {
    const filePath = this.filePath(state.runId);
    const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    const backupPath = `${filePath}.${String(process.pid)}.${randomUUID()}.bak`;
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(temporaryPath, this.serializer.serialize(state), "utf8");
      await replaceFile(temporaryPath, filePath, backupPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new DevflowError({
        code: "INTERNAL_ERROR",
        message: `Could not persist AgentState for run '${state.runId}'.`,
        details: {
          directory: path.resolve(this.directory),
          cause: error instanceof Error ? error.message : String(error),
        },
        cause: error,
      });
    }
  }

  private filePath(runId: RunId): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)
    ) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "AgentState runId must be a UUID.",
      });
    }
    return path.join(this.directory, `${runId}.json`);
  }
}

async function replaceFile(
  temporaryPath: string,
  destinationPath: string,
  backupPath: string,
): Promise<void> {
  try {
    await rename(temporaryPath, destinationPath);
    return;
  } catch (error) {
    if (!isReplaceConflict(error)) throw error;
  }

  let destinationMoved = false;
  try {
    await rename(destinationPath, backupPath);
    destinationMoved = true;
    await rename(temporaryPath, destinationPath);
    await rm(backupPath, { force: true }).catch(() => undefined);
  } catch (error) {
    if (destinationMoved) {
      try {
        await rename(backupPath, destinationPath);
      } catch (restoreError) {
        throw new DevflowError({
          code: "INTERNAL_ERROR",
          message: "AgentState replacement failed and the previous state could not be restored.",
          details: { backupPath, destinationPath },
          cause: restoreError,
        });
      }
    }
    throw error;
  }
}

export function createInitialAgentState(
  runId: RunId,
  messages: AgentState["messages"],
  now = new Date().toISOString(),
): AgentState {
  return {
    schemaVersion: 1,
    runId,
    phase: "IDLE",
    stepCount: 0,
    messages,
    metrics: {
      modelCalls: 0,
      toolCalls: 0,
      retries: 0,
      modelLatencyMs: 0,
      toolLatencyMs: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    },
    startedAt: now,
    updatedAt: now,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isReplaceConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EACCES", "EEXIST", "EPERM"].includes(String((error as { code?: unknown }).code))
  );
}
