import { createHash } from "node:crypto";
import type { ToolExecutionResult } from "@devflow/tools";
import type { ReplanFile } from "./replan-evidence.js";
import {
  prospectiveCheckpointPaths,
  replanOperationPlan,
  type ReplanOperationInput,
} from "./replan-operation-plan.js";
import type { CurrentSourceCache } from "./current-source-cache.js";
import type { SandboxSession } from "@devflow/sandbox";

/** Capacity projection only. No reservation is added to consumed tool metrics. */
export class ContinuationTools {
  readonly changed = new Set<string>();
  readonly current = new Map<string, ReplanFile>();
  unknownMutation = false;
  constructor(
    readonly approved: readonly string[],
    readonly sourceCache?: CurrentSourceCache,
    private readonly sandbox?: SandboxSession,
  ) {}
  observe(name: string, result: ToolExecutionResult) {
    this.sourceCache?.observe(name, result);
    if (name === "runCommand") {
      this.unknownMutation = true;
      this.current.clear();
    } else if (result.mutation) {
      const m = result.mutation;
      if (!m.observationComplete) {
        this.unknownMutation = true;
        this.current.clear();
      } else if (m.workspaceChanged) {
        for (const path of m.affectedPaths ?? m.changedFiles) this.current.delete(path);
        m.changedFiles.forEach((p) => this.changed.add(p));
      }
    } else if (["runCommand", "writeFile", "replaceText", "applyPatch"].includes(name)) {
      this.unknownMutation = true;
      this.current.clear();
    }
    if (!result.ok || name !== "readFile") return;
    const f = result.output as Record<string, unknown>;
    if (
      typeof f.path === "string" &&
      typeof f.content === "string" &&
      f.truncated === false &&
      typeof f.fileSha256 === "string" &&
      createHash("sha256").update(f.content).digest("hex") === f.fileSha256
    )
      this.current.set(f.path, {
        path: f.path,
        content: f.content,
        contentHash: f.fileSha256,
        sizeBytes: Buffer.byteLength(f.content),
      });
  }

  /** The selected paths drive both admission and host preparation; no maximum allowance
   * is substituted for operations that will actually be performed. */
  operationPlan(
    input: Omit<ReplanOperationInput, "changedPaths" | "cachedSourcePaths"> & {
      restoredChangedPaths?: readonly string[];
      prospectiveEditPaths?: readonly string[];
    },
  ) {
    const changedPaths = prospectiveCheckpointPaths({
      approvedPaths: this.approved,
      unknownMutation: this.unknownMutation,
      changedPaths: [...(input.restoredChangedPaths ?? []), ...this.changed],
      editPaths: input.prospectiveEditPaths ?? [],
    });
    const invalidated = new Set(input.prospectiveEditPaths ?? []);
    return replanOperationPlan({
      ...input,
      changedPaths,
      cachedSourcePaths: input.sourceReadPaths.filter(
        (path) =>
          !invalidated.has(path) &&
          (this.current.has(path) ||
            (this.sandbox && this.sourceCache?.source(this.sandbox, path))),
      ),
      cachedCheckpointCurrentPaths: (input.cachedCheckpointCurrentPaths ?? []).filter(
        (path) => !invalidated.has(path),
      ),
      cachedRepairContextPaths: (input.cachedRepairContextPaths ?? []).filter(
        (path) => !invalidated.has(path),
      ),
      review: {
        ...input.review,
        cachedSourcePaths: (input.review.cachedSourcePaths ?? []).filter(
          (path) => !invalidated.has(path),
        ),
      },
    });
  }

  prospectiveChanges(editPaths: readonly string[], restoredChangedPaths: readonly string[] = []) {
    const current = prospectiveCheckpointPaths({
      approvedPaths: this.approved,
      changedPaths: [...restoredChangedPaths, ...this.changed],
      editPaths: [],
      unknownMutation: this.unknownMutation,
    });
    const after = prospectiveCheckpointPaths({
      approvedPaths: this.approved,
      changedPaths: current,
      editPaths,
      unknownMutation: this.unknownMutation,
    });
    return { current, after, added: after.filter((path) => !current.includes(path)) };
  }
  /** Preparation and restore have already consumed their capacity after new approval. */
  afterReplan(checks: number, restoredChangedPaths: readonly string[]) {
    return this.finalization(checks, {
      restoredChangedPaths,
      observeIdentity: true,
    });
  }

  /** Only operations still required after handing the current candidate to the Workflow. */
  finalization(
    checks: number,
    input: {
      restoredChangedPaths?: readonly string[];
      observeIdentity: boolean;
      prospectiveEditPaths?: readonly string[];
    },
  ) {
    const changed = new Set([
      ...(input.restoredChangedPaths ?? []),
      ...this.changed,
      ...(input.prospectiveEditPaths ?? []),
      ...(this.unknownMutation ? this.approved : []),
    ]);
    const operations = {
      // captureReplanCandidate: head/status, then baseline/current for each changed file.
      checkpoint: input.restoredChangedPaths
        ? (this.sandbox && this.sourceCache?.head(this.sandbox) ? 1 : 2) +
          [...changed].reduce(
            (sum, path) =>
              sum +
              (this.sandbox &&
              this.sourceCache?.baseline(
                this.sandbox,
                this.sourceCache.head(this.sandbox) ?? "",
                path,
              ) !== undefined
                ? 0
                : 1) +
              (!input.prospectiveEditPaths?.includes(path) &&
              this.sandbox &&
              (this.sourceCache?.source(this.sandbox, path) ||
                this.sourceCache?.identity(this.sandbox, path) === "ABSENT")
                ? 0
                : 1),
            0,
          )
        : 0,
      // continueCoding observes the new approved scope once after the Agent returns.
      sourceIdentity: input.observeIdentity
        ? [...new Set(this.approved)].filter(
            (path) =>
              !(
                !input.prospectiveEditPaths?.includes(path) &&
                this.sandbox &&
                this.sourceCache?.identity(this.sandbox, path)
              ) &&
              // The immediately preceding checkpoint verifies all actually changed source identities.
              !(input.restoredChangedPaths && this.sourceCache && changed.has(path)),
          ).length
        : 0,
      // The failed public profile has already been discovered before scope replanning.
      publicChecks: Math.max(0, checks),
      // Initial Review/delivery reads are internal IO, guarded separately by the Scheduler.
      reviewReads: 0,
    };
    return { operations, total: Object.values(operations).reduce((sum, n) => sum + n, 0) };
  }
}
