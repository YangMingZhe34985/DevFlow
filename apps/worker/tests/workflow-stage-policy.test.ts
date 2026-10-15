import type { ModelToolDescriptor } from "@devflow/agent";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { stageReasoningEffort, toolsForStage } from "../src/runs/workflow-stage-policy.js";

const tools: ModelToolDescriptor[] = [
  descriptor("listFiles"),
  descriptor("readFile"),
  descriptor("applyPatch"),
  descriptor("runCommand"),
];

describe("workflow stage policy", () => {
  it("keeps deterministic tests out of implementation and repair toolsets", () => {
    expect(toolsForStage(tools, "IMPLEMENTATION").map(({ name }) => name)).toEqual([
      "listFiles",
      "readFile",
      "applyPatch",
      "finishPhase",
    ]);
    expect(toolsForStage(tools, "TEST_REPAIR").map(({ name }) => name)).toEqual([
      "readFile",
      "applyPatch",
      "finishPhase",
    ]);
  });

  it("uses efficient reasoning only when the profile opts in", () => {
    expect(stageReasoningEffort("IMPLEMENTATION", "efficient")).toBe("low");
    expect(stageReasoningEffort("TEST_REPAIR", "efficient")).toBe("medium");
    expect(stageReasoningEffort("IMPLEMENTATION", "provider-default")).toBeUndefined();
  });
});

function descriptor(name: string): ModelToolDescriptor {
  return { name, description: name, inputSchema: z.object({}) };
}
