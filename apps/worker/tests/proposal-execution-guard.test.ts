import { InMemoryBudgetLedgerStore } from "@devflow/database";
import { describe, expect, it, vi } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import { readFileContent, type ReadFileRequest, type SandboxSession } from "@devflow/sandbox";
import { SandboxGitService } from "@devflow/git";
import { type AgentPlan, type NewAgentEvent } from "@devflow/shared";
import {
  ApprovalWorkflowRunExecutor,
  createTools,
} from "../src/runs/approval-workflow-run-executor.js";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { hash } from "../src/localization/contracts.js";
import type { AgentPhasePurpose } from "../src/runs/workflow-stage-policy.js";
import { RepositoryRelationGraph } from "../src/localization/relation-graph.js";

const plan: AgentPlan = {
  summary: "Repair sum",
  steps: [{ id: "1", title: "Fix", description: "Confirm and fix" }],
  proposalVersion: "plan-proposal-v1",
  approvalScope: {
    version: "plan-approval-scope-v1",
    mode: "READY",
    baseCommitSha: "base",
    workspaceRevision: 0,
    files: [{ path: "src/a.ts", operation: "MODIFY" }],
  },
};
const original = "export const value = 1;\n";
const finish = fakeModelResponse({
  toolCalls: [
    { callId: "finish", name: "finishPhase", input: { summary: "Stop", outcome: "CHANGED" } },
  ],
});

async function phase(
  purpose: AgentPhasePurpose,
  responses: ConstructorParameters<typeof FakeLanguageModel>[0],
  stale = false,
  withGraph = false,
  partialRead?: "HASHED" | "NO_HASH" | "STALE_HASH",
  recovery?: Parameters<typeof createTools>[3],
  enabled?: string[],
) {
  const events: NewAgentEvent[] = [];
  const artifacts: { name: string; content: string }[] = [];
  if (withGraph) {
    const entry = {
      path: "src/a.ts",
      kind: "FILE" as const,
      sizeBytes: Buffer.byteLength(original),
      contentHash: hash(original),
    };
    const graph = new RepositoryRelationGraph({
      repositoryId: "repo",
      baseCommitSha: "base",
      source: {
        manifest: async () => ({ entries: [entry], incomplete: false }),
        read: async () => ({ content: original, truncated: false }),
      },
    });
    await graph.inspect([entry.path], new AbortController().signal);
    artifacts.push({
      name: "repository-relations-plan-v1.json",
      content: JSON.stringify(graph.snapshot()),
    });
  }
  const database = {
    budgetLedgers: new InMemoryBudgetLedgerStore(),
    events: {
      append: async (event: NewAgentEvent) => {
        events.push(event);
      },
    },
    artifacts: {
      create: vi.fn(async (artifact: { name: string; content: string }) => {
        artifacts.push(artifact);
        return artifact;
      }),
      list: async () => artifacts,
    },
  } as unknown as DatabaseAdapter;
  let reads = 0;
  let currentContent = partialRead ? original + "// unread remainder\n" : original;
  const write = vi.fn(async (input: { path: string; content: string; expectedSha256?: string }) => {
    currentContent = input.content;
    return {
      path: input.path,
      sha256: hash(input.content),
      sizeBytes: Buffer.byteLength(input.content),
    };
  });
  const sandbox = {
    id: "guard",
    workspacePath: "/workspace",
    listFiles: async ({ path }: { path: string }) => ({
      entries:
        path === "."
          ? [{ path: "src", kind: "DIRECTORY" }]
          : [{ path: "src/a.ts", kind: "FILE", sizeBytes: Buffer.byteLength(currentContent) }],
      truncated: false,
    }),
    readFile: vi.fn(async (input: ReadFileRequest) => {
      const content =
        stale && ++reads > 1 ? currentContent + "// concurrent change\n" : currentContent;
      if (partialRead) {
        const result = readFileContent(Buffer.from(content), input);
        if (result.truncated && partialRead === "NO_HASH") {
          const { fileSha256: _fileSha256, ...unverified } = result;
          return unverified;
        }
        if (result.truncated && partialRead === "STALE_HASH")
          return { ...result, fileSha256: "0".repeat(64) };
        return result;
      }
      return {
        path: "src/a.ts",
        content,
        fileSha256: hash(content),
        sizeBytes: Buffer.byteLength(content),
        truncated: false,
      };
    }),
    writeFile: write,
    applyPatch: vi.fn(),
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      outputTruncated: false,
      durationMs: 0,
    })),
  } as unknown as SandboxSession;
  const model = new FakeLanguageModel(responses);
  const worker = new ApprovalWorkflowRunExecutor(
    database,
    loadWorkerEnvironment({
      DATABASE_URL: "unused",
      DEVFLOW_PREPATCH_EFFICIENCY_ENABLED: "false",
      DEVFLOW_POST_PATCH_CONVERGENCE_ENABLED: "false",
      DEVFLOW_EVIDENCE_ACTION_ENABLED: "false",
      DEVFLOW_EFFICIENCY_TRACE_ENABLED: "false",
    }),
    () => model,
  );
  const result = await worker["runAgentPhase"]({
    run: {
      id: "guard-run",
      repository: { id: "repo" },
      task: { id: "task", title: "Repair", description: "Repair", baseCommitSha: "base" },
      maxTestRetries: 0,
      maxReviewRetries: 0,
    } as RunExecutionRecord,
    plan,
    sandbox,
    signal: new AbortController().signal,
    ...createTools(new SandboxGitService(), enabled ? { enabled } : undefined, undefined, recovery),
    model,
    purpose,
    maxSteps: 5,
    adaptiveStepBudget: {
      initialLimit: 5,
      hardLimit: 5,
      onLimitReached: () => ({ action: "STOP", reason: "NO_PROGRESS" }),
    },
    timeoutMs: 900_000,
    executionBudget: {
      stage: purpose === "IMPLEMENTATION" ? "EXECUTE" : "REPAIR",
      maxModelCalls: 5,
      maxToolCalls: 12,
      maxTotalTokens: 24000,
    },
    additionalContext: "Source remains to be read.",
  });
  return { result, events, write, sandbox, artifacts, model };
}
const call = (name: string, input: unknown) =>
  fakeModelResponse({ toolCalls: [{ callId: name, name, input }] });

