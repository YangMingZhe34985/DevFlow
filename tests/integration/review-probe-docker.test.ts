import { describe, expect, it } from "vitest";
import { NodeDockerCommandRunner, ReadonlyProbeRunner } from "@devflow/sandbox";
import { DockerSandboxManager } from "@devflow/sandbox";
import { createHash, randomUUID } from "node:crypto";
import { DefaultAgentRuntime, FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { SandboxGitService } from "@devflow/git";
import { createTools } from "../../apps/worker/src/runs/approval-workflow-run-executor.js";
import { FinishPhaseTool } from "../../apps/worker/src/runs/workflow-stage-policy.js";
import { capturePublicProbeSource } from "../../apps/worker/src/runs/review-probe-source.js";
import {
  preparePublicProbe,
  collectReviewProbes,
  emptyReviewProbeState,
  ReviewProbeStateSchema,
  type ProbeRequest,
} from "../../apps/worker/src/runs/review-probes.js";
const enabled = process.env.DEVFLOW_REVIEW_PROBE_INTEGRATION === "1";
describe.skipIf(!enabled)("isolated public Review reproduction", () => {
  it("corrects a first client label and assertion parameter error with durable host identity and matching script versions", async () => {
    const state = emptyReviewProbeState(),
      runner = new ReadonlyProbeRunner(new NodeDockerCommandRunner());
    const publicSource = (value: number) => ({
      manifest: async () => ({
        entries: [{ path: "index.js", kind: "FILE" as const, sizeBytes: 24 }],
        incomplete: false,
      }),
      read: async () => ({ content: `exports.value=${value};`, truncated: false }),
    });
    const request: ProbeRequest = {
      findingId: "host-1",
      probeId: "client-check-value",
      publicEntrypoint: "index.js",
      language: "JS",
      code: "assertBehavior(entry.value===2,'value=2',entry.value)",
      expectedObservation: "value=2",
      taskBasis: "Issue requires value two",
    };
    const options = {
      requests: [request],
      findings: [{ findingId: "host-1", severity: "ERROR" as const, message: "Wrong value" }],
      state,
      baseline: publicSource(1),
      current: publicSource(2),
      baseRevision: "base",
      currentRevision: "1",
      runner,
      image: "devflow-sandbox:local",
      signal: new AbortController().signal,
      save: async () => {},
      beforeWork: () => {},
    };
    const first = await collectReviewProbes(options);
    expect(first.observations.every((o) => o.behaviorOutcome === "SCRIPT_ERROR")).toBe(true);
    expect(first.feedback[0]?.message).toContain("actual must be string");
    expect(first.feedback[0]?.message).toContain("String(entry.value)");
    const id = state.requests[0]!.probeId!;
    expect(id).not.toBe(request.probeId);
    const restored = ReviewProbeStateSchema.parse(JSON.parse(JSON.stringify(state)));
    const fixed = await collectReviewProbes({
      ...options,
      state: restored,
      requests: [
        { ...request, code: "assertBehavior(entry.value===2,'value=2',String(entry.value))" },
      ],
    });
    expect(fixed.observations.map((o) => o.behaviorOutcome)).toEqual([
      "EXPECTATION_FAILED",
      "EXPECTATION_MET",
    ]);
    expect(new Set(fixed.observations.map((o) => o.scriptSha256)).size).toBe(1);
    expect(fixed.observations.every((o) => o.probeId === id)).toBe(true);
    expect(restored).toMatchObject({
      executions: 4,
      correctionsUsed: 1,
      aliases: [{ clientLabel: "client-check-value", probeId: id, findingId: "host-1" }],
    });
    const repaired = await collectReviewProbes({
      ...options,
      state: restored,
      requests: [],
      current: publicSource(3),
      currentRevision: "2",
    });
    expect(repaired.observations[0]?.cached).toBe(true);
    expect(repaired.observations[1]?.cached).not.toBe(true);
    expect(restored.executions).toBe(5);
    const forbidden = await collectReviewProbes({
      ...options,
      state: restored,
      requests: [{ ...request, probeId: id, code: "assertBehavior(true,'fake','fake')" }],
    });
    expect(forbidden.feedback[0]?.code).toBe("PROBE_CORRECTION_LIMIT");
    expect(restored.executions).toBe(5);
  }, 60000);
  it("captures a current import chain in one host operation and recovers Repair without executing truncated edits", async () => {
    const runId = randomUUID(),
      source = "exports.value=1;\n",
      sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const snapshot = {
      version: 1 as const,
      sourceHead: "b".repeat(40),
      totalBytes: Buffer.byteLength(source),
      files: [
        {
          kind: "FILE" as const,
          path: "index.js",
          mode: 0o644,
          sizeBytes: Buffer.byteLength(source),
          sha256: sha(source),
          contentBase64: Buffer.from(source).toString("base64"),
        },
      ],
    };
    const sandbox = await new DockerSandboxManager({
      image: "devflow-sandbox:local",
      workspaceRoot: process.cwd(),
    }).create({
      runId,
      repository: { sourceUri: "snapshot", snapshot },
      limits: { cpuCount: 1, memoryMb: 256, pids: 64, timeoutMs: 60000, networkEnabled: false },
    });
    try {
      const probe = {
        findingId: "one",
        publicEntrypoint: "index.js",
        language: "JS" as const,
        code: "console.log(entry.value)",
        expectedObservation: "two",
        taskBasis: "Public requirement",
      };
      const captured = await capturePublicProbeSource(
        sandbox,
        probe.publicEntrypoint,
        probe.code,
        new AbortController().signal,
      );
      expect(
        (await preparePublicProbe(captured, probe, new AbortController().signal)).sourceHashes[
          "index.js"
        ],
      ).toBe(sha(source));
      const { executor, tools } = createTools(new SandboxGitService());
      const model = new FakeLanguageModel([
        fakeModelResponse({
          finishReason: "LENGTH",
          toolCalls: [
            {
              id: randomUUID(),
              name: "replaceText",
              input: {
                path: "index.js",
                oldText: "exports.value=1",
                newText: "exports.value=99",
                expectedSha256: sha(source),
              },
            },
          ],
        }),
        async (r) => {
          expect((await sandbox.readFile({ path: "index.js" })).content).toBe(source);
          expect(r.tools.every((t) => ["replaceText", "finishPhase"].includes(t.name))).toBe(true);
          expect(JSON.stringify(r.messages)).toContain("finding-one");
          return fakeModelResponse({
            toolCalls: [
              {
                id: randomUUID(),
                name: "replaceText",
                input: {
                  path: "index.js",
                  oldText: "exports.value=1",
                  newText: "exports.value=2",
                  expectedSha256: sha(source),
                  expectedOccurrences: 1,
                },
              },
              {
                id: randomUUID(),
                name: "finishPhase",
                input: {
                  outcome: "CHANGED",
                  summary: "Corrected value",
                  findingResponses: [
                    {
                      findingId: "finding-one",
                      outcome: "CHANGED",
                      summary: "Value is now two",
                      evidence: [
                        {
                          path: "index.js",
                          quote: "exports.value=2",
                          fileSha256: sha(source.replace("=1", "=2")),
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          });
        },
      ]);
      const result = await new DefaultAgentRuntime(model).run(
        {
          repairMode: true,
          stableTaskContext: "finding-one: value must be two; Test remains required",
          maxSteps: 3,
          timeoutMs: 30000,
          maxRetries: 0,
          modelSettings: { maxOutputTokens: 512 },
          executionBudget: {
            stage: "REPAIR",
            maxModelCalls: 3,
            maxToolCalls: 8,
            maxTotalTokens: 10000,
          },
          repairRecoveryContext: {
            maxToolExecutions: 1,
            collect: async () => {
              const f = await sandbox.readFile({ path: "index.js" });
              return { text: JSON.stringify(f), toolExecutions: 1, toolLatencyMs: 0 };
            },
          },
        },
        {
          runId,
          task: {
            taskId: randomUUID(),
            repositoryId: randomUUID(),
            title: "Fix value",
            description: "Return two",
          },
          signal: new AbortController().signal,
          tools: [...tools, FinishPhaseTool],
          emit: async () => {},
          executeTool: (stepId, request, signal) =>
            executor.execute(request, {
              runId,
              stepId,
              sandbox,
              signal: signal!,
              emit: async () => {},
            }),
        },
      );
      expect(result.status, JSON.stringify(result.error)).toBe("SUCCEEDED");
      expect(result.phaseCompletion?.findingResponses?.[0]?.findingId).toBe("finding-one");
      expect((await sandbox.readFile({ path: "index.js" })).content).toBe(
        source.replace("=1", "=2"),
      );
      const test = await sandbox.exec({
        program: "node",
        args: ["-e", "require('node:assert/strict').equal(require('./index.js').value,2)"],
      });
      expect(test.exitCode).toBe(0);
    } finally {
      await sandbox.dispose();
    }
  }, 60000);
  it("compares actual baseline/candidate without writable source or credentials", async () => {
    const runner = new ReadonlyProbeRunner(new NodeDockerCommandRunner());
    const signal = new AbortController().signal;
    const image = await runner.imageIdentity("devflow-sandbox:local", signal);
    const script = `assertBehavior(entry.value===2,'value=2',String(entry.value)); console.log('value='+entry.value);`;
    const result = async (value: number) =>
      runner.run(
        {
          entrypoint: "index.js",
          script,
          modules: { "index.js": `exports.value=${value};`, "__review_probe__.ts": script },
        },
        image,
        signal,
      );
    expect(await result(1)).toMatchObject({
      exitCode: 1,
      behaviorOutcome: "EXPECTATION_FAILED",
      assertions: [{ ok: false, expected: "value=2", actual: "1" }],
    });
    expect(await result(2)).toMatchObject({ exitCode: 0, behaviorOutcome: "EXPECTATION_MET" });
    expect((await result(3)).exitCode).toBe(1);
    for (const [code, outcome] of [
      ["console.log('ran')", "NO_ASSERTION"],
      ["throw Error('bad script')", "SCRIPT_ERROR"],
      ["assertBehavior(true,'ok','ok');throw Error('later error')", "SCRIPT_ERROR"],
    ]) {
      expect(
        await runner.run(
          {
            entrypoint: "index.js",
            script: code!,
            modules: { "index.js": "exports.value=2", "__review_probe__.ts": code! },
          },
          image,
          signal,
        ),
      ).toMatchObject({ behaviorOutcome: outcome });
    }
    const protect = `const fs=require('node:fs'),assert=require('node:assert/strict'); assert.throws(()=>fs.writeFileSync('/workspace/probe-tamper','bad')); fs.writeFileSync('/scratch/ok','allowed'); assert.equal(process.env.LLM_API_KEY,undefined); assert.equal(require('node:os').networkInterfaces().eth0,undefined); console.log('readonly, scratch, credentials, network verified');`;
    const protectedResult = await runner.run(
      {
        entrypoint: "index.js",
        script: protect,
        modules: { "index.js": "exports.value=2;", "__review_probe__.ts": protect },
      },
      image,
      signal,
    );
    expect(protectedResult.exitCode).toBe(0);
    expect(protectedResult.stdout).toContain("verified");
    const infinite = "while(true) {}";
    expect(
      (
        await runner.run(
          {
            entrypoint: "index.js",
            script: infinite,
            modules: { "index.js": "", "__review_probe__.ts": infinite },
          },
          image,
          signal,
          1000,
        )
      ).status,
    ).toBe("TIMEOUT");
    const missing = "require('not-installed-public-dependency')";
    expect(
      (
        await runner.run(
          {
            entrypoint: "index.js",
            script: missing,
            modules: { "index.js": "", "__review_probe__.ts": missing },
          },
          image,
          signal,
        )
      ).status,
    ).toBe("DEPENDENCY_MISSING");
  }, 60000);
});
