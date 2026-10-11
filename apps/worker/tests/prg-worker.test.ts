import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InMemoryBudgetLedgerStore,
  type DatabaseAdapter,
  type RunExecutionRecord,
} from "@devflow/database";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import {
  encodeLocalRepositorySnapshot,
  LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
} from "@devflow/sandbox";
import { ApprovalWorkflowRunExecutor } from "../src/runs/approval-workflow-run-executor.js";
import { loadWorkerEnvironment } from "../src/config/env.js";
import { hash } from "../src/localization/contracts.js";
import { exclusionReason } from "../src/localization/contracts.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function replayPrgWorker(
  files: Record<string, string>,
  title: string,
  description: string,
  mode: "prg" | "legacy-dynamic" = "prg",
  investigationQueries: string[] = [],
) {
  const baseCommitSha = "a".repeat(40);
  const artifacts: { id?: string; kind: string; name: string; content: string }[] = [
    {
      kind: "OTHER",
      name: LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
      content: encodeLocalRepositorySnapshot({
        version: 1,
        sourceHead: baseCommitSha,
        totalBytes: Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0),
        files: Object.entries(files)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, content]) => ({
            path,
            kind: "FILE",
            mode: 0o644,
            sizeBytes: Buffer.byteLength(content),
            sha256: hash(content),
            contentBase64: Buffer.from(content).toString("base64"),
          })),
      }),
    },
  ];
  const events: { type: string; payload?: unknown }[] = [];
  const cache = new Map<string, unknown>();
  const database = {
    budgetLedgers: new InMemoryBudgetLedgerStore(),
    repositoryIndexes: {
      get: async (scope: string, key: string) => cache.get(scope + key),
      publish: async (scope: string, key: string, value: unknown) => {
        cache.set(scope + key, value);
      },
    },
    artifacts: {
      list: async () => artifacts,
      create: async (a: (typeof artifacts)[number]) => {
        const artifact = { ...a, id: randomUUID() };
        artifacts.push(artifact);
        return artifact;
      },
    },
    events: {
      list: async () => events,
      append: async (e: (typeof events)[number]) => {
        events.push(e);
      },
    },
    approvals: { list: async () => [] },
    runs: { transition: async () => undefined },
  } as unknown as DatabaseAdapter;
  const reply = (value: unknown) =>
    fakeModelResponse({
      text: JSON.stringify(value),
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
  const model = new FakeLanguageModel([
    ...investigationQueries.map(
      (query) => () =>
        reply({
          summary: "Investigate public behavior; path ranking is not root-cause proof",
          hypotheses: [
            {
              query,
              explanation: "Missing implementation/consumer evidence for the public behavior",
            },
          ],
          inspect: [],
          candidates: [],
          uncertainty: ["Behavior chain still unverified"],
        }),
    ),
    (request) => {
      const state = JSON.parse(String(request.messages[1]!.content));
      const row = state.evidence.find(
        (e: { fileType: string; snippet: string }) =>
          e.fileType === "SOURCE" && /return|if/.test(e.snippet),
      );
      return reply({
        summary: "Observe implementation and behavior before proposing scope",
        hypotheses: [],
        inspect: [],
        candidates: row
          ? [{ evidenceId: row.id, explanation: "Observed behavior candidate, not proof of cause" }]
          : [],
        uncertainty: [],
      });
    },
    (request) => {
      const serialized = JSON.stringify(request.messages);
      const file =
        Object.keys(files).find((p) => p.endsWith("kernel.ts") && serialized.includes(p)) ??
        Object.keys(files).find(
          (p) => /\.(?:ts|cpp|py|java)$/.test(p) && !p.includes("test") && serialized.includes(p),
        )!;
      if (!serialized.includes(file))
        return reply({
          decision: "UNKNOWN",
          goal: "Insufficient evidence",
          approach: [],
          candidateFiles: [],
          verification: [],
          uncertainties: ["Implementation source missing"],
        });
      return reply({
        decision: "PROPOSE",
        goal: "Correct observable behavior",
        approach: ["Check current behavior implementation against public assertions"],
        candidateFiles: [{ path: file, intent: "EDIT", reason: "Current source region observed" }],
        verification: ["Run public validation"],
        uncertainties: ["Root cause needs verification"],
      });
    },
  ]);
  const run = {
    id: randomUUID(),
    localizationMode: mode,
    status: "RUNNING",
    currentStage: "START",
    retryCount: 0,
    maxSteps: 25,
    maxTestRetries: 3,
    maxReviewRetries: 1,
    task: { title, description, baseCommitSha },
    repository: { id: randomUUID(), sourceKind: "LOCAL", sourceUri: process.cwd() },
  } as RunExecutionRecord;
  const worker = new ApprovalWorkflowRunExecutor(
    database,
    loadWorkerEnvironment({
      DATABASE_URL: "unused",
      DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "60000",
      DEVFLOW_TIMEOUT_MS: "1500000",
      DEVFLOW_MAX_TOOL_CALLS: "75",
    }),
    () => model,
  );
  const result = await worker.execute(run, new AbortController().signal);
  return {
    result,
    requests: model.requests,
    artifacts,
    events,
    ledger: await database.budgetLedgers!.get(run.id),
  };
}

describe("PRG production Worker handoff", () => {
  const publicIt = process.env.PRG_PUBLIC_REPLAY === "1" ? it : it.skip;
  publicIt.each(["E05-ConfigTree", "E06-LogStream", "E10-FlowEngine"])(
    "replays only public issue and broken-source material for %s",
    async (dataset) => {
      const root = path.resolve("datasets", dataset, "broken");
      const files: Record<string, string> = {};
      async function scan(relative = "") {
        for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
          const name = [relative, entry.name].filter(Boolean).join("/");
          if (
            exclusionReason(name) ||
            entry.isSymbolicLink() ||
            name.startsWith(".git/") ||
            name === ".git"
          )
            continue;
          if (entry.isDirectory()) {
            await scan(name);
            continue;
          }
          if (!/\.(?:[cm]?[jt]sx?|py|java|cpp|cc|c|hpp|h|json|toml|xml|md|txt)$/iu.test(name))
            continue;
          const content = await readFile(path.join(root, name), "utf8");
          if (Buffer.byteLength(content) <= 512 * 1024 && !content.includes("\0"))
            files[name] = content;
        }
      }
      await scan();
      const issue = await readFile(
        path.resolve("datasets", dataset, "benchmark", "benchmark_issue.md"),
        "utf8",
      );
      // Queries use only public behavior text, never expected implementation paths.
      const queries = issue
        .split(/\r?\n/u)
        .filter((line) => /^\d+\./u.test(line))
        .slice(-4);
      const replay = await replayPrgWorker(files, issue.split("\n")[0]!, issue, "prg", queries);
      expect(replay.requests.length, JSON.stringify(replay.result)).toBeGreaterThan(0);
      const localizationRequests = replay.requests.filter((request) =>
        String(request.messages[0]?.content).includes("Issue Localization Agent"),
      );
      const states = localizationRequests
        .map((request) => {
          try {
            return JSON.parse(String(request.messages[1]?.content));
          } catch {
            return {};
          }
        })
        .filter((state) => Array.isArray(state.evidence));
      const state = states.at(-1)!;
      expect(localizationRequests.length).toBeGreaterThan(4);
      expect(replay.result.status, JSON.stringify(replay.result)).toBe("WAITING_APPROVAL");
      const evidence = state.evidence as { path: string; fileType: string; snippet: string }[];
      expect(evidence.some((e) => e.fileType === "TEST")).toBe(true);
      expect(evidence.some((e) => e.fileType === "SOURCE")).toBe(true);
      for (const row of evidence)
        expect(files[row.path]!.replaceAll("\r\n", "\n")).toContain(row.snippet);
      // Public diagnostics only. This replay never reads golden/, injection patches or scorers.
      console.log(
        JSON.stringify({
          dataset,
          status: replay.result.status,
          visiblePaths: evidence.map((e) => e.path),
          evidenceRecords: evidence.length,
          missing: [...(state.investigation?.missing ?? []), ...(state.graph?.limitations ?? [])],
          requests: replay.requests.length,
          localizationRequests: localizationRequests.length,
          error: replay.result.status === "FAILED" ? replay.result : undefined,
        }),
      );
    },
    60000,
  );
  it("jointly exposes assertions, implementation and consumer without giving the model expected paths", async () => {
    const files = {
      "src/kernel.ts": "export function transform(value: number) { return value - 1; }\n",
      "src/screen.ts":
        "import { transform } from './kernel';\nexport function render(value: number) { return transform(value); }\n",
      "tests/behavior.test.ts":
        "import { render } from '../src/screen';\nit('preserves values in render', () => expect(render(4)).toBe(4));\n",
      "src/distractor.ts": "export function transformName(name: string) { return name; }\n",
    };
    const replay = await replayPrgWorker(
      files,
      "Rendered values change",
      "Rendering a value returns the wrong result. Public render should preserve its input.",
    );
    expect(replay.result.status, JSON.stringify(replay.result)).toBe("WAITING_APPROVAL");
    const localization = JSON.stringify(replay.requests[0]?.messages);
    expect(localization).toContain("toBe(4)");
    expect(localization).toContain("return value - 1");
    expect(localization).toContain("return transform(value)");
    const planner = JSON.stringify(replay.requests[1]?.messages);
    expect(planner).toContain("toBe(4)");
    expect(planner).toContain("return value - 1");
    expect(planner).toContain("return transform(value)");
    expect(replay.artifacts.some((a) => a.name === "localization-investigation-v1.json")).toBe(
      true,
    );
    expect(replay.requests).toHaveLength(2);
  }, 30000);
});
