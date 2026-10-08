import { createHash, randomUUID } from "node:crypto";
import type { LanguageModelPort, ModelRequest } from "@devflow/agent";
import { z } from "zod";
import type { EvidencePack } from "../localization/contracts.js";
import type { SandboxSession } from "@devflow/sandbox";

export const fingerprint = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "");
export interface TraceRow {
  kind: "SPAN" | "MODEL" | "TOOL";
  stage: string;
  startedAt: number;
  wallMs: number;
  [key: string]: unknown;
}

/** Bounded, content-free attribution. Intervals overlap; never sum them as Run wall time. */
export class EfficiencyTrace {
  sandbox(session: SandboxSession): SandboxSession {
    return {
      id: session.id,
      workspacePath: session.workspacePath,
      exec: (request, signal) => session.exec(request, signal),
      listFiles: (request, signal) => session.listFiles(request, signal),
      writeFile: (request, signal) => session.writeFile(request, signal),
      applyPatch: (request, signal) => session.applyPatch(request, signal),
      dispose: () => session.dispose(),
      readFile: async (request, signal) => {
        const startedAt = Date.now();
        const result = await session.readFile(request, signal);
        this.span("SOURCE_READ", startedAt, {
          pathFingerprint: fingerprint(request.path),
          sourceBytes: Buffer.byteLength(result.content),
          truncated: result.truncated,
        });
        return result;
      },
    };
  }
  readonly startedAt = Date.now();
  readonly rows: TraceRow[] = [];
  stage = "PLAN";
  evidenceVersion: string | null = null;
  workspaceRevision = 0;
  previousAction = "START";
  executeStartedAt: number | null = null;
  firstPatch: Record<string, number> | null = null;
  truncated = false;
  incomplete = false;
  readonly flushFailures: string[] = [];
  readonly evidenceItems: {
    path: string;
    contentHash: string;
    workspaceRevision: number;
    fileType: string;
    includedInPlan: boolean;
    suppliedToExecute: boolean;
    usedByExecute: boolean;
    laterReadAgain: number;
    laterSearchedAgain: number;
    changedByPatch: boolean;
    usedByTestSelection: false;
  }[] = [];
  private seen = new Set<string>();

