import { describe, expect, it } from "vitest";
import { repeatedVerificationReason, stableFailureStream } from "../src/runs/repair-convergence.js";
import { testResultFingerprint } from "../src/runs/workflow-context.js";
const result = (stdout: string) => ({
  exitCode: 1,
  stdout,
  stderr: "",
  durationMs: 1,
  timedOut: false,
  outputTruncated: false,
});
describe("stable public failure and bounded repair", () => {
  it("does not confuse pytest reporter timing with changed assertions", () => {
    const first =
      "FAILED tests/test_names.py::test_equivalence - assert 3 == 0\n51 failed, 1472 passed in 131.54s (0:02:11)\n";
    expect(testResultFingerprint(result(first))).toBe(
      testResultFingerprint(result(first.replace("131.54s (0:02:11)", "139.98s (0:02:19)"))),
    );
    expect(testResultFingerprint(result(first))).not.toBe(
      testResultFingerprint(result(first.replace("3 == 0", "2 == 0"))),
    );
    expect(stableFailureStream("Expected: 131.54s\nActual: 139.98s")).toBe(
      "Expected: 131.54s\nActual: 139.98s",
    );
    expect(testResultFingerprint({ ...result(first), timedOut: true })).not.toBe(
      testResultFingerprint(result(first)),
    );
  });
  it("avoids deterministic repeated failure, while changed candidates and valid counterevidence still validate", () => {
    expect(
      repeatedVerificationReason({
        before: "same",
        after: "same",
        previousFailed: true,
        response: { outcome: "SCOPE_CONFLICT" },
      }),
    ).toBe("SCOPE_CONFLICT");
    expect(
      repeatedVerificationReason({
        before: "same",
        after: "same",
        previousFailed: true,
        response: { outcome: "CHANGED" },
      }),
    ).toBe("UNCHANGED_CANDIDATE_AND_PUBLIC_FAILURE");
    expect(
      repeatedVerificationReason({ before: "same", after: "different", previousFailed: true }),
    ).toBeUndefined();
    expect(
      repeatedVerificationReason({
        before: "same",
        after: "same",
        previousFailed: true,
        response: { outcome: "CONTRADICTED", evidenceStatus: "CURRENT_SOURCE_LINKED" },
      }),
    ).toBeUndefined();
    expect(
      repeatedVerificationReason({ before: "same", after: "same", previousFailed: false }),
    ).toBeUndefined();
  });
});
