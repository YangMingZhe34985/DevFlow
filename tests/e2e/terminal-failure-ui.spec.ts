import { expect, test, type Page, type Route } from "@playwright/test";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000002";
const REPOSITORY_ID = "00000000-0000-4000-8000-000000000003";
const NOW = "2026-09-19T02:03:04.000Z";

test("projects a live RUN_FAILED event into the Run detail UI", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/runs/${RUN_ID}`);

  const detail = page.getByTestId("run-detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".run-header .status")).toHaveText("FAILED");
  await expect(page.getByTestId("run-header-stage")).toHaveText("Failed at Execute");
  await expect(page.getByTestId("run-duration")).toContainText("Duration");
  await expect(page.getByTestId("workflow-stage-execute")).toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("workflow-stage-push")).toHaveAttribute("data-state", "skipped");
  await expect(page.getByTestId("workflow-stage-pr")).toHaveAttribute("data-state", "skipped");
  await expect(page.getByTestId("run-result")).toContainText("SANDBOX_FAILED");
  await expect(page.getByTestId("run-result")).toContainText("Failed to create Docker sandbox.");
  await expect(page.getByTestId("event-timeline")).toContainText("RUN_FAILED");
  await expect(page.getByTestId("connection-state")).toHaveText("已结束");
  await expect(page.getByTestId("review-verdict")).toHaveText("Review: PASSED");
  await expect(page.getByTestId("review-findings")).toContainText("No blocking findings");
  await expect(page.getByText("Raw review data").locator("..")).not.toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "取消 Run" })).toHaveCount(0);
});

test("offers a Web-first P10-P11 acceptance workflow", async ({ page }) => {
  await mockApi(page);
  await page.goto("/acceptance");

  await expect(page.getByTestId("acceptance-guide")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Web 验收中心" })).toBeVisible();
  await expect(page.getByTestId("repository-form")).toBeVisible();
  await page.getByTestId("setup-task").locator("summary").click();
  const taskForm = page.getByTestId("task-form");
  await expect(taskForm.getByLabel("Repository")).toHaveValue(REPOSITORY_ID);
  await expect(taskForm.getByLabel("Base ref")).toHaveValue("");
  await expect(page.getByTestId("acceptance-guide")).toContainText("npm run test:p11");
});

test("creates a Task without a client-supplied commit and shows the resolved base", async ({
  page,
}) => {
  const taskBodies: unknown[] = [];
  await mockApi(page, taskBodies);
  await page.goto("/acceptance");
  await page.getByTestId("setup-task").locator("summary").click();

  const taskForm = page.getByTestId("task-form");
  await taskForm.getByLabel("标题").fill("Pinned base task");
  await taskForm.getByLabel("需求描述").fill("Resolve the immutable base on the server.");
  await taskForm.getByRole("button", { name: "创建 Task" }).click();

  await expect(page.getByTestId("task-base-ref")).toHaveText("main");
  await expect(page.getByTestId("task-base-commit")).toHaveText("aaaaaaaaaaaa");
  expect(taskBodies).toHaveLength(1);
  expect(taskBodies[0]).toMatchObject({
    repositoryId: REPOSITORY_ID,
    title: "Pinned base task",
  });
  expect(taskBodies[0]).not.toHaveProperty("baseCommit");
  expect(taskBodies[0]).not.toHaveProperty("baseCommitSha");
});

async function mockApi(page: Page, taskBodies: unknown[] = []): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === `/api/v1/runs/${RUN_ID}/events/stream`) {
      await route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders(route),
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
        body: [
          "id: 2",
          "event: RUN_FAILED",
          `data: ${JSON.stringify(failureEvent())}`,
          "",
          "id: 2",
          "event: stream-end",
          `data: ${JSON.stringify({ runId: RUN_ID, status: "FAILED", lastSequence: 2 })}`,
          "",
          "",
        ].join("\n"),
      });
      return;
    }
    if (path === `/api/v1/runs/${RUN_ID}/events`) {
      await json(route, { events: [startedEvent()], nextSequence: 1, hasMore: false });
      return;
    }
    if (path === `/api/v1/runs/${RUN_ID}/detail`) {
      await json(route, runDetail());
      return;
    }
    if (path === "/api/v1/repositories") {
      await json(route, [repository()]);
      return;
    }
    if (path === "/api/v1/tasks") {
      if (route.request().method() === "POST") {
        taskBodies.push(route.request().postDataJSON());
        await json(route, { ...taskRecord(), title: "Pinned base task" });
        return;
      }
      await json(route, [taskRecord()]);
      return;
    }
    if (path === "/api/v1/runs") {
      await json(route, [runningRun()]);
      return;
    }
    await route.fulfill({ status: 404, headers: corsHeaders(route), body: "not mocked" });
  });
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: { ...corsHeaders(route), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function corsHeaders(route: Route): Record<string, string> {
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-origin":
      route.request().headers().origin ??
      process.env.PLAYWRIGHT_BASE_URL ??
      "http://127.0.0.1:3300",
  };
}

function repository() {
  return {
    id: REPOSITORY_ID,
    name: "terminal-failure-fixture",
    sourceKind: "LOCAL",
    sourceUri: "C:/fixtures/terminal-failure",
    defaultBranch: "main",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function taskRecord() {
  return {
    id: TASK_ID,
    repositoryId: REPOSITORY_ID,
    title: "Terminal failure projection",
    description: "Project a structured terminal failure without a stale RUNNING UI.",
    status: "OPEN",
    baseRef: "main",
    baseCommitSha: "a".repeat(40),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runningRun() {
  return {
    id: RUN_ID,
    taskId: TASK_ID,
    status: "RUNNING",
    currentStage: "EXECUTE",
    maxSteps: 25,
    maxTestRetries: 3,
    maxReviewRetries: 1,
    dispatchRevision: 1,
    retryCount: 0,
    cancellationRequested: false,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
  };
}

function runDetail() {
  return {
    run: runningRun(),
    task: taskRecord(),
    repository: repository(),
    steps: [],
    toolCalls: [],
    events: [startedEvent()],
    artifacts: [
      {
        id: "review-artifact",
        runId: RUN_ID,
        kind: "REVIEW_REPORT",
        name: "review.json",
        content: JSON.stringify({
          approved: true,
          summary: "Review completed successfully.",
          findings: [{ severity: "INFO", message: "No blocking findings" }],
        }),
        createdAt: NOW,
      },
    ],
    approvals: [],
  };
}

function startedEvent() {
  return {
    schemaVersion: 1,
    eventId: "00000000-0000-4000-8000-000000000004",
    runId: RUN_ID,
    sequence: 1,
    occurredAt: NOW,
    type: "RUN_STARTED",
    level: "INFO",
    payload: { stage: "EXECUTE" },
  };
}

function failureEvent() {
  return {
    schemaVersion: 1,
    eventId: "00000000-0000-4000-8000-000000000005",
    runId: RUN_ID,
    sequence: 2,
    occurredAt: NOW,
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
}
