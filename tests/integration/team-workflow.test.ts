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
    it.each(["READ", "SEARCH", "SEARCH_TIMEOUT", "MODEL_TIMEOUT"])(
      "routes independent %s evidence into the existing Planner and PLAN approval without write authority",
      async (action) => {
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
                expect(view.resourceAvailability?.tokens).toBeGreaterThan(0);
                expect(view.resourceAvailability?.costMicros).toBeLessThan(4000000);
                if (action === "MODEL_TIMEOUT" && view.role === "INVESTIGATOR")
                  throw new DOMException("model transport deadline", "TimeoutError");
                if (action === "SEARCH_TIMEOUT" && view.role === "INVESTIGATOR")
                  database.repositoryIndexes.get = async () => {
                    throw new DOMException("read-only search deadline", "TimeoutError");
                  };
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
                          action.startsWith("SEARCH")
                            ? { type: "SEARCH", query: view.assignments[0]!.goal }
                            : {
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
            // 1080s downstream + one shared 180s Coordinator closing request leaves
            // less than 180s for investigators; their actual deadline must be fitted.
            DEVFLOW_TIMEOUT_MS: "1400000",
            DEVFLOW_MAX_COST_MICROS: "4000000",
            DEVFLOW_MODEL_PRICES_JSON: JSON.stringify({
              "openai-compatible:glm-5.3": {
                inputMicrosPerMillionTokens: 8000000,
                outputMicrosPerMillionTokens: 28000000,
              },
              "injected:injected": {
                inputMicrosPerMillionTokens: 8000000,
                outputMicrosPerMillionTokens: 28000000,
              },
            }),
            DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "60000",
            DEVFLOW_PLAN_AGENT_TIMEOUT_MS: "180000",
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
          if (action.endsWith("TIMEOUT")) {
            expect(outcome).toMatchObject({ status: "FAILED", error: { code: "TIMEOUT" } });
            const saved = (await database.teams.load(run!.id))!;
            expect(saved.operations.some((op) => op.failure?.code === "TIMEOUT")).toBe(true);
            expect(requests.some((r) => r.output?.name === "plan_proposal")).toBe(false);
            if (action === "MODEL_TIMEOUT") {
              const unknown = saved.operations.filter(
                (op) => op.kind === "MODEL" && op.status === "UNKNOWN",
              );
              expect(unknown.length).toBeGreaterThan(0);
              const ledger = (await database.budgetLedgers.get(run!.id))!.value as {
                reservations: Record<string, { status: string }>;
              };
              expect(unknown.every((op) => ledger.reservations[op.id]?.status === "ADMITTED")).toBe(
                true,
              );
            }
            return;
          }
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
            reservations: Record<
              string,
              {
                status: string;
                executionDeadlineAt?: number;
                quote: { resources: { timeMs: number } };
              }
            >;
          };
          expect(ledger.consumed.modelCalls).toBe(requests.length);
          expect(ledger.reservations["team:shared-downstream"]?.status).toBe("RELEASED");
          const investigatorDecision = state.operations.find((op) => op.kind === "MODEL" && op.agentId !== state.coordinatorId)!;
          expect(ledger.reservations[investigatorDecision.id]?.quote.resources.timeMs).toBeLessThan(
            180000,
          );
          expect(ledger.reservations[investigatorDecision.id]?.executionDeadlineAt).toBeTypeOf("number");
          const durable = (await database.budgetLedgers.get(run!.id))!.value as {
            reservations: Record<string, { quote: { dispatchGroup?: string } }>;
            violations: unknown[];
          };
          const groups = state.operations
            .filter((op) => op.kind === "MODEL" && op.agentId !== state.coordinatorId)
            .map((op) => durable.reservations[op.id]?.quote.dispatchGroup);
          expect(groups.length).toBeGreaterThanOrEqual(4);
          expect(groups.every((group) => group?.startsWith(`team:${run!.id}:wave:`))).toBe(true);
          expect(new Set(groups).size).toBe(1);
          expect(durable.violations).toEqual([]);
          expect(requests.some((r) => r.output?.name === "issue_localization")).toBe(false);
          expect(
            requests
              .filter((r) => r.output?.name === "team_decision")
              .every((r) => r.tools.length === 0),
          ).toBe(true);
        } finally {
          await database.disconnect();
        }
      },
    );
  },
);
