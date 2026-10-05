import { randomUUID } from "node:crypto";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeLanguageModel, fakeModelResponse, type ModelRequest } from "@devflow/agent";
import {
  IssueLocalizationAgent,
  localizationRanges,
} from "../src/localization/issue-localization-agent.js";
import { IssueLocalizer } from "../src/localization/retrieval.js";
import { hash, type EvidencePack, type IndexSource } from "../src/localization/contracts.js";

const signal = new AbortController().signal;
const response = (value: unknown) =>
  fakeModelResponse({
    text: JSON.stringify(value),
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
const decision = (overrides: Record<string, unknown> = {}) => ({
  summary: "Inspect behavior using actual repository evidence",
  hypotheses: [],
  inspect: [],
  candidates: [],
  uncertainty: [],
  ...overrides,
});
function memorySource(files: Record<string, string>): IndexSource {
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    contentHash: hash(content),
    kind: "FILE" as const,
    sizeBytes: Buffer.byteLength(content),
  }));
  return {
    identity: randomUUID(),
    fileCount: entries.length,
    lookup: async (path) => entries.find((e) => e.path === path),
    manifest: async () => ({ entries, incomplete: false }),
    read: vi.fn(async (path: string) => {
      if (!(path in files)) throw new Error("missing");
      return { content: files[path]!, truncated: false };
    }),
  };
}
function run(source: IndexSource, model: FakeLanguageModel, evidence?: EvidencePack) {
  const localizer = new IssueLocalizer();
  return new IssueLocalizationAgent().run({
    title: "Defaults disappear",
    description:
      "When I export a description of my data, zero, empty text and disabled defaults disappear, but enabled defaults are kept.",
    repositoryId: "repo",
    baseCommitSha: "base",
    source,
    model,
    signal,
    maxTokens: 18000,
    ...(evidence ? { evidence } : {}),
    retrieve: (description, current, querySignal) =>
      localizer.retrieve({
        repositoryId: "repo",
        accessScope: "repo",
        baseCommitSha: "base",
        runId: "run",
        workspaceRevision: 0,
        description,
        source: current,
        signal: querySignal,
        tokenBudget: 6000,
      }),
  });
}
const state = (r: ModelRequest) => JSON.parse(String(r.messages[1]!.content));

