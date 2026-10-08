import { createHash } from "node:crypto";

const object = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
/** Source coverage and graph facts, independent of query spelling and transport metrics. */
export class EvidenceProgress {
  private ranges = new Map<string, [number, number][]>();
  private facts = new Set<string>();
  constructor(saved?: { ranges: [string, [number, number][]][]; facts: string[] }) {
    if (saved) {
      this.ranges = new Map(saved.ranges);
      this.facts = new Set(saved.facts);
    }
  }
  snapshot() {
    return { ranges: [...this.ranges], facts: [...this.facts] };
  }
  observe(value: unknown, revision: number, pathHint?: string): boolean {
    const row = object(value);
    let changed = false;
    const text = row.content ?? row.snippet ?? row.code;
    if (typeof row.path === "string" && typeof text === "string" && text.length) {
      const identity = `${row.path}:${row.fileSha256 ?? row.contentHash ?? row.sha256 ?? revision}`;
      const start = typeof row.startLine === "number" ? row.startLine : 1;
      const end =
        typeof row.endLine === "number" ? row.endLine : start + text.split("\n").length - 1;
      const ranges = this.ranges.get(identity) ?? [];
      if (!ranges.some(([a, b]) => a <= start && b >= end)) {
        changed = true;
        const ordered = [...ranges, [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        for (const range of ordered) {
          const last = merged.at(-1);
          if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
          else merged.push([...range]);
        }
        this.ranges.set(identity, merged);
      }
    }
    for (const key of ["files", "implementationEvidence", "matches", "results"]) {
      if (Array.isArray(row[key]))
        for (const item of row[key]) {
          if (key === "matches" && typeof item === "string") {
            const qualified = /^([^:]+):(\d+):(\d+):(.*)$/u.exec(item);
            const local = /^(\d+):(\d+):(.*)$/u.exec(item);
            if (qualified && !/^\d+$/u.test(qualified[1]!))
              changed =
                this.fact({ path: qualified[1], line: Number(qualified[2]), text: qualified[4] }) ||
                changed;
            else if (local && pathHint)
              changed =
                this.fact({ path: pathHint, line: Number(local[1]), text: local[3] }) || changed;
          } else
            changed =
              this.observe(item, revision, typeof row.path === "string" ? row.path : pathHint) ||
              changed;
        }
    }
    if (typeof row.path === "string" && Array.isArray(row.symbols)) {
      for (const s of row.symbols)
        changed = this.fact({ path: row.path, sha: row.sha256, symbol: s }) || changed;
    }
    if (Array.isArray(row.relations))
      for (const r of row.relations) changed = this.fact(r) || changed;
    // Search matches represent observed lines, not a query or aggregate hit count.
    if (typeof row.path === "string" && typeof row.line === "number")
      changed =
        this.fact({ path: row.path, line: row.line, text: row.text ?? row.content }) || changed;
    return changed;
  }
  private fact(value: unknown): boolean {
    const id = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (this.facts.has(id)) return false;
    this.facts.add(id);
    return true;
  }
}
