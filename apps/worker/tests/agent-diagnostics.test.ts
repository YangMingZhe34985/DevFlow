import { expect, it, vi } from "vitest";
import { AgentDiagnostics, type DiagnosticRecord } from "../src/runs/agent-diagnostics.js";
import { createTools } from "../src/runs/approval-workflow-run-executor.js";
import { SandboxGitService } from "@devflow/git";
import type { ToolContext } from "@devflow/tools";
import { toolsForCoding, toolsForStage } from "../src/runs/workflow-stage-policy.js";
import { EvidenceProgress } from "../../../packages/agent/src/evidence-progress.js";

function fixture() {
  const records = new Map<string, DiagnosticRecord>();
  const result = {
    exitCode: 1,
    stdout: "assertion failed",
    stderr: "",
    durationMs: 2,
    timedOut: false,
    outputTruncated: false,
  };
  const ports = {
    runId: "run-a",
    enabled: true,
    profile: {
      version: 1 as const,
      checks: [
        {
          kind: "test" as const,
          source: "package.json#scripts.test",
          command: { program: "npm", args: ["test"], cwd: ".", environment: {} },
        },
      ],
    },
    load: async () => [...records.values()],
    save: async (r: DiagnosticRecord) => {
      records.set(r.id, structuredClone(r));
    },
    identity: vi.fn(async () => "source-a"),
    admit: vi.fn(async () => undefined),
    execute: vi.fn(async () => result),
  };
  return { ports, records, diagnostics: new AgentDiagnostics(ports) };
}
const request = {
  checkId: "0:test",
  reason: "Check the public assertion before choosing another edit",
};
const signal = new AbortController().signal;
it("lets a model choose a diagnostic and retains non-authoritative failure feedback", async () => {
  const { diagnostics, ports } = fixture();
  const output = await diagnostics.run(request, signal);
  expect(output).toMatchObject({
    status: "COMPLETED",
    authority: "OBSERVATION_ONLY",
    finalValidationRequired: true,
    result: { exitCode: 1 },
  });
  expect(ports.execute.mock.calls[0]![0]).toEqual(ports.profile.checks[0]);
  const progress = new EvidenceProgress();
  expect(progress.observe(output, 0)).toBe(true);
  const cached = await diagnostics.run({ ...request, reason: "rephrased" }, signal);
  expect(cached.cached).toBe(true);
  expect(progress.observe(cached, 0)).toBe(false);
  expect(ports.execute).toHaveBeenCalledTimes(1);
});
it("a denied budget never dispatches and cannot regain an attempt on restore", async () => {
  const { diagnostics, ports, records } = fixture();
  ports.admit.mockRejectedValueOnce(new Error("required Review reserve unavailable"));
  await expect(diagnostics.run(request, signal)).rejects.toThrow("Review reserve");
  expect([...records.values()][0]!.status).toBe("NOT_ISSUED");
  await expect(new AgentDiagnostics(ports).run(request, signal)).rejects.toThrow("NOT_REPLAYABLE");
  expect(ports.execute).not.toHaveBeenCalled();
});
it("unknown side effects and two completed attempts survive session/approval recovery", async () => {
  const { diagnostics, ports } = fixture();
  await diagnostics.run(request, signal);
  ports.identity.mockResolvedValue("source-b");
  await new AgentDiagnostics(ports).run(request, signal);
  ports.identity.mockResolvedValue("source-c");
  await expect(new AgentDiagnostics(ports).run(request, signal)).rejects.toThrow("Two optional");
  const other = fixture();
  other.ports.execute.mockRejectedValueOnce(new Error("transport lost"));
  await expect(other.diagnostics.run(request, signal)).rejects.toThrow("transport lost");
  await expect(new AgentDiagnostics(other.ports).run(request, signal)).rejects.toThrow(
    "RECEIPT_UNKNOWN",
  );
  expect(other.ports.execute).toHaveBeenCalledTimes(1);
});
it("rejects raw commands and unknown checks without touching the sandbox", async () => {
  const { diagnostics, ports } = fixture();
  await expect(diagnostics.run({ ...request, program: "bash" }, signal)).rejects.toThrow();
  await expect(diagnostics.run({ ...request, checkId: "private:scorer" }, signal)).rejects.toThrow(
    "Unknown",
  );
  ports.enabled = false;
  await expect(diagnostics.run(request, signal)).rejects.toThrow("disabled");
  expect(ports.identity).not.toHaveBeenCalled();
  expect(ports.execute).not.toHaveBeenCalled();
});
it("enforces the benchmark whitelist in Executor as well as the model descriptors", async () => {
  const { diagnostics, ports } = fixture();
  const { executor, tools } = createTools(
    new SandboxGitService(),
    { enabled: ["readFile"] },
    undefined,
    undefined,
    undefined,
    diagnostics,
  );
  expect(tools.some((t) => t.name === "runDiagnostic")).toBe(false);
  const result = await executor.execute({ name: "runDiagnostic", input: request }, {
    runId: "run",
    stepId: "step",
    signal,
    emit: async () => undefined,
  } as unknown as ToolContext);
  expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  expect(ports.execute).not.toHaveBeenCalled();
});
it("only offers the optional diagnostic to Coding, not legacy Repair or investigator", () => {
  const { diagnostics } = fixture();
  const { tools } = createTools(
    new SandboxGitService(),
    undefined,
    undefined,
    undefined,
    undefined,
    diagnostics,
  );
  expect(toolsForCoding(tools).some((t) => t.name === "runDiagnostic")).toBe(true);
  expect(toolsForStage(tools, "TEST_REPAIR").some((t) => t.name === "runDiagnostic")).toBe(false);
});

it("persists exact resources before dispatch and never collides with another Run", async () => {
  const first = fixture(),
    second = fixture();
  second.ports.runId = "run-b";
  first.ports.execute.mockImplementationOnce(async () => {
    const inflight = [...first.records.values()][0]!;
    expect(inflight.status).toBe("INFLIGHT");
    expect(inflight.resources).toEqual({
      containerName: `devflow-diagnostic-${inflight.id}`,
      snapshotTag: `devflow-diagnostic:${inflight.id}`,
    });
    throw new Error("lost process receipt");
  });
  await expect(first.diagnostics.run(request, signal)).rejects.toThrow("lost process");
  const frozen = [...first.records.values()][0]!;
  await expect(new AgentDiagnostics(first.ports).run(request, signal)).rejects.toMatchObject({
    details: { requestIssued: false, operations: [{ id: frozen.id, resources: frozen.resources }] },
  });
  await second.diagnostics.run(request, signal);
  expect([...second.records.values()][0]!.resources).not.toEqual(frozen.resources);
  expect(first.ports.execute).toHaveBeenCalledTimes(1);
});
