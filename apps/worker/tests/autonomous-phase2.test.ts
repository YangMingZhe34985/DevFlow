import { describe, expect, it, vi } from "vitest";
import { FakeLanguageModel } from "@devflow/agent";
import type { SandboxSession } from "@devflow/sandbox";
import { runIndependentReview, emptyUsage } from "../src/autonomous/review.js";
import {
  candidatePriority,
  selectCandidate,
  failureSummary,
  runAttempts,
} from "../src/autonomous/attempts.js";
import { runAutonomousSolve, type SolveInput } from "../src/autonomous/solve.js";
import { loadWorkerEnvironment } from "../src/config/env.js";
import {
  reviewInput,
  step,
  submission,
  finding,
  fakeSandbox,
  candidate,
  attemptInput,
} from "./autonomous-test-support.js";

describe("independent reviewer", () => {
  it("submits a structured result with only read-only tools in a fresh conversation", async () => {
    const model = new FakeLanguageModel([step("submit_review", submission())]);
    const outcome = await runIndependentReview(reviewInput(model));
    expect(outcome).toMatchObject({
      verdict: "PASS",
      findings: [],
      stopReason: "SUBMITTED",
      turns: 1,
    });
    expect(model.requests[0]!.tools.map((tool) => [tool.name, tool.readOnly])).toEqual([
      ["bash", true],
      ["read_file", true],
      ["submit_review", true],
    ]);
    expect(model.requests[0]!.messages).toHaveLength(2);
  });
  it("returns malformed arguments as a tool error and lets the model retry", async () => {
    const model = new FakeLanguageModel([
      step("submit_review", { verdict: "WRONG", findings: [], summary: "" }),
      async (request) => {
        expect(request.messages.at(-1)).toMatchObject({ role: "TOOL", isError: true });
        expect(String(request.messages.at(-1)?.content)).toContain("Invalid arguments");
        return step("submit_review", submission("FAIL", [finding("blocking")]));
      },
    ]);
    expect(await runIndependentReview(reviewInput(model))).toMatchObject({
      verdict: "FAIL",
      turns: 2,
    });
  });
  it.each(["TURN_LIMIT", "COST_LIMIT"])(
    "records NEEDS_EVIDENCE on %s without a submission",
    async (stopReason) => {
      const model = new FakeLanguageModel([step("bash", { command: "true" })]);
      const outcome = await runIndependentReview({
        ...reviewInput(model),
        limits: {
          maxTurns: stopReason === "TURN_LIMIT" ? 1 : 3,
          ...(stopReason === "COST_LIMIT" ? { maxCostMicros: 0 } : {}),
        },
        price: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0 },
      });
      expect(outcome).toMatchObject({ verdict: "NEEDS_EVIDENCE", stopReason });
    },
  );
  it.each([
    ["FAIL", "suggestion", "PASS"],
    ["PASS", "blocking", "FAIL"],
    ["FAIL", "blocking", "FAIL"],
    ["NEEDS_EVIDENCE", "suggestion", "NEEDS_EVIDENCE"],
  ] as const)("normalizes %s with %s findings to %s", async (verdict, severity, expected) => {
    expect(
      (
        await runIndependentReview(
          reviewInput(
            new FakeLanguageModel([
              step("submit_review", submission(verdict, [finding(severity)])),
            ]),
          ),
        )
      ).verdict,
    ).toBe(expected);
  });
  it("rejects blocking findings without evidence as invalid arguments", async () => {
    const model = new FakeLanguageModel([
      step("submit_review", submission("FAIL", [{ ...finding("blocking"), evidence: " " }])),
    ]);
    const result = await runIndependentReview({ ...reviewInput(model), limits: { maxTurns: 1 } });
    expect(result.verdict).toBe("NEEDS_EVIDENCE");
  });
  it("discards even PASS when bash modifies files and restores the full prior candidate", async () => {
    const fake = fakeSandbox();
    const model = new FakeLanguageModel([
      step("bash", { command: "mutate" }),
      step("submit_review", submission()),
    ]);
    const result = await runIndependentReview(reviewInput(model, fake.sandbox));
    expect(result).toMatchObject({ verdict: "NEEDS_EVIDENCE", findings: [] });
    expect(result.summary).toContain("workspace restored");
    expect(fake.state()).toBe("candidate");
    expect(fake.exec.mock.calls.some(([cmd]) => cmd.args?.[1]?.includes("tar -xf"))).toBe(true);
  });
});

