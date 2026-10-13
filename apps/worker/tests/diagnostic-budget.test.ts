import { expect, it, vi } from "vitest";
import { InMemoryBudgetLedgerStore } from "@devflow/database";
import { z } from "zod";
import { optimizeContextProjection, type ModelRequest } from "@devflow/agent";
import {
  diagnosticContinuationPlan,
  diagnosticOperationPlan,
  executeDiagnosticBudget,
} from "../src/runs/agent-diagnostics.js";
import {
  estimateOperationPlan,
  ResourceBudgetScheduler,
  type ResourceBudgetOperationPlan,
} from "../src/runs/resource-budget-scheduler.js";

const price = { inputMicrosPerMillionTokens: 8_000_000, outputMicrosPerMillionTokens: 28_000_000 };
const continuation: ResourceBudgetOperationPlan = {
  kind: "OPERATION",
  id: "validation-review",
  requirement: "REQUIRED",
  state: "PENDING",
  costStatus: "PRICED",
  resources: {
    inputTokens: 3000,
    outputTokens: 32768,
    modelCalls: 2,
    steps: 2,
    logicalToolCalls: 3,
    timeMs: 780000,
    costMicros: 909000,
  },
};
async function setup(limits = {}) {
  const now = Date.now();
  return ResourceBudgetScheduler.open({
    runId: "diagnostic-test",
    store: new InMemoryBudgetLedgerStore(),
    startedAt: now,
    deadlineAt: now + 1_500_000,
    limits: {
      tokens: 320000,
      logicalToolCalls: 75,
      steps: 32,
      timeMs: 1500000,
      costMicros: 4_000_000,
      ...limits,
    },
  });
}
const projection = () =>
  diagnosticContinuationPlan({
    id: "future",
    request: {
      messages: [
        { role: "SYSTEM", content: "Task and latest approval must remain." },
        { role: "USER", content: "Fix the public failure; preserve known counterevidence." },
      ],
      tools: [
        { name: "readFile", description: "read", inputSchema: z.object({ path: z.string() }) },
      ],
      settings: { maxOutputTokens: 8192 },
    },
    contextTokens: 32000,
    outputTokens: 8192,
    logicalToolCapacity: 16,
    continuation,
    price,
  });

it("projects actual history and schemas, then adds next Coding and final validation sequentially", async () => {
  const projected = await projection(),
    quoted = estimateOperationPlan(projected.plan);
  expect(projected.audit.inputBytes).toBeGreaterThan(200);
  expect(projected.audit.inputFingerprint).toHaveLength(64);
  expect(quoted.resources).toMatchObject({
    logicalToolCalls: 16,
    modelCalls: 3,
    steps: 3,
    timeMs: 840000,
    outputTokens: 40960,
  });
  expect(quoted.resources.inputTokens).toBe(
    3000 + projected.audit.inputTokens + Math.ceil(32768 / 3),
  );
  expect(quoted.resources.costMicros).toBe(
    909000 +
      Math.ceil(
        ((projected.audit.inputTokens + Math.ceil(32768 / 3)) * 8_000_000 + 8192 * 28_000_000) /
          1_000_000,
      ),
  );
});

it("forecasts pending tool observations only for quotation; the real Session remains pending", async () => {
  const request: ModelRequest = {
    messages: [
      { role: "USER", content: "Task and approved scope" },
      {
        role: "ASSISTANT",
        content: "Check public behavior",
        toolCalls: [
          {
            id: "diagnostic-1",
            name: "runDiagnostic",
            input: { checkId: "0:test", reason: "need public feedback" },
          },
        ],
      },
    ],
    tools: [],
  };
  const original = structuredClone(request);
  const quote = await diagnosticContinuationPlan({
    id: "forecast",
    request,
    contextTokens: 32000,
    outputTokens: 8192,
    logicalToolCapacity: 16,
    continuation,
    price,
  });
  expect(quote.audit.inputTokens).toBeGreaterThan(0);
  expect(request).toEqual(original);
  await expect(optimizeContextProjection({ request, maxBytes: 96000 })).rejects.toThrow(
    "CONTEXT_PENDING_ACTIONS",
  );
});

