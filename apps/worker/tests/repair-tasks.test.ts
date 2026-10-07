import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "@devflow/sandbox";
import type { SandboxGitService } from "@devflow/git";
import { buildRepairContext } from "../src/runs/workflow-context.js";
import { repairFinishInputError, resolveRepairEvidenceRefs } from "../src/runs/repair-response.js";
import { sourceEvidenceRecord } from "../src/runs/repair-tasks.js";

describe("host Repair diagnostic tasks", () => {
  it("seeds both unused imports and SHA, using the existing manifest and recording each physical IO once", async () => {
    const path = "src/plugin/runtime.py";
    const source = "from plugin import PluginRef, to_plugin_id\n\ndef execute():\n    return 1\n";
    const listFiles = vi.fn();
    const beforeOperation = vi.fn();
    const context = await buildRepairContext(
      {
        status: async () => ({ files: [{ path }] }),
        diff: async () => ({ patch: "", filesChanged: 1 }),
      } as unknown as SandboxGitService,
      {
        listFiles,
        readFile: async () => ({
          path,
          content: source,
          startLine: 1,
          endLine: 4,
          fileSha256: "a".repeat(64),
          truncated: false,
        }),
      } as unknown as SandboxSession,
      {
        exitCode: 1,
        stdout: `F401 PluginRef imported but unused\n --> ${path}:1:20\nF401 to_plugin_id imported but unused\n --> ${path}:1:31`,
        stderr: "",
        timedOut: false,
        outputTruncated: false,
        durationMs: 1,
      },
      new AbortController().signal,
      undefined,
      { repositoryManifest: { paths: [path], complete: true }, beforeOperation },
    );
    expect(listFiles).not.toHaveBeenCalled();
    expect(beforeOperation).toHaveBeenCalledTimes(3);
    expect(context.toolWorkRecorded).toBe(true);
    expect(context.diagnosticTasks?.records[0]?.kind).toBe("LINT");
    expect(context.stableTaskContext).toContain("F401 PluginRef");
    expect(context.stableTaskContext).toContain("F401 to_plugin_id");
    expect(context.stableTaskContext).not.toContain("from plugin import");
    expect(context.text).not.toContain("F401 PluginRef");
    const record = context.evidenceRecords![0]!;
    const response = { outcome: "SCOPE_CONFLICT" as const, evidenceRefs: [record.id] };
    expect(resolveRepairEvidenceRefs(response, context.currentSources).evidence?.[0]).toMatchObject(
      { path, quote: source },
    );
    expect(
      repairFinishInputError(response, context.currentSources, new Map([[path, "a".repeat(64)]])),
    ).toBeUndefined();
    expect(
      repairFinishInputError(response, context.currentSources, new Map([[path, "b".repeat(64)]])),
    ).toContain("STALE");
    expect(
      repairFinishInputError(
        {
          ...response,
          evidenceRefs: [sourceEvidenceRecord({ ...context.currentSources[0]!, startLine: 5 }).id],
        },
        context.currentSources,
        new Map(),
      ),
    ).toContain("unknown");
  });
});
