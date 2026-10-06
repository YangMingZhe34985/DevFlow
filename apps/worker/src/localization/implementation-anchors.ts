import { extractIssueSignals, sourcePathPriority, sourceRole } from "./contracts.js";

const common = new Set([
  "z",
  "string",
  "number",
  "object",
  "array",
  "parse",
  "test",
  "expect",
  "console",
  "return",
  "const",
  "schema",
  "schemas",
  "source",
  "implementation",
]);
export function issueSymbolHints(text: string): string[] {
  return [
    ...new Set(
      [
        ...text.matchAll(
          /\$[A-Za-z]\w*|\b[A-Za-z_$][\w$]*(?=\s*\()|\b[A-Za-z]+[A-Z][\w$]*\b|`([A-Za-z_$][\w$]*)`/gu,
        ),
      ]
        .map((m) => m[1] ?? m[0])
        .filter((s) => !common.has(s.toLowerCase())),
    ),
  ].slice(0, 24);
}

/** Lexical relevance only: an anchor locates code, never proves a root cause. */
export function implementationAnchors(content: string, direction: string, symbol?: string | null) {
  const hints = [...new Set([...(symbol ? [symbol] : []), ...issueSymbolHints(direction)])];
  const lines = content.split(/\r?\n/u);
  return lines
    .flatMap((line, index) => {
      if (/^\s*(?:\/\/|\*|import\b)/u.test(line)) return [];
      const declaration = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\b/u.test(line);
      const implementation =
        /^\s*(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+[$\w]+/u.test(line);
      const declaredName = implementation
        ? line
            .match(/(?:const|let|var|function|class)\s+([$\w]+)/u)?.[1]
            ?.replace(/^\$/u, "")
            .toLowerCase()
        : undefined;
      const exportOnly = /^\s*export\s+(?:\{|\*|type\b)/u.test(line);
      const matches = hints.filter((h) => {
        const escaped = h.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        return (
          new RegExp(`(?:^|[^\\w$])\\$?${escaped.replace(/^\\\$/u, "")}(?=[^\\w$]|$)`, "iu").test(
            line,
          ) ||
          (h.length > 4 && line.toLowerCase().includes(h.toLowerCase()))
        );
      });
      const behavioral =
        /cycl|recurs/iu.test(direction) && /seen\.(?:get|set)|(?:cycles|cycle)\s*[=:]/iu.test(line);
      if (!matches.length && !behavioral) return [];
      const kind = declaration
        ? "DECLARATION"
        : exportOnly
          ? "EXPORT"
          : implementation
            ? "IMPLEMENTATION"
            : "CALL";
      const score =
        (implementation ? 60 : declaration ? -40 : exportOnly ? -60 : 0) +
        matches.length * 4 +
        (symbol && matches.includes(symbol) ? 35 : 0) +
        (behavioral ? 50 : 0) +
        (declaredName
          ? Math.max(
              0,
              ...matches.map((h) => {
                const normalized = h.replace(/^\$/u, "").toLowerCase();
                return (
                  (declaredName === normalized
                    ? 200
                    : declaredName.endsWith(normalized)
                      ? 100
                      : 0) /
                  (hints.indexOf(h) + 1)
                );
              }),
            )
          : 0);
      return [{ line: index + 1, kind, score, hints: matches }];
    })
    .sort((a, b) => b.score - a.score || a.line - b.line);
}

export function rankIssueCandidates<
  T extends {
    path: string;
    symbol?: string | null | undefined;
    snippet?: string;
    reason?: string;
    explanation?: string;
  },
>(candidates: readonly T[], issue: string): T[] {
  const signals = extractIssueSignals(issue);
  const rolePriority = (path: string) =>
    ({ IMPLEMENTATION: 4, ENTRY: 2, TEST: 1, BENCHMARK: 0, METADATA: 0 })[sourceRole(path)];
  const score = (c: T) =>
    sourcePathPriority(c.path, signals) +
    (/\b(?:core|shared|internal|runtime)\b/iu.test(c.reason ?? c.explanation ?? "") ? 10 : 0) +
    (implementationAnchors(
      c.snippet ?? "",
      `${issue} ${c.reason ?? c.explanation ?? ""}`,
      c.symbol,
    )[0]?.score ?? 0);
  const sorted = [...candidates].sort(
    (a, b) => rolePriority(b.path) - rolePriority(a.path) || score(b) - score(a),
  );
  return sorted.filter(
    (c, index) => !sorted.slice(0, index).some((p) => p.path === c.path && p.symbol === c.symbol),
  );
}
