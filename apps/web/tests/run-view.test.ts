import { describe, expect, it } from "vitest";

import {
  eventActivity,
  failureStage,
  metricGroups,
  projectTerminalRun,
  reviewView,
  stepActivities,
  toolActivities,
  workflowItems,
} from "../src/lib/run-view.js";
import type {
  AgentEvent,
  ArtifactRecord,
  RunDetail,
  RunMetrics,
  RunRecord,
  StepRecord,
  ToolCallRecord,
} from "../src/lib/types.js";

describe("projectTerminalRun", () => {
  it("shows a structured SSE failure immediately while the detail snapshot is still RUNNING", () => {
    const event: AgentEvent = {
      schemaVersion: 1,
      eventId: "00000000-0000-4000-8000-000000000003",
      runId: RUN_ID,
      sequence: 3,
      occurredAt: "2026-09-19T02:03:04.000Z",
      type: "RUN_FAILED",
      level: "ERROR",
      payload: {
        status: "FAILED",
        stage: "EXECUTE",
        terminalStage: "FAILED",
        code: "SANDBOX_FAILED",
        message: "Failed to create Docker sandbox.",
        error: {
          code: "SANDBOX_FAILED",
          message: "Failed to create Docker sandbox.",
          retryable: false,
          details: { operation: "create" },
        },
      },
    };

    expect(projectTerminalRun(runningRun(), [event])).toMatchObject({
      status: "FAILED",
      currentStage: "FAILED",
      finishedAt: event.occurredAt,
      result: {
        status: "FAILED",
        error: {
          code: "SANDBOX_FAILED",
          message: "Failed to create Docker sandbox.",
          details: { operation: "create" },
        },
      },
    });
  });

  it("projects cancellation and success terminal events", () => {
    expect(projectTerminalRun(runningRun(), [terminalEvent("RUN_CANCELLED")])).toMatchObject({
      status: "CANCELLED",
      currentStage: "CANCELLED",
    });
    expect(projectTerminalRun(runningRun(), [terminalEvent("RUN_COMPLETED")])).toMatchObject({
      status: "SUCCEEDED",
      currentStage: "DONE",
    });
  });
});

describe("workflow view", () => {
  it("locates the actual failed stage from the terminal event", () => {
    const failed = failureEvent("EXECUTE");
    const run = { ...runningRun(), status: "FAILED" as const, currentStage: "FAILED" as const };
    const detail = runDetail({ run });

    expect(failureStage(run, [failed])).toBe("EXECUTE");
    expect(workflowItems(detail, [failed]).map(({ id, state }) => [id, state])).toEqual([
      ["PLAN", "completed"],
      ["APPROVAL", "completed"],
      ["EXECUTE", "failed"],
      ["TEST", "future"],
      ["REPAIR", "future"],
      ["REVIEW", "future"],
      ["DIFF", "future"],
      ["PUSH", "skipped"],
      ["PR", "skipped"],
      ["RESULT", "future"],
    ]);
  });

  it("marks deterministic-test, unused repair, and LOCAL publication stages as skipped", () => {
    const run = {
      ...runningRun(),
      status: "SUCCEEDED" as const,
      currentStage: "DONE" as const,
    };
    const testResult = agentEvent("TEST_RESULT", {
      stage: "TEST",
      skipped: true,
      ok: true,
      durationMs: 0,
    });
    const states = new Map(
      workflowItems(runDetail({ run }), [testResult]).map(({ id, state }) => [id, state]),
    );

    expect(states.get("TEST")).toBe("skipped");
    expect(states.get("REPAIR")).toBe("skipped");
    expect(states.get("PUSH")).toBe("skipped");
    expect(states.get("PR")).toBe("skipped");
    expect(states.get("RESULT")).toBe("completed");
  });

  it("keeps Git publication stages active for GIT repositories", () => {
    const run = {
      ...runningRun(),
      status: "WAITING_APPROVAL" as const,
      currentStage: "WAITING_PUSH_APPROVAL" as const,
    };
    const items = workflowItems(runDetail({ run, sourceKind: "GIT" }), []);

    expect(items.find(({ id }) => id === "PUSH")?.state).toBe("running");
    expect(items.find(({ id }) => id === "PR")?.state).toBe("future");
  });
});

