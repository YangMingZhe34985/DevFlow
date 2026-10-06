import { afterEach, expect, it, vi } from "vitest";
import { SandboxGitService } from "@devflow/git";
import type { SandboxSession } from "@devflow/sandbox";
import type { DatabaseAdapter } from "@devflow/database";
import type { RunResult } from "@devflow/shared";
import { createWorkflowMetrics } from "../src/runs/workflow-metrics.js";
import { preserveInterruptedWorkflow } from "../src/runs/workflow-interruption.js";
afterEach(() => vi.restoreAllMocks());
it("salvages a timed-out candidate and open findings with a fresh signal, preserving failure", async () => {
  const saved: { name: string; content?: string }[] = [];
  const failed: RunResult = {
    runId: "run",
    status: "TIMED_OUT",
    metrics: createWorkflowMetrics(),
    error: { code: "TIMEOUT", message: "Review incomplete", retryable: false },
  };
  vi.spyOn(SandboxGitService.prototype, "diff").mockImplementation(
    async (_sandbox, _options, signal) => {
      expect(signal?.aborted).toBe(false);
      return { patch: "diff --git a/a.ts b/a.ts", truncated: false, files: [] };
    },
  );
  const database = {
    artifacts: {
      list: async () => [
        {
          kind: "REVIEW_REPORT",
          name: "review.json",
          content: '{"findings":[{"findingId":"open"}]}',
        },
      ],
      create: async (a: { name: string; content?: string }) => {
        saved.push(a);
        return a;
      },
    },
  } as unknown as DatabaseAdapter;
  const result = await preserveInterruptedWorkflow({
    database,
    sandbox: {} as SandboxSession,
    failed,
    timeoutMs: 1000,
    finalize: async (signal) => {
      expect(signal.aborted).toBe(false);
      return failed;
    },
  });
  expect(result).toBe(failed);
  expect(JSON.parse(saved[0]!.content!)).toMatchObject({ status: "TIMED_OUT", truncated: false });
  expect(saved[1]?.content).toContain("open");
});
it("bounds a hung finalization even if the adapter cannot cancel its own operation", async () => {
  const failed: RunResult = { runId: "run", status: "CANCELLED", metrics: createWorkflowMetrics() };
  vi.spyOn(SandboxGitService.prototype, "diff").mockReturnValue(new Promise(() => {}));
  await expect(
    preserveInterruptedWorkflow({
      database: {} as DatabaseAdapter,
      sandbox: {} as SandboxSession,
      failed,
      timeoutMs: 20,
      finalize: async () => failed,
    }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
});
