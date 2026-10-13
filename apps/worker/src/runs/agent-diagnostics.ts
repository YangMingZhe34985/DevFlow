import { createHash } from "node:crypto";
import { z } from "zod";
import { DevflowError } from "@devflow/shared";
import type { PublicVerificationProfile } from "@devflow/eval";
import {
  publicDiagnosticResources,
  type CommandResult,
  type PublicDiagnosticResources,
} from "@devflow/sandbox";
import type {
  ResourceBudgetOperationPlan,
  ResourceBudgetScheduler,
} from "./resource-budget-scheduler.js";
import { estimateOperationPlan } from "./resource-budget-scheduler.js";
import { optimizeContextProjection, type ModelRequest, type ModelMessage } from "@devflow/agent";
import { priceModelOperationPlan, type ModelResourcePrice } from "./resource-budget-runtime.js";

export const DiagnosticRequestSchema = z.strictObject({
  checkId: z.string().min(1).max(80),
  reason: z.string().min(1).max(2000),
});
export type DiagnosticRequest = z.infer<typeof DiagnosticRequestSchema>;
export interface DiagnosticRecord {
  version: 1;
  id: string;
  sourceIdentity: string;
  profileSha256: string;
  checkId: string;
  reason: string;
  status: "PREPARED" | "INFLIGHT" | "COMPLETED" | "NOT_ISSUED" | "UNKNOWN";
  result?: CommandResult;
  failure?: string;
  /** Frozen before dispatch so an interrupted operation can only clean up its own copy. */
  resources?: PublicDiagnosticResources;
  failureDetails?: unknown;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Optional strategy, with immutable receipts in the same leased Run artifact store. */
export class AgentDiagnostics {
  constructor(
    private readonly ports: {
      runId: string;
      enabled: boolean;
      profile: PublicVerificationProfile;
      load: () => Promise<DiagnosticRecord[]>;
      save: (record: DiagnosticRecord) => Promise<void>;
      identity: () => Promise<string>;
      admit: (record: DiagnosticRecord) => Promise<void>;
      execute: (
        check: PublicVerificationProfile["checks"][number],
        signal: AbortSignal,
        record: DiagnosticRecord,
      ) => Promise<CommandResult>;
    },
  ) {}

  checks() {
    return this.ports.profile.checks.map((check, index) => ({
      checkId: `${index}:${check.kind}`,
      kind: check.kind,
      source: check.source,
    }));
  }

  async run(raw: unknown, signal: AbortSignal) {
    // Enforced at the execution boundary even if a caller fabricates a descriptor.
    if (!this.ports.enabled)
      throw new DevflowError({
        code: "PERMISSION_DENIED",
        message: "Agent diagnostics disabled for this Run.",
      });
    const request = DiagnosticRequestSchema.parse(raw);
    const selected = this.checks().findIndex((c) => c.checkId === request.checkId);
    if (selected < 0)
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Unknown public diagnostic checkId.",
        details: { field: "checkId", allowed: this.checks(), requestIssued: false },
      });
    const records = await this.ports.load();
    // A lost receipt cannot become a fresh allowance after approval or process recovery.
    const unknown = records.filter((r) => r.status === "INFLIGHT" || r.status === "UNKNOWN");
    if (unknown.length)
      throw new DevflowError({
        code: "CONFLICT",
        message: "DIAGNOSTIC_RECEIPT_UNKNOWN: cannot re-execute an unconfirmed diagnostic.",
        details: {
          requestIssued: false,
          operations: unknown.map(({ id, resources }) => ({ id, resources })),
          recovery: "CLEANUP_ONLY; unknown execution and budget remain retained",
        },
      });
    const sourceIdentity = await this.ports.identity();
    const profileSha256 = hash(this.ports.profile);
    const id = hash({
      runId: this.ports.runId,
      sourceIdentity,
      profileSha256,
      checkId: request.checkId,
    });
    const prior = records.find((r) => r.id === id);
    if (prior?.status === "COMPLETED")
      return {
        ...prior,
        cached: true,
        authority: "OBSERVATION_ONLY",
        finalValidationRequired: true,
      };
    if (prior)
      throw new DevflowError({
        code: "CONFLICT",
        message: "DIAGNOSTIC_NOT_REPLAYABLE: prior incomplete or denied attempt retained.",
      });
    if (records.length >= 2)
      throw new DevflowError({
        code: "EXECUTION_BUDGET_EXCEEDED",
        message: "Two optional diagnostics already attempted in this Run.",
        details: { requestIssued: false },
      });
    const record: DiagnosticRecord = {
      version: 1,
      id,
      sourceIdentity,
      profileSha256,
      ...request,
      resources: publicDiagnosticResources(id),
      status: "PREPARED",
    };
    await this.ports.save(record);
    try {
      await this.ports.admit(record);
      signal.throwIfAborted();
    } catch (error) {
      await this.ports.save({
        ...record,
        status: "NOT_ISSUED",
        failure: String(error).slice(0, 1500),
      });
      throw error;
    }
    await this.ports.save({ ...record, status: "INFLIGHT" });
    try {
      const result = await this.ports.execute(this.ports.profile.checks[selected]!, signal, record);
      const completed: DiagnosticRecord = { ...record, status: "COMPLETED", result };
      await this.ports.save(completed);
      return {
        ...completed,
        cached: false,
        authority: "OBSERVATION_ONLY",
        finalValidationRequired: true,
      };
    } catch (error) {
      const saved = (await this.ports.load()).find((r) => r.id === id);
      if (saved?.status !== "COMPLETED")
        await this.ports.save({
          ...record,
          status: "UNKNOWN",
          failure: String(error).slice(0, 1500),
          ...(error instanceof DevflowError ? { failureDetails: error.toJSON() } : {}),
        });
      throw error;
    }
  }
}

