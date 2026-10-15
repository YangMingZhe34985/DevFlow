import { describe, expect, it, vi } from "vitest";
import { FakeLanguageModel } from "@devflow/agent";
import { AutonomousRunExecutor } from "../src/autonomous/executor.js";
import { loadWorkerEnvironment } from "../src/config/env.js";
import type {
  ArtifactRecord,
  CreateArtifactInput,
  DatabaseAdapter,
  RunExecutionRecord,
} from "@devflow/database";
import { DevflowError, type NewAgentEvent, type RunResult } from "@devflow/shared";
import {
  triage,
  issue,
  step,
  submission,
  finding,
  fakeSandbox,
  signal,
} from "./autonomous-test-support.js";

describe("executor Phase 2 artifacts and results", () => {
  function harness(
    reviewer: FakeLanguageModel,
    env: Record<string, string> = {},
    solver = new FakeLanguageModel([step("submit", { summary: "candidate fixed" })]),
    priced = false,
  ) {
    const events: NewAgentEvent[] = [];
    const artifacts: ArtifactRecord[] = [];
    let failWhen: ((event: NewAgentEvent) => boolean) | undefined;
    const run = {
      id: "run",
      status: "RUNNING",
      currentStage: "START",
      task: { title: issue.title, description: issue.body },
      repository: { sourceKind: "LOCAL", sourceUri: "fixture" },
    } as unknown as RunExecutionRecord;
    const database = {
      runs: { transition: vi.fn(async () => {}) },
      events: {
        list: async () => events,
        append: async (event: NewAgentEvent) => {
          if (failWhen?.(event)) {
            failWhen = undefined;
            throw new DevflowError({
              code: "DATABASE_FAILED",
              message: "injected dispatch outage",
              retryable: true,
            });
          }
          events.push(event);
        },
      },
      artifacts: {
        list: async () => artifacts,
        create: async (input: CreateArtifactInput) => {
          const record = input as unknown as ArtifactRecord;
          artifacts.push(record);
          return record;
        },
      },
    } as unknown as DatabaseAdapter;
    const factory = vi.fn(async () => fakeSandbox().sandbox);
    const environment = loadWorkerEnvironment({
      DATABASE_URL: "postgresql://unused@localhost/unused",
      DEVFLOW_AUTONOMOUS_MAX_REVISIONS: "0",
      DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS: "1",
      ...env,
    });
    const executor = new AutonomousRunExecutor(database, environment, {
      modelFactory: () => ({ model: solver, settings: {}, bindingHash: "solver" }),
      reviewModelFactory: () => ({
        model: reviewer,
        settings: {},
        bindingHash: "reviewer",
        ...(priced
          ? { price: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 1_000_000 } }
          : {}),
      }),
      sandboxFactory: factory,
    });
    return {
      executor,
      run,
      events,
      artifacts,
      solver,
      factory,
      failOn: (predicate: (event: NewAgentEvent) => boolean) => {
        failWhen = predicate;
      },
    };
  }
  it.each(["PASS", "FAIL", "NEEDS_EVIDENCE"] as const)(
    "records verdict %s and the correct Run status while preserving the selected diff",
    async (verdict) => {
      const h = harness(
        new FakeLanguageModel([
          triage(
            verdict === "NEEDS_EVIDENCE" ? "CONCERNS" : verdict,
            verdict === "FAIL" ? [finding("blocking")] : [],
            verdict === "NEEDS_EVIDENCE" ? [{ question: "Does the second path still fail?" }] : [],
          ),
          ...(verdict === "NEEDS_EVIDENCE" ? [step("submit_review", submission(verdict))] : []),
        ]),
      );
      const result = (await h.executor.execute(h.run, signal)) as RunResult;
      expect(result.status, JSON.stringify(result.error)).toBe(
        verdict === "FAIL" ? "FAILED" : "SUCCEEDED",
      );
      expect(result.summary).toContain("Independent review");
      expect(result.summary).toContain(verdict);
      if (verdict === "NEEDS_EVIDENCE") expect(result.summary).toContain("未经独立审查确认");
      expect(h.artifacts.filter((artifact) => artifact.kind === "DIFF")).toHaveLength(1);
      expect(h.artifacts.some((artifact) => artifact.kind === "REVIEW_REPORT")).toBe(true);
      expect(
        h.artifacts.some((artifact) => artifact.name === "autonomous-transcript-attempt-1.json"),
      ).toBe(true);
      expect(h.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["REVIEW_STARTED", "REVIEW_RESULT", "WORKFLOW_CHECKPOINT"]),
      );
      expect(result.metrics.modelCalls).toBe(verdict === "NEEDS_EVIDENCE" ? 3 : 2);
      for (const event of h.events.filter((e) => e.type.startsWith("REVIEW_"))) {
        expect(event.payload).toMatchObject({ at: expect.any(String), tier: expect.any(Number) });
      }
    },
  );
  it("can disable review and preserve the single solver path", async () => {
    const h = harness(new FakeLanguageModel([]), { DEVFLOW_AUTONOMOUS_REVIEW: "0" });
    const result = (await h.executor.execute(h.run, signal)) as RunResult;
    expect(result.status).toBe("SUCCEEDED");
    expect(h.events.some((event) => event.type === "REVIEW_STARTED")).toBe(false);
    expect(result.metrics.modelCalls).toBe(1);
  });
  it.each(["REVIEW_RESULT", "LLM_RESPONSE"])(
    "preserves review spending across an outage at %s",
    async (failedEvent) => {
      const reviewer = new FakeLanguageModel([triage("PASS", [], [], 10), triage()]);
      const h = harness(
        reviewer,
        { DEVFLOW_MAX_COST_MICROS: "100", DEVFLOW_AUTONOMOUS_REVIEW_MAX_OUTPUT: "10" },
        undefined,
        true,
      );
      h.failOn(
        (event) => event.type === failedEvent && h.events.some((e) => e.type === "REVIEW_STARTED"),
      );
      await expect(h.executor.execute(h.run, signal)).rejects.toMatchObject({
        code: "DATABASE_FAILED",
      });
      const result = (await h.executor.execute(h.run, signal)) as RunResult;
      expect(result.status).toBe("SUCCEEDED");
      expect(result.summary).toContain("NEEDS_EVIDENCE");
      expect(reviewer.requests).toHaveLength(1);
      const review = JSON.parse(
        h.artifacts.filter((a) => a.kind === "REVIEW_REPORT").at(-1)!.content!,
      );
      expect(review).toMatchObject({ summary: "review budget exhausted" });
      const transcript = JSON.parse(
        h.artifacts.filter((a) => a.name === "autonomous-transcript.json").at(-1)!.content!,
      );
      expect(transcript.review.costMicros).toBe(10);
    },
  );
  it("loads completed attempts from artifacts without rerunning them after a dispatch interruption", async () => {
    const h = harness(new FakeLanguageModel([triage()]));
    await h.executor.execute(h.run, signal);
    const result = (await h.executor.execute(h.run, signal)) as RunResult;
    expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
    expect(h.solver.requests).toHaveLength(1);
    expect(result.metrics.modelCalls).toBe(2);
    expect(result.summary).toContain("Selected attempt 1 of 1");
  });
  it("resumes attempt two after an outage without replaying attempt one", async () => {
    const solver = new FakeLanguageModel([
      step("submit", { summary: "first attempt summary" }),
      async (request) => {
        expect(request.messages).toHaveLength(2);
        expect(String(request.messages.at(-1)?.content)).toContain("first attempt summary");
        return step("submit", { summary: "second attempt summary" });
      },
    ]);
    const h = harness(
      new FakeLanguageModel([triage("FAIL", [finding("blocking")]), triage()]),
      { DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS: "2" },
      solver,
    );
    h.failOn(
      (event) => event.type === "LLM_REQUEST" && (event.payload as { turn: number }).turn === 3,
    );
    await expect(h.executor.execute(h.run, signal)).rejects.toMatchObject({
      code: "DATABASE_FAILED",
    });
    const checkpoint = JSON.parse(
      h.artifacts.filter((artifact) => artifact.name === "autonomous-checkpoint.json").at(-1)!
        .content!,
    );
    expect(checkpoint.attempt).toBe(2);
    const result = (await h.executor.execute(h.run, signal)) as RunResult;
    expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
    expect(solver.requests).toHaveLength(2);
    expect(
      h.artifacts.filter((artifact) => artifact.name === "autonomous-transcript-attempt-1.json"),
    ).toHaveLength(1);
    expect(result.summary).toContain("Selected attempt 2 of 2");
    expect(result.metrics.modelCalls).toBe(4);
  });
});
