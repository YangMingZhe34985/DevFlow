/** Explicit allowlist: upstream records must never be spread into solver inputs. */
import type { PublicCheck } from "../../../apps/worker/src/autonomous/solve.js";
export interface ExternalRecord {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;
  test_patch: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  eval_script: string;
}
export interface PublicFixture {
  version: 1;
  caseId: string;
  source: {
    dataset: string;
    revision: string;
    instanceId: string;
    repo: string;
    baseCommit: string;
  };
  task: { title: string; description: string };
  imageId: string;
  snapshotSha256: string;
  publicChecks: {
    status: "NOT_CONFIGURED" | "CONFIGURED";
    checks: PublicCheck[];
    sources?: { path: string; line: number; quote: string; sha256: string }[];
    excludedBaseTests?: { id: string; reason: string; evidence: string }[];
    scopeReason?: string;
    runtimeEnvironment?: Record<string, string>;
  };
}
export function adaptPublic(
  record: ExternalRecord,
  identity: {
    caseId: string;
    dataset: string;
    revision: string;
    imageId: string;
    snapshotSha256: string;
  },
): PublicFixture {
  for (const sha of [record.base_commit, identity.revision])
    if (!/^[a-f0-9]{40}$/.test(sha)) throw Error("Unfrozen source identity");
  if (
    !/^X[A-Z0-9]+$/.test(identity.caseId) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.imageId) ||
    !/^[a-f0-9]{64}$/.test(identity.snapshotSha256)
  )
    throw Error("Invalid preparation identity");
  if (
    !record.problem_statement.trim() ||
    !record.FAIL_TO_PASS.length ||
    !record.PASS_TO_PASS.length
  )
    throw Error("Incomplete issue or official controls");
  return {
    version: 1,
    caseId: identity.caseId,
    source: {
      dataset: identity.dataset,
      revision: identity.revision,
      instanceId: record.instance_id,
      repo: record.repo,
      baseCommit: record.base_commit,
    },
    task: { title: record.instance_id, description: record.problem_statement },
    imageId: identity.imageId,
    snapshotSha256: identity.snapshotSha256,
    publicChecks: { status: "NOT_CONFIGURED", checks: [] },
  };
}
/** Generic host protection, independent of private test names. */
export function protectedPath(value: string): string | undefined {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((p) => ["..", ".git"].includes(p))
  )
    return "Unsafe path";
  return /(^|\/)(tests?|testing|__tests__|buildScripts|\.github)(\/|$)|(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|build\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradlew(?:\.bat)?|Makefile|pytest\.ini|tox\.ini|pyproject\.toml|setup\.(?:cfg|py)|conftest\.py|requirements[^/]*\.txt|tsconfig[^/]*\.json|(?:jest|vite|vitest)\.config\.[cm]?[jt]s)$|(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$|(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(
    value,
  )
    ? "Existing tests and build/test configuration are read-only"
    : undefined;
}