describe("proposal writes keep host guards through implementation and repair", () => {
  it("preserves an evidence response through finish and checks it against current source", async () => {
    const response = call("finishPhase", {
      summary: "Value already present",
      outcome: "CONTRADICTED",
      evidence: [{ path: "src/a.ts", quote: "value = 1", fileSha256: hash(original) }],
    });
    const current = await phase("REVIEW_REPAIR", [
      call("readFile", { path: "src/a.ts" }),
      response,
    ]);
    expect(current.result.phaseCompletion).toMatchObject({
      outcome: "CONTRADICTED",
      evidenceStatus: "CURRENT_SOURCE_LINKED",
    });
    expect(current.write).not.toHaveBeenCalled();
    const unobserved = await phase("REVIEW_REPAIR", [response]);
    expect(unobserved.result.phaseCompletion?.evidenceStatus).toBe("CURRENT_SOURCE_LINKED");
    expect(unobserved.write).not.toHaveBeenCalled();
  });
  it("stops no-op repair loops with convergence disabled", async () => {
    const same = call("writeFile", { path: "src/a.ts", content: original });
    const current = await phase("REVIEW_REPAIR", [
      call("readFile", { path: "src/a.ts" }),
      same,
      same,
      finish,
    ]);
    expect(current.result.status).toBe("FAILED");
    expect(current.result.error?.code).toBe("AGENT_STALLED");
    expect(JSON.stringify(current.events)).toContain('"mutationApplied":false');
    expect(current.model.requests).toHaveLength(3);
  });
  it.each(["TEST_REPAIR", "REVIEW_REPAIR"] as const)(
    "delivers historical evidence through the actual %s request without authorizing a write",
    async (purpose) => {
      const recover = vi.fn(async () => ({
        content: original,
        artifactSha256: hash(original),
        historical: true,
      }));
      const current = await phase(
        purpose,
        [
          call("readEvidenceArtifact", {
            sha256: hash(original),
            section: "file:src/a.ts",
            startLine: 1,
            endLine: 2,
          }),
          call("writeFile", { path: "src/a.ts", content: "unauthorized historical replacement" }),
          finish,
        ],
        false,
        false,
        undefined,
        recover,
      );
      expect(current.model.requests[0]?.tools.map((t) => t.name)).toContain("readEvidenceArtifact");
      expect(recover).toHaveBeenCalledOnce();
      expect(JSON.stringify(current.model.requests[1]?.messages)).toContain("historical");
      expect(JSON.stringify(current.model.requests[1]?.messages)).toContain(hash(original));
      expect(current.write).not.toHaveBeenCalled();
      expect(JSON.stringify(current.events)).toContain("CURRENT_CODE_REQUIRED");
    },
  );
  it("preserves an explicit disabled evidence tool at the final Repair request", async () => {
    const recover = vi.fn();
    const current = await phase(
      "TEST_REPAIR",
      [
        call("readEvidenceArtifact", {
          sha256: hash(original),
          section: "stdout",
          startLine: 1,
          endLine: 2,
        }),
        finish,
      ],
      false,
      false,
      undefined,
      recover,
      ["readFile"],
    );
    expect(current.model.requests[0]?.tools.map((t) => t.name)).not.toContain(
      "readEvidenceArtifact",
    );
    expect(recover).not.toHaveBeenCalled();
  });
  it.each(["IMPLEMENTATION", "TEST_REPAIR", "REVIEW_REPAIR"] as const)(
    "permits an exact replacement after a SHA-bearing range read in %s",
    async (purpose) => {
      const current = await phase(
        purpose,
        [
          call("readFile", { path: "src/a.ts", startLine: 1, endLine: 1 }),
          call("replaceText", {
            path: "src/a.ts",
            oldText: "value = 1",
            newText: "value = 2",
            expectedSha256: hash(original + "// unread remainder\n"),
          }),
          finish,
        ],
        false,
        false,
        "HASHED",
      );
      expect(current.write).toHaveBeenCalledOnce();
      expect(current.write.mock.calls[0]?.[0].content).toBe(
        original.replace("1", "2") + "// unread remainder\n",
      );
    },
  );
  it("registers complete SHA from partial batch reads", async () => {
    const current = await phase(
      "TEST_REPAIR",
      [
        call("batchReadFiles", {
          paths: ["src/a.ts"],
          maxBytesPerFile: Buffer.byteLength(original),
        }),
        call("replaceText", {
          path: "src/a.ts",
          oldText: "value = 1",
          newText: "value = 2",
          expectedSha256: hash(original + "// unread remainder\n"),
        }),
        finish,
      ],
      false,
      false,
      "HASHED",
    );
    expect(current.write).toHaveBeenCalledOnce();
  });
  it("does not permit whole-file replacement after a partial range read", async () => {
    const current = await phase(
      "TEST_REPAIR",
      [
        call("readFile", { path: "src/a.ts", startLine: 1, endLine: 1 }),
        call("writeFile", { path: "src/a.ts", content: "erase unread lines" }),
        finish,
      ],
      false,
      false,
      "HASHED",
    );
    expect(current.write).not.toHaveBeenCalled();
    expect(JSON.stringify(current.events)).toContain("CURRENT_CODE_REQUIRED");
  });
  it.each(["NO_HASH", "STALE_HASH"] as const)(
    "rejects a partial read with %s without writing",
    async (partialRead) => {
      const current = await phase(
        "REVIEW_REPAIR",
        [
          call("readFile", { path: "src/a.ts", startLine: 1, endLine: 1 }),
          call("replaceText", {
            path: "src/a.ts",
            oldText: "value = 1",
            newText: "value = 2",
            expectedSha256: hash(original + "// unread remainder\n"),
          }),
          finish,
        ],
        false,
        false,
        partialRead,
      );
      expect(current.write).not.toHaveBeenCalled();
    },
  );
  it("rejects changes between a range read and exact replacement", async () => {
    const current = await phase(
      "REVIEW_REPAIR",
      [
        call("readFile", { path: "src/a.ts", startLine: 1, endLine: 1 }),
        call("replaceText", {
          path: "src/a.ts",
          oldText: "value = 1",
          newText: "value = 2",
          expectedSha256: hash(original + "// unread remainder\n"),
        }),
        finish,
      ],
      true,
      false,
      "HASHED",
    );
    expect(current.write).not.toHaveBeenCalled();
    expect(JSON.stringify(current.events)).toContain("STALE_EVIDENCE");
  });
  it("queries a verified graph without granting writes, then invalidates its overlay after replaceText", async () => {
    const current = await phase(
      "IMPLEMENTATION",
      [
        call("queryRelations", { paths: ["src/a.ts"], symbols: ["value"] }),
        call("readFile", { path: "src/a.ts" }),
        call("replaceText", {
          path: "src/a.ts",
          oldText: "value = 1",
          newText: "value = 2",
          expectedSha256: hash(original),
        }),
        finish,
      ],
      false,
      true,
    );
    expect(current.result.status).toBe("SUCCEEDED");
    expect(current.write).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(current.model.requests)).toContain("implementationEvidence");
    const overlay = JSON.parse(
      current.artifacts.find((a) => a.name.startsWith("repository-relations-overlay-"))!.content,
    );
    expect(overlay.workspaceRevision).toBe(1);
    expect(overlay.files[0].state).toBe("STALE");
  });
  it.each(["IMPLEMENTATION", "TEST_REPAIR", "REVIEW_REPAIR"] as const)(
    "denies outside-scope writes with efficiency flags off in %s",
    async (purpose) => {
      const current = await phase(purpose, [
        call("writeFile", { path: "other.ts", content: "unauthorized" }),
        finish,
      ]);
      expect(current.write).not.toHaveBeenCalled();
      expect(JSON.stringify(current.events)).toContain("APPROVAL_SCOPE");
    },
  );
  it("denies an in-scope whole-file write before reading current code", async () => {
    const current = await phase("IMPLEMENTATION", [
      call("writeFile", { path: "src/a.ts", content: "new" }),
      finish,
    ]);
    expect(current.write).not.toHaveBeenCalled();
    expect(JSON.stringify(current.events)).toContain("CURRENT_CODE_REQUIRED");
  });
  it("uses a fresh read hash on an approved repair write", async () => {
    const current = await phase("TEST_REPAIR", [
      call("readFile", { path: "src/a.ts" }),
      call("writeFile", { path: "src/a.ts", content: "export const value = 2;\n" }),
      finish,
    ]);
    expect(current.write).toHaveBeenCalledOnce();
    expect(current.write.mock.calls[0]?.[0].expectedSha256).toBe(hash(original));
  });
  it("rejects a changed SHA between a repair read and write", async () => {
    const current = await phase(
      "REVIEW_REPAIR",
      [
        call("readFile", { path: "src/a.ts" }),
        call("writeFile", { path: "src/a.ts", content: "new" }),
        finish,
      ],
      true,
    );
    expect(current.write).not.toHaveBeenCalled();
    expect(JSON.stringify(current.events)).toContain("STALE_EVIDENCE");
  });
  it.each(["IMPLEMENTATION", "TEST_REPAIR", "REVIEW_REPAIR"] as const)(
    "denies unapproved replacements in %s",
    async (purpose) => {
      const current = await phase(purpose, [
        call("replaceText", {
          path: "other.ts",
          oldText: "1",
          newText: "2",
          expectedSha256: hash(original),
        }),
        finish,
      ]);
      expect(current.write).not.toHaveBeenCalled();
      expect(JSON.stringify(current.events)).toContain("APPROVAL_SCOPE");
    },
  );
  it("continues two exact edits from the returned new SHA, without rereading unchanged evidence", async () => {
    const afterFirst = original.replace("1", "2");
    const current = await phase("TEST_REPAIR", [
      call("readFile", { path: "src/a.ts" }),
      call("replaceText", {
        path: "src/a.ts",
        oldText: "= 1",
        newText: "= 2",
        expectedSha256: hash(original),
      }),
      call("replaceText", {
        path: "src/a.ts",
        oldText: "= 2",
        newText: "= 3",
        expectedSha256: hash(afterFirst),
      }),
      finish,
    ]);
    expect(current.write).toHaveBeenCalledTimes(2);
    expect(current.write.mock.calls[1]?.[0].expectedSha256).toBe(hash(afterFirst));
  });
});
