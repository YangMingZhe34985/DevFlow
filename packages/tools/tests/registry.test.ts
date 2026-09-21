import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolRegistry, type ToolDefinition } from "../src/index.js";

const tool: ToolDefinition<{ path: string }, { content: string }> = {
  name: "readFile",
  description: "Read a UTF-8 file",
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.object({ content: z.string() }),
  permission: "READ",
  timeoutMs: 1_000,
  async execute(input) {
    return { content: input.path };
  },
};

describe("ToolRegistry", () => {
  it("registers and describes tools", () => {
    const registry = new ToolRegistry();
    registry.register(tool);

    expect(registry.get("readFile")).toBeDefined();
    expect(registry.list()).toEqual([
      {
        name: "readFile",
        description: "Read a UTF-8 file",
        inputSchema: tool.inputSchema,
        permission: "READ",
        timeoutMs: 1_000,
        readOnly: true,
        parallelSafe: true,
        mutatesWorkspace: false,
      },
    ]);
  });

  it("rejects duplicate names", () => {
    const registry = new ToolRegistry();
    registry.register(tool);

    expect(() => registry.register(tool)).toThrow("already registered");
  });
});
