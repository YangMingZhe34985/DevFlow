import { createHash } from "node:crypto";
import { DevflowError, type ExecutionPacket } from "@devflow/shared";
import type { ToolExecutionRequest, ToolExecutionResult } from "@devflow/tools";
import type { ModelMessage, ModelRequest, ModelToolDescriptor } from "./model.js";
import { z } from "zod";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const reads = new Set(["readFile", "batchReadFiles"]);
const searches = new Set(["searchCode", "batchSearchCode"]);
const directTools = new Set([
  "readFile",
  "batchReadFiles",
  "applyPatch",
  "writeFile",
  "replaceText",
  "gitDiff",
  "finishPhase",
]);

export const PREPATCH_DEFAULTS = {
  contextTokenCap: 6000,
  // gate-a-attribution.json: observed 13956 Test Repair, 1063 Review, 4008 completion;
  // Review Repair has no successful sample: use Test Repair conservatively, not a fake measurement.
  downstreamReserve: 33000,
  nextOutputEstimate: 6000,
  modelDecisions: 3,
  sourceBytes: 1024 * 1024,
} as const;

/** Trusted, phase-local state; model prose cannot change tools, levels or completion. */
export class PrePatchController {
  level: 0 | 1 | 2;
  active = true;
  decisions = 0;
  targetedReads = 0;
  searchQueries = 0;
  relocalizations = 0;
  sourceBytes: number;
  contextBytes = 0;
  compressionCount = 0;
  blockedRequests = 0;
  toolCalls = 0;
  providerTokens = 0;
  noProgress = 0;
  readonly transitions: { level: number; reason: string }[] = [];
  readonly requests: Record<string, unknown>[] = [];
  readonly blockers: string[] = [];
  readonly outcomes: {
    tool: string;
    ok: boolean;
    code: string | null;
    ref: string;
    message: string | null;
    facts: unknown;
  }[] = [];
  private decisionMode: "NORMAL" | "REFRESH" | "CORRECT" = "NORMAL";
  private decisionProgress = false;
  private decisionTracked = false;
  private refreshUsed = false;
  private corrections = 0;
  private lengthRecoveries = 0;
  private readonly terminations: Record<string, unknown>[] = [];
  private recovery: {
    kind: string;
    message: string;
    needsRead: boolean;
    path: string | null;
    diagnostics: string[];
  } | null = null;
  private nextMode(): "NORMAL" | "REFRESH" | "CORRECT" {
    if (this.decisions >= this.limits.modelDecisions - 1) return "CORRECT";
    if (this.recovery) return this.recovery.needsRead && !this.refreshUsed ? "REFRESH" : "CORRECT";
    return "NORMAL";
  }
  private modeAllows(name: string, mode: "NORMAL" | "REFRESH" | "CORRECT"): boolean {
    if (mode === "CORRECT")
      return !reads.has(name) && !searches.has(name) && name !== "locateIssue";
    if (mode === "REFRESH") return reads.has(name) || name === "finishPhase";
    return true;
  }
  private firstPatch: Record<string, number> | null = null;
  private startedAt = Date.now();
  private seen = new Set<string>();
  private latestSlices: ExecutionPacket["codeSlices"];
  constructor(
    readonly packet: ExecutionPacket,
    readonly limits: {
      contextTokenCap: number;
      targetedReads: number;
      searchQueries: number;
      relocalizations: number;
      modelDecisions: number;
      sourceBytes: number;
      downstreamReserve: number;
      nextOutputEstimate: number;
      adaptiveReserve?: boolean;
      /** Host-checked public reads do not expand mutation permissions. */
      allowPublicReads?: boolean;
    },
    initialSourceBytes = 0,
    private readonly slice?: (
      path: string,
      content: string,
      revision: number,
      previous?: ExecutionPacket["codeSlices"][number],
    ) => Promise<ExecutionPacket["codeSlices"][number]>,
  ) {
    this.sourceBytes = initialSourceBytes;
    this.latestSlices = [...packet.codeSlices];
    this.level =
      packet.codeSlices.some((s) => s.truncated || !s.code) || packet.unresolvedQuestions.length > 0
        ? 1
        : 0;
    this.transitions.push({
      level: this.level,
      reason: this.level
        ? "PACKET_HAS_OBSERVABLE_MISSING_SOURCE_OR_UNRESOLVED_CONTRACT"
        : "CURRENT_EXPLICIT_TARGET_SLICE",
    });
  }
  available(tool: Pick<ModelToolDescriptor, "name">): boolean {
    if (!this.active) return true;
    if (!this.modeAllows(tool.name, this.nextMode())) return false;
    if (reads.has(tool.name)) return this.targetedReads < this.limits.targetedReads;
    if (searches.has(tool.name))
      return this.level === 2 && this.searchQueries < this.limits.searchQueries;
    if (tool.name === "locateIssue")
      return this.level === 2 && this.relocalizations < this.limits.relocalizations;
    return directTools.has(tool.name);
  }
  authorize(request: ToolExecutionRequest): string | undefined {
    if (!this.active) return undefined;
    if (!this.modeAllows(request.name, this.decisionMode))
      return "PRE_PATCH_CORRECTION_REQUIRED: use the current evidence to correct the approved mutation; unchanged reads cannot consume the reserved correction.";
    if (
      !directTools.has(request.name) &&
      !searches.has(request.name) &&
      request.name !== "locateIssue"
    )
      return "PRE_PATCH_CAPABILITY_UNAVAILABLE";
    if (searches.has(request.name) && this.level !== 2) return "PRE_PATCH_CAPABILITY_UNAVAILABLE";
    if (
      request.name === "locateIssue" &&
      (this.level !== 2 || this.relocalizations >= this.limits.relocalizations)
    )
      return "PRE_PATCH_CAPABILITY_UNAVAILABLE";
    const input = object(request.input);
    if (request.name === "applyPatch") {
      const paths = [
        ...String(input.patch ?? "").matchAll(/^(?:--- a\/|\+\+\+ b\/)([^\r\n]+)$/gmu),
      ].map((m) => m[1]!);
      if (!paths.length || paths.some((p) => !this.packet.editTargets.some((t) => t.path === p)))
        return "PRE_PATCH_PATCH_OUTSIDE_EXPLICIT_EDIT_OBLIGATION";
    }
    if (reads.has(request.name)) {
      const paths = request.name === "readFile" ? [input.path] : input.paths;
      if (!Array.isArray(paths) || this.targetedReads + paths.length > this.limits.targetedReads)
        return "PRE_PATCH_READ_BUDGET_EXHAUSTED";
      const allowed = new Set(
        [...this.packet.editTargets, ...this.packet.inspectTargets].map((t) => t.path),
      );
      if (
        paths.some(
          (p) => typeof p !== "string" || (!this.limits.allowPublicReads && !allowed.has(p)),
        )
      )
        return "PRE_PATCH_READ_OUTSIDE_EXPLICIT_CONTRACT";
      if (
        this.decisionMode === "REFRESH" &&
        paths.some(
          (p) =>
            !this.packet.editTargets.some((t) => t.path === p) ||
            (this.recovery?.path && p !== this.recovery.path),
        )
      )
        return "PRE_PATCH_REFRESH_REQUIRES_STALE_EDIT_TARGET";
      const cap =
        request.name === "readFile"
          ? Number(input.maxBytes ?? 200000)
          : Number(input.maxBytesPerFile ?? 65536) * paths.length;
      if (!Number.isFinite(cap) || cap + this.sourceBytes > this.limits.sourceBytes)
        return "PRE_PATCH_SOURCE_BUDGET_EXHAUSTED";
      this.targetedReads += paths.length;
    }
    if (searches.has(request.name)) {
      const queries = request.name === "searchCode" ? [input] : input.searches;
      if (
        !Array.isArray(queries) ||
        this.searchQueries + queries.length > this.limits.searchQueries
      )
        return "PRE_PATCH_SEARCH_BUDGET_EXHAUSTED";
      const modules = [...this.packet.editTargets, ...this.packet.inspectTargets].map(
        (t) => t.path.split("/").slice(0, -1).join("/") || ".",
      );
      if (
        queries.some(
          (q) =>
            !modules.includes(String(object(q).path ?? ".")) ||
            Number(object(q).maxResults ?? 100) > 30,
        )
      )
        return "PRE_PATCH_SEARCH_REQUIRES_APPROVED_MODULE_AND_MAX_RESULTS_30";
      this.searchQueries += queries.length;
    }
    if (request.name === "locateIssue") this.relocalizations++;
    if (request.name === "writeFile") {
      const target = this.packet.editTargets.find((t) => t.path === input.path);
      if (!target || target.operation === "DELETE")
        return "PRE_PATCH_WRITE_OUTSIDE_EDIT_OBLIGATION";
      if (
        target.operation !== "CREATE" &&
        !this.latestSlices.some((s) => s.path === input.path && s.fullFile)
      )
        return "PATCH_ATTEMPT_REJECTED: writeFile needs the complete current file; use applyPatch for a slice.";
    }
    if (request.name === "replaceText") {
      const target = this.packet.editTargets.find((t) => t.path === input.path);
      if (!target || target.operation !== "MODIFY")
        return "PRE_PATCH_REPLACE_OUTSIDE_EDIT_OBLIGATION";
      if (!this.latestSlices.some((s) => s.path === input.path))
        return "CURRENT_CODE_REQUIRED: read the current target before replacement.";
    }
    return undefined;
  }
  /** Called before *every* prepatch provider attempt, including provider retries. */
  preflight(
    system: string,
    tools: readonly ModelToolDescriptor[],
    remainingTokens: number,
    settings?: ModelRequest["settings"],
  ): { request: ModelRequest; observation: Record<string, unknown> } {
    if (this.decisions >= this.limits.modelDecisions)
      throw this.failure(
        "PRE_PATCH_MODEL_BUDGET_EXHAUSTED",
        "Bounded pre-patch model decisions exhausted.",
      );
    this.decisionMode = this.nextMode();
    if (this.decisionMode === "CORRECT" && this.corrections >= 1)
      throw this.failure(
        "PRE_PATCH_EXPLORATION_STALLED",
        "The single bounded correction did not produce an applied patch.",
      );
    this.decisionProgress = false;
    this.decisionTracked = false;
    // Reserve mandatory review/completion first, then a bounded share for possible repairs.
    // The absolute Run budget still governs every subsequent phase.
    const reserve = this.limits.adaptiveReserve
      ? Math.min(this.limits.downstreamReserve, Math.max(6000, Math.floor(remainingTokens * 0.35)))
      : this.limits.downstreamReserve;
    const minimum = reserve + this.limits.nextOutputEstimate;
    const allowedInput = Math.min(this.limits.contextTokenCap, remainingTokens - minimum);
    const current = this.latestSlices.filter(
      (s) => s.workspaceRevision === this.packet.workspaceRevision,
    );
    const unique = current.filter(
      (s, i) =>
        current.findIndex(
          (t) =>
            t.path === s.path && t.startLine === s.startLine && t.contentHash === s.contentHash,
        ) === i,
    );
    let selected = unique;
    let projected: ModelMessage[] = [];
    let estimated = 0;
    let serialized = "";
    const build = () => {
      projected = [
        { role: "SYSTEM", content: system },
        {
          role: "USER",
          content: "ExecutionPacket:\n" + JSON.stringify({ ...this.packet, codeSlices: selected }),
        },
        {
          role: "USER",
          content:
            "PrePatchState:\n" +
            JSON.stringify({
              workspaceRevision: this.packet.workspaceRevision,
              level: this.level,
              blockers: this.blockers,
              unresolvedQuestions: this.packet.unresolvedQuestions,
              remaining: {
                targetedReads: this.limits.targetedReads - this.targetedReads,
                searchQueries: this.limits.searchQueries - this.searchQueries,
                relocalizations: this.limits.relocalizations - this.relocalizations,
                modelDecisions: this.limits.modelDecisions - this.decisions,
                sourceBytes: this.limits.sourceBytes - this.sourceBytes,
              },
              lastToolOutcomes: this.outcomes.slice(-4),
              recovery: this.recovery,
              decisionMode: this.decisionMode,
              correctionRemaining: Math.max(0, 1 - this.corrections),
              instructions:
                this.decisionMode === "CORRECT"
                  ? "This is the reserved correction decision. Apply a corrected approved mutation using current evidence, or report inability. No repeated reads/searches. Follow the typed diagnostic; a format error does not require re-reading unchanged source."
                  : this.noProgress
                    ? "No new source information; attempt the approved patch or resolve the exact blocker. Repeating this evidence is not progress."
                    : "Use current targets; external TEST and REVIEW remain mandatory.",
            }),
        },
      ];
      serialized = JSON.stringify({
        messages: projected,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          schema: z.toJSONSchema(t.inputSchema),
        })),
        settings: settings ?? null,
      });
      estimated = Math.ceil(Buffer.byteLength(serialized) / 3);
    };
    build();
    const before = estimated;
    const compression: string[] = [
      "REPLACE_TASK_PLAN_EVIDENCE_HISTORY_WITH_PACKET_AND_CURRENT_STATE",
    ];
    if (selected.length !== unique.length || current.length !== unique.length)
      compression.push("CURRENT_REVISION_SOURCE_DEDUP");
    if (estimated > allowedInput) {
      selected = selected.filter((s) => s.role === "EDIT");
      compression.push("DROP_LOW_PRIORITY_INSPECT_SOURCE");
      build();
    }
    if (estimated > allowedInput) {
      // Reduce the largest region incrementally; never discard every target's
      // useful context merely because one long test file exceeds the cap.
      for (let reductions = 0; estimated > allowedInput && reductions < 64; reductions++) {
        const candidate = selected
          .map((slice, index) => ({ slice, index }))
          .filter(({ slice }) => slice.code.split("\n").length > 32)
          .sort((a, b) => Buffer.byteLength(b.slice.code) - Buffer.byteLength(a.slice.code))[0];
        if (!candidate) break;
        const lines = candidate.slice.code.split("\n");
        const count = Math.max(32, Math.floor(lines.length / 2));
        selected = selected.map((slice, index) =>
          index === candidate.index
            ? {
                ...slice,
                code: lines.slice(0, count).join("\n"),
                endLine: slice.startLine + count - 1,
                complete: false,
                truncated: true,
                fullFile: false,
              }
            : slice,
        );
        build();
      }
      compression.push("BOUND_TARGET_REGION_KEEP_SIGNATURE_HASH_AND_OBLIGATION");
    }
    if (estimated > allowedInput) {
      this.blockedRequests++;
      throw this.failure(
        remainingTokens - minimum < 0
          ? "PRE_PATCH_TOKEN_RESERVE_BLOCKED"
          : "PRE_PATCH_CONTEXT_BUDGET_EXHAUSTED",
        "Cannot send required current target context without consuming the downstream reserve.",
        {
          estimatedInputTokens: estimated,
          remainingTokens,
          reserve,
          estimatedOutputTokens: this.limits.nextOutputEstimate,
          contextTokenCap: this.limits.contextTokenCap,
        },
      );
    }
    if (this.decisionMode === "CORRECT") this.corrections++;
    if (this.decisionMode === "REFRESH") this.refreshUsed = true;
    this.decisions++;
    this.compressionCount += compression.length;
    this.contextBytes += Buffer.byteLength(serialized);
    const categoryBytes = {
      systemPrompt: bytes(projected[0]),
      toolSchemas: bytes(
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          schema: z.toJSONSchema(t.inputSchema),
        })),
      ),
      sourceCode: bytes(selected.map((s) => s.code)),
      executionPacket: bytes(projected[1]) - bytes(selected.map((s) => s.code)),
      runtimeInstructions: bytes(projected[2]),
      other: 0,
    };
    categoryBytes.other =
      Buffer.byteLength(serialized) - Object.values(categoryBytes).reduce((n, v) => n + v, 0);
    const observation = {
      version: "prepatch-preflight-v1",
      decision: this.decisions,
      level: this.level,
      estimator: "ESTIMATED_SERIALIZED_UTF8_BYTES_DIV_3",
      estimatedInputTokens: estimated,
      beforeEstimate: before,
      estimatedOutputTokens: this.limits.nextOutputEstimate,
      remainingTokens,
      downstreamReserve: reserve,
      contextTokenCap: this.limits.contextTokenCap,
      compression,
      categoryBytes,
      contextFingerprint: hash(serialized),
      toolSchemaEstimatedTokens: Math.ceil(categoryBytes.toolSchemas / 3),
      workspaceRevision: this.packet.workspaceRevision,
    };
    this.requests.push(observation);
    return {
      request: {
        messages: projected,
        tools,
        settings: {
          ...settings,
          maxOutputTokens: this.limits.nextOutputEstimate,
        },
      },
      observation,
    };
  }
  usage(input: number, output: number): void {
    if (this.active) this.providerTokens += input + output;
  }
  /** A truncated response is not a mutation. Reuse, never extend, the reserved correction. */
  recoverLength(toolCalls: number): boolean {
    const eligible =
      this.active &&
      toolCalls === 0 &&
      this.lengthRecoveries === 0 &&
      this.corrections === 0 &&
      this.decisions < this.limits.modelDecisions;
    this.terminations.push({
      finishReason: "LENGTH",
      decision: this.decisions,
      toolCalls,
      recoveryScheduled: eligible,
    });
    if (!eligible) return false;
    this.lengthRecoveries++;
    this.decisionTracked = true;
    this.recovery = {
      kind: "MODEL_OUTPUT_LENGTH",
      message:
        "The previous response reached the output limit without a tool action. Use the current source and diagnostics to emit one concise approved mutation now, or report inability. This is the single reserved correction; output and Run budgets are unchanged.",
      needsRead: false,
      path: null,
      diagnostics: [],
    };
    return true;
  }
  async observe(request: ToolExecutionRequest, result: ToolExecutionResult): Promise<void> {
    if (!this.active) return;
    this.toolCalls++;
    if (!result.ok) {
      const details = object(result.error.details),
        diagnostic = object(details.patchFailure);
      const input = object(request.input);
      const kind = String(
        diagnostic.kind ??
          (/STALE/.test(result.error.message)
            ? "STALE_SOURCE"
            : /OUTSIDE|FORBIDDEN/.test(result.error.message)
              ? "TARGET_FORBIDDEN"
              : "TOOL_REJECTED"),
      );
      const failure = {
        kind,
        message: String(diagnostic.message ?? result.error.message).slice(0, 1500),
        needsRead: diagnostic.needsRead === true || kind === "STALE_SOURCE",
        path:
          typeof input.path === "string"
            ? input.path
            : typeof details.path === "string"
              ? details.path
              : null,
        diagnostics: (Array.isArray(diagnostic.diagnostics)
          ? diagnostic.diagnostics
          : Array.isArray(details.diagnostics)
            ? details.diagnostics
            : []
        )
          .slice(0, 3)
          .map((x) => String(x).slice(0, 1500)),
      };
      if (
        ["applyPatch", "replaceText", "writeFile"].includes(request.name) ||
        result.mutation?.mutationAttempted ||
        kind === "STALE_SOURCE"
      )
        this.recovery = failure;
    }
    const ref = hash({
      name: request.name,
      input: request.input,
      workspaceRevision: this.packet.workspaceRevision,
      result: result.ok ? result.output : result.error,
    });
    this.outcomes.push({
      tool: request.name,
      ok: result.ok,
      code: result.ok ? null : result.error.code,
      ref,
      message: result.ok ? null : result.error.message,
      facts: result.ok
        ? {
            matches: Array.isArray(object(result.output).matches)
              ? (object(result.output).matches as unknown[])
                  .slice(0, 8)
                  .map((m) => String(m).slice(0, 512))
              : [],
            truncated: object(result.output).truncated === true,
            evidenceRefs: Array.isArray(object(result.output).evidence)
              ? (object(result.output).evidence as unknown[]).slice(0, 4).map((e) => ({
                  path: object(e).path,
                  contentHash: object(e).contentHash,
                  startLine: object(e).startLine,
                  endLine: object(e).endLine,
                }))
              : [],
          }
        : { error: result.error, recovery: this.recovery },
    });
    if (this.outcomes.length > 8) this.outcomes.shift();
    if (result.mutation?.mutationApplied === true && result.mutation.workspaceChanged) {
      this.firstPatch = {
        TokensToFirstPatch: this.providerTokens,
        TimeToFirstPatch: Date.now() - this.startedAt,
        ModelCallsToFirstPatch: this.decisions,
        ToolCallsToFirstPatch: this.toolCalls,
        SourceBytesToFirstPatch: this.sourceBytes,
        ContextBytesToFirstPatch: this.contextBytes,
      };
      this.active = false;
      return;
    }
    if (result.mutation?.workspaceChanged) {
      this.packet.workspaceRevision = result.mutation.afterRevision;
      this.packet.evidenceRefs = [];
      this.latestSlices = [];
      this.blockers.push("CURRENT_VERSION_REQUIRED_AFTER_REJECTED_MUTATION_CHANGED_WORKSPACE");
      this.escalate("OBSERVED_DIRTY_REVISION_WITHOUT_ACCEPTED_PATCH");
    }
    if (result.mutation?.mutationAttempted) {
      this.blockers.push(`PATCH_ATTEMPT_REJECTED:${result.mutation.reason}`);
      this.escalate("PATCH_ATTEMPT_REJECTED");
    }
    const input = object(request.input),
      output = result.ok ? object(result.output) : {};
    let progress = false;
    if (reads.has(request.name)) {
      if (!result.ok) {
        this.blockers.push(`TARGET_READ_FAILED:${result.error.code}`);
        this.escalate("TARGET_READ_FAILED");
      } else {
        const files =
          request.name === "readFile"
            ? [output]
            : Array.isArray(output.files)
              ? output.files.map(object)
              : [];
        for (const file of files) {
          const path = String(file.path ?? input.path ?? "");
          if (typeof file.content !== "string") continue;
          this.sourceBytes += Buffer.byteLength(file.content);
          if (file.truncated === true) {
            this.blockers.push(`INSUFFICIENT_EVIDENCE:truncated:${path}`);
            this.escalate("TRUNCATED_TARGET_READ");
            continue;
          }
          if (
            this.decisionMode === "REFRESH" &&
            this.recovery &&
            this.packet.editTargets.some((t) => t.path === path) &&
            (!this.recovery.path || this.recovery.path === path)
          )
            this.recovery.needsRead = false;
          if (this.slice) {
            const old = this.latestSlices.filter((s) => s.path === path);
            const slice = await this.slice(
              path,
              file.content,
              this.packet.workspaceRevision,
              old.at(-1),
            );
            progress ||= !old.some(
              (s) =>
                s.contentHash === slice.contentHash &&
                s.startLine === slice.startLine &&
                s.endLine === slice.endLine &&
                s.code === slice.code &&
                s.complete === slice.complete,
            );
            // Preserve already inspected current regions while adding genuinely new ranges.
            const retained = slice.fullFile
              ? []
              : old
                  .filter(
                    (s) =>
                      s.contentHash === slice.contentHash &&
                      s.workspaceRevision === slice.workspaceRevision &&
                      (s.startLine !== slice.startLine || s.endLine !== slice.endLine),
                  )
                  .slice(-3);
            this.latestSlices = this.latestSlices
              .filter((s) => s.path !== path)
              .concat(retained, slice)
              .slice(-16);
          }
        }
      }
    } else if (searches.has(request.name) || request.name === "locateIssue") {
      if (result.ok && !this.seen.has(ref)) progress = true;
      // Results remain untrusted candidates; never create edit obligations automatically.
    }
    if (this.sourceBytes > this.limits.sourceBytes)
      throw this.failure("INSUFFICIENT_EVIDENCE", "Pre-patch source byte limit exceeded.");
    this.seen.add(ref);
    this.decisionProgress ||= progress;
    this.decisionTracked ||=
      reads.has(request.name) ||
      searches.has(request.name) ||
      result.mutation?.mutationAttempted === true ||
      !result.ok;
  }
  /** Called after the whole decision's tool outcomes have been persisted. */
  endDecision(): void {
    if (!this.active) return;
    if (this.decisionProgress) this.noProgress = 0;
    else if (this.decisionTracked) this.noProgress++;
    if (this.decisionMode === "CORRECT" || (this.noProgress >= 2 && this.corrections > 0))
      throw this.failure(
        "PRE_PATCH_EXPLORATION_STALLED",
        "Repeated current evidence did not resolve a target, symbol or blocker.",
      );
  }
  private escalate(reason: string): void {
    if (this.level < 2) {
      this.level = (this.level + 1) as 1 | 2;
      this.transitions.push({ level: this.level, reason });
    }
  }
  observedFirstPatchSourceBytes(sourceBytes: number): void {
    if (this.firstPatch) this.firstPatch.SourceBytesToFirstPatch = sourceBytes;
  }
  failure(
    code: ConstructorParameters<typeof DevflowError>[0]["code"],
    message: string,
    details?: unknown,
  ): DevflowError {
    return new DevflowError({
      code,
      message,
      details: { ...object(details), prePatch: this.metrics() },
    });
  }
  metrics(): Record<string, unknown> {
    return {
      version: "prepatch-v3-bounded-length-recovery",
      decisionMode: this.decisionMode,
      correctionDecisions: this.corrections,
      lengthRecoveries: this.lengthRecoveries,
      terminations: this.terminations,
      recovery: this.recovery,
      level: this.level,
      transitions: this.transitions,
      targetedReads: this.targetedReads,
      searchQueries: this.searchQueries,
      relocalizations: this.relocalizations,
      modelDecisions: this.decisions,
      sourceBytes: this.sourceBytes,
      contextBytes: this.contextBytes,
      compressionCount: this.compressionCount,
      blockedRequests: this.blockedRequests,
      blockers: this.blockers,
      requests: this.requests,
      TokensToFirstPatch: this.firstPatch?.TokensToFirstPatch ?? null,
      TimeToFirstPatch: this.firstPatch?.TimeToFirstPatch ?? null,
      ModelCallsToFirstPatch: this.firstPatch?.ModelCallsToFirstPatch ?? null,
      ToolCallsToFirstPatch: this.firstPatch?.ToolCallsToFirstPatch ?? null,
      SourceBytesToFirstPatch: this.firstPatch?.SourceBytesToFirstPatch ?? null,
      ContextBytesToFirstPatch: this.firstPatch?.ContextBytesToFirstPatch ?? null,
    };
  }
}