const DIAGNOSTIC_OPERATIONS = [
  "inspect-candidate",
  "capture-snapshot",
  "execute-public-check",
  "cleanup-container",
  "cleanup-snapshot",
] as const;
const DIAGNOSTIC_OUTPUT_BYTES = [128 * 1024, 2 * 1024, 32 * 1024, 2 * 1024, 2 * 1024] as const;

/** Quote the existing Coding view, its bounded observation growth, and the sequential
 * continuation. This never mutates Session history or invokes the model. The actual
 * next request still runs the same optimizer and final Provider capacity check. */
export async function diagnosticContinuationPlan(input: {
  id: string;
  request: ModelRequest;
  contextTokens: number;
  outputTokens: number;
  continuation: ResourceBudgetOperationPlan;
  logicalToolCapacity: number;
  price?: ModelResourcePrice;
  prepare?: (request: ModelRequest) => Promise<ModelRequest>;
}) {
  const observationBytes = 32 * 1024;
  const growthTokens = Math.ceil(observationBytes / 3);
  // Called inside a tool dispatch: the current Assistant decision is intentionally
  // still pending. Forecast its missing receipts only for quotation. These markers
  // are never stored as observations or sent through model.generate.
  const messages = structuredClone(input.request.messages) as ModelMessage[];
  const observed = new Set(messages.filter((m) => m.role === "TOOL").map((m) => m.toolCallId));
  for (const message of [...messages]) {
    if (message.role !== "ASSISTANT") continue;
    for (const call of message.toolCalls ?? [])
      if (!observed.has(call.id)) {
        messages.push({
          role: "TOOL",
          toolCallId: call.id,
          toolName: call.name,
          isError: false,
          content: {
            status: "NOT_EXECUTED",
            authority: "BUDGET_ONLY",
            observation:
              "No execution result is asserted. The real result replaces this forecast only in the next actual projection.",
          },
        });
        observed.add(call.id);
      }
  }
  const projection = await optimizeContextProjection({
    request: { ...input.request, messages },
    history: messages,
    maxBytes: Math.min(96000, input.contextTokens * 3) - observationBytes,
    maxInputTokens: input.contextTokens - input.outputTokens - growthTokens,
    ...(input.prepare ? { prepare: input.prepare } : {}),
  });
  const next = priceModelOperationPlan(
    {
      kind: "OPERATION",
      id: `${input.id}:next-coding`,
      requirement: "REQUIRED",
      state: "PENDING",
      resources: {
        inputTokens: projection.artifact.estimatedInputTokens + growthTokens,
        outputTokens: input.outputTokens,
        modelCalls: 1,
        steps: 1,
        timeMs: 60_000,
      },
      reason:
        "Current Coding projection plus up to 32 KiB of new diagnostic view; actual response projection is checked again before dispatch",
    },
    () => input.price,
  );
  const alreadyQuotedTools = estimateOperationPlan(input.continuation).resources.logicalToolCalls;
  const plan: ResourceBudgetOperationPlan = {
    kind: "SEQUENCE",
    id: input.id,
    operations: [
      next,
      input.continuation,
      {
        kind: "OPERATION",
        id: `${input.id}:host-continuation`,
        requirement: "REQUIRED",
        state: "PENDING",
        resources: {
          logicalToolCalls: Math.max(0, input.logicalToolCapacity - alreadyQuotedTools),
        },
        reason: "Actual candidate, identity, approval recovery and validation operation inventory",
      },
    ],
  };
  return {
    plan,
    audit: {
      inputFingerprint: projection.artifact.inputFingerprint,
      inputBytes: projection.artifact.wireBytes,
      inputTokens: projection.artifact.estimatedInputTokens,
      diagnosticViewGrowthBytes: observationBytes,
      outputTokens: input.outputTokens,
      operationPlan: plan,
    },
  };
}

