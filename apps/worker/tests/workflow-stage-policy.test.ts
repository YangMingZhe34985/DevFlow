import type { ModelToolDescriptor } from "@devflow/agent";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  stageReasoningEffort,
  stageStepLimit,
  toolsForStage,
} from "../src/runs/workflow-stage-policy.js";

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

  it("clamps adaptive leases without fixed implementation or repair ceilings", () => {
    expect(stageStepLimit("IMPLEMENTATION", 25)).toBe(25);
    expect(stageStepLimit("TEST_REPAIR", 10)).toBe(10);
    expect(stageStepLimit("REVIEW_REPAIR", 10, 3)).toBe(3);
    expect(stageStepLimit("IMPLEMENTATION", 20, 30)).toBe(20);
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