describe("candidate selection", () => {
  it("orders all four priorities", () => {
    const candidates = [
      candidate(false, "PASS"),
      candidate(true),
      candidate(true, "NEEDS_EVIDENCE"),
      candidate(true, "PASS"),
    ];
    expect(candidates.map(candidatePriority)).toEqual([0, 1, 2, 3]);
    expect(selectCandidate(candidates.map((solve, i) => ({ attempt: i + 1, solve }))).attempt).toBe(
      4,
    );
    expect(candidatePriority(candidate(true, "FAIL"))).toBe(1);
  });
  it.each([undefined, "PASS", "NEEDS_EVIDENCE", "FAIL"] as const)(
    "chooses fewer changed lines within verdict %s",
    (verdict) => {
      expect(
        selectCandidate([
          { attempt: 1, solve: candidate(!!verdict, verdict, 4) },
          { attempt: 2, solve: candidate(!!verdict, verdict, 2) },
        ]).attempt,
      ).toBe(2);
    },
  );
});

describe("adaptive attempts", () => {
  it.each([undefined, "PASS", "NEEDS_EVIDENCE"] as const)(
    "does not append attempts after host success (%s)",
    async (verdict) => {
      const factory = vi.fn(async () => fakeSandbox().sandbox);
      const solve = vi.fn(async () => candidate(true, verdict));
      const result = await runAttempts({ ...attemptInput(), sandboxFactory: factory, solve });
      expect(result.attempts).toHaveLength(1);
      expect(factory).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["host", "review"])(
    "appends on %s failure with a new sandbox and a fresh transcript",
    async (failure) => {
      const seen: SandboxSession[] = [];
      const solve = vi.fn(async (input: SolveInput) => {
        seen.push(input.sandbox);
        const first = seen.length === 1;
        if (!first) {
          expect(input.resume?.messages).toEqual([]);
          expect(input.failureSummary).toContain("src/a.ts");
          expect(input.failureSummary).not.toContain("SECRET FULL DIALOGUE");
          expect(input.failureSummary).not.toContain("+new");
          expect(input.resume?.usage.costMicros).toBe(30);
        }
        const result = candidate(
          !first || failure === "review",
          first && failure === "review" ? "FAIL" : "PASS",
        );
        result.kernel.usage.costMicros = (input.resume?.usage.costMicros ?? 0) + 30;
        result.kernel.turns = (input.resume?.turns ?? 0) + 1;
        return result;
      });
      const result = await runAttempts({
        ...attemptInput(),
        sandboxFactory: async () => fakeSandbox().sandbox,
        solve,
      });
      expect(result.selectedAttempt).toBe(2);
      expect(result.usage.costMicros).toBe(60);
      expect(seen[0]).not.toBe(seen[1]);
    },
  );
  it("appends after an attempt that produced no change at all", async () => {
    const solve = vi.fn(async (input: SolveInput) => {
      if (input.failureSummary === undefined) {
        const empty = candidate(false);
        delete empty.verification;
        return { ...empty, patch: "", changedFiles: [] };
      }
      return candidate(true, "PASS");
    });
    const result = await runAttempts({
      ...attemptInput(),
      sandboxFactory: async () => fakeSandbox().sandbox,
      solve,
    });
    expect(solve).toHaveBeenCalledTimes(2);
    expect(result.selectedAttempt).toBe(2);
  });
  it.each(["cost", "turns", "deadline"])(
    "does not append when the global %s limit is reached",
    async (limit) => {
      const solve = vi.fn(async () => {
        const result = candidate(false);
        result.kernel.usage.costMicros = limit === "cost" ? 100 : 0;
        result.kernel.turns = limit === "turns" ? 10 : 1;
        return result;
      });
      await runAttempts({
        ...attemptInput(),
        ...(limit === "deadline" ? { limits: { maxTurns: 10, deadlineAt: Date.now() - 1 } } : {}),
        sandboxFactory: async () => fakeSandbox().sandbox,
        solve,
      });
      expect(solve).toHaveBeenCalledTimes(1);
    },
  );
  it("does not start a sandbox when the remaining slice cannot afford the first call", async () => {
    const result = candidate(false);
    result.kernel.usage.costMicros = 95;
    const factory = vi.fn(async () => fakeSandbox().sandbox);
    await runAttempts({
      ...attemptInput(),
      completed: [{ attempt: 1, solve: result }],
      price: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 1_000_000 },
      settings: { maxOutputTokens: 10 },
      sandboxFactory: factory,
    });
    expect(factory).not.toHaveBeenCalled();
  });
  it("resumes only the active attempt, reusing completed artifacts and their spending", async () => {
    const done = candidate(false);
    const usage = { ...emptyUsage(), costMicros: 45 };
    const messages = [{ role: "USER" as const, content: "active attempt transcript" }];
    const solve = vi.fn(async (input: SolveInput) => {
      expect(input.resume).toEqual({ messages, usage, turns: 4 });
      const result = candidate(true, "PASS");
      result.kernel.usage = { ...usage, costMicros: 50 };
      return result;
    });
    const result = await runAttempts({
      ...attemptInput(),
      currentAttempt: 2,
      completed: [{ attempt: 1, solve: done }],
      resume: { messages, usage, turns: 4 },
      sandboxFactory: async () => fakeSandbox().sandbox,
      solve,
    });
    expect(solve).toHaveBeenCalledTimes(1);
    expect(result.selectedAttempt).toBe(2);
    expect(result.usage.costMicros).toBe(50);
    expect(failureSummary(done)).not.toContain("SECRET FULL DIALOGUE");
  });
});

