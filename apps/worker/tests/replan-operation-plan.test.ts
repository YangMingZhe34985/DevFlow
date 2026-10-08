import { describe, expect, it } from "vitest";
import {
  replanOperationPlan,
  prospectiveCheckpointPaths,
  type ReplanOperationInput,
} from "../src/runs/replan-operation-plan.js";
import { estimateOperationPlan } from "../src/runs/resource-budget-scheduler.js";

function operationInput(): ReplanOperationInput {
  return {
    sourceReadPaths: [
      "codec.ts",
      "state.ts",
      "events.ts",
      "storage.ts",
      "tests/state.test.ts",
      "tests/events.test.ts",
    ],
    changedPaths: ["summary.ts"],
    repairContextPaths: Array.from({ length: 8 }, (_, i) => `tests/failure-${i}.test.ts`),
    publicChecks: ["build", "typecheck", "lint", "test"],
    publicProfileDiscovered: true,
    review: {
      requiredSourcePaths: ["summary.ts"],
      optionalSourcePaths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      candidateCaptureRequired: true,
    },
    correctionAvailable: true,
  };
}
describe("actual replanning operation capacity", () => {
  it("counts the actual eight diagnostic paths and discovered commands, separating optional review expansion", () => {
    const result = replanOperationPlan(operationInput());
    expect(result.byPhase).toMatchObject({
      evidence: 6,
      checkpoint: 4,
      restore: 5,
      "repair-context": 10,
      coding: 3,
      validation: 4,
      review: 0,
      delivery: 0,
    });
    expect(result.requiredToolCalls).toBe(32);
    expect(result.optionalToolCalls).toBe(0);
    expect(result.requiredToolExecutions).toBe(34);
    expect(result.optionalToolExecutions).toBe(5);
    expect(estimateOperationPlan(result.plan).resources.logicalToolCalls).toBe(32);
    expect(
      estimateOperationPlan(result.plan, { omitOptional: true }).resources.logicalToolCalls,
    ).toBe(32);
    expect(
      result.operations
        .filter((operation) => operation.requirement === "OPTIONAL")
        .every((operation) => operation.id.startsWith("review:")),
    ).toBe(true);
  });
  it("preserves cached/completed audit rows without recharging their future physical IO", () => {
    const input = operationInput();
    const result = replanOperationPlan({
      ...input,
      cachedSourcePaths: ["codec.ts"],
      checkpointCaptured: true,
      restoreCompleted: true,
    });
    expect(result.byPhase.evidence).toBe(5);
    expect(result.byPhase.checkpoint).toBe(0);
    expect(result.byPhase.restore).toBe(0);
    expect(result.requiredToolCalls).toBe(22);
    expect(result.operations.find((operation) => operation.id === "evidence:codec.ts")?.state).toBe(
      "CACHED",
    );
    expect(
      result.operations.find((operation) => operation.id === "restore:current-sha:summary.ts")
        ?.state,
    ).toBe("COMPLETED");
  });
  it("keeps base and clean-state verification for a zero-change candidate and counts new/deleted records", () => {
    const input = operationInput();
    const clean = replanOperationPlan({ ...input, changedPaths: [] });
    expect(clean.byPhase.checkpoint).toBe(2);
    expect(clean.byPhase.restore).toBe(2);
    const modified = replanOperationPlan({
      ...input,
      changedPaths: ["old.ts", "added.ts", "deleted.ts", "old.ts"],
    });
    expect(modified.byPhase.checkpoint).toBe(8);
    expect(modified.byPhase.restore).toBe(11);
  });
  it("reserves a second edited file before execution without claiming every approved file is changed", () => {
    const paths = prospectiveCheckpointPaths({
      changedPaths: ["old.ts"],
      editPaths: ["new.ts", "new.ts"],
      approvedPaths: ["old.ts", "new.ts", "untouched.ts"],
    });
    expect(paths).toEqual(["old.ts", "new.ts"]);
    const input = operationInput();
    const before = replanOperationPlan({ ...input, changedPaths: ["old.ts"] });
    const after = replanOperationPlan({ ...input, changedPaths: paths });
    expect(after.requiredToolCalls - before.requiredToolCalls).toBe(5);
    expect(
      prospectiveCheckpointPaths({
        changedPaths: [],
        editPaths: [],
        approvedPaths: ["a", "b"],
        unknownMutation: true,
      }),
    ).toEqual(["a", "b"]);
  });
  it("does not remove mandatory review source or validation cost when optional evidence is omitted", () => {
    const input = operationInput();
    input.review.optionalSourcePaths = ["summary.ts", "background.ts"];
    const result = replanOperationPlan(input);
    const estimate = estimateOperationPlan(result.plan, { omitOptional: true });
    expect(estimate.resources.logicalToolCalls).toBe(32);
    expect(estimate.resources.toolExecutions).toBe(34);
    expect(
      result.operations.filter((operation) => operation.id === "review:summary.ts"),
    ).toHaveLength(1);
    expect(
      result.operations.filter(
        (operation) => operation.id.startsWith("validation:") && operation.state === "PENDING",
      ),
    ).toHaveLength(4);
  });
});
