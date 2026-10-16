/** Trusted host only: official test identifiers never enter the solver fixture. */
export interface TestStatus {
  success: string[];
  failure: string[];
}
export interface OfficialCaseReport {
  resolved: boolean;
  infra_failure?: boolean;
  patch_successfully_applied?: boolean;
  tests_status?: Record<string, TestStatus>;
}
function group(status: TestStatus | undefined, expected: readonly string[]) {
  if (!expected.length) return { status: "NOT_CONFIGURED", passed: 0, failed: 0, missing: 0 };
  const success = new Set(status?.success ?? []),
    failures = new Set(status?.failure ?? []);
  const missing = expected.filter((t) => !success.has(t) && !failures.has(t)).length;
  const failed = expected.filter((t) => failures.has(t)).length;
  const passed = expected.filter((t) => success.has(t) && !failures.has(t)).length;
  return { status: missing ? "INCOMPLETE" : failed ? "FAIL" : "PASS", passed, failed, missing };
}
export function mapOfficial(
  report: OfficialCaseReport,
  expected: { f2p: string[]; p2p: string[] },
  integrity: {
    nonemptyPatch: boolean;
    protectedChanges: string[];
    network: string;
    durationSeconds: number;
  },
) {
  const baseline = group(report.tests_status?.PASS_TO_PASS, expected.p2p);
  const core = group(report.tests_status?.FAIL_TO_PASS, expected.f2p);
  const valid =
    !report.infra_failure &&
    report.patch_successfully_applied === true &&
    integrity.nonemptyPatch &&
    !integrity.protectedChanges.length &&
    integrity.network === "none" &&
    integrity.durationSeconds >= 0 &&
    integrity.durationSeconds <= 300;
  return {
    officialResolved: report.resolved === true,
    strictPatchPass:
      valid && report.resolved === true && baseline.status === "PASS" && core.status === "PASS",
    baseline,
    core,
    reproduction: { status: "NOT_CONFIGURED" },
    note: "Patch acceptance only; not a claim of completed independent Review or live solve.",
  };
}
export function auditBoundary(input: {
  flattened: boolean;
  gitRoots: string[];
  distinctTrees: number;
  privateMatches: number;
  imageId: string;
  auditedImageId: string;
  network: string;
  user: string;
}) {
  return (
    input.flattened &&
    input.gitRoots.length === 1 &&
    input.gitRoots[0] === "workspace" &&
    input.distinctTrees === 1 &&
    input.privateMatches === 0 &&
    input.imageId === input.auditedImageId &&
    input.network === "none" &&
    input.user === "10001"
  );
}