describe("review and solving share a fixed cost slice", () => {
  const price = { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 1_000_000 };
  it("stops solving at 85% and lets review use the remaining Run budget", async () => {
    const solver = new FakeLanguageModel([step("bash", { command: "true" }, 80)]);
    const reviewer = new FakeLanguageModel([step("submit_review", submission(), 10)]);
    const result = await runAutonomousSolve({
      ...attemptInput(),
      sandbox: fakeSandbox().sandbox,
      model: solver,
      price,
      settings: { maxOutputTokens: 10 },
      review: { model: reviewer, settings: { maxOutputTokens: 10 }, price },
    });
    expect(result.kernel.stopReason).toBe("COST_LIMIT");
    expect(solver.requests).toHaveLength(1);
    expect(result.review?.verdict).toBe("PASS");
    expect(result.review?.usage.costMicros).toBe(10);
    expect(result.kernel.usage.costMicros).toBe(90);
  });
  it("feeds blocking findings back to the original solver conversation using the revision count", async () => {
    const solver = new FakeLanguageModel([
      step("submit", { summary: "first fix" }),
      async (request) => {
        expect(request.messages).toHaveLength(5);
        expect(String(request.messages.at(-1)?.content)).toContain(
          "Second path returns a wrong value",
        );
        return step("submit", { summary: "both paths fixed" });
      },
    ]);
    const reviewer = new FakeLanguageModel([
      step("submit_review", submission("FAIL", [finding("blocking")])),
      step("submit_review", submission()),
    ]);
    const result = await runAutonomousSolve({
      ...attemptInput(),
      sandbox: fakeSandbox().sandbox,
      model: solver,
      maxRevisions: 1,
      review: { model: reviewer },
    });
    expect(result.revisions).toBe(1);
    expect(result.review?.verdict).toBe("PASS");
    expect(result.kernel.usage.modelCalls).toBe(4);
  });
  it("NEEDS_EVIDENCE does not consume a revision", async () => {
    const solver = new FakeLanguageModel([step("submit", { summary: "fix" })]);
    const result = await runAutonomousSolve({
      ...attemptInput(),
      sandbox: fakeSandbox().sandbox,
      model: solver,
      maxRevisions: 2,
      review: { model: new FakeLanguageModel([]), maxTurns: 0 },
    });
    expect(result.review?.verdict).toBe("NEEDS_EVIDENCE");
    expect(result.revisions).toBe(0);
    expect(solver.requests).toHaveLength(1);
  });
  it("keeps an evidenced FAIL if the reserved slice cannot afford any revision", async () => {
    const solver = new FakeLanguageModel([step("submit", { summary: "first candidate" }, 75)]);
    const reviewer = new FakeLanguageModel([
      step("submit_review", submission("FAIL", [finding("blocking")]), 10),
    ]);
    const result = await runAutonomousSolve({
      ...attemptInput(),
      sandbox: fakeSandbox().sandbox,
      model: solver,
      price,
      settings: { maxOutputTokens: 10 },
      maxRevisions: 2,
      review: { model: reviewer, price, settings: { maxOutputTokens: 10 } },
    });
    expect(result.kernel.stopReason).toBe("COST_LIMIT");
    expect(result.review?.verdict).toBe("FAIL");
    expect(reviewer.requests).toHaveLength(1);
    expect(solver.requests).toHaveLength(1);
  });
  it("has conservative validated environment defaults", () => {
    const environment = loadWorkerEnvironment({
      DATABASE_URL: "postgresql://unused@localhost/unused",
    });
    expect(environment).toMatchObject({
      DEVFLOW_AUTONOMOUS_REVIEW: "1",
      DEVFLOW_AUTONOMOUS_REVIEW_MAX_TURNS: 30,
      DEVFLOW_AUTONOMOUS_REVIEW_RESERVE: 0.15,
      DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS: 2,
    });
    expect(() =>
      loadWorkerEnvironment({
        DATABASE_URL: "postgresql://unused@localhost/unused",
        DEVFLOW_AUTONOMOUS_REVIEW_RESERVE: "1.5",
      }),
    ).toThrow();
  });
});