describe("structured review view", () => {
  it("renders the persisted approved/findings contract without promoting raw JSON", () => {
    const content = JSON.stringify({
      approved: true,
      summary: "The implementation is correct.",
      findings: [
        { severity: "INFO", message: "Naming can be tightened later." },
        { severity: "ERROR", message: "Preserved for contract coverage." },
      ],
    });
    const view = reviewView(runDetail({ artifacts: [reviewArtifact(content)] }), []);

    expect(view).toMatchObject({
      verdict: "PASSED",
      approved: true,
      summary: "The implementation is correct.",
      source: "ARTIFACT",
      findings: [
        { severity: "INFO", message: "Naming can be tightened later." },
        { severity: "ERROR", message: "Preserved for contract coverage." },
      ],
      raw: content,
    });
  });

  it("supports the strict transport verdict/issues event and fails closed for malformed text", () => {
    const event = agentEvent("REVIEW_RESULT", {
      verdict: "FAIL",
      summary: "A correction is required.",
      issues: [{ severity: "medium", message: "Handle the empty case." }],
    });
    expect(reviewView(runDetail(), [event])).toMatchObject({
      verdict: "CHANGES_REQUESTED",
      approved: false,
      findings: [{ severity: "WARNING", message: "Handle the empty case." }],
      source: "EVENT",
    });
    expect(reviewView(runDetail({ artifacts: [reviewArtifact("not-json")] }), [])).toMatchObject({
      verdict: "UNKNOWN",
      summary: "not-json",
    });
  });
});

