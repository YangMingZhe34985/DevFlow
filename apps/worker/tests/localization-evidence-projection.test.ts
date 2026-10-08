import { expect, it } from "vitest";
import { projectLocalizationEvidence } from "../src/localization/evidence-projection.js";

const row = (id: string, snippet: string, startLine = 1) => ({
  id,
  path: `src/${id}.ts`,
  contentHash: "a".repeat(64),
  startLine,
  endLine: startLine + snippet.split("\n").length - 1,
  snippet,
});
it("grows the soft target for complete required records while honoring the actual cap", () => {
  const rows = [
    row("behavior", "return value;\n".repeat(2000)),
    row("background", "x".repeat(1000)),
  ];
  const result = projectLocalizationEvidence({
    rows,
    requiredIds: new Set(["behavior"]),
    state: {},
    maxBytes: 64000,
  });
  expect(result.permitted).toBe(true);
  expect(result.selected[0]?.snippet).toBe(rows[0]!.snippet);
  expect(Buffer.byteLength(JSON.stringify(result.state))).toBeLessThanOrEqual(64000);
  const blocked = projectLocalizationEvidence({
    rows,
    requiredIds: new Set(["behavior"]),
    state: {},
    maxBytes: 20000,
  });
  expect(blocked.permitted).toBe(false);
  expect(blocked.requiredBytes).toBeGreaterThan(blocked.maxBytes);
});
it("avoids redundant ranges only when current SHA and exact lines agree", () => {
  const whole = row("whole", "first\nsecond\nthird"),
    inner = { ...row("inner", "second", 2), path: whole.path };
  const result = projectLocalizationEvidence({
    rows: [whole, inner],
    requiredIds: new Set(["whole", "inner"]),
    state: {},
    maxBytes: 10000,
  });
  expect(result.selected).toEqual([whole]);
  expect(result.state.omittedEvidenceDetails[0]?.reason).toBe("COVERED_BY_CURRENT_EVIDENCE");
  const stale = { ...inner, contentHash: "b".repeat(64) };
  expect(
    projectLocalizationEvidence({
      rows: [whole, stale],
      requiredIds: new Set(["whole", "inner"]),
      state: {},
      maxBytes: 10000,
    }).selected,
  ).toHaveLength(2);
  const invented = { ...inner, snippet: "invented" };
  expect(
    projectLocalizationEvidence({
      rows: [whole, invented],
      requiredIds: new Set(["whole", "inner"]),
      state: {},
      maxBytes: 10000,
    }).selected,
  ).toHaveLength(2);
});
