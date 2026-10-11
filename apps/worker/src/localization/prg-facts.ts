import type { RelationGraphArtifact } from "./relation-graph.js";

export interface PrgRelationFact {
  from: string;
  to: string | null;
  name: string;
  relation: "DECLARES" | "IMPORTS" | "REFERENCES" | "CALLS";
  status: "VERIFIED" | "UNRESOLVED" | "DYNAMIC";
  evidence: {
    path: string;
    sourceSha: string;
    startLine: number;
    endLine: number;
    parser: string;
    configurationHash: string;
  };
}
/** Reverse queries inspect only current, source-bound facts. Missing edges are unknown. */
export function queryPrgFacts(
  graph: RelationGraphArtifact,
  paths: readonly string[],
  symbols: readonly string[] = [],
  limit = 32,
) {
  const facts: PrgRelationFact[] = [];
  const targets = new Set(paths);
  const names = new Set(symbols);
  const relevant = new Set(paths);
  for (const e of graph.edges) if (!e.stale && e.to && targets.has(e.to)) relevant.add(e.from);
  for (const file of graph.files) {
    if (file.state !== "CURRENT" || !file.sha256 || !relevant.has(file.path)) continue;
    const parser = file.prgFacts?.parserVersion ?? graph.parserVersion;
    const base = {
      path: file.path,
      sourceSha: file.sha256,
      parser,
      configurationHash: graph.configurationHash,
    };
    const declarations = file.prgFacts?.syntax.declarations ?? file.parse?.symbols ?? [];
    const sound = file.prgFacts?.syntax.status === "PARSED" || file.parse?.status === "PARSED";
    for (const d of declarations)
      if (!names.size || names.has(d.name))
        facts.push({
          from: file.path,
          to: `${file.path}#${d.name}:${d.startLine}`,
          name: d.name,
          relation: "DECLARES",
          status: sound ? "VERIFIED" : "UNRESOLVED",
          evidence: { ...base, startLine: d.startLine, endLine: d.endLine },
        });
    for (const e of graph.edges.filter(
      (e) =>
        !e.stale &&
        e.from === file.path &&
        e.sourceSha256 === file.sha256 &&
        e.configurationHash === graph.configurationHash,
    ))
      facts.push({
        from: e.from,
        to: e.to,
        name: e.specifier ?? "dynamic import",
        relation: "IMPORTS",
        status:
          e.resolution === "DYNAMIC"
            ? "DYNAMIC"
            : e.resolution === "RESOLVED"
              ? "VERIFIED"
              : "UNRESOLVED",
        evidence: { ...base, startLine: e.line, endLine: e.line },
      });
    for (const relation of ["CALLS", "REFERENCES"] as const) {
      const rows =
        relation === "CALLS"
          ? (file.prgFacts?.syntax.calls ?? file.parse?.calls ?? [])
          : (file.prgFacts?.syntax.references ?? file.parse?.references ?? []);
      for (const row of rows)
        if (!names.size || names.has(row.name))
          facts.push({
            from: file.path,
            to: null,
            name: row.name,
            relation,
            status: "UNRESOLVED",
            evidence: { ...base, startLine: row.line, endLine: row.line },
          });
    }
  }
  const size = Math.max(0, Math.min(64, limit));
  return {
    facts: facts.slice(0, size),
    omitted: Math.max(0, facts.length - size),
    reverseCoverage: "PARTIAL" as const,
    limitation:
      "Declarations/import targets are static facts. References and calls expose syntax locations; unresolved overloads, aliases, macros and dynamic dispatch are not verified target relationships.",
  };
}
