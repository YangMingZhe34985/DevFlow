import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { FakeLanguageModel, fakeModelResponse, type ModelRequest } from "@devflow/agent";
import { PrismaDatabaseAdapter } from "@devflow/database";
import { DockerSandboxManager } from "@devflow/sandbox";
import { SandboxGitService } from "@devflow/git";
import type { AgentPlan } from "@devflow/shared";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.js";
import {
  RepositoryRelationGraph,
  relationGraphDigest,
} from "../../apps/worker/src/localization/relation-graph.js";
import { sandboxSource } from "../../apps/worker/src/localization/sources.js";
import {
  ApprovalWorkflowRunExecutor,
  createTools,
  initialWorkflowMetrics,
} from "../../apps/worker/src/runs/approval-workflow-run-executor.js";

const integration = process.env.DEVFLOW_EF_INTEGRATION === "1" ? describe : describe.skip;
const exec = promisify(execFile);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const call = (name: string, input: unknown) =>
  fakeModelResponse({
    toolCalls: [{ id: randomUUID(), name, input }],
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  });

integration("E/F real Docker and database integration", () => {
  let database: PrismaDatabaseAdapter;
  let fixtureRoot: string;
  let baseCommit: string;
  let original: string;
  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl || !/^\/devflow_p11_\d+$/.test(new URL(databaseUrl).pathname))
      throw new Error("E/F requires the runner's isolated test database");
    database = PrismaDatabaseAdapter.fromConnectionString(databaseUrl);
    await database.connect();
    await mkdir(path.resolve(".devflow"), { recursive: true });
    fixtureRoot = await mkdtemp(path.resolve(".devflow/ef-validation-"));
    await cp(path.resolve("tests/fixtures/calculator-bug"), fixtureRoot, { recursive: true });
    await writeFile(
      path.join(fixtureRoot, "src/barrel.js"),
      'export { subtract } from "./calculator.js";\n',
    );
    await mkdir(path.join(fixtureRoot, "notes"));
    for (let i = 0; i < 6; i++)
      await writeFile(
        path.join(fixtureRoot, `notes/observation${i}.js`),
        `// Old observation ${i}: verify arithmetic before editing.\n// ${"x".repeat(2200)}\nexport const marker${i}=${i};\n`,
      );
    const git = async (...args: string[]) =>
      (await exec("git", args, { cwd: fixtureRoot, windowsHide: true })).stdout.trim();
    await git("init", "--initial-branch=main");
    await git("add", "--all");
    await git(
      "-c",
      "user.name=Devflow Test",
      "-c",
      "user.email=test@devflow.invalid",
      "commit",
      "--no-gpg-sign",
      "-m",
      "E/F test fixture",
    );
    baseCommit = await git("rev-parse", "HEAD");
    original = await readFile(path.join(fixtureRoot, "src/calculator.js"), "utf8");
  }, 60000);
  afterAll(async () => {
    await database?.disconnect();
    if (fixtureRoot) {
      if (
        path.dirname(fixtureRoot) !== path.resolve(".devflow") ||
        !path.basename(fixtureRoot).startsWith("ef-validation-")
      )
        throw new Error("Unsafe fixture cleanup target");
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "persists graph invalidation, precise edits and bounded summary recovery (summary failure=%s)",
    async (failure) => {
      const repository = await database.repositories.create({
        name: `ef-${randomUUID()}`,
        sourceKind: "LOCAL",
        sourceUri: fixtureRoot,
      });
      const task = await database.tasks.create({
        repositoryId: repository.id,
        title: "Repair subtraction",
        description: "Fix subtract; preserve add and existing tests.",
        baseCommitSha: baseCommit,
      });
      const created = await database.runs.create({ taskId: task.id, maxSteps: 20 });
      const run = (await database.runs.findExecutionById(created.run.id))!;
      const sandbox = await new DockerSandboxManager({
        image: "devflow-sandbox:local",
        workspaceRoot: fixtureRoot,
      }).create({
        runId: run.id,
        repository: { sourceUri: pathToFileURL(fixtureRoot).href },
        limits: { cpuCount: 1, memoryMb: 256, pids: 64, timeoutMs: 60000, networkEnabled: false },
      });
      const signal = AbortSignal.timeout(60000);
      try {
        const source = sandboxSource(sandbox, { maxFileBytes: 512 * 1024 });
        const graph = new RepositoryRelationGraph({
          repositoryId: repository.id,
          baseCommitSha: baseCommit,
          source,
        });
        await graph.inspect(["src/barrel.js"], signal);
        const baseline = JSON.stringify(graph.snapshot());
        const artifact = await database.artifacts.create({
          runId: run.id,
          kind: "OTHER",
          name: "repository-relations-plan-v1.json",
          mimeType: "application/json",
          content: baseline,
          sha256: sha(baseline),
          sizeBytes: Buffer.byteLength(baseline),
        });
        const plan: AgentPlan = {
          summary: "Repair subtraction",
          steps: [{ id: "1", title: "Repair", description: "Verify and repair subtraction" }],
          proposalVersion: "plan-proposal-v1",
          approvalScope: {
            version: "plan-approval-scope-v1",
            mode: "READY",
            baseCommitSha: baseCommit,
            workspaceRevision: 0,
            files: [{ path: "src/calculator.js", operation: "MODIFY" }],
          },
        };
        const corrected = original.replace(
          "// Intentional fixture bug: the agent should change + to -.\n  return left + right;",
          "// Intentional fixture bug: the agent should change + to -.\n  return left - right;",
        );
        const actions = [
          ["queryRelations", { paths: ["src/barrel.js"] }],
          ["readFile", { path: "notes/missing.js" }],
          ...Array.from({ length: 6 }, (_, i) => [
            "readFile",
            { path: `notes/observation${i}.js` },
          ]),
          ["readFile", { path: "src/calculator.js" }],
          ["writeFile", { path: "test/calculator.test.js", content: "forged" }],
          [
            "replaceText",
            {
              path: "src/calculator.js",
              oldText:
                "// Intentional fixture bug: the agent should change + to -.\n  return left + right;",
              newText:
                "// Intentional fixture bug: the agent should change + to -.\n  return left - right;",
              expectedSha256: sha(original),
            },
          ],
          ["queryRelations", { paths: ["src/barrel.js"], symbols: ["subtract"] }],
          ["finishPhase", { summary: "Candidate ready for actual tests", outcome: "CHANGED" }],
        ] as const;
        let cursor = 0,
          summaries = 0,
          sawSummary = false,
          sawError = false;
        const respond = async (request: ModelRequest) => {
          if (request.output?.name === "context_summary") {
            summaries++;
            if (failure) throw new Error("Simulated summary transport failure");
            const row = JSON.parse(String(request.messages[1]!.content)).observations[0];
            return fakeModelResponse({
              toolCalls: [],
              output: {
                facts: [
                  {
                    index: row.index,
                    sha256: row.sha256,
                    quote: JSON.stringify(row.content).slice(0, 100),
                    interpretation: "Older repository observation; re-read before editing.",
                  },
                ],
              },
              usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            });
          }
          const text = JSON.stringify(request.messages);
          sawSummary ||= text.includes("context-summary-v1");
          sawError ||=
            text.includes("notes/missing.js") &&
            request.messages.some((m) => m.role === "TOOL" && m.isError);
          const action = actions[cursor++];
          if (action?.[0] === "finishPhase") {
            const currentGraph = request.messages.findLast(
              (m) => m.role === "TOOL" && m.toolName === "queryRelations",
            );
            expect(JSON.stringify(currentGraph?.content)).toContain(sha(corrected));
          }
          if (!action) throw new Error("Unexpected extra main request");
          return call(action[0], action[1]);
        };
        const raw = new FakeLanguageModel(Array.from({ length: 20 }, () => respond));
        const environment = loadWorkerEnvironment({
          ...process.env,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          LLM_EXECUTE_CONTEXT_TOKENS: "4000",
          LLM_EXECUTE_MAX_OUTPUT_TOKENS: "512",
          DEVFLOW_CONTEXT_COMPRESSION_MAX_INPUT_TOKENS: "4000",
          DEVFLOW_CONTEXT_COMPRESSION_MAX_OUTPUT_TOKENS: "512",
          DEVFLOW_MAX_RETRIES: "0",
          DEVFLOW_POST_PATCH_CONVERGENCE_ENABLED: "false",
          DEVFLOW_PREPATCH_EFFICIENCY_ENABLED: "false",
          DEVFLOW_EVIDENCE_ACTION_ENABLED: "false",
          DEVFLOW_RELATION_GRAPH_ENABLED: "true",
          DEVFLOW_CONTEXT_COMPRESSION_ENABLED: "true",
        });
        const worker = new ApprovalWorkflowRunExecutor(database, environment, () => raw);
        const result = await worker["runAgentPhase"]({
          run,
          plan,
          sandbox,
          signal,
          ...createTools(new SandboxGitService()),
          model: worker["createModel"](run),
          purpose: "IMPLEMENTATION",
          maxSteps: 20,
          adaptiveStepBudget: {
            initialLimit: 20,
            hardLimit: 20,
            onLimitReached: () => ({ action: "STOP", reason: "NO_PROGRESS" }),
          },
          timeoutMs: 60000,
          executionBudget: {
            stage: "EXECUTE",
            maxModelCalls: 20,
            maxToolCalls: 25,
            maxTotalTokens: 50000,
          },
          additionalContext:
            "Verify source and retain the latest error; the host controls approval scope.",
        });
        expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
        expect(summaries).toBe(1);
        expect(sawSummary).toBe(!failure);
        expect(sawError).toBe(true);
        expect(result.metrics.modelCalls).toBe(actions.length + 1);
        expect(result.metrics.tokenUsage.totalTokens).toBe(
          actions.length * 30 + (failure ? 0 : 150),
        );
        expect((await sandbox.readFile({ path: "src/calculator.js" })).content).toBe(corrected);
        expect((await sandbox.readFile({ path: "test/calculator.test.js" })).content).not.toBe(
          "forged",
        );
        expect((await sandbox.exec({ program: "npm", args: ["test"] })).exitCode).toBe(0);
        const artifacts = await database.artifacts.list(run.id);
        expect(artifacts.find((a) => a.id === artifact.id)?.content).toBe(baseline);
        const overlay = JSON.parse(
          artifacts.find((a) => a.name.startsWith("repository-relations-overlay-"))!.content!,
        );
        expect(overlay.workspaceRevision).toBeGreaterThan(0);
        expect(
          overlay.files
            .filter((f: { path: string }) =>
              ["src/calculator.js", "src/barrel.js"].includes(f.path),
            )
            .every((f: { state: string }) => f.state === "STALE"),
        ).toBe(true);
        const summaryArtifacts = artifacts.filter((a) => a.name.startsWith("context-compression-"));
        const summary = summaryArtifacts
          .map((a) => JSON.parse(a.content!))
          .find((a) => a.summary.requestIssued);
        expect(summary?.summary.status).toBe(
          failure ? "SUMMARY_FAILED_STATIC_FALLBACK" : "SUMMARIZED",
        );
        expect(summary?.context.historyBytes).toBeGreaterThan(summary?.context.viewBytes);
        const restarted = new ApprovalWorkflowRunExecutor(database, environment, () => raw);
        const restored = await restarted["restoreCompressionState"](
          run.id,
          "IMPLEMENTATION",
          artifacts,
        );
        expect(restored?.calls).toBe(1);
        expect(restored?.pendingTokenReserve).toBe(0);
        const metrics = await initialWorkflowMetrics(database, run);
        expect(metrics.contextCompressionReservedTokens ?? 0).toBe(
          failure ? result.metrics.contextCompressionReservedTokens : 0,
        );
        const events = await database.events.list(run.id, { limit: 1000 });
        const started = events.filter((e) => e.type === "STEP_STARTED");
        expect(new Set(started.map((e) => e.stepId)).size).toBe(started.length);
        expect(JSON.stringify(events)).toContain("APPROVAL_SCOPE");
        if (process.env.DEVFLOW_EF_VALIDATION_OUTPUT) {
          const output = path.resolve(process.env.DEVFLOW_EF_VALIDATION_OUTPUT);
          if (!output.startsWith(path.resolve("docs/performance/results") + path.sep))
            throw new Error("Unsafe validation output directory");
          await writeFile(
            path.join(output, failure ? "ef-fallback.json" : "ef-summary.json"),
            JSON.stringify(
              {
                result,
                summaryStatus: summary.summary.status,
                summaryCalls: summaries,
                baselineGraphSha256: relationGraphDigest(graph.snapshot()),
                overlay,
                restored,
                actualTestsPassed: true,
                providerRequests: 0,
                graphBaselinePreserved: true,
                approvalScope: plan.approvalScope,
                artifactCount: artifacts.length,
                eventCount: events.length,
              },
              null,
              2,
            ),
            { flag: "wx" },
          );
        }
      } finally {
        await sandbox.dispose();
      }
    },
    120000,
  );
});