describe("read-only semantic Issue localization", () => {
  it("normalizes the recorded 200-line request and exposes actual bounds without losing source identity", async () => {
    const path = "packages/zod/src/v4/core/schemas.ts";
    const text = Array.from({ length: 220 }, (_, i) => `// source line ${i + 1}`).join("\n");
    const source = memorySource({ [path]: text });
    const model = new FakeLanguageModel([
      response(
        decision({
          inspect: [{ path, startLine: 1, endLine: 200, reason: "Recorded #5296 range" }],
        }),
      ),
      (request) => {
        const current = state(request);
        expect(current.readLimits).toMatchObject({
          maxLines: 80,
          maxSnippetBytes: 4096,
          maxReadAttempts: 6,
        });
        expect(current.remaining).toMatchObject({ reads: 2, readAttempts: 5 });
        expect(current.observations.join(" ")).toContain("observed=1-80");
        const evidence = current.evidence[0];
        expect(evidence).toMatchObject({
          startLine: 1,
          endLine: 80,
          contentHash: hash(text),
          truncated: true,
        });
        return response(
          decision({
            candidates: [{ evidenceId: evidence.id, explanation: "Verified bounded source" }],
          }),
        );
      },
    ]);
    const result = await run(source, model);
    expect(result.metrics).toMatchObject({
      reads: 1,
      readAttempts: 1,
      readBytes: 2 * Buffer.byteLength(text),
    });
    expect(result.candidates[0]).toMatchObject({
      startLine: 1,
      endLine: 80,
      contentHash: hash(text),
    });
    expect(result.candidates[0]?.snippet).not.toContain("source line 81");
  });

  it("clips by UTF-8 bytes at complete lines and explicitly reports a partial requested range", async () => {
    const path = "src/unicode.ts";
    const text = Array.from({ length: 90 }, () => "// " + "字".repeat(100)).join("\n");
    const source = memorySource({ [path]: text });
    const model = new FakeLanguageModel([
      response(
        decision({
          inspect: [{ path, startLine: 1, endLine: 80, reason: "Inspect multibyte text" }],
        }),
      ),
      (request) => {
        const evidence = state(request).evidence[0];
        expect(evidence.endLine).toBe(13);
        return response(
          decision({
            candidates: [{ evidenceId: evidence.id, explanation: "Only these lines observed" }],
          }),
        );
      },
    ]);
    const result = await run(source, model);
    expect(Buffer.byteLength(result.candidates[0]!.snippet)).toBeLessThanOrEqual(4096);
    expect(result.candidates[0]!.snippet.split("\n")).toHaveLength(13);
    expect(result.observations.join(" ")).toContain("observed=1-13");
  });

  it("does not charge invalid parameters as source IO and preserves a later valid read", async () => {
    const path = "src/a.ts";
    const source = memorySource({ [path]: "export const a = 1;" });
    const onInspect = vi.fn();
    const model = new FakeLanguageModel([
      response(
        decision({
          inspect: [
            { path: "../secret", startLine: 1, endLine: 1, reason: "Forbidden" },
            { path: "missing.ts", startLine: 1, endLine: 1, reason: "Missing" },
            { path, startLine: 2, endLine: 1, reason: "Reversed range" },
          ],
        }),
      ),
      (request) => {
        expect(state(request).remaining).toMatchObject({ reads: 3, readAttempts: 3 });
        expect(state(request).observations.join(" ")).toMatch(
          /READ_EXCLUDED.*READ_SOURCE_UNAVAILABLE.*READ_INVALID_RANGE/,
        );
        return response(
          decision({ inspect: [{ path, startLine: 1, endLine: 1, reason: "Valid correction" }] }),
        );
      },
      (request) =>
        response(
          decision({
            candidates: [{ evidenceId: state(request).evidence[0].id, explanation: "Observed" }],
          }),
        ),
    ]);
    const result = await new IssueLocalizationAgent().run({
      title: "bug",
      description: "bug",
      repositoryId: "repo",
      baseCommitSha: "base",
      source,
      model,
      signal,
      maxTokens: 18000,
      onInspect,
      retrieve: async () => undefined,
    });
    expect(result.metrics).toMatchObject({ reads: 1, readAttempts: 4 });
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(result.candidates[0]?.path).toBe(path);
  });

  it("announces FINAL-only mode and reports an unexecutable last-round action", async () => {
    const source = memorySource({ "src/a.ts": "export const a = 1;" });
    const model = new FakeLanguageModel([
      response(decision({ candidates: [{ evidenceId: "absent", explanation: "Need evidence" }] })),
      response(decision({ candidates: [{ evidenceId: "absent", explanation: "Still missing" }] })),
      (request) => {
        expect(state(request)).toMatchObject({
          mode: "FINAL",
          canInspect: false,
          remaining: { reads: 0, searches: 0, readAttempts: 0 },
        });
        return response(
          decision({
            inspect: [{ path: "src/a.ts", startLine: 1, endLine: 1, reason: "Too late" }],
          }),
        );
      },
    ]);
    const result = await run(source, model);
    expect(source.read).not.toHaveBeenCalled();
    expect(result.observations.join(" ")).toContain("FINAL_ROUND");
    expect(result.uncertainty.join(" ")).toContain("not executed");
  });

  it("bounds invalid attempts and rejects stale reads without manufacturing evidence", async () => {
    const path = "src/a.ts",
      source = memorySource({ [path]: "export const a = 1;" });
    source.read = vi.fn(async () => ({ content: "export const a = 2;", truncated: false }));
    const model = new FakeLanguageModel([
      response(decision({ inspect: [{ path, startLine: 1, endLine: 200, reason: "Stale" }] })),
      response(decision()),
    ]);
    const result = await run(source, model);
    expect(result.metrics).toMatchObject({ reads: 1, readAttempts: 1 });
    expect(result.observations.join(" ")).toContain("READ_SOURCE_STALE");
    expect(result.candidates).toEqual([]);
  });

  it("labels an agent-directed read of an adjacent test.ts as a test", async () => {
    const path = "src/roundToNearestMinutes/test.ts";
    const source = memorySource({ [path]: "export const regression=1;\n" });
    const model = new FakeLanguageModel([
      response(
        decision({
          inspect: [{ path, startLine: 1, endLine: 1, reason: "Read the regression test" }],
        }),
      ),
      (request) => {
        const evidence = state(request).evidence.find((e: { path: string }) => e.path === path);
        expect(evidence).toMatchObject({ path, fileType: "TEST" });
        return response(
          decision({
            candidates: [
              { evidenceId: evidence.id, explanation: "Regression test for investigation" },
            ],
          }),
        );
      },
    ]);
    expect((await run(source, model)).candidates[0]?.path).toBe(path);
  });

  it("grounds a path-free natural language issue through semantic search and actual evidence IDs", async () => {
    const path = `src/${randomUUID()}.ts`;
    const source = memorySource({
      [path]:
        "export function describeData(defaultValue: unknown) {\n  const description: Record<string, unknown> = {};\n  if (defaultValue) description.default = defaultValue;\n  return description;\n}\n",
      "src/unrelated.ts": "export const network = true;\n",
    });
    const model = new FakeLanguageModel([
      (request) => {
        expect(JSON.stringify(request.messages)).not.toContain(path);
        expect(request.tools).toEqual([]);
        return response(
          decision({
            hypotheses: [
              {
                explanation:
                  "Falsy values may be dropped by a truthiness guard during description export",
                query: "defaultValue description default",
              },
            ],
          }),
        );
      },
      (request) => {
        const evidence = state(request).evidence.find((e: { snippet: string }) =>
          e.snippet.includes("description"),
        );
        expect(evidence).toBeDefined();
        return response(
          decision({
            inspect: [
              {
                path: evidence.path,
                startLine: 1,
                endLine: 5,
                reason: "Read the surrounding declaration to check the guard and return",
              },
            ],
          }),
        );
      },
      (request) => {
        const evidence = state(request).evidence.find((e: { snippet: string }) =>
          e.snippet.includes("if (defaultValue)"),
        );
        expect(evidence).toBeDefined();
        return response(
          decision({
            candidates: [
              {
                evidenceId: evidence.id,
                explanation: "Current guard discards zero/empty/disabled values",
              },
            ],
            uncertainty: ["Behavior has not yet been reproduced by a test"],
          }),
        );
      },
    ]);
    const result = await run(source, model);
    expect(result.status).toBe("CANDIDATES");
    expect(result.candidates[0]).toMatchObject({
      path,
      contentHash: hash((await source.read(path, signal)).content),
    });
    expect(result.candidates[0]!.snippet).toContain("if (defaultValue)");
    expect(result.metrics).toMatchObject({ modelCalls: 3, totalTokens: 450, searches: 1 });
    expect(model.requests.every((r) => r.settings?.maxOutputTokens === 4096)).toBe(true);
  });

  it("can inspect a real helper and retains uncertainty instead of granting edits", async () => {
    const source = memorySource({
      "src/entry.ts":
        'import { prepare } from "./helper.js";\nexport function build(value: unknown) { return prepare(value); }\n',
      "src/helper.ts": "export function prepare(value: unknown) {\n  return value || 1;\n}\n",
    });
    const evidence = await new IssueLocalizer().retrieve({
      repositoryId: "repo",
      accessScope: "repo",
      baseCommitSha: "base",
      runId: "seed",
      workspaceRevision: 0,
      description: "src/entry.ts build()",
      source,
      signal,
    });
    const model = new FakeLanguageModel([
      response(
        decision({
          inspect: [
            {
              path: "src/helper.ts",
              startLine: 1,
              endLine: 3,
              reason: "Inspect the helper imported by the caller",
            },
          ],
        }),
      ),
      (request) => {
        const helper = state(request).evidence.find(
          (e: { path: string }) => e.path === "src/helper.ts",
        );
        return response(
          decision({
            candidates: [{ evidenceId: helper.id, explanation: "Fallback replaces falsy input" }],
            uncertainty: ["Need an original reproducer"],
          }),
        );
      },
    ]);
    const result = await run(source, model, evidence);
    expect(result.candidates[0]!.path).toBe("src/helper.ts");
    expect(result.metrics.reads).toBe(1);
    expect(result).not.toHaveProperty("editTargets");
  });

  it("rejects invented candidates and forbidden or missing paths, then allows bounded correction", async () => {
    const source = memorySource({ "src/a.ts": "export const truth = true;\n" });
    const result = await run(
      source,
      new FakeLanguageModel([
        response(
          decision({
            candidates: [{ evidenceId: "imaginary", explanation: "Guess" }],
            inspect: [
              { path: "../secret", startLine: 1, endLine: 1, reason: "bad" },
              { path: "missing.ts", startLine: 1, endLine: 1, reason: "guess" },
            ],
          }),
        ),
        (request) => {
          expect(state(request).observations.join(" ")).toContain("Rejected");
          return response(decision({ uncertainty: ["Insufficient repository evidence"] }));
        },
      ]),
    );
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.candidates).toEqual([]);
    expect(source.read).not.toHaveBeenCalled();
    expect(result.metrics.modelCalls).toBe(2);
  });

  it("rejects stale source and retains the source identity on persisted hints", async () => {
    const source = memorySource({ "src/a.ts": "export function thing() { return 1; }\n" });
    const pack = await new IssueLocalizer().retrieve({
      repositoryId: "repo",
      accessScope: "repo",
      baseCommitSha: "base",
      runId: "seed",
      workspaceRevision: 0,
      description: "src/a.ts thing()",
      source,
      signal,
    });
    source.read = async () => ({
      content: "export function thing() { return 2; }\n",
      truncated: false,
    });
    const result = await run(
      source,
      new FakeLanguageModel([
        (request) =>
          response(
            decision({
              candidates: [{ evidenceId: state(request).evidence[0].id, explanation: "Candidate" }],
            }),
          ),
        response(decision()),
      ]),
      pack,
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.observations.join(" ")).toContain("stale");
    expect(
      localizationRanges(JSON.stringify({ ...result, baseCommitSha: "other" }), "base"),
    ).toEqual([]);
  });

  it("bounds repeat searches and model calls even when the model keeps requesting exploration", async () => {
    const source = memorySource({ "src/a.ts": "export const x = 1;\n" });
    const model = new FakeLanguageModel(
      Array.from({ length: 3 }, () =>
        response(
          decision({
            hypotheses: [{ explanation: "Try semantic alternative", query: "something missing" }],
            candidates: [{ evidenceId: "unknown", explanation: "guess" }],
          }),
        ),
      ),
    );
    const result = await run(source, model);
    expect(result.metrics).toMatchObject({ searches: 1, modelCalls: 3 });
    expect(result.status).toBe("INCONCLUSIVE");
  });

  it("does not send a request when the localization token budget cannot afford it", async () => {
    const source = memorySource({});
    const model = new FakeLanguageModel([]);
    await expect(
      new IssueLocalizationAgent().run({
        title: "bug",
        description: "bug",
        repositoryId: "repo",
        baseCommitSha: "base",
        source,
        model,
        signal,
        maxTokens: 100,
        retrieve: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_EVIDENCE" });
    expect(model.requests).toHaveLength(0);
  });

  it("uses the configured ceiling and shrinks it to the remaining shared budget", async () => {
    const model = new FakeLanguageModel([response(decision())]);
    await new IssueLocalizationAgent().run({
      title: "bug",
      description: "bug",
      repositoryId: "repo",
      baseCommitSha: "base",
      source: memorySource({}),
      model,
      signal,
      maxTokens: 3000,
      maxOutputTokens: 8192,
      retrieve: async () => undefined,
    });
    const actual = model.requests[0]!;
    const estimated = Math.ceil(
      Buffer.byteLength(
        JSON.stringify({
          messages: actual.messages,
          schema: z.toJSONSchema(actual.output!.schema),
        }),
      ) / 3,
    );
    expect(actual.settings?.maxOutputTokens).toBe(3000 - estimated);
    expect(actual.settings!.maxOutputTokens).toBeGreaterThan(0);
  });

  it("accounts for a LENGTH/empty response and one semantic regeneration", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        text: "",
        toolCalls: [],
        finishReason: "LENGTH",
        usage: { inputTokens: 100, outputTokens: 4096, totalTokens: 4196 },
        reasoningTokens: 4096,
      }),
      response(decision()),
    ]);
    const onResponse = vi.fn();
    const result = await new IssueLocalizationAgent().run({
      title: "bug",
      description: "bug",
      repositoryId: "repo",
      baseCommitSha: "base",
      source: memorySource({}),
      model,
      signal,
      maxTokens: 18000,
      maxOutputTokens: 4096,
      onResponse,
      retrieve: async () => undefined,
    });
    expect(result.metrics).toMatchObject({ modelCalls: 2, totalTokens: 4346 });
    expect(model.requests[0]?.settings).toEqual({ maxOutputTokens: 4096 });
    expect(model.requests[1]?.settings).toEqual({ reasoningEffort: "none", maxOutputTokens: 4096 });
    expect(onResponse).toHaveBeenCalledTimes(2);
    expect(result.observations.join(" ")).toContain("LENGTH");
  });

  it("does not pay for regeneration when the first response exhausts the token budget", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        text: "",
        toolCalls: [],
        finishReason: "LENGTH",
        usage: { inputTokens: 400, outputTokens: 4096, totalTokens: 4496 },
      }),
    ]);
    await expect(
      new IssueLocalizationAgent().run({
        title: "bug",
        description: "bug",
        repositoryId: "repo",
        baseCommitSha: "base",
        source: memorySource({}),
        model,
        signal,
        maxTokens: 4496,
        maxOutputTokens: 4096,
        retrieve: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_EVIDENCE",
      details: { requestIssued: false, modelCalls: 1 },
    });
    expect(model.requests).toHaveLength(1);
  });

  it("hands off valid uncertainty when later exploration cannot fit, without inventing candidates", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        text: JSON.stringify(
          decision({
            hypotheses: [{ explanation: "Need source evidence", query: "defaultValue" }],
          }),
        ),
        toolCalls: [],
        usage: { inputTokens: 1200, outputTokens: 1000, totalTokens: 2200 },
      }),
    ]);
    const result = await new IssueLocalizationAgent().run({
      title: "bug",
      description: "bug",
      repositoryId: "repo",
      baseCommitSha: "base",
      source: memorySource({}),
      model,
      signal,
      maxTokens: 2300,
      maxOutputTokens: 4096,
      retrieve: async () => undefined,
    });
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.candidates).toEqual([]);
    expect(result.uncertainty.join(" ")).toContain("Planner must verify");
    expect(result.metrics).toMatchObject({ modelCalls: 1, totalTokens: 2200 });
    expect(model.requests).toHaveLength(1);
  });

  it("allows only one LENGTH regeneration across localization rounds", async () => {
    const truncated = () =>
      fakeModelResponse({
        text: "",
        toolCalls: [],
        finishReason: "LENGTH",
        usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
      });
    const model = new FakeLanguageModel([
      truncated(),
      response(
        decision({
          hypotheses: [{ explanation: "Find evidence", query: "defaultValue" }],
        }),
      ),
      truncated(),
    ]);
    await expect(run(memorySource({}), model)).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
    });
    expect(model.requests).toHaveLength(3);
  });
});

