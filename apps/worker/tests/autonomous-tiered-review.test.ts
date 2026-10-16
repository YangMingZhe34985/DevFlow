import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import type { CommandSpec, SandboxSession } from "@devflow/sandbox";
import { readReviewContext, REVIEW_CONTEXT_BYTES } from "../src/autonomous/review-context.js";
import {
  runTriageReview,
  runIndependentReview,
  reviewSettings,
  TriageReviewSchema,
} from "../src/autonomous/review.js";
import { runAutonomousSolve } from "../src/autonomous/solve.js";
import { runAttempts } from "../src/autonomous/attempts.js";
import {
  attemptInput,
  fakeSandbox,
  finding,
  reviewInput,
  signal,
  step,
  submission,
  triage,
} from "./autonomous-test-support.js";

const concern = {
  question: "Does the second path still return 8 instead of 2?",
  file: "src/a.ts",
  line: 7,
};
const price = { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 1_000_000 };
const solve = (model: FakeLanguageModel) => ({
  ...attemptInput(),
  sandbox: fakeSandbox().sandbox,
  model: new FakeLanguageModel([
    step("submit", { summary: "Fixed the first path; checked the second." }),
  ]),
  review: { model },
});

describe("tool-free triage and escalation", () => {
  it("passes with exactly one tool-free request containing solver summary, context and bounded host output", async () => {
    const sandbox = fakeSandbox();
    const reviewer = new FakeLanguageModel([
      async (request) => {
        expect(request.tools).toEqual([]);
        expect(request.output?.schema).toBe(TriageReviewSchema);
        expect(request.settings?.maxOutputTokens).toBe(4096);
        const task = JSON.parse(String(request.messages[1]?.content));
        expect(task.solverSummary).toContain("checked the second");
        expect(task.changedContext).toContain("src/a.ts:7: return 8;");
        expect(task.hostVerification.checks[0]).toEqual({
          kind: "test",
          status: "PASS",
          exitCode: 0,
          outputTail: "x".repeat(1500),
        });
        return triage();
      },
    ]);
    const input = solve(reviewer);
    const original = sandbox.exec.getMockImplementation()!;
    sandbox.exec.mockImplementation(async (command) =>
      command.args?.includes("devflow-check")
        ? {
            exitCode: 0,
            stdout: "x".repeat(3000),
            stderr: "",
            durationMs: 1,
            timedOut: false,
            outputTruncated: false,
          }
        : original(command),
    );
    const result = await runAutonomousSolve({
      ...input,
      sandbox: sandbox.sandbox,
      checks: [{ kind: "test", command: { program: "check", args: [] } }],
    });
    expect(result.review).toMatchObject({ tier: 1, verdict: "PASS", concernCount: 0 });
    expect(reviewer.requests).toHaveLength(1);
    expect(sandbox.exec.mock.calls.filter(([cmd]) => cmd.program === "node")).toHaveLength(1);
    expect(
      sandbox.exec.mock.calls.some(([cmd]) =>
        cmd.args?.[1]?.includes("mktemp /tmp/devflow-review"),
      ),
    ).toBe(false);
  });

  it.each(["PASS", "FAIL"] as const)(
    "escalates concrete concerns and resolves them to %s",
    async (verdict) => {
      const model = new FakeLanguageModel([
        triage("CONCERNS", [], [concern]),
        async (request) => {
          const task = JSON.parse(String(request.messages[1]?.content));
          expect(task.concerns).toEqual([concern]);
          expect(task.changedContext).toContain("src/a.ts:7:");
          expect(request.messages[0]?.content).toContain("do not browse the repository again");
          expect(request.settings).toMatchObject({
            maxOutputTokens: 4096,
            reasoningEffort: "medium",
          });
          return step(
            "submit_review",
            submission(verdict, verdict === "FAIL" ? [finding("blocking")] : []),
          );
        },
      ]);
      expect((await runAutonomousSolve(solve(model))).review).toMatchObject({
        tier: 2,
        verdict,
        concernCount: 1,
      });
      expect(model.requests).toHaveLength(2);
    },
  );

  it.each([
    { ...finding("blocking"), file: "unseen.ts" },
    { ...finding("blocking"), line: 999 },
    { ...finding("blocking"), file: undefined },
    finding("suggestion"),
  ])("turns unsupported FAIL evidence into a targeted concern: %j", async (invalid) => {
    const model = new FakeLanguageModel([
      triage("FAIL", [invalid]),
      async (request) => {
        expect(JSON.parse(String(request.messages[1]?.content)).concerns[0].question).toContain(
          "Second path returns a wrong value",
        );
        return step("submit_review", submission());
      },
    ]);
    expect((await runAutonomousSolve(solve(model))).review).toMatchObject({
      tier: 2,
      verdict: "PASS",
    });
    expect(model.requests).toHaveLength(2);
  });

  it("still reviews a changed candidate after the solver used every turn", async () => {
    const reviewer = new FakeLanguageModel([triage("FAIL", [finding("blocking")])]);
    const result = await runAutonomousSolve({
      ...solve(reviewer),
      model: new FakeLanguageModel([
        step("bash", { command: "true" }),
        step("bash", { command: "true" }),
      ]),
      limits: { maxTurns: 2 },
    });
    expect(result.kernel.stopReason).toBe("TURN_LIMIT");
    expect(result.review).toMatchObject({ tier: 1, verdict: "FAIL" });
    expect(reviewer.requests).toHaveLength(1);
  });

  it("limits tool investigation to eight turns even if callers request more", async () => {
    const model = new FakeLanguageModel([
      triage("CONCERNS", [], [concern]),
      ...Array.from({ length: 9 }, () => step("bash", { command: "true" })),
    ]);
    const result = await runAutonomousSolve({
      ...solve(model),
      limits: { maxTurns: 30 },
      review: { model, maxTurns: 25 },
    });
    expect(result.review).toMatchObject({
      tier: 2,
      verdict: "NEEDS_EVIDENCE",
      stopReason: "TURN_LIMIT",
    });
    expect(model.requests).toHaveLength(9);
    expect(result.revisions).toBe(0);
  });
  it("gives the reviewer a role-neutral budget note", async () => {
    const model = new FakeLanguageModel([
      step("bash", { command: "true" }),
      async (request) => {
        expect(String(request.messages.at(-1)?.content)).toContain(
          "wrap up and submit your result soon",
        );
        return step("submit_review", submission());
      },
    ]);
    expect(
      (await runIndependentReview({ ...reviewInput(model), concerns: [concern] })).verdict,
    ).toBe("PASS");
  });
});