it("admits all five Docker boundaries and settles real returned bytes without inventing repository IO", async () => {
  const scheduler = await setup();
  const plan = diagnosticOperationPlan("lifetime"),
    quote = estimateOperationPlan(plan);
  expect(quote.resources).toMatchObject({
    toolExecutions: 5,
    ioReads: 0,
    ioWrites: 0,
    ioBytes: 166 * 1024,
    timeMs: 40000,
  });
  await scheduler.replaceHold("future", (await projection()).plan);
  expect((await scheduler.reserve("lifetime", plan)).reserved).toBe(true);
  await scheduler.admit("lifetime");
  const events: Record<string, unknown>[] = [];
  const value = await executeDiagnosticBudget({
    scheduler,
    operationId: "lifetime",
    record: async (e) => {
      events.push(e);
    },
    run: async (execute) => {
      for (const label of [
        "inspect-candidate",
        "capture-snapshot",
        "execute-public-check",
        "cleanup-container",
        "cleanup-snapshot",
      ])
        await execute(label, async () => ({ stdout: "汉字", stderr: "failure" }));
      return "result";
    },
  });
  expect(value).toBe("result");
  const ledger = await scheduler.snapshot();
  expect(ledger.consumed).toMatchObject({
    toolExecutions: 5,
    ioReads: 0,
    ioWrites: 0,
    ioBytes: 65,
    modelCalls: 0,
    logicalToolCalls: 0,
  });
  expect(events).toHaveLength(10);
  expect(events.every((e) => e.containerFilesystemIO === "UNOBSERVED")).toBe(true);
  expect(ledger.reservations.lifetime?.status).toBe("SETTLED");
  expect(ledger.reservations.future?.status).toBe("RESERVED");
});

it("retains required continuation and refuses optional diagnostic before any Docker dispatch", async () => {
  const scheduler = await setup({ logicalToolCalls: 15 });
  const future = await scheduler.replaceHold("future", (await projection()).plan);
  expect(future.reserved).toBe(false);
  expect(future.quote.shortfalls.logicalToolCalls).toBe(1);
  const run = vi.fn();
  await expect(
    executeDiagnosticBudget({ scheduler, operationId: "lifetime", record: async () => {}, run }),
  ).rejects.toThrow("not admitted");
  expect(run).not.toHaveBeenCalled();
  expect((await scheduler.snapshot()).consumed.toolExecutions).toBe(0);
});

it("cleanup uses already admitted capacity after cancellation without another admission", async () => {
  const scheduler = await setup();
  await scheduler.reserve("lifetime", diagnosticOperationPlan("lifetime"));
  await scheduler.admit("lifetime");
  const reserve = vi.spyOn(scheduler, "reserve"),
    admit = vi.spyOn(scheduler, "admit");
  const labels: string[] = [];
  await expect(
    executeDiagnosticBudget({
      scheduler,
      operationId: "lifetime",
      record: async (e) => {
        if (e.status === "INFLIGHT") labels.push(String(e.label));
      },
      run: async (execute) => {
        try {
          await execute("execute-public-check", async () => {
            throw new Error("aborted without receipt");
          });
        } finally {
          await execute("cleanup-container", async () => ({ stdout: "removed", stderr: "" }));
          await execute("cleanup-snapshot", async () => ({ stdout: "removed", stderr: "" }));
        }
      },
    }),
  ).rejects.toThrow("aborted");
  expect(labels).toEqual(["execute-public-check", "cleanup-container", "cleanup-snapshot"]);
  expect(reserve).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
  const ledger = await scheduler.snapshot();
  expect(ledger.reservations.lifetime?.status).toBe("ADMITTED");
  expect(ledger.reservations.lifetime?.knownUsage?.toolExecutions).toBe(3);
  expect((await scheduler.admit("lifetime")).admitted).toBe(false);
});

it("a callback whose receipt outlives the runner keeps the reservation unknown", async () => {
  const scheduler = await setup();
  await scheduler.reserve("lifetime", diagnosticOperationPlan("lifetime"));
  await scheduler.admit("lifetime");
  let finish!: () => void;
  let late: Promise<unknown> | undefined;
  await executeDiagnosticBudget({
    scheduler,
    operationId: "lifetime",
    record: async () => {},
    run: async (execute) => {
      late = execute(
        "execute-public-check",
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ stdout: "late", stderr: "" });
          }),
      );
      await Promise.resolve();
      return "aborted before receipt";
    },
  });
  expect((await scheduler.snapshot()).reservations.lifetime?.status).toBe("ADMITTED");
  finish();
  await late;
});

it("a delayed INFLIGHT persistence cannot dispatch Docker after its lifetime has closed", async () => {
  const scheduler = await setup();
  await scheduler.reserve("lifetime", diagnosticOperationPlan("lifetime"));
  await scheduler.admit("lifetime");
  let acknowledge!: () => void;
  let late: Promise<unknown> | undefined;
  const work = vi.fn(async () => ({ stdout: "must not run", stderr: "" }));
  await executeDiagnosticBudget({
    scheduler,
    operationId: "lifetime",
    record: async (e) => {
      if (e.status === "INFLIGHT")
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
    },
    run: async (execute) => {
      late = execute("execute-public-check", work);
      return "callback deadline elapsed";
    },
  });
  acknowledge();
  await expect(late).rejects.toThrow("late execution forbidden");
  expect(work).not.toHaveBeenCalled();
  expect((await scheduler.snapshot()).reservations.lifetime?.status).toBe("ADMITTED");
});
