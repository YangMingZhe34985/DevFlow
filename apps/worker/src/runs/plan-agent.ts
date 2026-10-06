import { createHash } from "node:crypto";
import type { LanguageModelPort, ModelRequest, ModelResponse } from "@devflow/agent";
import { readFileContent } from "@devflow/sandbox";
import {
  PlanProposalSchema,
  type AgentPlan,
  type ExecutionContract,
  type PlanProposal,
} from "@devflow/shared";
import { PROPOSAL_PROMPT, PROPOSAL_MAX_BYTES, prepareProposalHandoff } from "./plan-proposal.js";
import { z } from "zod";
import type { EvidencePack, IndexEntry, IndexSource } from "../localization/contracts.js";
import { navigateImplementation } from "../localization/implementation-navigation.js";
import type { StructuredOutputAttempt } from "./workflow-structured-output.js";
import {
  boundPlanSnippet,
  estimatePlanRequest,
  planContextText,
  planEvidenceRows,
  planHash,
  planHostState,
  planSourcePath,
  serializePlanRequest,
  type PlanContextInput,
  type PlanEvidenceRef,
  type PlanEvidenceRow,
  type PlanHostState,
  type PlanRequestEstimate,
} from "./plan-agent-context.js";
export {
  estimatePlanRequest,
  serializePlanRequest,
  planEditProtected,
  planSourcePath,
} from "./plan-agent-context.js";
export type {
  PlanPathPolicy,
  PlanEvidenceRef,
  PlanHostState,
  PlanRequestEstimate,
} from "./plan-agent-context.js";
export type AgentModel = LanguageModelPort;
export type PlanAgentPlan = AgentPlan & {
  executionContract: ExecutionContract;
};
export const PlanEvidenceSelectionSchema = z.strictObject({
  summary: z.string().min(1).max(1000),
  inspect: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1024),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        reason: z.string().min(1).max(500),
      }),
    )
    .max(3),
  uncertainty: z.array(z.string().min(1).max(500)).max(8),
});
export type PlanReadRequest = z.infer<typeof PlanEvidenceSelectionSchema>["inspect"][number];
export type PlanUnresolvedOutcome = "UNKNOWN" | "ESCALATE" | "REPLAN";
export interface PlanAgentLimits {
  maxTotalTokens: number;
  maxModelCalls: number;
  timeoutMs: number;
  maxSourceBytes: number;
  maxSnippetBytes: number;
  maxFileBytes: number;
  maxReadLines: number;
  finalOutputTokens: number;
  formatRepairOutputTokens: number;
  inspectionOutputTokens: number;
}
export const PLAN_AGENT_DEFAULTS: Readonly<PlanAgentLimits> = {
  maxTotalTokens: 12000,
  maxModelCalls: 6,
  timeoutMs: 120000,
  maxSourceBytes: 2 * 1024 * 1024,
  maxSnippetBytes: 12 * 1024,
  maxFileBytes: 512 * 1024,
  maxReadLines: 300,
  finalOutputTokens: 1536,
  formatRepairOutputTokens: 1024,
  inspectionOutputTokens: 768,
};
export interface PlanAgentMetrics {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  modelLatencyMs: number;
  reads: number;
  sourceBytes: number;
  requestedReads?: number;
  requestedSearches?: number;
  readsByPurpose?: Partial<Record<PlanReadObservation["purpose"], number>>;
  archivedSnippetBytes?: number;
  verifiedSourceBytes: number;
  snippetBytes: number;
  supplementarySnippetBytes: number;
  elapsedMs: number;
  searches?: number;
}
export interface PlanDiagnostic {
  code: string;
  phase:
    | "PREPARE"
    | "INSPECT"
    | "ITERATE"
    | "SEARCH"
    | "READ"
    | "FINAL"
    | "FORMAT_REPAIR"
    | "VALIDATE"
    | "CONTRACT_CORRECTION"
    | "OUTPUT_REGENERATION";
  message: string;
  details?: Record<string, string | number | boolean | null>;
}
export interface PlanPreflight {
  estimate: PlanRequestEstimate;
  consumedTokens: number;
  remainingTokens: number;
  outputTokens: number;
  repairReserveTokens: number;
  requiredTokens: number;
  maxTotalTokens: number;
  remainingModelCalls: number;
  permitted: boolean;
}
export interface PlanAttempt {
  version: "plan-agent-attempt-v1";
  status: "READY" | "SUCCEEDED" | "BLOCKED" | PlanUnresolvedOutcome;
  phase: PlanDiagnostic["phase"];
  hostState: PlanHostState;
  limits: PlanAgentLimits;
  metrics: PlanAgentMetrics;
  diagnostics: PlanDiagnostic[];
  evidenceRefs: PlanEvidenceRef[];
  preflight: PlanPreflight | null;
  serializedFinalRequest: string | null;
  requests: {
    purpose: string;
    formatRepair: boolean;
    preflight: PlanPreflight;
    finishReason?: ModelResponse["finishReason"];
    actualTokens?: number;
  }[];
  outputRegeneration?: {
    trigger: "LENGTH" | "COMPACT_SCHEMA";
    attempted: boolean;
    outcome?: "SUCCEEDED" | "UNKNOWN" | "REJECTED";
  };
}
export interface PlanReadObservation {
  path: string;
  purpose:
    | "SUPPLEMENTARY"
    | "CONTRACT_VALIDATION"
    | "HYPOTHESIS_VALIDATION"
    | "SEARCH"
    | "TARGET_GROUNDING";
  sourceBytes: number;
  snippetBytes: number;
  verified: boolean;
  contentHash: string;
  workspaceRevision: number;
}
export interface PlanAgentHooks {
  onRequest?(input: {
    purpose: string;
    formatRepair: boolean;
    request: ModelRequest;
    preflight: PlanPreflight;
  }): Promise<void>;
  onResponse?(attempt: StructuredOutputAttempt): Promise<void>;
  onGenerationError?(input: {
    purpose: string;
    formatRepair: boolean;
    latencyMs: number;
    error: unknown;
  }): Promise<void>;
  /** Must run before source IO, so the workflow can deny an exhausted tool budget. */
  onBeforeRead?(input: Pick<PlanReadObservation, "path" | "purpose">): Promise<void>;
  onRead?(input: PlanReadObservation): Promise<void>;
  onBeforeSearch?(input: { query: string }): Promise<void>;
  onSearch?(input: {
    query: string;
    queryHash: string;
    evidenceCount: number;
    status: "SUCCEEDED" | "FAILED";
  }): Promise<void>;
  onAttempt?(attempt: PlanAttempt): Promise<void>;
}
export interface PlanAgentPreparationInput extends PlanContextInput, PlanAgentHooks {
  source: IndexSource;
  signal: AbortSignal;
  limits?: Partial<PlanAgentLimits>;
  supplementaryReads?: readonly PlanReadRequest[];
  /** One host-controlled investigation preparation; never a mutation capability. */
  discoveryCandidates?: PlanProposal["candidateFiles"];
  allowUnknownDiscovery?: boolean;
}
export interface PlanAgentInput extends PlanAgentPreparationInput {
  model: AgentModel;
  /** Must use the supplied guarded source; no commands, provider construction or writes. */
  retrieve?(
    query: string,
    source: IndexSource,
    signal: AbortSignal,
  ): Promise<EvidencePack | undefined>;
}
export interface PreparedPlanAttempt {
  status: "READY" | "BLOCKED";
  attempt: PlanAttempt;
  preparedFinalRequest?: ModelRequest;
}
export interface PlanAttemptResult {
  status: "SUCCEEDED" | "BLOCKED" | PlanUnresolvedOutcome;
  attempt: PlanAttempt;
  plan?: PlanAgentPlan;
  preparedFinalRequest?: ModelRequest;
}
const REPAIR_SYSTEM =
  "You are a lossless JSON format converter. Preserve the supplied decision and meaning exactly. Do not review, infer, add, remove, or improve content. Return only the schema-conforming object requested by the response format.";
