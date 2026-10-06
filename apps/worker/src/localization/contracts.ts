import { createHash } from "node:crypto";

import { z } from "zod";

export const INDEX_VERSION = "localization-v1.6";
export const INDEX_CONFIG = {
  filter: "safe-text-v1",
  resolution: "unresolved-direct-specifiers-v1",
  maxFiles: 50_000,
  maxReadBytes: 2 * 1024 * 1024,
  maxFileBytes: 64 * 1024,
  maxCandidates: 40,
  fusedCandidates: 60,
  maxEvidenceFiles: 8,
  contextBudgetTokens: 12_000,
  concurrency: 4,
} as const;
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const INDEX_CONFIG_HASH = hash(JSON.stringify(INDEX_CONFIG));
export function isTestFile(path: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.|(?:^|\/)(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(
    path,
  );
}
export const SafePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => exclusionReason(value) !== "FORBIDDEN");
export const EntrySchema = z.object({
  path: SafePathSchema,
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string().optional(),
  blobId: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .optional(),
  kind: z.enum(["FILE", "SYMLINK", "DIRECTORY"]).default("FILE"),
});
export type IndexEntry = z.infer<typeof EntrySchema>;
export interface IndexSource {
  /** Validated immutable identity prepared at capture, not computed during queries. */
  identity?: string;
  fileCount?: number;
  base?: IndexSource;
  changes?(
    signal: AbortSignal,
  ): Promise<{ entries: IndexEntry[]; deleted: string[]; incomplete: boolean }>;
  lookup?(path: string, signal: AbortSignal): Promise<IndexEntry | undefined>;
  manifest(signal: AbortSignal): Promise<{ entries: IndexEntry[]; incomplete: boolean }>;
  read(path: string, signal: AbortSignal): Promise<{ content: string; truncated: boolean }>;
}
export interface IssueSignals {
  description: string;
  expectedBehavior: string;
  actualBehavior: string;
  paths: string[];
  symbols: string[];
  errorStrings: string[];
  stackFrames: { path: string; line: number }[];
  testNames: string[];
  moduleHints: string[];
  constraints: string[];
  /** Names declared in the Issue's reproduction are hints, not repository definitions. */
  exampleLocals?: string[];
  apiSymbols?: string[];
  versionHints?: string[];
}
export interface EvidenceItem {
  repositoryId: string;
  baseCommitSha: string;
  viewRevision: string;
  path: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  reason: string;
  retrievalSource: string[];
  score: number;
  snippet: string;
  language: string;
  module: string;
  fileType: "TEST" | "CONFIG" | "DOCUMENT" | "SOURCE";
  parseStatus: "PARSED" | "LEXICAL" | "PARSE_ERROR";
  signature: string | null;
  directImports: { specifier: string; kind: "import" | "export"; line: number }[];
  truncated: boolean;
}
export interface EvidencePack {
  route?: "FAST_PATH" | "DIRECT_SEARCH" | "INDEXED_SEARCH";
  evidenceSufficient?: boolean;
  sufficiencyReasons?: string[];
  indexVersion: string;
  indexConfigHash: string;
  viewRevision: string;
  issueSummary: string;
  moduleScope: string[];
  rootCauseCandidates: string[];
  evidence: EvidenceItem[];
  excludedHypotheses: string[];
  missingInformation: string[];
  truncated: boolean;
  incomplete: boolean;
  metrics: {
    indexMs: number;
    retrievalMs: number;
    contextMs: number;
    wallMs: number;
    readBytes: number;
    fileCount: number;
    indexedBytes: number;
    parsedFiles: number;
    cacheHits: number;
    duplicateQueries: number;
    cacheState: "COLD" | "WARM" | "PARTIAL";
    excluded: Record<string, number>;
    peakRssBytes: number;
    estimatedTokens: number;
    tokenCounting: "UTF8_BYTES_UPPER_BOUND";
    exitReason: string;
    toolExecutions: number;
    manifestEntriesVisited?: number;
    postingsVisited?: number;
    filesInspected?: number;
    indexBuildReadBytes?: number;
    targetedSearchFiles?: number;
  };
}

export function exclusionReason(input: string): string | undefined {
  const path = input.replaceAll("\\", "/");
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-z]:/iu.test(path) ||
    path.includes("\0") ||
    path.split("/").some((part) => part === ".." || part === ".git") ||
    /(?:^|\/)(?:\.devflow[^/]*|hidden-acceptance|hidden-tests?)(?:\/|$)/iu.test(path) ||
    /(?:^|\/)(?:\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|id_rsa|id_ed25519|credentials)(?:\/|$)|\.(?:pem|key|p12)$/iu.test(
      path,
    )
  )
    return "FORBIDDEN";
  if (
    /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|\.next[^/]*|generated|\.devflow)(?:\/|$)/u.test(
      path,
    )
  )
    return "GENERATED_OR_DEPENDENCY";
  if (/(?:\.lock|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock))$/u.test(path))
    return "LOCK_METADATA_ONLY";
  if (/\.(?:png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|exe|dll|bin|wasm)$/iu.test(path))
    return "BINARY";
  return undefined;
}

export function tokens(text: string, limit = 64): string[] {
  const full = text.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  const split = text.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(/[^\p{L}\p{N}]+/u);
  return [
    ...new Set(
      [...full, ...split].map((part) => part.toLowerCase()).filter((part) => part.length >= 2),
    ),
  ].slice(0, limit);
}

