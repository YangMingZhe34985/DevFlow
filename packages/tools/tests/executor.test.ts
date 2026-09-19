import { randomUUID } from "node:crypto";

import type { SandboxSession } from "@devflow/sandbox";
import type { NewAgentEvent } from "@devflow/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DefaultToolExecutor,
  ExplicitToolPolicy,
  ToolRegistry,
  type ToolContext,
  type ToolDefinition,
  type ToolPolicy,
} from "../src/index.js";

const sandbox = {
  id: "fake",
  workspacePath: "/workspace",
  async exec() {
    throw new Error("unused");
  },
  async listFiles() {
    throw new Error("unused");
  },
  async readFile() {
    throw new Error("unused");
  },
  async writeFile() {
    throw new Error("unused");
  },
  async applyPatch() {
    throw new Error("unused");
  },
  async dispose() {},
} satisfies SandboxSession;

function createHarness(
  tool: ToolDefinition<{ value: string }, { value: string }>,
  policy: ToolPolicy = new ExplicitToolPolicy(["READ"]),
) {
  const registry = new ToolRegistry();
  registry.register(tool);
  const events: NewAgentEvent[] = [];
  const context: ToolContext = {
    runId: randomUUID(),
    stepId: randomUUID(),
    sandbox,
    signal: new AbortController().signal,
    async emit(event) {
      events.push(event);
    },
  };
  return { executor: new DefaultToolExecutor(registry, policy), context, events };
}

function definition(
  execute: ToolDefinition<{ value: string }, { value: string }>["execute"],
  timeoutMs = 100,
): ToolDefinition<{ value: string }, { value: string }> {
  return {
    name: "sample",
    description: "P2 executor test tool",
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    permission: "READ",
    timeoutMs,
    execute,
  };
}

describe("DefaultToolExecutor", () => {
  it("returns a structured validation error and emits correlated events", async () => {
    const { executor, context, events } = createHarness(definition(async (input) => input));

    const result = await executor.execute({ name: "sample", input: { value: 42 } }, context);

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(events.map(({ type }) => type)).toEqual(["TOOL_CALL", "TOOL_RESULT"]);
    expect(events[0]?.toolCallId).toBe(events[1]?.toolCallId);
  });

  it("applies policy decisions and emits the denied result", async () => {
    const { executor, context, events } = createHarness(
      definition(async (input) => input),
      new ExplicitToolPolicy([]),
    );

    const result = await executor.execute({ name: "sample", input: { value: "blocked" } }, context);

    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(events.map(({ type }) => type)).toEqual(["TOOL_CALL", "TOOL_RESULT"]);
  });

  it("enforces timeout even when a tool ignores its AbortSignal", async () => {
    const { executor, context, events } = createHarness(
      definition(async () => await new Promise<never>(() => undefined), 15),
    );

    const result = await executor.execute({ name: "sample", input: { value: "slow" } }, context);

    expect(result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(events.at(-1)).toMatchObject({ type: "TOOL_RESULT", level: "ERROR" });
  });

  it("normalizes thrown errors and cancellation", async () => {
    const throwing = createHarness(
      definition(async () => {
        throw new Error("boom");
      }),
    );
    const failed = await throwing.executor.execute(
      { name: "sample", input: { value: "x" } },
      throwing.context,
    );
    expect(failed).toMatchObject({ ok: false, error: { code: "TOOL_FAILED" } });

    const cancellation = new AbortController();
    cancellation.abort();
    let executed = false;
    const cancelled = createHarness(
      definition(async (input) => {
        executed = true;
        return input;
      }),
    );
    cancelled.context.signal = cancellation.signal;
    const cancelledResult = await cancelled.executor.execute(
      { name: "sample", input: { value: "x" } },
      cancelled.context,
    );

    expect(cancelledResult).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(executed).toBe(false);
  });
});