class Blocked extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: PlanDiagnostic["details"],
  ) {
    super(message);
  }
}
/** No filesystem or provider construction: source and model capabilities are supplied by the caller. */
export class PlanAgent {
  async prepare(input: PlanAgentPreparationInput): Promise<PreparedPlanAttempt> {
    const session = new PlanSession(input);
    try {
      await session.prepare();
      session.attempt.status = "READY";
    } catch (error) {
      session.block(error);
    }
    await session.finish();
    return {
      status: session.attempt.status === "BLOCKED" ? "BLOCKED" : "READY",
      attempt: session.attempt,
      ...(session.finalRequest ? { preparedFinalRequest: session.finalRequest } : {}),
    };
  }
  async run(input: PlanAgentInput): Promise<PlanAttemptResult> {
    const session = new PlanSession(input);
    let plan: PlanAgentPlan | undefined;
    try {
      await session.prepare();
      const finalize = true;
      if (finalize) {
        plan = await session.generateProposal(input.model);
        if (plan && session.attempt.status !== "UNKNOWN") session.attempt.status = "SUCCEEDED";
      }
    } catch (error) {
      session.block(error);
    }
    await session.finish();
    return {
      status: session.attempt.status === "READY" ? "BLOCKED" : session.attempt.status,
      attempt: session.attempt,
      ...(plan === undefined ? {} : { plan }),
      ...(session.finalRequest ? { preparedFinalRequest: session.finalRequest } : {}),
    };
  }
}
class PlanSession {
  readonly limits: PlanAgentLimits;
  readonly signal: AbortSignal;
  readonly startedAt = Date.now();
  readonly attempt: PlanAttempt;
  readonly observations: string[] = [];
  rows: PlanEvidenceRow[] = [];
  finalRequest: ModelRequest | undefined;
  private manifest: Map<string, IndexEntry> | undefined;
  private manifestIncomplete = false;
  private readonly seenReads = new Set<string>();
  private readonly hooks: PlanAgentHooks;