it("Worker passes verified localization into PLAN and accounts for its model decisions", async () => {
  const { ApprovalWorkflowRunExecutor } =
    await import("../src/runs/approval-workflow-run-executor.js");
  const { loadWorkerEnvironment } = await import("../src/config/env.js");
  const { encodeLocalRepositorySnapshot, LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME } =
    await import("@devflow/sandbox");
  const filePath = `src/${randomUUID()}.ts`;
  const code =
    "export function describeData(defaultValue: unknown) {\n  const description: Record<string, unknown> = {};\n  if (defaultValue) description.default = defaultValue;\n  return description;\n}\n";
  const baseCommitSha = "a".repeat(40);
  const artifacts: { id?: string; kind: string; name: string; content: string }[] = [
    {
      kind: "OTHER",
      name: LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
      content: encodeLocalRepositorySnapshot({
        version: 1,
        sourceHead: baseCommitSha,
        totalBytes: Buffer.byteLength(code),
        files: [
          {
            path: filePath,
            kind: "FILE",
            mode: 0o644,
            sizeBytes: Buffer.byteLength(code),
            sha256: hash(code),
            contentBase64: Buffer.from(code).toString("base64"),
          },
        ],
      }),
    },
  ];
  const events: { type: string; payload?: unknown }[] = [];
  const database = {
    artifacts: {
      list: async () => artifacts,
      create: async (a: { kind: string; name: string; content: string }) => {
        const artifact = { ...a, id: randomUUID() };
        artifacts.push(artifact);
        return artifact;
      },
    },
    events: {
      list: async () => events,
      append: async (event: { type: string; payload?: unknown }) => {
        events.push(event);
      },
    },
    approvals: { list: async () => [] },
    runs: { transition: async () => undefined },
  } as unknown as DatabaseAdapter;
  const model = new FakeLanguageModel([
    (request) => {
      const candidate = state(request).evidence[0];
      expect(candidate).toBeDefined();
      return response(
        decision({
          inspect: [
            {
              path: candidate.path,
              startLine: 1,
              endLine: 5,
              reason: "Check the behavior around the exported description",
            },
          ],
        }),
      );
    },
    (request) => {
      const candidate = state(request).evidence.find((e: { snippet: string }) =>
        e.snippet.includes("if (defaultValue)"),
      );
      return response(
        decision({
          candidates: [
            { evidenceId: candidate.id, explanation: "Truthiness guard drops falsy defaults" },
          ],
          uncertainty: ["Reproduction required"],
        }),
      );
    },
    (request) => {
      expect(request.output?.name).toBe("plan_proposal");
      return response({
        decision: "PROPOSE",
        goal: "Preserve falsy defaults",
        approach: ["Repair observed truthiness guard"],
        candidateFiles: [{ path: filePath, intent: "EDIT", reason: "Observed guard" }],
        verification: ["Check explicit falsy defaults"],
        uncertainties: [],
      });
    },
    (request) => {
      expect(JSON.stringify(request.messages)).toContain("Truthiness guard drops falsy defaults");
      expect(JSON.stringify(request.messages)).toContain(filePath);
      expect(request.output?.name).toBe("agent_plan");
      return response({
        summary: "Preserve falsy defaults",
        steps: [
          {
            id: "fix",
            title: "Fix guard",
            description: "Use the verified source and add behavior coverage",
          },
        ],
        complexity: "SIMPLE",
        estimatedSteps: 4,
        confidence: 0.8,
        executionContract: {
          version: "execution-contract-v1",
          editTargets: [
            {
              path: filePath,
              symbol: "describeData",
              operation: "MODIFY",
              rationale: "Repair observed truthiness guard",
            },
          ],
          inspectTargets: [],
          verificationHints: [],
          unresolvedQuestions: [],
        },
        behaviorAudit: {
          constraints: [],
          uncertainties: [
            "No public behavior test is supplied; validate explicit falsy defaults after approval.",
          ],
        },
      });
    },
  ]);
  const worker = new ApprovalWorkflowRunExecutor(
    database,
    loadWorkerEnvironment({
      DATABASE_URL: "unused",
      DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "24000",
    }),
    () => model,
  );
  const result = await worker.execute(
    {
      id: randomUUID(),
      status: "RUNNING",
      currentStage: "START",
      retryCount: 0,
      maxSteps: 12,
      maxTestRetries: 1,
      maxReviewRetries: 1,
      task: {
        title: "Default values disappear",
        description:
          "Zero, empty text and disabled defaults disappear from the exported description.",
        baseCommitSha,
      },
      repository: { id: randomUUID(), sourceKind: "LOCAL", sourceUri: process.cwd() },
    } as RunExecutionRecord,
    signal,
  );
  expect(result.status, JSON.stringify(result)).toBe("WAITING_APPROVAL");
  const checkpoint = events.findLast(
    (event) =>
      event.type === "WORKFLOW_CHECKPOINT" && (event.payload as { metrics?: unknown })?.metrics,
  );
  const metrics = (
    checkpoint!.payload as {
      metrics: {
        modelCalls: number;
        steps: number;
        tokenUsage: { totalTokens: number };
        toolCalls: number;
      };
    }
  ).metrics;
  expect(metrics.modelCalls).toBe(3);
  expect(metrics.steps).toBe(3);
  expect(metrics.tokenUsage.totalTokens).toBe(450);
  expect(metrics.toolCalls).toBeGreaterThanOrEqual(2);
  expect(artifacts.some((a) => a.name === "issue-localization-agent-plan-v1.json")).toBe(true);
  expect(events.filter((e) => e.type === "LLM_REQUEST")).toHaveLength(3);
});

it("verifies bounded large-file regions without claiming an unparsed symbol", async () => {
  const code =
    "// padding a much larger file than parser limit\n".repeat(2000) + "if (value) return value;\n";
  const source = memorySource({ "src/large.ts": code });
  const model = new FakeLanguageModel([
    response(
      decision({
        inspect: [
          {
            path: "src/large.ts",
            startLine: 2001,
            endLine: 2001,
            reason: "Inspect a bounded behavior region",
          },
        ],
      }),
    ),
    (request) =>
      response(
        decision({
          candidates: [
            { evidenceId: state(request).evidence[0].id, explanation: "Current guard evidence" },
          ],
        }),
      ),
  ]);
  const result = await run(source, model);
  expect(result.candidates[0]).toMatchObject({
    path: "src/large.ts",
    symbol: null,
    startLine: 2001,
    endLine: 2001,
    contentHash: hash(code),
  });
  expect(result.metrics.readBytes).toBeLessThan(2 * 1024 * 1024);
});
