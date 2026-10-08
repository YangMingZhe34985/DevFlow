import type { ResourceBudgetOperationPlan } from "./resource-budget-scheduler.js";

export interface ReplanOperationInput {
  sourceReadPaths: readonly string[];
  cachedSourcePaths?: readonly string[];
  metadataPaths?: readonly string[];
  changedPaths: readonly string[];
  /** Exact paths selected by repairContextSourcePaths, not the candidate count. */
  repairContextPaths: readonly string[];
  cachedRepairContextPaths?: readonly string[];
  cachedCheckpointCurrentPaths?: readonly string[];
  cachedCheckpointBaselinePaths?: readonly string[];
  checkpointCaptured?: boolean;
  /** HEAD is reused only while host identity continuity is established. */
  baseHeadVerified?: boolean;
  restoreCompleted?: boolean;
  repairContextPrepared?: boolean;
  publicChecks: readonly string[];
  publicProfileDiscovered: boolean;
  review: {
    requiredSourcePaths: readonly string[];
    optionalSourcePaths?: readonly string[];
    cachedSourcePaths?: readonly string[];
    diffCurrent?: boolean;
    candidateCaptureRequired: boolean;
  };
  /** Existing correction credit; consumed credit cannot be reserved again. */
  correctionAvailable: boolean;
}

type Operation = Extract<ResourceBudgetOperationPlan, { kind: "OPERATION" }>;
const unique = (paths: readonly string[] = []) => [...new Set(paths)];

/** This is an operation list, not a stage quota. The caller executes these same selected paths.
 * Cached/completed rows remain auditable while consuming no future execution capacity. */