  private readonly verifiedFiles = new Map<
    string,
    {
      content: string;
      contentHash: string;
    }
  >();
  constructor(readonly input: PlanAgentPreparationInput) {
    this.hooks = input;
    this.limits = { ...PLAN_AGENT_DEFAULTS, ...input.limits };
    // Invalid limits are reported in prepare(), including a zero remaining workflow budget.
    this.signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(
        Number.isSafeInteger(this.limits.timeoutMs) && this.limits.timeoutMs > 0
          ? Math.min(this.limits.timeoutMs, 4294967295)
          : 1,
      ),
    ]);
    this.attempt = {
      version: "plan-agent-attempt-v1",
      status: "READY",
      phase: "PREPARE",
      hostState: planHostState(input, input.source.identity),
      limits: this.limits,
      metrics: {
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        modelLatencyMs: 0,
        reads: 0,
        sourceBytes: 0,
        verifiedSourceBytes: 0,
        snippetBytes: 0,
        supplementarySnippetBytes: 0,
        elapsedMs: 0,
      },
      diagnostics: [],
      evidenceRefs: [],
      preflight: null,
      serializedFinalRequest: null,
      requests: [],
    };
  }
  check(): void {
    if (this.input.signal.aborted) throw new Blocked("PLAN_CANCELLED", "Planning was cancelled.");
    if (this.signal.aborted || Date.now() - this.startedAt >= this.limits.timeoutMs)
      throw new Blocked("PLAN_TIME_BUDGET_EXHAUSTED", "The shared planning deadline was reached.");
  }
  diagnostic(code: string, message: string, details?: PlanDiagnostic["details"]): void {
    this.attempt.diagnostics.push({
      code,
      phase: this.attempt.phase,
      message,
      ...(details === undefined ? {} : { details }),
    });
  }
  block(error: unknown): void {
    this.attempt.status = "BLOCKED";
    const value = error as {
      code?: unknown;
      message?: unknown;
    };
    this.diagnostic(
      this.input.signal.aborted
        ? "PLAN_CANCELLED"
        : this.signal.aborted
          ? "PLAN_TIME_BUDGET_EXHAUSTED"
          : typeof value?.code === "string"
            ? value.code
            : "PLAN_PREPARATION_FAILED",
      error instanceof Error ? error.message : String(error),
      error instanceof Blocked ? error.details : undefined,
    );
  }
  async finish(): Promise<void> {
    this.syncEvidence();
    this.attempt.metrics.elapsedMs = Math.max(0, Date.now() - this.startedAt);
    await this.hooks.onAttempt?.(this.attempt);
  }
  syncEvidence(): void {
    this.attempt.evidenceRefs = this.rows.map(
      ({ snippet: _snippet, symbol: _symbol, fileType: _type, reason: _reason, ...ref }) => ref,
    );
    this.attempt.metrics.archivedSnippetBytes = this.rows.reduce(
      (sum, row) => sum + Buffer.byteLength(row.snippet),
      0,
    );
    this.attempt.metrics.snippetBytes = this.contextRows().reduce(
      (sum, row) => sum + Buffer.byteLength(row.snippet),
      0,
    );
  }
  private contextRows(): PlanEvidenceRow[] {
    return this.rows;
  }
  async prepare(): Promise<void> {
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Blocked("PLAN_INVALID_BUDGET", "Planning limits must be positive integers.", {
          key,
          value,
        });
    }
    this.check();
    if (!Number.isSafeInteger(this.input.workspaceRevision) || this.input.workspaceRevision < 0)
      throw new Blocked("PLAN_SOURCE_IDENTITY", "A nonnegative workspace revision is required.");
    const projected = planEvidenceRows(
      this.input,
      this.input.discoveryCandidates?.length
        ? Math.min(4096, Math.floor(this.limits.maxSnippetBytes / 3))
        : this.limits.maxSnippetBytes,
    );
    this.rows = projected.rows;
    if (projected.omitted || projected.rejected.length)
      this.diagnostic(
        "PLAN_EVIDENCE_FILTERED",
        "Some candidate evidence was omitted or rejected.",
        { omitted: projected.omitted, rejected: projected.rejected.length },
      );
    if (this.input.evidence?.evidence.length && !this.rows.length)
      throw new Blocked(
        "PLAN_SOURCE_IDENTITY",
        "No supplied evidence has a usable public source identity.",
      );
    for (const request of this.input.supplementaryReads ?? []) {
      try {
        await this.readRange(request);
      } catch (error) {
        this.readFeedback(error, request.path);
      }
    }
    await this.discoverCandidates();
    this.buildFinal();
  }
  private readFeedback(error: unknown, path: string): void {
    // Recover only local candidate errors. Cancellation, byte exhaustion and
    // stale source identity must still stop the complete attempt.
    if (
      !(error instanceof Blocked) ||
      ![
        "PLAN_SOURCE_UNAVAILABLE",
        "PLAN_SOURCE_LOOKUP_INCOMPLETE",
        "PLAN_READ_RANGE_INVALID",
      ].includes(error.code)
    )
      throw error;
    this.diagnostic(error.code, error.message, { path });
    this.observations.push(
      `${error.code}: ${path}: ${error.message}; no evidence or write authority obtained.`,
    );
  }
  private async discoverCandidates(): Promise<void> {
    const candidates = this.input.discoveryCandidates ?? [];
    if (!candidates.length) return;
    for (const candidate of candidates) this.path(candidate.path);
    const available = this.limits.maxSnippetBytes - this.attempt.metrics.supplementarySnippetBytes;
    if (available < 512) {
      this.diagnostic(
        "PLAN_DISCOVERY_SNIPPET_RESERVE",
        "Optional investigation stopped before IO; finalize from current verified evidence.",
        { remainingBytes: available, requiredBytes: 512, readIssued: false },
      );
      return;
    }
    const navigation = await navigateImplementation({
      repositoryId: this.input.repositoryId,
      baseCommitSha: this.input.baseCommitSha,
      source: {
        ...this.input.source,
        read: async (path) => {
          const file = this.verifiedFiles.get(path) ?? (await this.readFile(path, "SUPPLEMENTARY"));
          return { content: file.content, truncated: false };
        },
      },
      description: this.input.title + "\n" + this.input.description,
      candidates,
      signal: this.signal,
      maxReads: 8,
      maxSourceBytes: Math.max(0, this.limits.maxSourceBytes - this.attempt.metrics.sourceBytes),
      maxSnippetBytes: available,
      maxLines: Math.min(96, this.limits.maxReadLines),
    });
    for (const window of navigation.windows) {
      const file = this.verifiedFiles.get(window.path);
      if (file)
        this.addReadRange(
          {
            path: window.path,
            startLine: window.startLine,
            endLine: window.endLine,
            reason: `${window.kind}: ${window.reason}`.slice(0, 500),
          },
          file,
          4096,
        );
    }
    this.observations.push(
      ...navigation.observations.slice(0, 8),
      ...navigation.missing.slice(0, 8),
    );
    for (const candidate of candidates) {
      if (!(await this.lookup(candidate.path)))
        this.diagnostic(
          "PLAN_SOURCE_UNAVAILABLE",
          "Discovery candidate was not found; observed alternatives grant no write authority.",
          { path: candidate.path },
        );
    }
    this.diagnostic(
      "PLAN_IMPLEMENTATION_NAVIGATION",
      "Shared read-only symbol navigation completed; observed source is not root-cause proof or edit authorization.",
      { ...navigation.metrics },
    );
  }
  private outputRequest(messages: ModelRequest["messages"], repair = false): ModelRequest {
    return {
      messages,
      tools: [],
      output: {
        name: "plan_proposal",
        description: "A concise, safe and testable software implementation plan.",
        schema: PlanProposalSchema,
      },
      settings: {
        ...(repair ? { reasoningEffort: "none" as const } : {}),
        // A complete plan cannot be losslessly rewritten into a smaller output
        // envelope. Missing operation fields use a separate compact whitelist.
        maxOutputTokens: repair
          ? Math.max(this.limits.finalOutputTokens, this.limits.formatRepairOutputTokens)
          : this.limits.finalOutputTokens,
      },
    };
  }
  private repairRequest(rawOutput: string, validationErrors: unknown): ModelRequest {
    return this.outputRequest(
      [
        { role: "SYSTEM", content: REPAIR_SYSTEM },
        { role: "USER", content: JSON.stringify({ rawOutput, validationErrors }) },
      ],
      true,
    );
  }
  repairReserve(): number {
    {
      if (!this.recoveryCalls()) return 0;
      return (
        estimatePlanRequest(
          this.repairRequest("x".repeat(this.limits.finalOutputTokens * 6), "invalid output shape"),
        ).estimatedInputTokens +
        Math.max(this.limits.finalOutputTokens, this.limits.formatRepairOutputTokens)
      );
    }
  }
  private recoveryCalls(): number {
    return this.limits.maxModelCalls > 1 ? 1 : 0;
  }
  preflight(request: ModelRequest, reserveTokens: number, reserveCalls: number): PlanPreflight {
    const estimate = estimatePlanRequest(request),
      consumedTokens = this.attempt.metrics.totalTokens;
    const outputTokens = request.settings?.maxOutputTokens ?? this.limits.finalOutputTokens;
    const requiredTokens = estimate.estimatedInputTokens + outputTokens + reserveTokens;
    const remainingModelCalls = this.limits.maxModelCalls - this.attempt.metrics.modelCalls;
    return {
      estimate,
      consumedTokens,
      remainingTokens: this.limits.maxTotalTokens - consumedTokens,
      outputTokens,
      repairReserveTokens: reserveTokens,
      requiredTokens,
      maxTotalTokens: this.limits.maxTotalTokens,
      remainingModelCalls,
      permitted:
        consumedTokens + requiredTokens <= this.limits.maxTotalTokens &&
        remainingModelCalls >= 1 + reserveCalls,
    };
  }
  buildFinal(): void {
    this.check();
    const create = () =>
      this.outputRequest([
        {
          role: "SYSTEM",
          content: PROPOSAL_PROMPT,
        },
        {
          role: "USER",
          content: this.contextText(),
        },
      ]);
    let request = create(),
      preflight = this.preflight(request, this.repairReserve(), this.recoveryCalls());
    while (
      !preflight.permitted &&
      this.contextRows().some((row) => Buffer.byteLength(row.snippet) > 256)
    ) {
      const largest = this.rows.reduce((a, b) =>
        Buffer.byteLength(a.snippet) >= Buffer.byteLength(b.snippet) ? a : b,
      );
      largest.snippet = boundPlanSnippet(
        largest.snippet,
        Math.max(256, Math.floor(Buffer.byteLength(largest.snippet) / 2)),
      );
      largest.snippetHash = planHash(largest.snippet);
      largest.endLine = largest.startLine + largest.snippet.split("\n").length - 1;
      largest.truncated = true;
      request = create();
      preflight = this.preflight(request, this.repairReserve(), this.recoveryCalls());
    }
    // Metadata and Issue/constraints are not silently truncated to manufacture reachability.
    this.finalRequest = request;
    this.attempt.serializedFinalRequest = serializePlanRequest(request);
    this.attempt.preflight = preflight;
    this.syncEvidence();
    if (!preflight.permitted)
      throw new Blocked(
        preflight.remainingModelCalls < 1 + this.recoveryCalls()
          ? "PLAN_MODEL_CALL_BUDGET_EXHAUSTED"
          : "PLAN_FINAL_PREFLIGHT_BLOCKED",
        "The complete final request and bounded schema/contract recovery do not fit the remaining planning budget.",
        {
          inputTokens: preflight.estimate.estimatedInputTokens,
          outputTokens: preflight.outputTokens,
          repairReserveTokens: preflight.repairReserveTokens,
          remainingTokens: preflight.remainingTokens,
          requiredTokens: preflight.requiredTokens,
          missingTokens: Math.max(0, preflight.requiredTokens - preflight.remainingTokens),
          requestIssued: false,
        },
      );
  }
  private contextText(): string {
    const view = this.contextRows();
    const text = JSON.stringify({
      ...JSON.parse(planContextText(this.attempt.hostState, view, this.input, this.observations)),
      ...{},
    });
    return text;
  }
  async generateProposal(model: AgentModel): Promise<PlanAgentPlan | undefined> {
    this.attempt.phase = "FINAL";
    this.buildFinal();
    let response = await this.generate(
      model,
      this.finalRequest!,
      "PLAN",
      false,
      this.repairReserve(),
      this.recoveryCalls(),
    );
    if (response.toolCalls.length)
      throw new Blocked("PLAN_UNEXPECTED_TOOL_CALL", "Planner cannot request tool actions.");
    if (response.finishReason === "LENGTH") {
      this.diagnostic(
        "PLAN_OUTPUT_TRUNCATED",
        "Generate one complete proposal from the original evidence; partial output is not a plan.",
      );
      this.attempt.outputRegeneration = {
        trigger: "LENGTH",
        attempted: false,
        outcome: "REJECTED",
      };
      this.attempt.phase = "OUTPUT_REGENERATION";
      const request: ModelRequest = {
        ...this.finalRequest!,
        messages: [
          {
            role: "SYSTEM",
            content:
              "Generate a complete concise proposal anew. The previous output was truncated and is intentionally absent. Do not continue or losslessly repair it. Preserve source policy and uncertainty; return UNKNOWN when evidence is insufficient. " +
              PROPOSAL_PROMPT,
          },
          ...this.finalRequest!.messages.slice(1),
        ],
        output: { ...this.finalRequest!.output!, name: "plan_proposal_length_regeneration" },
        settings: { ...this.finalRequest!.settings, reasoningEffort: "none" },
      };
      try {
        response = await this.generate(model, request, "PLAN_LENGTH_REGENERATION", false, 0, 0);
      } finally {
        this.attempt.outputRegeneration.attempted = this.attempt.requests.some(
          (r) => r.purpose === "PLAN_LENGTH_REGENERATION",
        );
      }
    }
    const assertComplete = () => {
      if (response.toolCalls.length)
        throw new Blocked("PLAN_UNEXPECTED_TOOL_CALL", "Planner cannot request tool actions.");
      if (response.finishReason !== "STOP")
        throw new Blocked(
          this.attempt.outputRegeneration
            ? "PLAN_LENGTH_REGENERATION_INCOMPLETE"
            : "PLAN_MODEL_OUTPUT_INCOMPLETE",
          "Proposal did not complete; partial decisions are not accepted.",
          { finishReason: response.finishReason },
        );
    };
    assertComplete();
    let parsed = parseResponse(response, PlanProposalSchema);
    if (!parsed.success) {
      if (this.attempt.outputRegeneration)
        throw new Blocked(
          "PLAN_LENGTH_REGENERATION_INVALID",
          "The single regeneration did not yield a complete valid proposal; no further format repair is allowed.",
        );
      const raw =
        response.text ??
        (response.output === undefined
          ? response.structuredOutput?.status === "ERROR"
            ? (response.structuredOutput.rawText ?? "")
            : ""
          : JSON.stringify(response.output));
      if (!raw) throw new Blocked("PLAN_MODEL_OUTPUT_EMPTY", "No proposal was returned.");
      if (Buffer.byteLength(raw) > PROPOSAL_MAX_BYTES)
        throw new Blocked("PLAN_OUTPUT_TOO_LARGE", "Proposal exceeds the transport cap.", {
          actualBytes: Buffer.byteLength(raw),
          maxBytes: PROPOSAL_MAX_BYTES,
        });
      this.attempt.phase = "FORMAT_REPAIR";
      this.diagnostic(
        "PLAN_PROPOSAL_FORMAT_REPAIR",
        "Attempting the single bounded format repair; no semantic correction loop.",
      );
      response = await this.generate(
        model,
        this.repairRequest(raw, parsed.error.issues),
        "PLAN_FORMAT_REPAIR",
        true,
        0,
        0,
      );
      assertComplete();
      parsed = parseResponse(response, PlanProposalSchema);
    }
    if (!parsed.success)
      throw new Blocked(
        "PLAN_INVALID_OUTPUT",
        "The single format repair did not yield a proposal.",
      );
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > PROPOSAL_MAX_BYTES)
      throw new Blocked("PLAN_OUTPUT_TOO_LARGE", "Proposal exceeds the transport cap.");
    if (parsed.data.decision === "UNKNOWN") {
      if (this.attempt.outputRegeneration) this.attempt.outputRegeneration.outcome = "UNKNOWN";
      this.attempt.status = "UNKNOWN";
      this.diagnostic("PLAN_UNKNOWN", `${parsed.data.goal}: ${parsed.data.approach.join("; ")}`);
      if (!this.input.allowUnknownDiscovery) return undefined;
      const candidates = parsed.data.candidateFiles.length
        ? parsed.data.candidateFiles
        : this.rows
            .filter((r) => r.fileType === "SOURCE")
            .slice(0, 3)
            .map((r) => ({
              path: r.path,
              intent: "INSPECT" as const,
              reason: "Public source evidence still needs implementation investigation.",
              ...(r.symbol ? { symbol: r.symbol } : {}),
            }));
      if (!candidates.length) return undefined;
      const discovery = await prepareProposalHandoff({
        proposal: { ...parsed.data, candidateFiles: candidates },
        source: this.input.source,
        policy: this.input.policy ?? {},
        baseCommitSha: this.input.baseCommitSha,
        workspaceRevision: this.input.workspaceRevision,
        evidenceRefs: this.attempt.evidenceRefs,
        signal: this.signal,
      });
      this.diagnostic(
        "PLAN_UNKNOWN_DISCOVERY",
        "UNKNOWN retained; only a bounded read-only investigation can be approved.",
      );
      return discovery.plan as PlanAgentPlan | undefined;
    }
    this.attempt.phase = "VALIDATE";
    const handoff = await prepareProposalHandoff({
      proposal: parsed.data,
      source: this.input.source,
      policy: this.input.policy ?? {},
      baseCommitSha: this.input.baseCommitSha,
      workspaceRevision: this.input.workspaceRevision,
      evidenceRefs: this.attempt.evidenceRefs,
      signal: this.signal,
    });
    if (handoff.conflict) throw new Blocked("SCOPE_CONFLICT", handoff.conflict);
    for (const warning of handoff.plan?.warnings ?? [])
      this.diagnostic("PLAN_PROPOSAL_WARNING", warning);
    this.diagnostic(
      "PLAN_PROPOSAL_HANDOFF",
      `Proposal prepared for ${handoff.plan?.approvalScope?.mode}; writing still requires persisted approval.`,
    );
    if (this.attempt.outputRegeneration) this.attempt.outputRegeneration.outcome = "SUCCEEDED";
    return handoff.plan as PlanAgentPlan;
  }
  private async generate(
    model: AgentModel,
    request: ModelRequest,
    purpose: string,
    formatRepair: boolean,
    reserveTokens: number,
    reserveCalls: number,
  ): Promise<ModelResponse> {
    this.check();
    const preflight = this.preflight(request, reserveTokens, reserveCalls);
    if (!preflight.permitted)
      throw new Blocked(
        "PLAN_REQUEST_PREFLIGHT_BLOCKED",
        "Request exceeds the shared planning reserve.",
        {
          requiredTokens: preflight.requiredTokens,
          remainingTokens: preflight.remainingTokens,
          missingTokens: Math.max(0, preflight.requiredTokens - preflight.remainingTokens),
          missingModelCalls: Math.max(0, 1 + reserveCalls - preflight.remainingModelCalls),
          requestIssued: false,
        },
      );
    await this.hooks.onRequest?.({ purpose, formatRepair, request, preflight });
    this.check();
    const row: PlanAttempt["requests"][number] = { purpose, formatRepair, preflight };
    this.attempt.requests.push(row);
    this.attempt.metrics.modelCalls++;
    const started = Date.now();
    let response: ModelResponse;
    try {
      response = await withSignal(model.generate(request, { signal: this.signal }), this.signal);
    } catch (error) {
      this.attempt.metrics.modelLatencyMs += Date.now() - started;
      await this.hooks.onGenerationError?.({
        purpose,
        formatRepair,
        latencyMs: Date.now() - started,
        error,
      });
      throw error;
    }
    const metrics = this.attempt.metrics;
    metrics.inputTokens += response.usage.inputTokens;
    metrics.outputTokens += response.usage.outputTokens;
    metrics.totalTokens += response.usage.totalTokens;
    metrics.reasoningTokens += response.reasoningTokens ?? response.usage.reasoningTokens ?? 0;
    metrics.modelLatencyMs += response.latencyMs;
    row.finishReason = response.finishReason;
    row.actualTokens = response.usage.totalTokens;
    const failure = structuredFailure(response, request);
    await this.hooks.onResponse?.({
      purpose,
      formatRepair,
      response,
      ...(failure === undefined ? {} : { failure }),
    });
    if (metrics.totalTokens > this.limits.maxTotalTokens)
      throw new Blocked(
        "PLAN_TOKEN_BUDGET_EXCEEDED",
        "Provider usage exceeded the shared planning token budget.",
      );
    this.check();
    return response;
  }
  private path(value: string): string {
    try {
      return planSourcePath(value);
    } catch {
      throw new Blocked(
        "PLAN_FORBIDDEN_SOURCE",
        "The requested path violates public source policy.",
      );
    }
  }
  private async lookup(path: string, signal = this.signal): Promise<IndexEntry | undefined> {
    this.check();
    const normalized = this.path(path);
    if (this.input.source.lookup)
      return await withSignal(this.input.source.lookup(normalized, signal), signal);
    if (!this.manifest) {
      const manifest = await withSignal(this.input.source.manifest(signal), signal);
      this.manifest = new Map(manifest.entries.map((entry) => [entry.path, entry]));
      this.manifestIncomplete = manifest.incomplete;
      if (manifest.incomplete)
        this.diagnostic(
          "PLAN_MANIFEST_INCOMPLETE",
          "Source lookup uses an incomplete manifest; absent paths remain unknown.",
        );
    }
    const entry = this.manifest.get(normalized);
    if (!entry && this.manifestIncomplete)
      throw new Blocked(
        "PLAN_SOURCE_LOOKUP_INCOMPLETE",
        "An incomplete manifest cannot establish that a path does not exist.",
      );
    return entry;
  }
  private async readFile(
    path: string,
    purpose: PlanReadObservation["purpose"],
  ): Promise<{
    content: string;
    contentHash: string;
  }> {
    this.check();
    path = this.path(path);
    const entry = await this.lookup(path);
    if (!entry || entry.kind !== "FILE")
      throw new Blocked(
        "PLAN_SOURCE_UNAVAILABLE",
        "Requested evidence is not a regular source file.",
        { path },
      );
    if (
      entry.sizeBytes > this.limits.maxFileBytes ||
      this.attempt.metrics.sourceBytes + entry.sizeBytes > this.limits.maxSourceBytes
    )
      throw new Blocked(
        "PLAN_SOURCE_BYTE_BUDGET_EXHAUSTED",
        "Full source verification would exceed its byte budget.",
        { path, sizeBytes: entry.sizeBytes },
      );
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      if ((await this.lookup(segments.slice(0, index).join("/")))?.kind === "SYMLINK")
        throw new Blocked("PLAN_FORBIDDEN_SOURCE", "A source parent is a symbolic link.");
    }
    const expectedHash =
      entry.contentHash ?? this.rows.find((row) => row.path === path)?.contentHash;
    const expectedBlob = entry.blobId;
    const immutableGitIdentity =
      /^github:[^/@]+\/[^/@]+@[a-f0-9]{40}$/iu.test(this.input.source.identity ?? "") &&
      this.input.source.identity?.endsWith(`@${this.input.baseCommitSha.toLowerCase()}`) === true;
    const canVerifyBlob = immutableGitIdentity && /^[a-f0-9]{40}$/iu.test(expectedBlob ?? "");
    if ((!expectedHash || !/^[a-f0-9]{64}$/iu.test(expectedHash)) && !canVerifyBlob)
      throw new Blocked(
        "PLAN_SOURCE_IDENTITY",
        "Full-source verification requires an expected immutable SHA-256 or a blob bound to the fixed Git commit.",
        { path },
      );
    await this.hooks.onBeforeRead?.({ path, purpose });
    this.check();
    this.attempt.metrics.reads++;
    const readCounts = (this.attempt.metrics.readsByPurpose ??= {});
    readCounts[purpose] = (readCounts[purpose] ?? 0) + 1;
    let file: Awaited<ReturnType<IndexSource["read"]>>;
    try {
      file = await withSignal(this.input.source.read(path, this.signal), this.signal);
    } catch (error) {
      // A failed attempted IO still belongs to the workflow tool ledger. No bytes/hash
      // were observed, so it must not be represented as a successful source verification.
      await this.hooks.onRead?.({
        path,
        purpose,
        sourceBytes: 0,
        snippetBytes: 0,
        verified: false,
        contentHash: "",
        workspaceRevision: this.input.workspaceRevision,
      });
      throw error;
    }
    const bytes = Buffer.byteLength(file.content),
      contentHash = planHash(file.content);
    this.attempt.metrics.sourceBytes += bytes;
    const blobHash = canVerifyBlob
      ? createHash("sha1").update(`blob ${bytes}\0`).update(file.content).digest("hex")
      : undefined;
    const verified =
      !file.truncated &&
      bytes === entry.sizeBytes &&
      (expectedHash ? contentHash === expectedHash : blobHash === expectedBlob);
    if (verified) this.attempt.metrics.verifiedSourceBytes += bytes;
    await this.hooks.onRead?.({
      path,
      purpose,
      sourceBytes: bytes,
      snippetBytes: 0,
      verified,
      contentHash,
      workspaceRevision: this.input.workspaceRevision,
    });
    this.check();
    if (
      bytes > this.limits.maxFileBytes ||
      this.attempt.metrics.sourceBytes > this.limits.maxSourceBytes
    )
      throw new Blocked(
        "PLAN_SOURCE_BYTE_BUDGET_EXHAUSTED",
        "Observed source bytes exceeded the declared source budget.",
      );
    if (!verified)
      throw new Blocked(
        "PLAN_SOURCE_IDENTITY",
        "Full source was truncated or differed from its immutable hash.",
        { path },
      );
    const observed = { content: file.content, contentHash };
    this.verifiedFiles.set(path, observed);
    return observed;
  }
  async readRange(request: PlanReadRequest): Promise<void> {
    this.attempt.phase = "READ";
    const path = this.path(request.path);
    if (
      !Number.isSafeInteger(request.startLine) ||
      !Number.isSafeInteger(request.endLine) ||
      request.startLine < 1 ||
      request.endLine < request.startLine ||
      request.endLine - request.startLine + 1 > this.limits.maxReadLines
    )
      throw new Blocked(
        "PLAN_READ_RANGE_INVALID",
        "A supplementary read must use a valid bounded line range.",
        { path },
      );
    const key = `${path}:${request.startLine}:${request.endLine}`;
    if (this.seenReads.has(key)) return;
    this.seenReads.add(key);
    const file = await this.readFile(path, "SUPPLEMENTARY");
    this.addReadRange({ ...request, path }, file);
  }
  private addReadRange(
    request: PlanReadRequest,
    file: {
      content: string;
      contentHash: string;
    },
    snippetCap = this.limits.maxSnippetBytes,
  ): void {
    const path = request.path;
    const lines = file.content.split(/\r?\n/u);
    if (request.endLine > lines.length) {
      this.diagnostic(
        "PLAN_READ_RANGE_CLAMPED",
        "Requested range exceeds EOF; the verified available range is reported.",
        {
          path,
          requestedStart: request.startLine,
          requestedEnd: request.endLine,
          availableStart: 1,
          availableEnd: lines.length,
        },
      );
      this.observations.push(
        `Read ${path}:${request.startLine}..${request.endLine}: actual file range 1..${lines.length}; ${request.startLine > lines.length ? "no overlap; request a valid range" : `returned ${request.startLine}..${lines.length}`}.`,
      );
      if (request.startLine > lines.length) return;
    }
    const raw = lines.slice(request.startLine - 1, request.endLine).join("\n");
    const available = Math.min(
      snippetCap,
      this.limits.maxSnippetBytes - this.attempt.metrics.supplementarySnippetBytes,
    );
    if (available <= 0)
      throw new Blocked(
        "PLAN_SNIPPET_BYTE_BUDGET_EXHAUSTED",
        "No supplementary snippet bytes remain.",
      );
    const selection = readFileContent(Buffer.from(file.content), {
      path,
      startLine: request.startLine,
      endLine: Math.min(request.endLine, lines.length),
      maxBytes: Math.min(available, 16384),
      expectedSha256: file.contentHash,
    });
    const snippet = selection
      ? selection.content.replace(/\r?\n$/u, "")
      : boundPlanSnippet(raw, available);
    if (!snippet)
      throw new Blocked(
        "PLAN_SNIPPET_BYTE_BUDGET_EXHAUSTED",
        "No supplementary snippet bytes remain.",
      );
    this.attempt.metrics.supplementarySnippetBytes += Buffer.byteLength(snippet);
    const endLine = selection?.endLine ?? request.startLine + snippet.split("\n").length - 1;
    const row: PlanEvidenceRow = {
      id: planHash(`${path}:${file.contentHash}:${request.startLine}:${endLine}`).slice(0, 24),
      repositoryId: this.input.repositoryId,
      baseCommitSha: this.input.baseCommitSha,
      workspaceRevision: this.input.workspaceRevision,
      viewRevision: this.input.evidence?.viewRevision ?? String(this.input.workspaceRevision),
      path,
      contentHash: file.contentHash,
      snippetHash: planHash(snippet),
      startLine: request.startLine,
      endLine,
      sourceVerified: true,
      truncated: snippet !== raw || request.startLine !== 1 || endLine < lines.length,
      snippet,
      symbol: null,
      fileType: /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)test\.|\.(?:test|spec)\./iu.test(path)
        ? "TEST"
        : "SOURCE",
      reason: request.reason,
    };
    {
      this.rows = this.rows.filter(
        (old) =>
          !(
            old.path === path &&
            (old.contentHash !== file.contentHash ||
              (old.startLine >= row.startLine && old.endLine <= row.endLine))
          ),
      );
    }
    this.rows.push(row);

    this.syncEvidence();
  }
}
function parseResponse<T>(response: ModelResponse, schema: z.ZodType<T>): z.ZodSafeParseResult<T> {
  if (response.finishReason !== "STOP" || response.toolCalls.length)
    return schema.safeParse(undefined);
  if (response.structuredOutput?.status === "ERROR") return schema.safeParse(undefined);
  if (response.output !== undefined) return schema.safeParse(response.output);
  try {
    return schema.safeParse(JSON.parse(response.text ?? ""));
  } catch {
    return schema.safeParse(undefined);
  }
}
function structuredFailure(
  response: ModelResponse,
  request: ModelRequest,
): StructuredOutputAttempt["failure"] {
  if (!request.output) return undefined;
  if (response.structuredOutput?.status === "ERROR") {
    const failure = response.structuredOutput;
    return {
      kind: failure.code,
      message: failure.message,
      ...(failure.rawText === undefined ? {} : { rawText: failure.rawText }),
      ...(failure.rawTextHash === undefined ? {} : { rawTextHash: failure.rawTextHash }),
      ...(failure.issues === undefined ? {} : { issues: failure.issues }),
    };
  }
  const raw =
    response.text ?? (response.output === undefined ? "" : JSON.stringify(response.output));
  if (!raw && response.output === undefined)
    return { kind: "EMPTY_OUTPUT", message: "The model returned no structured output." };
  let value: unknown = response.output;
  if (value === undefined) {
    try {
      value = JSON.parse(raw);
    } catch {
      return {
        kind: "INVALID_JSON",
        message: "The model output was not valid JSON.",
        rawText: raw,
        rawTextHash: planHash(raw),
      };
    }
  }
  const parsed = request.output.schema.safeParse(value);
  if (parsed.success && response.finishReason === "STOP" && !response.toolCalls.length)
    return undefined;
  return {
    kind: "SCHEMA_MISMATCH",
    message: "The model did not return a completed schema-conforming result.",
    rawText: raw,
    rawTextHash: planHash(raw),
    issues: parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
          message: issue.message,
        })),
  };
}
async function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
