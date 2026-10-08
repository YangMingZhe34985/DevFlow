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
import {
  ContextCompressionStateSchema,
  type ContextCompressionState,
} from "./context-compression.js";

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

const MutationObservationSchema = z.object({
  status: z.enum(["APPLIED", "NO_OP", "REJECTED", "FAILED"]),
  executionSucceeded: z.boolean(),
  mutationAttempted: z.boolean(),
  mutationApplied: z.boolean(),
  workspaceChanged: z.boolean(),
  reason: z.string(),
  beforeRevision: z.number().int().nonnegative(),
  afterRevision: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
  currentHashes: z.record(
    z.string(),
    z.union([z.string().regex(/^[a-f0-9]{64}$/u), z.literal("ABSENT")]),
  ),
  observationComplete: z.boolean().optional(),
  affectedPaths: z.array(z.string()).optional(),
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
    mutation: MutationObservationSchema.optional(),
  }),
]);

export const AgentStateMetricsSchema = z.object({
  modelRequestsDispatched: z.number().int().nonnegative().optional(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolExecutions: z.number().int().nonnegative().default(0),
  cacheHits: z.number().int().nonnegative().default(0),
  duplicateToolCalls: z.number().int().nonnegative().default(0),
  stalledDetections: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  retries: z.number().int().nonnegative(),
  modelLatencyMs: z.number().int().nonnegative(),
  toolLatencyMs: z.number().int().nonnegative(),
  tokenUsage: TokenUsageSchema,
});
export interface AgentStateMetrics {
  modelRequestsDispatched?: number;
  modelCalls: number;
  toolCalls: number;
  toolExecutions: number;
  cacheHits: number;
  duplicateToolCalls: number;
  stalledDetections: number;
  reasoningTokens: number;
  retries: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  tokenUsage: TokenUsage;
}

export const AdaptiveStepBudgetStateSchema = z.object({
  currentLimit: z.number().int().positive(),
  hardLimit: z.number().int().positive(),
  extensions: z.number().int().nonnegative(),
});
export interface AdaptiveStepBudgetState {
  currentLimit: number;
  hardLimit: number;
  extensions: number;
}

export const AgentStateSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  phase: AgentPhaseSchema,
  stepCount: z.number().int().nonnegative(),
  messages: z.array(ModelMessageSchema),
  metrics: AgentStateMetricsSchema,
  startedAt: z.string().datetime({ offset: true }),
  phaseDeadlineAt: z.number().optional(),
  updatedAt: z.string().datetime({ offset: true }),
  /** Optional so schema-version 1 checkpoints written before adaptive leases remain valid. */
  adaptiveStepBudget: AdaptiveStepBudgetStateSchema.optional(),
  plan: AgentPlanSchema.optional(),
  contextCompression: ContextCompressionStateSchema.optional(),
  /** Host-owned admission accounting; never supplied by model tool arguments. */
  hostToolState: z.record(z.string(), z.unknown()).optional(),
  codingContinuations: z
    .array(
      z.object({
        id: z.string(),
        fingerprint: z.string(),
        kind: z.string(),
        step: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  executionConvergence: z
    .object({
      noProgressStreak: z.number().int().nonnegative(),
      diffFingerprints: z.array(z.string()),
      evidence: z.object({
        ranges: z.array(z.tuple([z.string(), z.array(z.tuple([z.number(), z.number()]))])),
        facts: z.array(z.string()),
      }),
    })
    .optional(),
  postPatch: z
    .object({
      revision: z.number().int().nonnegative(),
      changed: z.array(z.string()),
      hashes: z.record(z.string(), z.string()),
      failures: z.record(z.string(), z.string()),
      firstMutationEndedAt: z.number().nullable(),
      diff: z.string(),
      diffFingerprint: z.string().nullable(),
      completionDecision: z.boolean(),
      unfinishedWork: z.array(z.string()).optional(),
      calls: z.object({
        model: z.number(),
        tool: z.number(),
        input: z.number(),
        output: z.number(),
        mutation: z.number(),
        reads: z.number(),
        diff: z.number(),
      }),
    })
    .optional(),
  executionRecovery: z
    .object({
      pending: z.boolean(),
      used: z.boolean(),
      explorationClosed: z.boolean(),
      handoffPending: z.boolean().optional(),
      authorizationHandoffUsed: z.boolean().optional(),
      evidenceRefreshUsed: z.boolean().optional(),
      submissionOnly: z.boolean().optional(),
      correctionTool: z.string().optional(),
      correctionInput: z.string().optional(),
      correctionReason: z.enum(["FORMAT_INVALID", "OUTPUT_LENGTH", "PROTOCOL_INVALID"]).optional(),
    })
    .optional(),
  lastError: DevflowErrorShapeSchema.optional(),
  finalResult: RunResultSchema.optional(),
});
export interface AgentState {
  hostToolState?: Record<string, unknown>;
  codingContinuations?: z.infer<typeof AgentStateSchema>["codingContinuations"];
  executionConvergence?: z.infer<typeof AgentStateSchema>["executionConvergence"];
  postPatch?: z.infer<typeof AgentStateSchema>["postPatch"];
  executionRecovery?: {
    pending: boolean;
    used: boolean;
    explorationClosed: boolean;
    handoffPending?: boolean;
    authorizationHandoffUsed?: boolean;
    evidenceRefreshUsed?: boolean;
    submissionOnly?: boolean;
    correctionReason?: "FORMAT_INVALID" | "OUTPUT_LENGTH" | "PROTOCOL_INVALID";
    correctionTool?: string;
    correctionInput?: string;
  };
  schemaVersion: 1;
  runId: RunId;
  phase: AgentPhase;
  stepCount: number;
  messages: readonly ModelMessage[];
  metrics: AgentStateMetrics;
  startedAt: string;
  phaseDeadlineAt?: number;
  updatedAt: string;
  adaptiveStepBudget?: AdaptiveStepBudgetState;
  plan?: AgentPlan;
  contextCompression?: ContextCompressionState;
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
      modelRequestsDispatched: 0,
      modelCalls: 0,
      toolCalls: 0,
      toolExecutions: 0,
      cacheHits: 0,
      duplicateToolCalls: 0,
      stalledDetections: 0,
      reasoningTokens: 0,
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
