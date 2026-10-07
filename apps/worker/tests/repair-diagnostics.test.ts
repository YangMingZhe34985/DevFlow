import { describe, expect, it } from "vitest";
import {
  resolveRepairDiagnostics,
  repairModeInstructions,
} from "../src/runs/repair-diagnostics.js";
import { verifiedReplanPaths } from "../src/runs/scope-replanning.js";

describe("shared repository diagnostic identities", () => {
  it("maps a Mockito Java frame to the package-qualified repository implementation", () => {
    const path =
      "src/main/java/com/accesshub/permission/cache/PolicyCacheInvalidationListener.java";
    const output =
      "-> at com.accesshub.permission.cache.PolicyCacheInvalidationListener.onPolicyChanged(PolicyCacheInvalidationListener.java:40)";
    const paths = [path, "src/other/PolicyCacheInvalidationListener.java"];
    const resolution = resolveRepairDiagnostics(output, paths);
    expect(resolution.resolved).toEqual([
      expect.objectContaining({ path, line: 40, resolution: "JAVA_CLASS" }),
    ]);
    expect(verifiedReplanPaths([path], output, [], () => true, paths)).toEqual([path]);
  });
  it("filters unrelated framework frames before selecting project files", () => {
    const output =
      Array.from({ length: 20 }, (_, i) => `at java.base.J${i}.run(J${i}.java:1)`).join("\n") +
      '\nFile "/workspace/src/registry.py", line 115';
    expect(resolveRepairDiagnostics(output, ["src/registry.py"]).resolved[0]?.path).toBe(
      "src/registry.py",
    );
  });
  it("does not guess duplicate basenames and retains concrete candidates", () => {
    const result = resolveRepairDiagnostics("Handler.java:3: error", [
      "a/Handler.java",
      "b/Handler.java",
    ]);
    expect(result.resolved).toEqual([]);
    expect(result.unresolved[0]).toMatchObject({
      reason: "AMBIGUOUS",
      candidates: ["a/Handler.java", "b/Handler.java"],
    });
  });
  it("distinguishes an incomplete manifest from known absence and rejects outside paths", () => {
    expect(resolveRepairDiagnostics("missing.py:4: error", [], false).unresolved[0]?.reason).toBe(
      "MANIFEST_INCOMPLETE",
    );
    expect(resolveRepairDiagnostics("missing.py:4: error", [], true).unresolved[0]?.reason).toBe(
      "NOT_IN_REPOSITORY",
    );
    expect(resolveRepairDiagnostics("/tmp/outside.py:4: error", ["outside.py"]).resolved).toEqual(
      [],
    );
  });
  it("retains exact paths and unique project suffixes", () => {
    expect(
      resolveRepairDiagnostics("src/file.cpp:12: error", ["src/file.cpp"]).resolved[0]?.resolution,
    ).toBe("EXACT");
    expect(
      resolveRepairDiagnostics("file.cpp:12: error", ["src/file.cpp"]).resolved[0]?.resolution,
    ).toBe("UNIQUE_SUFFIX");
  });
  it("separates test diagnostics and host Review finding identities", () => {
    expect(repairModeInstructions("TEST_REPAIR")).toContain("Omit findingIds and findingResponses");
    expect(repairModeInstructions("REVIEW_REPAIR", ["finding-1"])).toContain('"finding-1"');
    expect(repairModeInstructions("TEST_REPAIR")).toContain("literal current source");
  });
  it("does not assert unique basename resolution from a truncated manifest", () => {
    const result = resolveRepairDiagnostics("Handler.java:3: error", ["a/Handler.java"], false);
    expect(result.resolved).toEqual([]);
    expect(result.unresolved[0]?.reason).toBe("MANIFEST_INCOMPLETE");
  });
});

it("excludes a completed passing Surefire expected-exception block from triage, preserving real and unknown failures", async () => {
  const { diagnosticTriageText } = await import("../src/runs/repair-diagnostics.js");
  const output = [
    "[INFO] Running demo.ExpectedTest",
    "java.lang.Exception: deliberate invalid input",
    " at demo.Noise.validate(Noise.java:9)",
    "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in demo.ExpectedTest",
    "[INFO] Running demo.ListenerTest",
    "[ERROR] ListenerTest.change <<< FAILURE!",
    "Wanted but not invoked: invalidateOrganization",
    " at demo.Listener.handle(Listener.java:40)",
    "[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.1 s <<< FAILURE! -- in demo.ListenerTest",
    "[INFO] Running demo.IncompleteTest",
    " at demo.Other.run(Other.java:7)",
  ].join("\n");
  const triaged = diagnosticTriageText(output);
  expect(triaged).not.toContain("Noise.java");
  expect(triaged).toContain("Wanted but not invoked");
  expect(triaged).toContain("Other.java");
  expect(output).toContain("Noise.java");
  const result = resolveRepairDiagnostics(output, [
    "src/demo/Noise.java",
    "src/demo/Listener.java",
    "src/demo/Other.java",
  ]);
  expect(result.resolved.map((d) => d.path)).not.toContain("src/demo/Noise.java");
  expect(result.resolved.map((d) => d.path)).toContain("src/demo/Listener.java");
});