describe("structured output and review settings", () => {
  it("retries the identical request once after invalid JSON, then accepts valid output", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({ text: "invalid", toolCalls: [] }),
      triage(),
    ]);
    expect(await runTriageReview(reviewInput(model))).toMatchObject({
      verdict: "PASS",
      turns: 2,
      usage: { modelCalls: 2 },
    });
    expect(model.requests[0]).toEqual(model.requests[1]);
  });
  it.each([
    fakeModelResponse({ output: { verdict: "PASS" }, toolCalls: [] }),
    fakeModelResponse({
      output: { ...submission(), concerns: [] },
      toolCalls: [],
      structuredOutput: {
        status: "ERROR",
        code: "INVALID_JSON",
        message: "Invalid JSON",
        rawTextLength: 3,
      },
    }),
    fakeModelResponse({
      output: { ...submission("CONCERNS"), concerns: Array.from({ length: 4 }, () => concern) },
      toolCalls: [],
    }),
    fakeModelResponse({
      output: { ...submission(), concerns: [] },
      toolCalls: [],
      finishReason: "LENGTH",
    }),
  ])("returns NEEDS_EVIDENCE after two invalid structured responses", async (invalid) => {
    const model = new FakeLanguageModel([invalid, invalid, triage()]);
    const result = await runTriageReview(reviewInput(model));
    expect(result.verdict).toBe("NEEDS_EVIDENCE");
    expect(result.summary).toContain("after 2 attempt(s)");
    expect(model.requests).toHaveLength(2);
  });
  it("retries a reply cut off by the output limit with twice the output room", async () => {
    const cut = fakeModelResponse({ toolCalls: [], finishReason: "LENGTH" });
    const model = new FakeLanguageModel([cut, triage()]);
    const result = await runTriageReview({
      ...reviewInput(model),
      settings: { maxOutputTokens: 4096 },
    });
    expect(result.verdict).toBe("PASS");
    expect(model.requests.map((r) => r.settings?.maxOutputTokens)).toEqual([4096, 8192]);
  });
  it("parses a JSON text response when no adapter output object is provided", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({ text: JSON.stringify({ ...submission(), concerns: [] }), toolCalls: [] }),
    ]);
    expect((await runTriageReview(reviewInput(model))).verdict).toBe("PASS");
  });
  it.each(["glm-5.3", "glm-5.3-preview", "deepseek-v4-pro-0813"])(
    "steps unsupported effort down to the nearest supported level for %s",
    (model) => {
      // medium is unsupported: use low, never the heavier binding level (high consumed the
      // whole 4096-token output in the tiered-review retest).
      expect(reviewSettings(model, { reasoningEffort: "high", maxOutputTokens: 16384 })).toEqual({
        reasoningEffort: "low",
        maxOutputTokens: 4096,
      });
      expect(
        reviewSettings(
          model,
          { reasoningEffort: "low" },
          { reasoningEffort: "xhigh", maxOutputTokens: 2048 },
        ),
      ).toEqual({ reasoningEffort: "high", maxOutputTokens: 2048 });
      expect(
        reviewSettings(model, { reasoningEffort: "low" }, { reasoningEffort: "max" })
          .reasoningEffort,
      ).toBe("max");
    },
  );
  it("keeps medium for unrestricted models and none only where supported", () => {
    expect(reviewSettings("other", {}).reasoningEffort).toBe("medium");
    expect(
      reviewSettings("deepseek-v4-flash", { reasoningEffort: "high" }, { reasoningEffort: "none" })
        .reasoningEffort,
    ).toBe("none");
    expect(
      reviewSettings("glm-5.3", { reasoningEffort: "high" }, { reasoningEffort: "none" })
        .reasoningEffort,
    ).toBe("low");
  });
});

