/**
 * Aggregates one or more Phase 0 runner output directories into per-case and overall
 * numbers: strict pass rate, cost, turns, wall time, stop reasons and golden-file reach.
 *
 *   node --import tsx scripts/v4/phase0-report.ts .devflow/v4-phase0/<run-a> [<run-b> ...]
 */
import fs from "node:fs/promises";
import path from "node:path";

interface Summary {
  caseId: string;
  stopReason?: string;
  strictPatchPass?: boolean;
  costCny?: number;
  turns?: number;
  wallSeconds?: number;
  goldenTouched?: number;
  goldenFiles?: string[];
  harnessError?: string;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    unconfirmedCostMicros?: number;
  };
}

const dirs = process.argv.slice(2);
if (!dirs.length) throw new Error("Pass at least one runner output directory.");
const rows: Summary[] = [];
for (const dir of dirs)
  rows.push(
    ...(JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8")) as Summary[]),
  );

const byCase = new Map<string, Summary[]>();
for (const row of rows) byCase.set(row.caseId, [...(byCase.get(row.caseId) ?? []), row]);

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const fmt = (n: number, digits = 2) => n.toFixed(digits);
const lines = [
  "| 案例 | 运行 | 严格通过 | 平均费用 ¥ | 平均轮数 | 平均墙钟 s | golden 触达 | 停止原因 |",
  "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
];
for (const [caseId, runs] of [...byCase].sort(([a], [b]) => a.localeCompare(b))) {
  const passed = runs.filter((r) => r.strictPatchPass).length;
  const reasons = Object.entries(
    runs.reduce<Record<string, number>>((acc, r) => {
      const key = r.harnessError ? "HARNESS_ERROR" : (r.stopReason ?? "UNKNOWN");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
  const reach = runs
    .map((r) => `${r.goldenTouched ?? 0}/${r.goldenFiles?.length ?? "?"}`)
    .join(" ");
  lines.push(
    `| ${caseId} | ${runs.length} | ${passed}/${runs.length} | ${fmt(mean(runs.map((r) => r.costCny ?? 0)))} | ${fmt(mean(runs.map((r) => r.turns ?? 0)), 1)} | ${fmt(mean(runs.map((r) => r.wallSeconds ?? 0)), 0)} | ${reach} | ${reasons} |`,
  );
}
const usage = rows.map((r) => r.usage).filter((u): u is NonNullable<Summary["usage"]> => !!u);
const input = usage.reduce((n, u) => n + u.inputTokens, 0);
const cached = usage.reduce((n, u) => n + u.cachedInputTokens, 0);
const unconfirmed = usage.reduce((n, u) => n + (u.unconfirmedCostMicros ?? 0), 0) / 1_000_000;
const passedCases = [...byCase.values()].filter((runs) =>
  runs.some((r) => r.strictPatchPass),
).length;
lines.push(
  "",
  `运行 ${rows.length} 次，严格通过 ${rows.filter((r) => r.strictPatchPass).length} 次；至少通过一次的案例 ${passedCases}/${byCase.size}。`,
  `总费用（无缓存上限口径）¥${fmt(
    rows.reduce((n, r) => n + (r.costCny ?? 0), 0),
    4,
  )}，未确认上界 ¥${fmt(unconfirmed, 4)}；输入 ${input} Token，其中缓存命中 ${cached}（${input ? fmt((cached / input) * 100, 1) : "0"}%）。`,
);
console.log(lines.join("\n"));
