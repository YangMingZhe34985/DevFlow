import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import {
  authorizeLive,
  BatchBudget,
  runWithinBudget,
  redact,
} from "../../scripts/v4/external-set/live-budget.js";
import { fakeSandbox } from "../../apps/worker/tests/autonomous-test-support.js";

const valid = { cases: "X11,X19", budgetCny: "4", perCaseCny: "2" };
describe("explicit live authorization", () => {
  it.each([
    { ...valid, cases: undefined },
    { ...valid, budgetCny: undefined },
    { ...valid, perCaseCny: undefined },
    { ...valid, budgetCny: "NaN" },
    { ...valid, perCaseCny: "0" },
    { ...valid, budgetCny: "0.1" },
    { ...valid, cases: "X11,X11" },
  ])("rejects %j before model dispatch", (args) => {
    const fake = new FakeLanguageModel([]);
    expect(() => authorizeLive(args)).toThrow();
    expect(fake.requests).toHaveLength(0);
  });
  it("keeps exact micro-currency precision", () =>
    expect(authorizeLive(valid)).toEqual({
      cases: ["X11", "X19"],
      budgetMicros: 4_000_000,
      perCaseMicros: 2_000_000,
    }));
});
describe("real Kernel budget through Fake model", () => {
  const input = (model: FakeLanguageModel) => ({
    sandboxFactory: async () => fakeSandbox().sandbox,
    maxAttempts: 1,
    issue: { title: "public issue", body: "Fix it" },
    checks: [],
    model,
    price: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 },
    settings: { maxOutputTokens: 64 },
    limits: { maxTurns: 2 },
    signal: new AbortController().signal,
  });
  it("allows a bounded Fake submission and records actual usage", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [{ id: "s", name: "submit", input: { summary: "done" } }],
        usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      }),
    ]);
    const authorization = authorizeLive({ cases: "X11", budgetCny: "0.02", perCaseCny: "0.02" });
    const result = await runWithinBudget(input(model), authorization.perCaseMicros);
    expect(model.requests).toHaveLength(1);
    expect(result.usage.costMicros).toBe(10);
    expect(result.selected.kernel.stopReason).toBe("SUBMITTED");
  });
  it("insufficient Kernel budget sends no Fake request", async () => {
    const model = new FakeLanguageModel([]);
    const result = await runWithinBudget(input(model), 1);
    expect(model.requests).toHaveLength(0);
    expect(result.selected.kernel.stopReason).toBe("COST_LIMIT");
  });
});
describe("durable serial batch reservations", () => {
  it("unknown consumption stays reserved and prevents extra case spending", async () => {
    const root = path.resolve(".devflow/external-set-suite/private/bootstrap/unit-temp");
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, "live-budget-"));
    try {
      const file = path.join(directory, "budget.json");
      const ledger = new BatchBudget(
        file,
        authorizeLive({ cases: "X11,X19", budgetCny: "2", perCaseCny: "2" }),
      );
      await ledger.initialize();
      expect(await ledger.reserve("X11")).toBe(2_000_000);
      await ledger.settle("X11");
      expect(await ledger.reserve("X19")).toBeUndefined();
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      expect(saved.entries[0].status).toBe("UNKNOWN");
      await expect(new BatchBudget(file, authorizeLive(valid)).initialize()).rejects.toThrow();
      await expect(ledger.reserve("X11")).rejects.toThrow();
    } finally {
      for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
      await fs.rmdir(directory);
    }
  });
  it("redacts actual configured credentials instead of serializing SDK configuration", () => {
    expect(
      redact({ error: "key credential-value appeared" }, { LLM_API_KEY: "credential-value" }),
    ).not.toContain("credential-value");
  });
});
