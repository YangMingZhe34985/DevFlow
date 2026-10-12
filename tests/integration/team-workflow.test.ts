import { randomUUID, createHash } from "node:crypto";
import { PrismaDatabaseAdapter } from "@devflow/database";
import { FakeLanguageModel, fakeModelResponse, type ModelRequest } from "@devflow/agent";
import {
  encodeLocalRepositorySnapshot,
  LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
} from "@devflow/sandbox";
import { describe, expect, it } from "vitest";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";
import { ApprovalWorkflowRunExecutor } from "../../apps/worker/src/runs/approval-workflow-run-executor.js";
import type { TeamDecisionView } from "../../apps/worker/src/team/engine.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const base = "a".repeat(40);
const files = {
  "calculator.ts": "export function add(a: number,b: number) { return a-b; }\n",
  "consumer.ts": "import { add } from './calculator.js';\nexport const total = add(2,3);\n",
  "test.ts":
    "import { add } from './calculator.js';\nif(add(2,3)!==5) throw new Error('addition');\n",
};

describe.skipIf(process.env.DEVFLOW_RESOURCE_BUDGET_INTEGRATION !== "1")(
  "production Worker team planning",
  () => {
    it("routes independent team evidence into the existing Planner and PLAN approval without write authority", async () => {
      const database = PrismaDatabaseAdapter.fromConnectionString(process.env.TEST_DATABASE_URL!);
      await database.connect();
      try {
        const repo = await database.repositories.create({
          name: `team-worker-${randomUUID()}`,
          sourceKind: "LOCAL",
          sourceUri: "file:///public-fixture",
        });
        const task = await database.tasks.create({
          repositoryId: repo.id,
          title: "addition returns subtraction",
          description:
            "add(2,3) should return 5; preserve negative numbers and the total consumer.",
          baseCommitSha: base,
        });
        const entries = Object.entries(files).map(([path, content]) => ({
          kind: "FILE" as const,
          path,
          mode: 0o644,
          sizeBytes: Buffer.byteLength(content),
          sha256: hash(content),
          contentBase64: Buffer.from(content).toString("base64"),
        }));
        const encoded = encodeLocalRepositorySnapshot({
          version: 1,
          sourceHead: base,
          files: entries,
          totalBytes: entries.reduce((n, f) => n + f.sizeBytes, 0),
        });
        const created = await database.runs.create({
          taskId: task.id,
          executionMode: "team",
          maxSteps: 32,
          initialArtifact: {
            kind: "OTHER",
            name: LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
            mimeType: "application/json",
            content: encoded,
            sha256: hash(encoded),
            sizeBytes: Buffer.byteLength(encoded),
          },
        });
        const run = await database.runs.claim(created.run.id, "team-test", 60_000);
        const requests: ModelRequest[] = [];
        const model: FakeLanguageModel = new FakeLanguageModel(
          Array.from({ length: 16 }, () => async (request: ModelRequest) => {
            requests.push(request);
            if (request.output?.name === "team_decision") {
              const view = JSON.parse(
                request.messages.find((m) => m.role === "USER")!.content as string,
              ) as TeamDecisionView;
              const actions =
                view.role === "COORDINATOR"
                  ? view.board.length
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
                          key: "implementation",
                          goal: "Trace addition implementation",
                          evidenceIds: [],
                          dependsOn: [],
                        },
                        {
                          type: "DELEGATE",
                          key: "consumer",
                          goal: "Check total consumer and counterevidence",
                          evidenceIds: [],
                          dependsOn: [],
                        },
                      ]
                  : !view.history.length
                    ? [
                        {
                          type: "READ",
                          path: view.assignments[0]!.goal.includes("consumer")
                            ? "consumer.ts"
                            : "calculator.ts",
                          startLine: 1,
                          endLine: 2,
                        },
                      ]
                    : [
                        {
                          type: "RESULT",
                          evidenceIds: view.evidence.map((e) => e.id),
                          hypotheses: ["subtraction conflicts with the public expected sum"],
                          missing: [],
                        },
                      ];
              return fakeModelResponse({
                toolCalls: [],
                output: { summary: "Investigate observed behavior", actions },
                usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
                latencyMs: 1,
              });
            }
            expect(request.output?.name).toBe("plan_proposal");
            const prompt = JSON.stringify(request.messages);
            expect(prompt).toContain("return a-b");
            expect(prompt).toContain("total = add");
            return fakeModelResponse({
              toolCalls: [],
              output: {
                decision: "PROPOSE",
                goal: "Use addition while preserving consumers",
                approach: ["Replace subtraction with addition"],
                candidateFiles: [
                  {
                    path: "calculator.ts",
                    intent: "EDIT",
                    operation: "MODIFY",
                    reason: "Public addition fails",
                  },
                  { path: "test.ts", intent: "INSPECT", reason: "Confirm public assertion" },
                ],
                verification: ["Run public test"],
                uncertainties: [],
              },
              usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
              latencyMs: 1,
            });
          }),
        );
        const environment = loadWorkerEnvironment({
          DATABASE_URL: process.env.TEST_DATABASE_URL!,
          DEVFLOW_TEAM_ENABLED: "true",
          DEVFLOW_MAX_TOTAL_TOKENS: "320000",
          DEVFLOW_MAX_TOOL_CALLS: "75",
          DEVFLOW_TIMEOUT_MS: "1500000",
          DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "60000",
          LLM_PROVIDER: "openai-compatible",
          LLM_MODEL: "glm-5.3",
          LLM_API_KEY: "offline-test",
          LLM_BASE_URL: "https://provider.invalid/v1",
          LLM_STRUCTURED_OUTPUT_MODE: "json-object",
        });
        const outcome = await new ApprovalWorkflowRunExecutor(
          database,
          environment,
          () => model,
        ).execute(run!, AbortSignal.timeout(30000));
        expect(
          outcome,
          JSON.stringify({
            outcome,
            errors: (await database.teams.load(run!.id))?.operations
              .filter((o) => o.error)
              .map((o) => o.error),
          }),
        ).toMatchObject({ status: "WAITING_APPROVAL", approvalKind: "PLAN" });
        const state = (await database.teams.load(run!.id))!;
        expect(state.status).toBe("READY_FOR_PLAN");
        expect(state.agents.filter((a) => a.role === "INVESTIGATOR")).toHaveLength(2);
        expect(
          state.operations
            .filter((o) => o.kind === "MODEL")
            .every((o) => o.status === "COMPLETED" && o.applied),
        ).toBe(true);
        const ledger = (await database.budgetLedgers.get(run!.id))!.value as {
          consumed: { modelCalls: number };
          reservations: Record<string, { status: string }>;
        };
        expect(ledger.consumed.modelCalls).toBe(requests.length);
        expect(ledger.reservations["team:shared-downstream"]?.status).toBe("RELEASED");
        expect(requests.some((r) => r.output?.name === "issue_localization")).toBe(false);
        expect(
          requests
            .filter((r) => r.output?.name === "team_decision")
            .every((r) => r.tools.length === 0),
        ).toBe(true);
      } finally {
        await database.disconnect();
      }
    });
  },
);