describe("grouped metrics", () => {
  it("separates primary, budget, operation, and latency metrics", () => {
    const metrics: RunMetrics = {
      durationMs: 12_500,
      steps: 7,
      modelCalls: 5,
      toolCalls: 9,
      retries: 1,
      modelLatencyMs: 8_000,
      toolLatencyMs: 2_000,
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      complexity: "SIMPLE",
      complexityConfidence: 0.82,
      estimatedSteps: 8,
      softLimit: 12,
      hardLimit: 25,
      planSteps: 1,
      executeSteps: 5,
      repairSteps: 1,
      reviewSteps: 0,
      unusedSteps: 5,
      budgetExtensions: 1,
    };
    const run = {
      ...runningRun(),
      status: "SUCCEEDED" as const,
      currentStage: "DONE" as const,
      result: { runId: RUN_ID, status: "SUCCEEDED" as const, metrics },
    };
    const groups = metricGroups(runDetail({ run }), []);
    const budget = groups.find(({ id }) => id === "budget");

    expect(groups.map(({ id }) => id)).toEqual(["primary", "budget", "operations", "latency"]);
    expect(Object.fromEntries(budget?.items.map(({ key, value }) => [key, value]) ?? [])).toEqual({
      complexity: "SIMPLE",
      complexityConfidence: "82%",
      estimatedSteps: "8",
      budget: "12 / 25",
      phaseSteps: "Plan 1 · Execute 5 · Repair 1 · Review 0",
      unusedSteps: "5",
      budgetExtensions: "1",
    });
  });

  it("reads adaptive metrics from the latest terminal event", () => {
    const metrics = {
      durationMs: 1,
      steps: 3,
      modelCalls: 2,
      toolCalls: 2,
      retries: 0,
      modelLatencyMs: 1,
      toolLatencyMs: 1,
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      complexity: "MEDIUM",
      estimatedSteps: 18,
      softLimit: 26,
      hardLimit: 50,
      executeSteps: 3,
      unusedSteps: 23,
      budgetExtensions: 0,
    };
    const event = agentEvent("RUN_COMPLETED", { status: "SUCCEEDED", metrics });
    const budget = metricGroups(runDetail(), [event]).find(({ id }) => id === "budget");

    expect(budget?.items.find(({ key }) => key === "complexity")?.value).toBe("MEDIUM");
    expect(budget?.items.find(({ key }) => key === "budget")?.value).toBe("26 / 50");
  });

  it("prefers nested adaptive metrics and displays soft, active, and hard limits", () => {
    const event = agentEvent("RUN_COMPLETED", {
      status: "SUCCEEDED",
      metrics: {
        durationMs: 1,
        steps: 50,
        modelCalls: 12,
        toolCalls: 20,
        retries: 0,
        modelLatencyMs: 1,
        toolLatencyMs: 1,
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        complexity: "SIMPLE",
        estimatedSteps: 3,
        softLimit: 4,
        hardLimit: 5,
        budget: {
          complexity: "COMPLEX",
          estimatedSteps: 55,
          confidence: 0.67,
          softLimit: 70,
          activeLimit: 76,
          hardLimit: 100,
          planSteps: 1,
          executeSteps: 40,
          repairSteps: 6,
          reviewSteps: 3,
          unusedSteps: 26,
          budgetExtensions: 2,
        },
      },
    });
    const budget = metricGroups(runDetail(), [event]).find(({ id }) => id === "budget");

    expect(Object.fromEntries(budget?.items.map(({ key, value }) => [key, value]) ?? [])).toEqual({
      complexity: "COMPLEX",
      complexityConfidence: "67%",
      estimatedSteps: "55",
      softLimit: "70",
      budget: "76 / 100",
      phaseSteps: "Plan 1 · Execute 40 · Repair 6 · Review 3",
      unusedSteps: "26",
      budgetExtensions: "2",
    });
  });

  it("shows the nested budget from a live workflow checkpoint event", () => {
    const checkpoint = agentEvent("WORKFLOW_CHECKPOINT", {
      budget: {
        limits: { agentSteps: 50, modelCalls: 60, toolCalls: 120, totalTokens: 250_000 },
        observed: { agentSteps: 9, modelCalls: 7, toolCalls: 10, totalTokens: 1_000 },
        deadlineAt: "2026-09-19T03:03:04.000Z",
        budget: {
          complexity: "MEDIUM",
          estimatedSteps: 18,
          confidence: 0.9,
          softLimit: 26,
          activeLimit: 34,
          hardLimit: 50,
          planSteps: 1,
          executeSteps: 8,
          repairSteps: 0,
          reviewSteps: 0,
          unusedSteps: 25,
          budgetExtensions: 1,
        },
      },
    });
    const groups = metricGroups(runDetail(), [checkpoint]);
    const budget = groups.find(({ id }) => id === "budget");

    expect(groups.map(({ id }) => id)).toEqual(["primary", "budget", "operations"]);
    expect(budget?.items.find(({ key }) => key === "complexity")?.value).toBe("MEDIUM");
    expect(budget?.items.find(({ key }) => key === "softLimit")?.value).toBe("26");
    expect(budget?.items.find(({ key }) => key === "budget")?.value).toBe("34 / 50");
    expect(budget?.items.find(({ key }) => key === "phaseSteps")?.value).toBe(
      "Plan 1 · Execute 8 · Repair 0 · Review 0",
    );
  });
});

describe("activity summaries", () => {
  it("creates compact step summaries", () => {
    const [activity] = stepActivities([stepRecord("EXECUTE")]);

    expect(activity).toMatchObject({
      title: "Review diff",
      status: "SUCCEEDED",
      stage: "EXECUTE",
      summary: "EXECUTE · SUCCEEDED · 2.0 s",
    });
  });

  it("joins tool calls to their step stage", () => {
    const step = stepRecord("REVIEW");
    const tool = toolCallRecord(step.id);
    const [activity] = toolActivities([tool], [step]);

    expect(activity).toMatchObject({
      id: tool.id,
      title: "gitDiffSummary",
      status: "SUCCEEDED",
      stage: "REVIEW",
      durationMs: 1_250,
      summary: "REVIEW · SUCCEEDED · 1.3 s",
    });
  });

  it("projects event stage, skipped status, duration, and summary", () => {
    const activity = eventActivity(
      agentEvent("TEST_RESULT", {
        stage: "TEST",
        skipped: true,
        ok: true,
        durationMs: 25,
        summary: "No test command detected.",
      }),
    );

    expect(activity).toMatchObject({
      title: "TEST_RESULT",
      status: "SKIPPED",
      stage: "TEST",
      durationMs: 25,
      summary: "TEST · No test command detected. · 25 ms",
    });
  });
});

