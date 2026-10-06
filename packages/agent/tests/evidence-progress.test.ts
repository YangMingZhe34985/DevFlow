import { expect, it } from "vitest";
import { EvidenceProgress } from "../src/evidence-progress.js";
it("remembers union coverage; narrower rereads and query metadata are not progress", () => {
  const p = new EvidenceProgress();
  const read = (startLine: number, endLine: number) => ({
    path: "src/a.ts",
    content: "code",
    fileSha256: "a".repeat(64),
    startLine,
    endLine,
  });
  expect(p.observe(read(1, 20), 0)).toBe(true);
  expect(p.observe(read(21, 40), 0)).toBe(true);
  expect(p.observe({ ...read(10, 30), cacheHits: 7 }, 0)).toBe(false);
  expect(p.observe({ ...read(1, 40), fileSha256: "b".repeat(64) }, 1)).toBe(true);
});
it("counts newly observed graph facts, not metrics, ordering or a reworded query", () => {
  const p = new EvidenceProgress(),
    edge = { from: "a.ts", to: "b.ts", kind: "IMPORT", line: 2 };
  const row = { relations: [edge], navigationMetrics: { reads: 3 }, missingInformation: ["A"] };
  expect(p.observe(row, 0)).toBe(true);
  expect(p.observe({ ...row, navigationMetrics: { reads: 4 }, missingInformation: ["B"] }, 0)).toBe(
    false,
  );
  expect(p.observe({ relations: [edge, { ...edge, to: "c.ts" }] }, 0)).toBe(true);
});
it("empty navigation and transport data cannot justify an extension", () => {
  expect(
    new EvidenceProgress().observe(
      {
        implementationEvidence: [],
        navigationMetrics: { reads: 8 },
        missingInformation: ["not found"],
      },
      0,
    ),
  ).toBe(false);
});
it("recognizes real ripgrep string matches without counting query spelling", () => {
  const p = new EvidenceProgress();
  expect(
    p.observe(
      { matches: ["556:14:export const lazyProcessor = fn;", "src/b.ts:12:3:helper()"] },
      0,
      "src/a.ts",
    ),
  ).toBe(true);
  expect(
    p.observe(
      {
        matches: ["src/b.ts:12:3:helper()", "556:14:export const lazyProcessor = fn;"],
        truncated: true,
      },
      0,
      "src/a.ts",
    ),
  ).toBe(false);
  expect(p.observe({ matches: ["src/c.ts:12:3:anotherHelper()"] }, 0, "src/a.ts")).toBe(true);
});