describe("separate cumulative review ceiling", () => {
  it("reports all review spending even when the earlier candidate is selected", async () => {
    const model = new FakeLanguageModel([
      triage("FAIL", [finding("blocking")], [], 5),
      triage("FAIL", [finding("blocking")], [], 5),
    ]);
    const result = await runAttempts({
      ...attemptInput(),
      sandboxFactory: async () => fakeSandbox().sandbox,
      model: new FakeLanguageModel([
        step("submit", { summary: "first" }),
        step("submit", { summary: "second" }),
      ]),
      review: { model, price, settings: { maxOutputTokens: 5 } },
    });
    expect(result.selectedAttempt).toBe(1);
    expect(result.selected.review?.costMicros).toBe(10);
  });
  it("keeps the full solver budget when review is disabled", async () => {
    const model = new FakeLanguageModel([
      step("bash", { command: "true" }, 80),
      step("submit", { summary: "fixed" }, 10),
    ]);
    const result = await runAutonomousSolve({
      ...attemptInput(),
      sandbox: fakeSandbox().sandbox,
      model,
      price,
      settings: { maxOutputTokens: 10 },
    });
    expect(result.kernel.stopReason).toBe("SUBMITTED");
    expect(result.kernel.usage.costMicros).toBe(90);
    expect(result.review).toBeUndefined();
    expect(result).not.toHaveProperty("reviewSpentMicros");
  });
  it("exhausts the review slice across revisions without reducing the solver slice", async () => {
    const solver = new FakeLanguageModel([
      step("submit", { summary: "first fix" }, 65),
      step("submit", { summary: "second fix" }, 10),
    ]);
    const reviewer = new FakeLanguageModel([
      triage("FAIL", [finding("blocking")], [], 10),
      triage(),
    ]);
    const result = await runAutonomousSolve({
      ...solve(reviewer),
      model: solver,
      price,
      settings: { maxOutputTokens: 10 },
      review: { model: reviewer, price, settings: { maxOutputTokens: 10 } },
      maxRevisions: 1,
    });
    expect(solver.requests).toHaveLength(2);
    expect(reviewer.requests).toHaveLength(1);
    expect(result.review).toMatchObject({
      verdict: "NEEDS_EVIDENCE",
      summary: "review budget exhausted",
      costMicros: 10,
    });
    expect(result.kernel.usage.costMicros).toBe(85);
    expect(result.reviewSpentMicros).toBe(10);
  });
  it("shares the ceiling across both tiers and subsequent attempts", async () => {
    const solver = new FakeLanguageModel([
      step("submit", { summary: "first" }),
      step("submit", { summary: "next" }),
    ]);
    const reviewer = new FakeLanguageModel([
      triage("CONCERNS", [], [concern], 5),
      step("submit_review", submission("FAIL", [finding("blocking")]), 10),
      triage(),
    ]);
    const result = await runAttempts({
      ...attemptInput(),
      model: solver,
      sandboxFactory: async () => fakeSandbox().sandbox,
      review: { model: reviewer, price, settings: { maxOutputTokens: 10 } },
    });
    expect(reviewer.requests).toHaveLength(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.selected.review).toMatchObject({
      verdict: "NEEDS_EVIDENCE",
      summary: "review budget exhausted",
      costMicros: 15,
    });
    expect(result.usage.costMicros).toBe(15);
  });
  it("does not retry invalid output when the remaining review budget cannot afford it", async () => {
    const invalid = fakeModelResponse({
      toolCalls: [],
      text: "bad",
      usage: { inputTokens: 0, outputTokens: 10, totalTokens: 10 },
    });
    const model = new FakeLanguageModel([invalid, triage()]);
    const result = await runTriageReview({
      ...reviewInput(model),
      price,
      settings: { maxOutputTokens: 10 },
      limits: { maxTurns: 3, maxCostMicros: 15 },
    });
    expect(result).toMatchObject({
      verdict: "NEEDS_EVIDENCE",
      summary: "review budget exhausted",
      costMicros: 10,
    });
    expect(model.requests).toHaveLength(1);
  });
  it("counts unconfirmed request failures against the review ceiling", async () => {
    const model = new FakeLanguageModel([
      async () => {
        throw new Error("socket closed after sending");
      },
    ]);
    const result = await runTriageReview({
      ...reviewInput(model),
      price,
      settings: { maxOutputTokens: 10 },
    });
    expect(result).toMatchObject({
      verdict: "NEEDS_EVIDENCE",
      costMicros: 10,
      usage: { unconfirmedCostMicros: 10 },
    });
    expect(model.requests).toHaveLength(1);
  });
  it("does not call a model with an empty review budget, even with zero-priced fake usage", async () => {
    const model = new FakeLanguageModel([triage()]);
    expect(
      await runTriageReview({ ...reviewInput(model), limits: { maxTurns: 2, maxCostMicros: 0 } }),
    ).toMatchObject({ summary: "review budget exhausted", turns: 0 });
    expect(model.requests).toHaveLength(0);
  });
});