export function replanOperationPlan(input: ReplanOperationInput) {
  const operations: Operation[] = [];
  const add = (
    phase: string,
    id: string,
    reason: string,
    options: { cached?: boolean; completed?: boolean; optional?: boolean; write?: boolean } = {},
  ) =>
    operations.push({
      kind: "OPERATION",
      id: `${phase}:${id}`,
      requirement: options.optional ? "OPTIONAL" : "REQUIRED",
      state: options.completed ? "COMPLETED" : options.cached ? "CACHED" : "PENDING",
      resources: {
        // Initial Review/delivery host evidence is internal execution in the existing
        // runtime ledger. It must not also spend the 75 logical Agent/host-call limit.
        logicalToolCalls: phase === "review" || phase === "delivery" ? 0 : 1,
        toolExecutions: 1,
        ...(options.write ? { ioWrites: 1 } : { ioReads: 1 }),
      },
      reason,
    });
  for (const path of unique(input.sourceReadPaths))
    add("evidence", path, "Verify current public failure and candidate source", {
      cached: input.cachedSourcePaths?.includes(path) ?? false,
    });
  for (const path of unique(input.metadataPaths))
    add("metadata", path, "Resolve a path missing from the available repository manifest");
  add("checkpoint", "head", "Verify immutable base before candidate capture", {
    cached: input.baseHeadVerified ?? false,
    completed: input.checkpointCaptured ?? false,
  });
  add("checkpoint", "status", "Enumerate actual cumulative changes including new/deleted files", {
    completed: input.checkpointCaptured ?? false,
  });
  for (const path of unique(input.changedPaths)) {
    add("checkpoint", `baseline:${path}`, "Read immutable baseline source", {
      cached: input.cachedCheckpointBaselinePaths?.includes(path) ?? false,
      completed: input.checkpointCaptured ?? false,
    });
    add("checkpoint", `current:${path}`, "Save full current source or explicit deletion identity", {
      cached: input.cachedCheckpointCurrentPaths?.includes(path) ?? false,
      completed: input.checkpointCaptured ?? false,
    });
  }
  for (const kind of ["head", "clean-status"])
    add("restore", kind, "Check new Sandbox base and clean state before restore", {
      completed: input.restoreCompleted ?? false,
    });
  for (const path of unique(input.changedPaths)) {
    for (const kind of ["baseline-sha", "restore-write", "current-sha"])
      add(
        "restore",
        `${kind}:${path}`,
        "Validate original approval/base, restore and verify full current SHA",
        {
          completed: input.restoreCompleted ?? false,
          write: kind === "restore-write",
        },
      );
  }
  for (const kind of ["status", "diff"])
    add(
      "repair-context",
      kind,
      "Collect candidate and public failure for the continuing Coding Session",
      {
        completed: input.repairContextPrepared ?? false,
      },
    );
  for (const path of unique(input.repairContextPaths))
    add("repair-context", path, "Read the actual selected diagnostic/additional/changed source", {
      completed: input.repairContextPrepared ?? false,
      cached: input.cachedRepairContextPaths?.includes(path) ?? false,
    });
  add("coding", "edit", "One admitted edit", { write: true });
  if (input.correctionAvailable)
    add("coding", "correction", "Existing single edit correction", { write: true });
  operations.push({
    kind: "OPERATION",
    id: "coding:finish",
    requirement: "REQUIRED",
    state: "PENDING",
    resources: { logicalToolCalls: 1 },
    reason: "Submit candidate to mandatory public validation",
  });
  add("validation", "discover-profile", "Discover public commands only if not already available", {
    cached: input.publicProfileDiscovered,
  });
  for (const command of unique(input.publicChecks))
    add("validation", command, "Execute a configured mandatory public check");
  add("review", "diff", "Independent Review receives the actual cumulative diff", {
    cached: input.review.diffCurrent ?? false,
  });
  for (const path of unique(input.review.requiredSourcePaths))
    add("review", path, "Required current implementation evidence for independent Review", {
      cached: input.review.cachedSourcePaths?.includes(path) ?? false,
    });
  for (const path of unique(input.review.optionalSourcePaths).filter(
    (path) => !input.review.requiredSourcePaths.includes(path),
  ))
    add(
      "review",
      path,
      "Optional related-source expansion; omit only from the operation plan before execution",
      {
        optional: true,
        cached: input.review.cachedSourcePaths?.includes(path) ?? false,
      },
    );
  if (input.review.candidateCaptureRequired)
    add(
      "delivery",
      "candidate",
      "Capture final candidate after mandatory validation and independent Review",
    );
  const required = operations.filter(
    (operation) => operation.state === "PENDING" && operation.requirement === "REQUIRED",
  );
  const optional = operations.filter(
    (operation) => operation.state === "PENDING" && operation.requirement === "OPTIONAL",
  );
  const count = (selected: readonly Operation[]) =>
    selected.reduce((sum, operation) => sum + (operation.resources.logicalToolCalls ?? 0), 0);
  return {
    plan: { kind: "SEQUENCE" as const, id: "scope-replanning", operations },
    operations,
    requiredToolCalls: count(required),
    optionalToolCalls: count(optional),
    requiredToolExecutions: required.reduce(
      (sum, operation) => sum + (operation.resources.toolExecutions ?? 0),
      0,
    ),
    optionalToolExecutions: optional.reduce(
      (sum, operation) => sum + (operation.resources.toolExecutions ?? 0),
      0,
    ),
    downstreamToolCalls: count(
      required.filter((operation) => !/^(?:evidence|metadata|checkpoint):/u.test(operation.id)),
    ),
    byPhase: Object.fromEntries(
      [...new Set(operations.map((operation) => operation.id.split(":")[0]!))].map((phase) => [
        phase,
        count(required.filter((operation) => operation.id.startsWith(`${phase}:`))),
      ]),
    ),
  };
}

/** Reserve changed-set growth before the edit, including a newly modified approved file.
 * Restoration and future checkpoint/identity collection are distinct sequential operations. */
export function prospectiveCheckpointPaths(input: {
  changedPaths: readonly string[];
  editPaths: readonly string[];
  approvedPaths: readonly string[];
  unknownMutation?: boolean;
}) {
  return unique(
    input.unknownMutation ? input.approvedPaths : [...input.changedPaths, ...input.editPaths],
  );
}
