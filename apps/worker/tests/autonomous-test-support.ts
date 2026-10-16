import { vi } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import type { CommandSpec, SandboxSession } from "@devflow/sandbox";
import { emptyUsage, type ReviewOutcome } from "../src/autonomous/review.js";
import type { SolveInput, SolveResult } from "../src/autonomous/solve.js";

export const signal = new AbortController().signal;
export const issue = { title: "wrong result", body: "Correct both affected paths." };
export const pass = { passed: true, checks: [], protectedChanges: [] };
export const step = (name: string, input: unknown, cost = 0) =>
  fakeModelResponse({
    toolCalls: [{ id: "call", name, input }],
    usage: { inputTokens: 0, outputTokens: cost, totalTokens: cost },
  });
export const submission = (verdict = "PASS", findings: unknown[] = []) => ({
  verdict,
  findings,
  summary: "Checked both paths.",
});
export const triage = (
  verdict = "PASS",
  findings: unknown[] = [],
  concerns: unknown[] = [],
  cost = 0,
) =>
  fakeModelResponse({
    toolCalls: [],
    output: { ...submission(verdict, findings), concerns },
    usage: { inputTokens: 0, outputTokens: cost, totalTokens: cost },
  });
export const finding = (severity: "blocking" | "suggestion") => ({
  severity,
  file: "src/a.ts",
  line: 7,
  description: "Second path returns a wrong value",
  evidence: "node /tmp/repro.js: expected 2, got 8",
});

/** Models git state, the full review snapshot and normal host checks without Docker. */
export function fakeSandbox() {
  let state = "candidate";
  let archived = state;
  const exec = vi.fn(async (command: CommandSpec) => {
    let stdout = "";
    const script = command.args?.[1] ?? "";
    if (command.program === "bash") {
      if (script.includes("mktemp /tmp/devflow-review")) {
        archived = state;
        stdout = "/tmp/review.tar";
      } else if (script.includes("git status --porcelain=v1")) stdout = state;
      else if (script.includes("find /workspace -mindepth")) state = archived;
      else if (command.args?.at(-1) === "mutate") state = "reviewer changed candidate";
    } else if (command.program === "node") stdout = "src/a.ts:1: new\nsrc/a.ts:7: return 8;\n";
    else if (command.program === "git") {
      const args = command.args ?? [];
      if (args[0] === "rev-parse") stdout = "a".repeat(40);
      else if (args[0] === "status") stdout = " M src/a.ts\0";
      else if (args.includes("--name-only")) stdout = "src/a.ts\0";
      else if (args[0] === "diff")
        stdout =
          "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    }
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      outputTruncated: false,
    };
  });
  return {
    sandbox: {
      exec,
      dispose: vi.fn(async () => {}),
      listFiles: vi.fn(async () => ({ entries: [], truncated: false })),
    } as unknown as SandboxSession,
    exec,
    state: () => state,
  };
}
export const reviewInput = (model: FakeLanguageModel, sandbox = fakeSandbox().sandbox) => ({
  sandbox,
  issue,
  model,
  diff: "+fixed",
  verification: pass,
  changedContext: "src/a.ts:7: return 8;\n",
  limits: { maxTurns: 3 },
  signal,
});

export function candidate(
  passed: boolean,
  verdict?: ReviewOutcome["verdict"],
  lines = 1,
): SolveResult {
  return {
    baseCommit: "a".repeat(40),
    changedFiles: ["src/a.ts"],
    excludedFiles: [],
    revisions: 0,
    patch: Array.from({ length: lines }, () => "+new").join("\n"),
    kernel: {
      messages: [{ role: "ASSISTANT", content: "SECRET FULL DIALOGUE" }],
      summary: "one path still fails",
      usage: emptyUsage(),
      turns: 1,
      stopReason: "SUBMITTED",
    },
    verification: {
      ...pass,
      passed,
      checks: passed
        ? []
        : [{ kind: "test", status: "FAIL", exitCode: 1, output: "expected 2", durationMs: 1 }],
    },
    ...(verdict
      ? {
          review: {
            ...submission(verdict),
            verdict,
            findings: verdict === "FAIL" ? [finding("blocking")] : [],
            usage: emptyUsage(),
            tier: 1,
            concerns: [],
            concernCount: 0,
            costMicros: 0,
            turns: 1,
            stopReason: "SUBMITTED",
          },
        }
      : {}),
  };
}
export const attemptInput = (): Omit<SolveInput, "sandbox"> => ({
  issue,
  checks: [],
  model: new FakeLanguageModel([]),
  limits: { maxTurns: 10, maxCostMicros: 100 },
  signal,
});