describe("host changed-context extraction", () => {
  async function contextFixture(source: string, diff: string, filename = "src/a.ts") {
    const root = await mkdtemp(path.join(tmpdir(), "devflow-review-context-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, filename), source);
    const exec = vi.fn(async (cmd: CommandSpec) => {
      // Execute the real single-read script against an isolated local fixture, without Docker.
      const script = cmd.args![1]!.replaceAll('"/workspace"', JSON.stringify(root));
      const child = execFile(process.execPath, ["-e", script], {
        maxBuffer: REVIEW_CONTEXT_BYTES + 1000,
      });
      child.stdin!.end(cmd.stdin);
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = "",
          stderr = "";
        child.stdout!.on("data", (data) => {
          stdout += String(data);
        });
        child.stderr!.on("data", (data) => {
          stderr += String(data);
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr)),
        );
      });
      return { ...result, exitCode: 0, durationMs: 1, timedOut: false, outputTruncated: false };
    });
    try {
      const context = await readReviewContext({ exec } as unknown as SandboxSession, diff, signal);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0]![0].maxOutputBytes).toBe(REVIEW_CONTEXT_BYTES);
      return context;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const diff = (hunks: string) =>
    `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${hunks}`;
  it("reads sixty lines on either side, merging overlapping and adjacent hunk intervals", async () => {
    const context = await contextFixture(
      Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n"),
      diff("@@ -100 +100 @@\n-old\n+new\n@@ -210 +210 @@\n-old\n+new\n"),
    );
    const rows = context.trim().split("\n");
    expect(rows[0]).toBe("src/a.ts:40: line 40");
    expect(rows.at(-1)).toBe("src/a.ts:270: line 270");
    expect(rows).toHaveLength(231);
    expect(new Set(rows).size).toBe(rows.length);
  });
  it("bounds multibyte context to 40 KB and retains the lines nearest changes", async () => {
    const context = await contextFixture(
      Array.from({ length: 300 }, (_, i) => `${i + 1}: ${"中".repeat(200)}`).join("\n"),
      diff("@@ -150 +150 @@\n-old\n+new\n"),
    );
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(REVIEW_CONTEXT_BYTES);
    expect(context).toContain("src/a.ts:150: 150:");
    expect(context).not.toContain("src/a.ts:90: 90:");
    expect(context).toContain("context truncated");
    const model = new FakeLanguageModel([triage()]);
    await runTriageReview({ ...reviewInput(model), changedContext: context });
    expect(
      Buffer.byteLength(JSON.parse(String(model.requests[0]!.messages[1]?.content)).changedContext),
    ).toBeLessThanOrEqual(REVIEW_CONTEXT_BYTES);
  });
  it("does not mistake added +++ text for a new file header", async () => {
    const context = await contextFixture(
      "first\nsecond\nthird",
      diff("@@ -1 +1 @@\n--- old\n+++ source text\n@@ -3 +3 @@\n-old\n+third\n"),
    );
    expect(context).toContain("src/a.ts:3: third");
    expect(context).not.toContain("unavailable");
  });
  it.each([true, false])(
    "reads Unicode and spaced filenames with core.quotepath=%s",
    async (quoted) => {
      const filename = "src/中 name.ts";
      const header = quoted ? String.raw`"b/src/\344\270\255 name.ts"` : `b/${filename}`;
      const patch = diff("@@ -1 +1 @@\n-old\n+new\n").replace("+++ b/src/a.ts", `+++ ${header}`);
      expect(await contextFixture("new", patch, filename)).toContain(`${filename}:1: new`);
    },
  );
});