const RUN_ID = "00000000-0000-4000-8000-000000000001";

function runningRun(): RunRecord {
  return {
    id: RUN_ID,
    taskId: "00000000-0000-4000-8000-000000000002",
    status: "RUNNING",
    currentStage: "EXECUTE",
    maxSteps: 25,
    maxTestRetries: 3,
    maxReviewRetries: 1,
    dispatchRevision: 1,
    retryCount: 0,
    cancellationRequested: false,
    createdAt: "2026-09-19T01:00:00.000Z",
    updatedAt: "2026-09-19T01:01:00.000Z",
  };
}

function terminalEvent(type: "RUN_CANCELLED" | "RUN_COMPLETED"): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: "00000000-0000-4000-8000-000000000003",
    runId: RUN_ID,
    sequence: 3,
    occurredAt: "2026-09-19T02:03:04.000Z",
    type,
    level: "INFO",
    payload: {},
  };
}

function failureEvent(stage: StepRecord["stage"]): AgentEvent {
  return {
    ...agentEvent("RUN_FAILED", {
      status: "FAILED",
      stage,
      terminalStage: "FAILED",
      error: { code: "SANDBOX_FAILED", message: "Sandbox failed." },
    }),
    level: "ERROR",
  };
}

function agentEvent(type: string, payload: AgentEvent["payload"]): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: "00000000-0000-4000-8000-000000000010",
    runId: RUN_ID,
    sequence: 10,
    occurredAt: "2026-09-19T02:03:04.000Z",
    type,
    level: "INFO",
    payload,
  };
}

function runDetail(
  options: {
    run?: RunRecord;
    sourceKind?: "LOCAL" | "GIT";
    artifacts?: readonly ArtifactRecord[];
    steps?: readonly StepRecord[];
    toolCalls?: readonly ToolCallRecord[];
  } = {},
): RunDetail {
  return {
    run: options.run ?? runningRun(),
    task: {
      id: "00000000-0000-4000-8000-000000000002",
      repositoryId: "00000000-0000-4000-8000-000000000003",
      title: "Run view",
      description: "Exercise the Run view model.",
      status: "OPEN",
      baseRef: "main",
      baseCommitSha: "a".repeat(40),
      createdAt: "2026-09-19T01:00:00.000Z",
      updatedAt: "2026-09-19T01:00:00.000Z",
    },
    repository: {
      id: "00000000-0000-4000-8000-000000000003",
      name: "fixture",
      sourceKind: options.sourceKind ?? "LOCAL",
      sourceUri:
        options.sourceKind === "GIT"
          ? "https://github.com/example/fixture.git"
          : "C:/fixtures/run-view",
      defaultBranch: "main",
      createdAt: "2026-09-19T01:00:00.000Z",
      updatedAt: "2026-09-19T01:00:00.000Z",
    },
    steps: options.steps ?? [],
    toolCalls: options.toolCalls ?? [],
    events: [],
    artifacts: options.artifacts ?? [],
    approvals: [],
  };
}

function reviewArtifact(content: string): ArtifactRecord {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    runId: RUN_ID,
    kind: "REVIEW_REPORT",
    name: "review.json",
    mimeType: "application/json",
    content,
    createdAt: "2026-09-19T02:03:04.000Z",
  };
}

function stepRecord(stage: StepRecord["stage"]): StepRecord {
  return {
    id: "00000000-0000-4000-8000-000000000030",
    runId: RUN_ID,
    sequence: 3,
    stage,
    status: "SUCCEEDED",
    title: "Review diff",
    startedAt: "2026-09-19T02:03:00.000Z",
    finishedAt: "2026-09-19T02:03:02.000Z",
    durationMs: 2_000,
  };
}

function toolCallRecord(stepId: string): ToolCallRecord {
  return {
    id: "00000000-0000-4000-8000-000000000040",
    runId: RUN_ID,
    stepId,
    name: "gitDiffSummary",
    status: "SUCCEEDED",
    input: { maxBytes: 32_768 },
    output: { filesChanged: 1 },
    startedAt: "2026-09-19T02:03:00.000Z",
    finishedAt: "2026-09-19T02:03:01.250Z",
    durationMs: 1_250,
  };
}