export type SourceRole = "IMPLEMENTATION" | "TEST" | "BENCHMARK" | "ENTRY" | "METADATA";
export function sourceRole(path: string): SourceRole {
  if (isTestFile(path)) return "TEST";
  if (/(?:^|\/)(?:bench(?:marks?)?|examples?|fixtures?|treeshake)(?:\/|$)/iu.test(path))
    return "BENCHMARK";
  if (/(?:^|\/)(?:docs?|website)(?:\/|$)/iu.test(path)) return "METADATA";
  if (/(?:^|\/)(?:index|external)\.[cm]?[jt]sx?$/iu.test(path)) return "ENTRY";
  if (!/\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|c|cpp|h|cs)$/iu.test(path)) return "METADATA";
  return "IMPLEMENTATION";
}

/** Retrieval priority only; a filename/role match never proves implementation or root cause. */
export function sourcePathPriority(path: string, signals?: IssueSignals): number {
  const role = sourceRole(path);
  let score = { IMPLEMENTATION: 20, TEST: -10, BENCHMARK: -35, ENTRY: -5, METADATA: -25 }[role];
  if (/(?:^|\/)(?:core|internal|shared|runtime)(?:\/|$)/iu.test(path)) score += 8;
  if (signals) {
    const normalized = path.toLowerCase().replace(/[^a-z0-9]/gu, "");
    for (const symbol of signals.symbols) {
      const name = symbol.toLowerCase().replace(/[^a-z0-9]/gu, "");
      if (name.length > 3 && normalized.includes(name)) score += 30;
    }
    for (const hint of signals.moduleHints) if (hint && path.startsWith(hint + "/")) score += 20;
    const version = path.match(/(?:^|\/)(v\d+)(?:\/|$)/iu)?.[1]?.toLowerCase();
    if (version && signals.versionHints?.length)
      score += signals.versionHints.includes(version) ? 35 : -35;
  }
  return score;
}

export function issueSearchTerms(signals: IssueSignals): string[] {
  return [
    ...new Set([...signals.symbols.map((s) => s.toLowerCase()), ...tokens(signals.description)]),
  ].slice(0, 64);
}

const fileExtension =
  /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|md|txt|py|go|rs|rb|java|c|cpp|h|cs|sh|sql|vue|svelte|html|css)$/iu;
const commonCalls = new Set([
  "test",
  "it",
  "expect",
  "log",
  "require",
  "if",
  "for",
  "while",
  "function",
]);

export function extractIssueSignals(description: string): IssueSignals {
  const text = description.slice(0, 16_000);
  const paths = [...new Set(text.match(/(?:[\w@.-]+\/)*[\w.-]+\.[a-zA-Z][a-zA-Z0-9]*/gu) ?? [])]
    .filter((p) => fileExtension.test(p) && exclusionReason(p) !== "FORBIDDEN")
    .slice(0, 16);
  const stackFrames = [
    ...text.matchAll(/((?:[\w@.-]+\/)*[\w.-]+\.[a-zA-Z][a-zA-Z0-9]*):(\d+)(?::\d+)?/gu),
  ]
    .filter((m) => fileExtension.test(m[1]!) && exclusionReason(m[1]!) !== "FORBIDDEN")
    .slice(0, 16)
    .map((m) => ({ path: m[1]!, line: Number(m[2]) }));
  const exampleLocals = [
    ...new Set(
      [...text.matchAll(/\b(?:const|let|var|function|class)\s+([\w$]+)/gu)].map((m) => m[1]!),
    ),
  ];
  const apiSymbols = [
    ...new Set(
      [
        ...text.matchAll(
          /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.([A-Za-z_$][\w$]*)\s*(?=\(|`|[;,\s])/gu,
        ),
      ].map((m) => m[1]!),
    ),
  ];
  const symbols = [
    ...new Set([
      ...apiSymbols,
      ...(text.match(/\b[a-zA-Z_$][\w$]*(?=\s*\()/gu) ?? []),
      ...[...text.matchAll(/`([\w$]+)`/gu)].map((m) => m[1]!),
    ]),
  ]
    .filter((name) => !exampleLocals.includes(name) && !commonCalls.has(name))
    .slice(0, 24);
  const versionHints = [
    ...new Set([
      ...[...text.matchAll(/\bv(\d+)(?:\.\d+)*\b/giu)].map((m) => `v${m[1]}`),
      ...[...text.matchAll(/\b(?:version|版本)\s*[:：=]?\s*["']?(\d+)\.\d+(?:\.\d+)?/giu)].map(
        (m) => `v${m[1]}`,
      ),
    ]),
  ];
  return {
    description: text,
    expectedBehavior: text.match(/(?:expected|预期)[:：]\s*([^\n]+)/iu)?.[1] ?? "",
    actualBehavior: text.match(/(?:actual|实际)[:：]\s*([^\n]+)/iu)?.[1] ?? "",
    paths,
    symbols,
    apiSymbols,
    exampleLocals,
    versionHints,
    stackFrames,
    errorStrings: [...text.matchAll(/["“]([^"”\n]{3,160})["”]/gu)].map((m) => m[1]!).slice(0, 8),
    testNames: [...text.matchAll(/(?:test|测试)[:：]\s*([^\n]+)/giu)].map((m) => m[1]!).slice(0, 8),
    moduleHints: [...new Set(paths.map((p) => p.split("/").slice(0, -1).join("/")))],
    constraints: text
      .split("\n")
      .filter((line) => /must|不得|必须|不能/iu.test(line))
      .slice(0, 12),
  };
}
