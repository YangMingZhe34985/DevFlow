import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FakeLanguageModel, fakeModelResponse, type ModelRequest } from "@devflow/agent";
import { PrismaDatabaseAdapter } from "@devflow/database";
import { expect, it, describe } from "vitest";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";
import { ApprovalWorkflowRunExecutor } from "../../apps/worker/src/runs/approval-workflow-run-executor.js";
import { ensureLocalRunSnapshot } from "../../apps/worker/src/runs/local-run-snapshot.js";
import type { TeamDecisionView } from "../../apps/worker/src/team/engine.js";

const exec = promisify(execFile);
describe.skipIf(process.env.DEVFLOW_RESOURCE_BUDGET_INTEGRATION !== "1")(
  "team production Coding and approval",
  () => {
    it.each(["team", "single"] as const)(
      "%s: persists investigation, approves, edits, fails validation, revises in one session and reviews",
      async (mode) => {
        await mkdir(path.resolve(".devflow"), { recursive: true });
        const fixture = await mkdtemp(path.resolve(".devflow/team-coding-"));
        const database = PrismaDatabaseAdapter.fromConnectionString(process.env.TEST_DATABASE_URL!);
        await database.connect();
        try {
          await cp(path.resolve("tests/fixtures/calculator-bug"), fixture, { recursive: true });
          const git = (args: string[]) =>
            exec("git", ["-C", fixture, ...args], { windowsHide: true });
          await git(["init"]);
          await git(["add", "."]);
          await git([
            "-c",
            "user.name=DevFlow Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "public fixture",
          ]);
          const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
          const original = await readFile(path.join(fixture, "src/calculator.js"), "utf8");
          const correct = original.replace(
            "// Intentional fixture bug: the agent should change + to -.\n  return left + right;",
            "// Intentional fixture bug: the agent should change + to -.\n  return left - right;",
          );
          expect(correct).not.toBe(original);
          const wrong = correct.replace("return left - right;", "return left - right + 1;");
          const repo = await database.repositories.create({
            name: `team-coding-${randomUUID()}`,
            sourceKind: "LOCAL",
            sourceUri: fixture,
          });
          const task = await database.tasks.create({
            repositoryId: repo.id,
            title: "Correct subtract",
            description: "subtract must return the difference, preserve add and all public tests.",
            baseCommitSha: base,
          });
          const created = await database.runs.create({
            taskId: task.id,
            executionMode: mode,
            maxSteps: 32,
            maxTestRetries: 2,
            maxReviewRetries: 1,
          });
          const owner = randomUUID();
          let run = (await database.runs.claim(created.run.id, owner, 240000))!;
          const signal = AbortSignal.timeout(180000);
          await ensureLocalRunSnapshot(database, run, signal);
          let codingTurns = 0,
            reviewCalls = 0;
          const seen = new Set<string>();
          const respond = async (request: ModelRequest) => {
            if (request.output?.name === "team_decision") {
              const view = JSON.parse(
                request.messages.find((m) => m.role === "USER")!.content as string,
              ) as TeamDecisionView;
              const currentTasks = view.board.filter((t) => t.current);
              const actions =
                view.role !== "INVESTIGATOR"
                  ? mode === "single" || currentTasks.length
                    ? [
                        {
                          type: "PROPOSE_PLAN",
                          evidenceIds: view.evidence
                            .filter((e) => e.kind === "SOURCE_OBSERVATION")
                            .map((e) => e.id),
                          missing: [],
                        },
                      ]
                    : [
                        {
                          type: "DELEGATE",
                          key: view.feedback?.id ?? "subtract-implementation",
                          goal: "Read arithmetic implementation and check public behavior",
                          evidenceIds: [],
                          dependsOn: [],
                        },
                      ]
                  : !seen.has(view.assignments[0]!.id)
                    ? (seen.add(view.assignments[0]!.id),
                      [{ type: "READ", path: "src/calculator.js", startLine: 1, endLine: 20 }])
                    : [
                        {
                          type: "RESULT",
                          evidenceIds: view.evidence
                            .filter((e) => e.kind === "SOURCE_OBSERVATION")
                            .map((e) => e.id),
                          hypotheses: ["subtract adds instead of subtracting"],
                          missing: [],
                        },
                      ];
              return fakeModelResponse({
                toolCalls: [],
                output: { summary: "Inspect public arithmetic", actions },
                usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
              });
            }
            if (request.output?.name === "plan_proposal") {
              if (mode === "single")
                expect(JSON.stringify(request.messages)).toContain("priorSolverSession");
              return fakeModelResponse({
                toolCalls: [],
                output: {
                  decision: "PROPOSE",
                  goal: "Fix subtraction",
                  approach: ["Change subtraction only; run public checks"],
                  candidateFiles: [
                    {
                      path: "src/calculator.js",
                      intent: "EDIT",
                      operation: "MODIFY",
                      reason: "Observed arithmetic conflicts with difference",
                    },
                    {
                      path: "test/calculator.test.js",
                      intent: "INSPECT",
                      reason: "Public behavior assertions",
                    },
                  ],
                  verification: ["npm test"],
                  uncertainties: [],
                },
                usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
              });
            }
            codingTurns++;
            const call = (name: string, input: unknown) => ({
              id: `${codingTurns}-${name}`,
              name,
              input,
            });
            if (mode === "team" && codingTurns === 1)
              return fakeModelResponse({
                toolCalls: [
                  call("locateIssue", {
                    query:
                      "subtract implementation and public arithmetic assertions before editing",
                  }),
                ],
              });
            // Team returned the same approved source: another identical read is not progress.
            const n = codingTurns;
            if (mode === "single" && n === 1)
              expect(JSON.stringify(request.messages)).toContain("existing solver session");
            if (n === 1 || n === 3)
              return fakeModelResponse({
                toolCalls: [call("readFile", { path: "src/calculator.js", maxBytes: 4096 })],
              });
            if (n === 2 || n === 4) {
              if (n === 4) expect(JSON.stringify(request.messages)).toContain("TEST_REPAIR");
              return fakeModelResponse({
                toolCalls: [
                  call("writeFile", {
                    path: "src/calculator.js",
                    content: n === 2 ? wrong : correct,
                  }),
                  call("finishPhase", {
                    outcome: "CHANGED",
                    summary: "Submit candidate for host public validation",
                  }),
                ],
                usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
              });
            }
            throw new Error(
              `Unexpected coding turn ${codingTurns}: ${JSON.stringify(request.messages).slice(-3000)}`,
            );
          };
          const model = new FakeLanguageModel(Array.from({ length: 32 }, () => respond));
          const reviewer = new FakeLanguageModel([
            () => {
              reviewCalls++;
              return fakeModelResponse({
                toolCalls: [],
                output: {
                  verdict: "PASS",
                  summary: "Tested subtraction corrected; add preserved",
                  issues: [],
                },
              });
            },
          ]);
          const env = loadWorkerEnvironment({
            DATABASE_URL: process.env.TEST_DATABASE_URL!,
            DEVFLOW_TEAM_ENABLED: "true",
            DEVFLOW_TIMEOUT_MS: "1500000",
            DEVFLOW_MAX_TOTAL_TOKENS: "320000",
            DEVFLOW_MAX_TOOL_CALLS: "75",
            DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "60000",
            DEVFLOW_MAX_RETRIES: "0",
            DEVFLOW_CONTEXT_COMPRESSION_ENABLED: "false",
            LLM_PROVIDER: "openai-compatible",
            LLM_MODEL: "glm-5.3",
            LLM_API_KEY: "offline",
            LLM_BASE_URL: "https://provider.invalid/v1",
            LLM_STRUCTURED_OUTPUT_MODE: "json-object",
          });
          const worker = new ApprovalWorkflowRunExecutor(
            database,
            env,
            () => model,
            () => reviewer,
          );
          const planned = await worker.execute(run, signal);
          expect(planned.status, JSON.stringify(planned)).toBe("WAITING_APPROVAL");
          if (planned.status !== "WAITING_APPROVAL" || planned.approvalKind === "GITHUB")
            throw new Error("Expected PLAN");
          const approval = await database.runs.pauseForApproval(run.id, owner, planned.plan);
          await database.approvals.resolveForWorkflow(approval.approval.id, { status: "APPROVED" });
          run = (await database.runs.claim(run.id, owner, 240000))!;
          const completed = await worker.execute(run, signal);
          const failureState =
            completed.status === "SUCCEEDED"
              ? undefined
              : (await database.artifacts.list(run.id)).findLast(
                  (a) => a.name === "coding-session-v1.json",
                )?.content;
          expect(
            completed.status,
            JSON.stringify({
              completed,
              tools: failureState
                ? JSON.parse(failureState).state.messages.filter(
                    (m: { role: string }) => m.role === "TOOL",
                  )
                : undefined,
            }),
          ).toBe("SUCCEEDED");
          expect(reviewCalls).toBe(1);
          const snapshots = (await database.artifacts.list(run.id))
            .filter((a) => a.name === "coding-session-v1.json")
            .map((a) => JSON.parse(a.content!).state);
          expect(snapshots.at(-1).stepCount).toBeGreaterThan(3);
          expect(new Set(snapshots.map((s) => s.startedAt)).size).toBe(1);
          const team = (await database.teams.load(run.id))!;
          if (mode === "team") expect(team.viewTransitions).toHaveLength(1);
          else expect(snapshots.every((s) => s.sessionId === team.agents[0]!.sessionId)).toBe(true);
          const ledger = (await database.budgetLedgers.get(run.id))!.value as {
            consumed: { modelCalls: number; steps: number };
            limits: { steps: number; tokens: number };
          };
          expect(ledger.consumed.modelCalls).toBe(model.requests.length + reviewer.requests.length);
          expect(ledger.limits).toMatchObject({ steps: 32, tokens: 320000 });
          expect(await readFile(path.join(fixture, "src/calculator.js"), "utf8")).toBe(original);
        } finally {
          await database.disconnect();
          if (
            path.dirname(fixture) === path.resolve(".devflow") &&
            path.basename(fixture).startsWith("team-coding-")
          )
            await rm(fixture, { recursive: true, force: true });
        }
      },
      180000,
    );
  },
);
