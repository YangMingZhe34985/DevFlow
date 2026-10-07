import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  DefaultAgentRuntime,
  FakeLanguageModel,
  fakeModelResponse,
  PostPatchController,
  type ModelRequest,
} from "@devflow/agent";
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
import { normalizePatchCandidate } from "@devflow/sandbox";
import { FinishPhaseTool } from "../../apps/worker/src/runs/workflow-stage-policy.js";
import {
  ApprovalWorkflowRunExecutor,
  createTools,
  initialWorkflowMetrics,
} from "../../apps/worker/src/runs/approval-workflow-run-executor.js";
import { observePostPatchTool } from "../../apps/worker/src/runs/post-patch.js";
import { ensureLocalRunSnapshot } from "../../apps/worker/src/runs/local-run-snapshot.js";
import { proposalMutationDenial } from "../../apps/worker/src/runs/plan-proposal.js";

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

  it.each(["APPROVE", "BUDGET_STOP", "TEST_ONLY", "HOST_TEST_EVIDENCE"] as const)(
    "bounded scope replan and candidate restoration: %s",
    async (mode) => {
      const repository = await database.repositories.create({
        name: `scope-${randomUUID()}`,
        sourceKind: "LOCAL",
        sourceUri: fixtureRoot,
      });
      const task = await database.tasks.create({
        repositoryId: repository.id,
        title: "Repair subtraction",
        description: "Fix subtract; preserve add and existing tests.",
        baseCommitSha: baseCommit,
      });
      const { run: created } = await database.runs.create({
        taskId: task.id,
        maxSteps: 20,
        maxTestRetries: 3,
        maxReviewRetries: 1,
      });
      const owner = `scope-${randomUUID()}`,
        signal = AbortSignal.timeout(180000);
      const oldPlan: AgentPlan = {
        summary: "Investigate subtraction through the export wrapper",
        steps: [
          {
            id: "wrapper",
            title: "Inspect wrapper",
            description: "Investigate the approved wrapper.",
          },
        ],
        proposalVersion: "plan-proposal-v1",
        approvalScope: {
          version: "plan-approval-scope-v1",
          mode: "READY",
          baseCommitSha: baseCommit,
          workspaceRevision: 0,
          files: [{ path: "src/barrel.js", operation: "MODIFY" }],
        },
      };
      let claimed = (await database.runs.claim(created.id, owner, 240000))!;
      await ensureLocalRunSnapshot(database, claimed, signal);
      const initial = await database.runs.pauseForApproval(created.id, owner, oldPlan);
      await database.approvals.resolveForWorkflow(initial.approval.id, { status: "APPROVED" });
      claimed = (await database.runs.claim(created.id, owner, 240000))!;
      const change = {
        path: "src/calculator.js",
        oldText: "return left + right;",
        newText: "return left - right;",
        expectedSha256: sha(original),
        expectedOccurrences: 1,
      };
      // The first + is in add too: use the exact function-local fragment.
      change.oldText =
        "// Intentional fixture bug: the agent should change + to -.\n  return left + right;";
      change.newText =
        "// Intentional fixture bug: the agent should change + to -.\n  return left - right;";
      const both = (edit: unknown) =>
        fakeModelResponse({
          toolCalls: [
            { id: randomUUID(), name: "replaceText", input: edit },
            {
              id: randomUUID(),
              name: "finishPhase",
              input: { summary: "Current approved candidate", outcome: "CHANGED" },
            },
          ],
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        });
      const model = new FakeLanguageModel([
        both({
          path: "src/barrel.js",
          oldText: 'export { subtract } from "./calculator.js";',
          newText: '// Candidate wrapper retained\nexport { subtract } from "./calculator.js";',
          expectedSha256: sha('export { subtract } from "./calculator.js";\n'),
        }),
        call("readFile", { path: "src/calculator.js" }),
        ...(mode === "TEST_ONLY" ? [call("readFile", { path: "test/calculator.test.js" })] : []),
        call("replaceText", change), // Must be rejected under the original wrapper-only approval.
        {
          ...call("finishPhase", {
            summary: "The public diagnostic identifies the implementation outside approval",
            outcome: "SCOPE_CONFLICT",
            ...(mode === "TEST_ONLY"
              ? {
                  evidence: [
                    {
                      path: "test/calculator.test.js",
                      quote: await readFile(
                        path.join(fixtureRoot, "test/calculator.test.js"),
                        "utf8",
                      ),
                      fileSha256: sha(
                        await readFile(path.join(fixtureRoot, "test/calculator.test.js"), "utf8"),
                      ),
                    },
                  ],
                }
              : {}),
            replanRequest: {
              candidatePaths: ["src/calculator.js"],
              reason: "The public check fails in the subtract implementation",
            },
          }),
          ...(mode === "BUDGET_STOP"
            ? { usage: { inputTokens: 45000, outputTokens: 100, totalTokens: 45100 } }
            : {}),
        },
        fakeModelResponse({
          output: {
            decision: "PROPOSE",
            goal: "subtract returns the difference",
            approach: ["Correct subtract and retain the wrapper candidate"],
            candidateFiles: [
              {
                path: "src/calculator.js",
                intent: "EDIT",
                reason: "Current public failing behavior",
              },
            ],
            verification: ["public arithmetic checks"],
            uncertainties: [],
          },
          toolCalls: [],
        }),
        both(change),
      ]);
      const review = new FakeLanguageModel([
        fakeModelResponse({
          output: {
            verdict: "PASS",
            summary: "Subtraction corrected; public verification passes.",
            issues: [],
          },
          toolCalls: [],
        }),
      ]);
      const environment = loadWorkerEnvironment({
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        DEVFLOW_TIMEOUT_MS: "1500000",
        DEVFLOW_MAX_TOTAL_TOKENS: mode === "BUDGET_STOP" ? "120000" : "400000",
        DEVFLOW_PLAN_AGENT_MAX_TOTAL_TOKENS: "60000",
        DEVFLOW_MAX_RETRIES: "0",
        DEVFLOW_CONTEXT_COMPRESSION_ENABLED: "false",
        DEVFLOW_EVIDENCE_ACTION_ENABLED: "false",
      });
      const profile = {
        version: 1 as const,
        checks: [
          {
            kind: "test" as const,
            source: "public synthetic arithmetic check",
            command: {
              program: "node",
              args: [
                "--input-type=module",
                "-e",
                `import {subtract,add} from "./src/calculator.js"; if(subtract(4,2)!==2 || add(4,2)!==6) { console.error("${mode === "TEST_ONLY" || mode === "HOST_TEST_EVIDENCE" ? "test/calculator.test.js:12" : "src/calculator.js:5"}: incorrect subtract behavior; expected 2, actual "+subtract(4,2)); process.exit(1); } console.log("public arithmetic passes");`,
              ],
              cwd: ".",
              environment: {},
            },
          },
        ],
      };
      const worker = new ApprovalWorkflowRunExecutor(
        database,
        environment,
        () => model,
        () => review,
        undefined,
        () => profile,
      );
      const paused = await worker.execute(claimed, signal);
      if (mode === "BUDGET_STOP") {
        expect(paused.status, JSON.stringify(paused)).toBe("FAILED");
        if (paused.status !== "FAILED") throw new Error("Expected preflight stop");
        expect(paused.error.message).toContain("REPLAN_DOWNSTREAM_RESERVE_INSUFFICIENT");
        expect(model.requests).toHaveLength(4);
        expect(JSON.stringify(await database.events.list(created.id, { limit: 1000 }))).toContain(
          '"requestIssued":false',
        );
        return;
      }
      expect(paused.status, JSON.stringify(paused)).toBe("WAITING_APPROVAL");
      if (paused.status !== "WAITING_APPROVAL" || paused.approvalKind === "GITHUB")
        throw new Error("Expected PLAN approval");
      expect(proposalMutationDenial(oldPlan, "replaceText", ["src/calculator.js"])).toContain(
        "APPROVAL_SCOPE",
      );
      const checkpoint = JSON.parse(
        (await database.artifacts.list(created.id)).findLast(
          (a) => a.name === "scope-replan-v1.json",
        )!.content!,
      );
      expect(checkpoint.used).toBe(1);
      expect(checkpoint.repairAttempts).toBe(1);
      expect(
        checkpoint.files.find((f: { path: string }) => f.path === "src/barrel.js").content,
      ).toContain("Candidate wrapper retained");
      const approval = await database.runs.pauseForApproval(created.id, owner, paused.plan);
      expect(approval.approval.id).not.toBe(initial.approval.id);
      await database.approvals.resolveForWorkflow(approval.approval.id, { status: "APPROVED" });
      claimed = (await database.runs.claim(created.id, owner, 240000))!;
      const completed = await worker.execute(claimed, signal);
      expect(completed.status, JSON.stringify(completed)).toBe("SUCCEEDED");
      const final = JSON.parse(
        (await database.artifacts.list(created.id)).findLast(
          (a) => a.name === "scope-replan-v1.json",
        )!.content!,
      );
      expect(final.used).toBe(1);
      expect(final.repairAttempts).toBe(2);
      expect(final.repairInFlight).toBe(false);
      expect(
        final.files.find((f: { path: string }) => f.path === "src/calculator.js").content,
      ).toContain("return left - right;");
      expect(
        final.files.find((f: { path: string }) => f.path === "src/barrel.js").content,
      ).toContain("Candidate wrapper retained");
      expect(model.requests).toHaveLength(mode === "TEST_ONLY" ? 7 : 6);
      if (mode === "HOST_TEST_EVIDENCE") {
        expect(checkpoint.evidenceRecords[0].testEvidence[0].source).toBe("HOST_DIAGNOSTIC_READ");
        expect(checkpoint.evidenceRecords[0].testEvidence[0].fileSha256).toMatch(/^[a-f0-9]{64}$/u);
      }
      const events = await database.events.list(created.id, { limit: 1000 });
      expect(JSON.stringify(events)).toContain("APPROVAL_SCOPE");
      expect(JSON.stringify(events)).toContain("APPROVED_SCOPE_REPLAN");
    },
    180000,
  );

  it("corrects a malformed patch at a soft boundary in a real sandbox, without changing source on rejection", async () => {
    const runId = randomUUID();
    const sandbox = await new DockerSandboxManager({
      image: "devflow-sandbox:local",
      workspaceRoot: fixtureRoot,
    }).create({
      runId,
      repository: { sourceUri: pathToFileURL(fixtureRoot).href },
      limits: { cpuCount: 1, memoryMb: 256, pids: 64, timeoutMs: 60000, networkEnabled: false },
    });
    try {
      const patch =
        "--- a/src/calculator.js\n+++ b/src/calculator.js\n@@ -1,99 +1,99 @@\n-old\n+new\n--- a/src/calculator.js\n+++ b/src/calculator.js\n@@ -1,99 +1,99 @@\n-old\n+new\n";
      const { executor, tools } = createTools(new SandboxGitService());
      const model = new FakeLanguageModel([
        call("applyPatch", { patch }),
        fakeModelResponse({
          toolCalls: [
            {
              id: randomUUID(),
              name: "replaceText",
              input: {
                path: "src/calculator.js",
                oldText:
                  "// Intentional fixture bug: the agent should change + to -.\n  return left + right;",
                newText:
                  "// Intentional fixture bug: the agent should change + to -.\n  return left - right;",
                expectedSha256: sha(original),
                expectedOccurrences: 1,
              },
            },
            {
              id: randomUUID(),
              name: "finishPhase",
              input: { summary: "Subtraction corrected", outcome: "CHANGED" },
            },
          ],
        }),
      ]);
      const result = await new DefaultAgentRuntime(model).run(
        {
          maxSteps: 3,
          timeoutMs: 60000,
          maxRetries: 0,
          modelSettings: { maxOutputTokens: 512 },
          executionBudget: {
            stage: "EXECUTE",
            maxModelCalls: 3,
            maxToolCalls: 5,
            maxTotalTokens: 10000,
          },
          adaptiveStepBudget: {
            initialLimit: 1,
            hardLimit: 3,
            onLimitReached: (s) =>
              s.editCorrectionPending
                ? { action: "EXTEND", additionalSteps: 1 }
                : { action: "STOP", reason: "NO_PROGRESS" },
          },
        },
        {
          runId,
          task: {
            taskId: randomUUID(),
            repositoryId: randomUUID(),
            title: "Fix subtraction",
            description: "Preserve tests",
          },
          signal: AbortSignal.timeout(60000),
          tools: [...tools, FinishPhaseTool],
          emit: async () => {},
          executeTool: async (stepId, request, signal) => {
            if (request.name === "applyPatch") {
              const current = await sandbox.readFile({ path: "src/calculator.js" });
              const check = normalizePatchCandidate({
                patch,
                targets: [{ path: current.path, operation: "MODIFY" }],
                current: new Map([
                  [current.path, { content: current.content, expectedHash: sha(original) }],
                ]),
              });
              expect(check.status).toBe("REJECTED");
              expect(current.content).toBe(original);
              if (check.status !== "REJECTED") throw new Error("expected rejection");
              return {
                ok: false,
                durationMs: 0,
                error: {
                  code: "TOOL_FAILED",
                  message: check.message,
                  retryable: false,
                  details: { patchFailure: { kind: check.kind, needsRead: false } },
                },
              };
            }
            return executor.execute(request, {
              runId,
              stepId,
              sandbox,
              signal: signal!,
              emit: async () => {},
            });
          },
        },
      );
      expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
      expect(model.requests).toHaveLength(2);
      expect((await sandbox.readFile({ path: "src/calculator.js" })).content).toBe(
        original.replace(
          "// Intentional fixture bug: the agent should change + to -.\n  return left + right;",
          "// Intentional fixture bug: the agent should change + to -.\n  return left - right;",
        ),
      );
      expect((await sandbox.exec({ program: "npm", args: ["test"] })).exitCode).toBe(0);
    } finally {
      await sandbox.dispose();
    }
  }, 120000);

  it("preserves current CRLF evidence after a failed exact edit and corrects it without changing unrelated bytes", async () => {
    const runId = randomUUID();
    const sandbox = await new DockerSandboxManager({
      image: "devflow-sandbox:local",
      workspaceRoot: fixtureRoot,
    }).create({
      runId,
      repository: { sourceUri: pathToFileURL(fixtureRoot).href },
      limits: { cpuCount: 1, memoryMb: 256, pids: 64, timeoutMs: 60000, networkEnabled: false },
    });
    try {
      const sourcePath = "src/calculator.js";
      const crlf = original.replace(/\n/gu, "\r\n");
      await sandbox.writeFile({ path: sourcePath, content: crlf });
      const oldText =
        "// Intentional fixture bug: the agent should change + to -.\n  return left + right;";
      const newText = oldText.replace("left + right", "left - right");
      const { executor, tools } = createTools(new SandboxGitService());
      const controller = new PostPatchController([sourcePath]);
      const model = new FakeLanguageModel([
        call("readFile", { path: sourcePath }),
        call("replaceText", {
          path: sourcePath,
          oldText,
          newText,
          expectedSha256: sha(crlf),
          expectedOccurrences: 1,
        }),
        call("replaceText", {
          path: sourcePath,
          oldText,
          newText,
          lineEndingMode: "MATCH_FILE",
          expectedSha256: sha(crlf),
          expectedOccurrences: 1,
        }),
        call("finishPhase", { summary: "Corrected subtraction", outcome: "CHANGED" }),
      ]);
      const result = await new DefaultAgentRuntime(model).run(
        { maxSteps: 4, timeoutMs: 60000, maxRetries: 0 },
        {
          runId,
          task: {
            taskId: randomUUID(),
            repositoryId: randomUUID(),
            title: "Fix subtraction",
            description: "Preserve existing tests and source line endings.",
          },
          signal: AbortSignal.timeout(60000),
          tools: [...tools, FinishPhaseTool],
          emit: async () => {},
          executeTool: async (stepId, request, signal) => {
            const observed = await observePostPatchTool({
              controller,
              request,
              sandbox,
              signal: signal!,
              execute: () =>
                executor.execute(request, {
                  runId,
                  stepId,
                  sandbox,
                  signal: signal!,
                  emit: async () => {},
                }),
            });
            if (request.name === "replaceText" && !observed.ok) {
              expect((await sandbox.readFile({ path: sourcePath })).content).toBe(crlf);
              expect(observed.mutation).toMatchObject({
                observationComplete: true,
                workspaceChanged: false,
                beforeRevision: 0,
                afterRevision: 0,
              });
            }
            return observed;
          },
        },
      );
      expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
      const read = model.requests[2]!.messages.find(
        (message) => message.role === "TOOL" && message.toolName === "readFile",
      );
      expect(read?.content).toMatchObject({ content: crlf });
      expect((await sandbox.readFile({ path: sourcePath })).content).toBe(
        crlf.replace(oldText.replace(/\n/gu, "\r\n"), newText.replace(/\n/gu, "\r\n")),
      );
      expect((await sandbox.exec({ program: "npm", args: ["test"] })).exitCode).toBe(0);
    } finally {
      await sandbox.dispose();
    }
  }, 120000);

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
            expect(
              JSON.stringify(currentGraph?.content),
              JSON.stringify(currentGraph?.content),
            ).toContain(sha(corrected));
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
          timeoutMs: 900000,
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