  add(row: TraceRow): void {
    const operation =
      row.kind === "MODEL"
        ? row.stage.endsWith("FORMAT_REPAIR")
          ? row.stage
          : `${row.stage}_LLM`
        : row.kind === "TOOL"
          ? row.mutatesWorkspace
            ? "PATCH_APPLY"
            : `${row.stage}_TOOL`
          : row.stage;
    if (this.rows.length < 4096) this.rows.push({ ...row, operation });
    else this.truncated = true;
  }
  span(stage: string, startedAt: number, extra: Record<string, unknown> = {}): void {
    this.add({ kind: "SPAN", stage, startedAt, wallMs: Date.now() - startedAt, ...extra });
  }
  tool(row: Record<string, unknown>): void {
    const stage = this.stage === "IMPLEMENTATION" ? "EXECUTE" : this.stage;
    const name = String(row.toolName);
    const exploration =
      /^(readFile|batchReadFiles|searchCode|batchSearchCode|listFiles|locateIssue)$/u.test(name);
    const key = `${row.workspaceRevision}:${name}:${row.inputFingerprint}:${row.resultFingerprint}`;
    const redundant = exploration && row.ok === true && this.seen.has(key);
    if (row.ok === true) this.seen.add(key);
    for (const item of this.evidenceItems) {
      if (!Array.isArray(row.paths) || !row.paths.includes(item.path)) continue;
      if (row.mutationApplied === true) {
        item.changedByPatch = true;
        item.usedByExecute = true;
      }
      if (["readFile", "batchReadFiles"].includes(name)) item.laterReadAgain++;
      if (["searchCode", "batchSearchCode", "locateIssue"].includes(name))
        item.laterSearchedAgain++;
    }
    this.add({
      ...row,
      kind: "TOOL",
      stage,
      reason: exploration
        ? "EXPLORATION"
        : row.mutatesWorkspace
          ? "MUTATION"
          : "VALIDATION_OR_CONTROL",
      exploration,
      redundant,
      evidenceVersion: this.evidenceVersion,
      startedAt: Number(row.startedAt),
      wallMs: Number(row.wallMs),
    });
    this.previousAction = name;
    this.workspaceRevision = Number(row.revisionAfter ?? row.workspaceRevision ?? 0);
    if (
      row.mutationApplied === true &&
      this.firstPatch === null &&
      this.executeStartedAt !== null
    ) {
      const models = this.rows.filter(
        (r) => r.kind === "MODEL" && r.startedAt >= this.executeStartedAt!,
      );
      this.firstPatch = {
        wallMs:
          (row.normalizedMutation ? Number(row.startedAt) + Number(row.wallMs) : Date.now()) -
          this.executeStartedAt,
        modelCallsBeforePatch: models.length,
        toolCallsBeforePatch: this.rows.filter(
          (r) => r.kind === "TOOL" && r.startedAt >= this.executeStartedAt!,
        ).length,
        tokensBeforePatch: models.reduce(
          (sum, r) => sum + Number(r.inputTokens ?? 0) + Number(r.outputTokens ?? 0),
          0,
        ),
      };
    }
  }
  evidence(pack: EvidencePack, stage: "PLAN" | "EXECUTE", revision: number): void {
    for (const e of pack.evidence)
      this.evidenceItems.push({
        path: e.path,
        contentHash: e.contentHash,
        workspaceRevision: revision,
        fileType: e.fileType,
        includedInPlan: stage === "PLAN",
        suppliedToExecute: stage === "EXECUTE",
        usedByExecute: false,
        laterReadAgain: 0,
        laterSearchedAgain: 0,
        changedByPatch: false,
        usedByTestSelection: false,
      });
  }
  model(model: LanguageModelPort): LanguageModelPort {
    return {
      ...(model.prepareRequest ? { prepareRequest: model.prepareRequest.bind(model) } : {}),
      generate: async (request, options) => {
        const startedAt = Date.now();
        const stage =
          request.output?.name === "agent_plan"
            ? "PLAN"
            : request.output?.name === "review_result"
              ? "REVIEW"
              : this.stage === "IMPLEMENTATION"
                ? "EXECUTE"
                : this.stage;
        const formatRepair = request.messages.some(
          (m) =>
            m.role === "SYSTEM" && m.content.startsWith("You are a lossless JSON format converter"),
        );
        const reason = request.messages.some(
          (m) => m.role === "SYSTEM" && m.content.startsWith("POST_PATCH_COMPLETION"),
        )
          ? "POST_PATCH_COMPLETION"
          : formatRepair
            ? "FORMAT_REPAIR"
            : stage === "PLAN" || stage === "REVIEW"
              ? stage
              : this.previousAction === "START"
                ? "INITIAL_EXECUTE"
                : this.previousAction === "TEST"
                  ? "POST_TEST_REPAIR"
                  : stage === "REVIEW_REPAIR"
                    ? "REVIEW_REPAIR"
                    : "POST_TOOL_DECISION";
        const row = {
          kind: "MODEL" as const,
          callId: randomUUID(),
          stage: formatRepair ? `${stage}_FORMAT_REPAIR` : stage,
          reason,
          previousAction: this.previousAction,
          evidenceVersion: this.evidenceVersion,
          workspaceRevision: this.workspaceRevision,
          startedAt,
          context: contextBytes(request),
        };
        try {
          const response = await model.generate(request, options);
          this.add({
            ...row,
            wallMs: Date.now() - startedAt,
            latencyMs: response.latencyMs,
            nextAction: response.toolCalls.length
              ? response.toolCalls.map((t) => t.name)
              : ["STOP"],
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            ok: true,
          });
          return response;
        } catch (error) {
          this.add({
            ...row,
            wallMs: Date.now() - startedAt,
            nextAction: ["ERROR"],
            inputTokens: null,
            outputTokens: null,
            ok: false,
          });
          throw error;
        }
      },
    };
  }
  report() {
    const activeWallMs = Date.now() - this.startedAt;
    const stages = [...new Set(this.rows.map((r) => r.stage))].map((stage) => {
      const rows = this.rows.filter((r) => r.stage === stage);
      return {
        stage,
        wallMs: unionMs(rows),
        modelCalls: rows.filter((r) => r.kind === "MODEL").length,
        toolCalls: rows.filter((r) => r.kind === "TOOL").length,
        inputTokens: rows.reduce((n, r) => n + Number(r.inputTokens ?? 0), 0),
        outputTokens: rows.reduce((n, r) => n + Number(r.outputTokens ?? 0), 0),
        sourceBytes: rows.reduce((n, r) => n + Number(r.sourceBytes ?? 0), 0),
      };
    });
    const exploration = this.rows.filter((r) => r.exploration === true);
    return {
      version: "efficiency-v2",
      incomplete: this.incomplete || this.truncated,
      flushFailures: this.flushFailures,
      startedAt: this.startedAt,
      activeWallMs,
      measuredUnionMs: unionMs(this.rows),
      unattributedWallMs: Math.max(0, activeWallMs - unionMs(this.rows)),
      stages,
      executeStartedAt: this.executeStartedAt,
      firstPatch: this.firstPatch,
      explorationRedundancyRate: exploration.length
        ? exploration.filter((r) => r.redundant).length / exploration.length
        : null,
      evidenceItems: this.evidenceItems,
      utilizationSemantics:
        "usedByExecute means observed successful mutation of that path, not inferred model attention; tests are not selected by evidence",
      operations: [...new Set(this.rows.map((r) => r.operation))].map((operation) => ({
        operation,
        wallMs: unionMs(this.rows.filter((r) => r.operation === operation)),
      })),
      truncated: this.truncated,
      rows: this.rows,
    };
  }
}

export function unionMs(rows: readonly Pick<TraceRow, "startedAt" | "wallMs">[]): number {
  let end = -Infinity,
    total = 0;
  for (const row of [...rows].sort((a, b) => a.startedAt - b.startedAt)) {
    const right = row.startedAt + row.wallMs;
    total += Math.max(0, right - Math.max(end, row.startedAt));
    end = Math.max(end, right);
  }
  return total;
}
function contextBytes(request: ModelRequest) {
  const categories: Record<string, number> = {};
  for (const m of request.messages) {
    const text = typeof m.content === "string" ? m.content : "";
    const category =
      m.role === "TOOL"
        ? "toolResults"
        : m.role === "SYSTEM"
          ? "system"
          : text.startsWith("Approved plan")
            ? "approvedPlan"
            : text.startsWith("Repository/stage evidence") || text.includes("<repository_evidence>")
              ? "evidenceAndTask"
              : text.startsWith("Latest relevant file snapshots")
                ? "fileSnapshots"
                : "taskAndHistory";
    categories[category] = (categories[category] ?? 0) + bytes(m);
  }
  return {
    ...categories,
    messages: bytes(request.messages),
    toolSchemas: bytes(
      request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        schema: z.toJSONSchema(t.inputSchema),
      })),
    ),
    outputSchema: request.output ? bytes(z.toJSONSchema(request.output.schema)) : 0,
    unit: "UTF8_BYTES_NOT_PROVIDER_TOKENS",
  };
}
