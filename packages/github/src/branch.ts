import { GitHubBranchSchema } from "./contracts.js";

export function branchNameForRun(runId: string): string {
  const trace = runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return GitHubBranchSchema.parse(`devflow/run-${trace.slice(0, 48)}`);
}

export function operationKeyForRun(
  runId: string,
  kind: "push" | "pull-request",
  revision = 0,
): string {
  if (!Number.isInteger(revision) || revision < 0)
    throw new Error("Revision must be non-negative.");
  return `${runId}:${kind}:${String(revision)}`;
}
