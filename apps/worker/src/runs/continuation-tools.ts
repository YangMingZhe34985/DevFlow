import { createHash } from "node:crypto";
import type { ToolExecutionResult } from "@devflow/tools";
import type { ReplanFile } from "./replan-evidence.js";
import { replanOperationReserve } from "./replan-source.js";

/** Capacity projection only. No reservation is added to consumed tool metrics. */
export class ContinuationTools {
  readonly changed = new Set<string>();
  readonly current = new Map<string, ReplanFile>();
  unknownMutation = false;
  constructor(readonly approved: readonly string[]) {}
  observe(name: string, result: ToolExecutionResult) {
    if (result.mutation) {
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
  reserve(checks: number, manifest: boolean, paths: readonly string[] = []) {
    const needed = [...new Set(paths)];
    return replanOperationReserve(this.approved.length, checks, manifest, {
      changedPaths: this.unknownMutation ? this.approved.length : this.changed.size,
      // Unknown targets reserve a minimal investigation, not the maximum eight-read allowance.
      sourceReads: needed.length || 2,
      candidatePaths: needed.length || 1,
      cachedReads: needed.filter((p) => this.current.has(p)).length,
    });
  }
}