/** One admitted lifetime includes cleanup even when cancellation exhausts wall time. */
export function diagnosticOperationPlan(id: string): ResourceBudgetOperationPlan {
  return {
    kind: "SEQUENCE",
    id,
    operations: DIAGNOSTIC_OPERATIONS.map((label, index) => ({
      kind: "OPERATION",
      id: `${id}:${label}`,
      requirement: "REQUIRED",
      state: "PENDING",
      resources: {
        toolExecutions: 1,
        ioBytes: DIAGNOSTIC_OUTPUT_BYTES[index]!,
        timeMs: index === 0 ? 30000 : index >= 3 ? 5000 : 0,
      },
      reason:
        index < 3
          ? "Capture and diagnostic share a 30-second absolute deadline"
          : "Independently bounded cancellation cleanup",
    })),
  };
}

/** Execute only labels already admitted for this operation. No cleanup re-admission. */
export async function executeDiagnosticBudget<T>(input: {
  scheduler: ResourceBudgetScheduler;
  operationId: string;
  record: (event: Record<string, unknown>) => Promise<void>;
  run: (execute: (label: string, work: () => Promise<unknown>) => Promise<unknown>) => Promise<T>;
}): Promise<T> {
  const saved = (await input.scheduler.snapshot()).reservations[input.operationId];
  if (saved?.status !== "ADMITTED")
    throw new DevflowError({ code: "CONFLICT", message: "Diagnostic lifetime was not admitted." });
  const started = Date.now(),
    labels = new Set<string>(),
    pending = new Set<string>();
  let executions = 0,
    ioBytes = 0,
    unknown = false,
    closed = false;
  try {
    return await input.run(async (label, work) => {
      if (!(DIAGNOSTIC_OPERATIONS as readonly string[]).includes(label) || labels.has(label))
        throw new DevflowError({
          code: "CONFLICT",
          message: "Diagnostic operation is outside the admitted inventory or repeated.",
        });
      labels.add(label);
      pending.add(label);
      const at = Date.now();
      await input.record({
        operationId: input.operationId,
        label,
        status: "INFLIGHT",
        containerFilesystemIO: "UNOBSERVED",
      });
      if (closed) {
        pending.delete(label);
        throw new DevflowError({
          code: "CONFLICT",
          message: "Diagnostic lifetime ended before its IO dispatch; late execution forbidden.",
        });
      }
      executions++;
      try {
        const value = await work();
        const result = value as { stdout?: unknown; stderr?: unknown } | undefined;
        const outputBytes = [result?.stdout, result?.stderr].reduce<number>(
          (n, text) => n + (typeof text === "string" ? Buffer.byteLength(text) : 0),
          0,
        );
        ioBytes += outputBytes;
        await input.record({
          operationId: input.operationId,
          label,
          status: "COMPLETED",
          elapsedMs: Date.now() - at,
          ioBytes: outputBytes,
          containerFilesystemIO: "UNOBSERVED",
        });
        return value;
      } catch (error) {
        unknown = true;
        await input.record({
          operationId: input.operationId,
          label,
          status: "UNKNOWN",
          elapsedMs: Date.now() - at,
          ioBytes: null,
          containerFilesystemIO: "UNOBSERVED",
        });
        throw error;
      } finally {
        pending.delete(label);
      }
    });
  } finally {
    closed = true;
    const actual = { toolExecutions: executions, timeMs: Math.max(0, Date.now() - started) };
    if (unknown || pending.size)
      await input.scheduler.markUncertain(
        input.operationId,
        actual,
        "Diagnostic subprocess or receipt completion is unknown; do not replay.",
      );
    else await input.scheduler.settle(input.operationId, { ...actual, ioBytes });
  }
}
