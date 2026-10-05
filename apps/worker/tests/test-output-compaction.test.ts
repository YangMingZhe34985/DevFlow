import { expect, it } from "vitest";
import { compactTestOutput } from "../src/runs/workflow-context.js";

it("retains actionable assertion evidence and totals when terminal styling and pass reports fill the old prefix", () => {
  const passing = Array.from(
    { length: 300 },
    (_, index) => ` \u001b[32m✓\u001b[39m src/module-${index}/test.ts (10 tests) 2ms`,
  ).join("\n");
  const failure =
    "FAIL critical.test.ts > fractional boundary\nExpected: 12:14\nReceived: 12:13\n at critical.test.ts:42:7\nTests 1 failed | 3000 passed";
  const result = {
    exitCode: 1,
    stdout: passing + "\n" + failure,
    stderr: "Warning: deprecated API",
    durationMs: 50,
    timedOut: false,
    outputTruncated: false,
  };
  const raw = result.stdout;
  const text = compactTestOutput(result);
  expect(text).toContain(failure);
  expect(text).toContain("300 passing file summaries omitted");
  expect(text).toContain("Warning: deprecated API");
  expect(text).not.toContain("\u001b");
  expect(result.stdout).toBe(raw);
});

it("preserves failed and skipped file records, arbitrary diagnostics and bounded unicode output", () => {
  const diagnostic =
    " ✓ mixed.test.ts (5 tests | 1 failed) 3ms\n ↓ skipped.test.ts (1 test)\nAssertionError: custom mismatch\n+ actual\n- expected";
  const text = compactTestOutput({
    exitCode: 1,
    stdout: diagnostic,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
  });
  expect(text).toContain(diagnostic);
  const bounded = compactTestOutput({
    exitCode: 1,
    stdout: "边界🧪".repeat(20_000),
    stderr: "",
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
  });
  expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(48 * 1024);
  expect(bounded).toContain("...[truncated]");
});
