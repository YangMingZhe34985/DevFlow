import { createHash } from "node:crypto";

import type { GitService } from "@devflow/git";
import { z } from "zod";

import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";

export const CORE_TOOL_NAMES = [
  "listFiles",
  "readFile",
  "batchReadFiles",
  "searchCode",
  "batchSearchCode",
  "writeFile",
  "applyPatch",
  "runCommand",
  "gitStatus",
  "gitDiff",
  "gitDiffSummary",
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

const listFilesInput = z.object({
  path: z.string().default("."),
  recursive: z.boolean().default(true),
  maxEntries: z.number().int().positive().max(2_000).default(500),
});

const readFileInput = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(1_000_000).default(200_000),
});

const batchReadFilesInput = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(12)
    .refine((paths) => new Set(paths).size === paths.length, "paths must be unique"),
  maxBytesPerFile: z
    .number()
    .int()
    .positive()
    .max(64 * 1_024)
    .default(64 * 1_024),
});

const searchCodeInput = z.object({
  query: z.string().min(1),
  path: z.string().default("."),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().max(500).default(100),
});

const batchSearchCodeInput = z.object({
  searches: z
    .array(
      z.object({
        query: z.string().min(1),
        path: z.string().default("."),
        glob: z.string().optional(),
        maxResults: z.number().int().positive().max(30).default(30),
      }),
    )
    .min(1)
    .max(8),
});

const writeFileInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  expectedSha256: z.string().optional(),
});

const applyPatchInput = z.object({ patch: z.string().min(1) });

const runCommandInput = z.object({
  program: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  timeoutMs: z.number().int().positive().max(300_000).default(120_000),
  maxOutputBytes: z.number().int().positive().max(1_000_000).default(200_000),
});

const gitDiffInput = z.object({
  cached: z.boolean().default(false),
  base: z.string().optional(),
  paths: z.array(z.string()).optional(),
  maxBytes: z.number().int().positive().max(1_000_000).default(300_000),
});

export function registerCoreTools(registry: ToolRegistry, git: GitService): void {
  registry.register({
    name: "listFiles",
    description: "List files and directories inside the repository workspace.",
    inputSchema: listFilesInput,
    outputSchema: z.unknown(),
    permission: "READ",
    timeoutMs: 15_000,
    readOnly: true,
    parallelSafe: true,
    mutatesWorkspace: false,
    execute: (input, context) => context.sandbox.listFiles(input, context.signal),
  });

  registry.register({
    name: "readFile",
    description: "Read a UTF-8 text file inside the repository workspace.",
    inputSchema: readFileInput,
    outputSchema: z.unknown(),
    permission: "READ",
    timeoutMs: 15_000,
    readOnly: true,
    parallelSafe: true,
    mutatesWorkspace: false,
    execute: (input, context) => context.sandbox.readFile(input, context.signal),
  });

  registry.register({
    name: "batchReadFiles",
    description:
      "Read up to 12 UTF-8 repository files in one call. Each file is limited to 64 KiB and the combined content to 256 KiB.",
    inputSchema: batchReadFilesInput,
    outputSchema: z.object({
      files: z.array(
        z.discriminatedUnion("ok", [
          z.object({
            ok: z.literal(true),
            path: z.string(),
            content: z.string(),
            encoding: z.literal("utf8"),
            contentBytes: z.number().int().nonnegative(),
            sha256: z.string(),
            truncated: z.boolean(),
          }),
          z.object({ ok: z.literal(false), path: z.string(), error: z.string() }),
        ]),
      ),
      totalBytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    permission: "READ",
    timeoutMs: 30_000,
    readOnly: true,
    parallelSafe: true,
    mutatesWorkspace: false,
    async execute(input, context) {
      const reads = await mapWithConcurrency(input.paths, 4, async (filePath) => {
        try {
          const result = await context.sandbox.readFile(
            { path: filePath, maxBytes: input.maxBytesPerFile },
            context.signal,
          );
          return { ok: true as const, result };
        } catch (error) {
          return { ok: false as const, path: filePath, error: errorMessage(error) };
        }
      });
      let remainingBytes = 256 * 1_024;
      let anyTruncated = false;
      const files = reads.map((read) => {
        if (!read.ok) return read;
        const perFileBounded = truncateUtf8(read.result.content, input.maxBytesPerFile);
        const bounded = truncateUtf8(perFileBounded.value, remainingBytes);
        const contentBytes = Buffer.byteLength(bounded.value);
        remainingBytes -= contentBytes;
        const truncated = read.result.truncated || perFileBounded.truncated || bounded.truncated;
        anyTruncated ||= truncated;
        return {
          ok: true as const,
          path: read.result.path,
          content: bounded.value,
          encoding: "utf8" as const,
          contentBytes,
          sha256: createHash("sha256").update(bounded.value).digest("hex"),
          truncated,
        };
      });
      return { files, totalBytes: 256 * 1_024 - remainingBytes, truncated: anyTruncated };
    },
  });

  registry.register({
    name: "searchCode",
    description: "Search repository text with ripgrep and return matching lines.",
    inputSchema: searchCodeInput,
    outputSchema: z.object({ matches: z.array(z.string()), truncated: z.boolean() }),
    permission: "READ",
    timeoutMs: 30_000,
    readOnly: true,
    parallelSafe: true,
    mutatesWorkspace: false,
    async execute(input, context) {
      return await searchCode(input, context);
    },
  });

  registry.register({
    name: "batchSearchCode",
    description:
      "Run up to 8 targeted repository searches in one call, returning at most 30 matches per search and 160 overall.",
    inputSchema: batchSearchCodeInput,
    outputSchema: z.object({
      results: z.array(
        z.discriminatedUnion("ok", [
          z.object({
            ok: z.literal(true),
            query: z.string(),
            matches: z.array(z.string()),
            truncated: z.boolean(),
          }),
          z.object({ ok: z.literal(false), query: z.string(), error: z.string() }),
        ]),
      ),
      totalMatches: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    permission: "READ",
    timeoutMs: 45_000,
    readOnly: true,
    parallelSafe: true,
    mutatesWorkspace: false,
    async execute(input, context) {
      const searches = await mapWithConcurrency(input.searches, 4, async (search) => {
        try {
          const result = await searchCode(search, context);
          return { ok: true as const, query: search.query, ...result };
        } catch (error) {
          return { ok: false as const, query: search.query, error: errorMessage(error) };
        }
      });
      let remainingMatches = 160;
      let remainingBytes = 200 * 1_024;
      let anyTruncated = false;
      const results = searches.map((search) => {
        if (!search.ok) return search;
        const matches: string[] = [];
        for (const match of search.matches.slice(0, remainingMatches)) {
          if (remainingBytes <= 0) break;
          const bounded = truncateUtf8(match, Math.min(4_096, remainingBytes));
          matches.push(bounded.value);
          remainingBytes -= Buffer.byteLength(bounded.value);
          anyTruncated ||= bounded.truncated;
        }
        remainingMatches -= matches.length;
        const truncated = search.truncated || matches.length < search.matches.length;
        anyTruncated ||= truncated;
        return { ok: true as const, query: search.query, matches, truncated };
      });
      return {
        results,
        totalMatches: 160 - remainingMatches,
        truncated: anyTruncated,
      };
    },
  });

  registry.register({
    name: "writeFile",
    description: "Write a UTF-8 file inside the repository workspace.",
    inputSchema: writeFileInput,
    outputSchema: z.unknown(),
    permission: "WRITE",
    timeoutMs: 20_000,
    readOnly: false,
    parallelSafe: false,
    mutatesWorkspace: true,
    execute: (input, context) =>
      context.sandbox.writeFile(
        {
          path: input.path,
          content: input.content,
          ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
        },
        context.signal,
      ),
  });

  registry.register({
    name: "applyPatch",
    description: "Apply a unified Git patch inside the repository workspace.",
    inputSchema: applyPatchInput,
    outputSchema: z.unknown(),
    permission: "WRITE",
    timeoutMs: 30_000,
    readOnly: false,
    parallelSafe: false,
    mutatesWorkspace: true,
    execute: (input, context) => context.sandbox.applyPatch(input, context.signal),
  });

  registry.register({
    name: "runCommand",
    description:
      "Run one structured command in the repository sandbox. Provide program and args separately; shell syntax is not supported.",
    inputSchema: runCommandInput,
    outputSchema: z.unknown(),
    permission: "EXECUTE",
    timeoutMs: 305_000,
    readOnly: false,
    parallelSafe: false,
    mutatesWorkspace: true,
    execute: (input, context) => context.sandbox.exec(input, context.signal),
  });

  registry.register({
    name: "gitStatus",
    description: "Read the current Git branch, HEAD and working tree status.",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    permission: "GIT",
    timeoutMs: 20_000,
    readOnly: true,
    parallelSafe: true,
    mutatesWorkspace: false,
    execute: (_input, context) => git.status(context.sandbox, context.signal),
  });

  registry.register({
    name: "gitDiff",
    description: "Read the current Git diff and summary from the sandbox repository.",
    inputSchema: gitDiffInput,
    outputSchema: z.unknown(),
    permission: "GIT",
    timeoutMs: 30_000,
    readOnly: true,
    parallelSafe: true,
    mutatesWorkspace: false,
    execute: (input, context) =>
      git.diff(
        context.sandbox,
        {
          cached: input.cached,
          maxBytes: input.maxBytes,
          ...(input.base === undefined ? {} : { base: input.base }),
          ...(input.paths === undefined ? {} : { paths: input.paths }),
        },
        context.signal,
      ),
  });

  registry.register({
    name: "gitDiffSummary",
    description:
      "Read a compact Git change summary and changed-file list without returning the full patch.",
    inputSchema: z.object({
      cached: z.boolean().default(false),
      base: z.string().optional(),
      paths: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      filesChanged: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative().optional(),
      deletions: z.number().int().nonnegative().optional(),
      changedFiles: z.array(z.string()),
      truncated: z.boolean(),
    }),
    permission: "GIT",
    timeoutMs: 30_000,
    readOnly: true,
    parallelSafe: true,
    mutatesWorkspace: false,
    async execute(input, context) {
      const [diff, status] = await Promise.all([
        git.diff(
          context.sandbox,
          {
            cached: input.cached,
            maxBytes: 16_384,
            ...(input.base === undefined ? {} : { base: input.base }),
            ...(input.paths === undefined ? {} : { paths: input.paths }),
          },
          context.signal,
        ),
        git.status(context.sandbox, context.signal),
      ]);
      return {
        filesChanged: diff.filesChanged,
        ...(diff.additions === undefined ? {} : { additions: diff.additions }),
        ...(diff.deletions === undefined ? {} : { deletions: diff.deletions }),
        changedFiles: status.files.map(({ path }) => path),
        truncated: diff.truncated,
      };
    },
  });
}

async function searchCode(
  input: { query: string; path: string; glob?: string | undefined; maxResults: number },
  context: ToolContext,
): Promise<{ matches: string[]; truncated: boolean }> {
  const args = ["--line-number", "--column", "--no-heading", "--color", "never"];
  if (input.glob !== undefined) args.push("--glob", input.glob);
  args.push("--", input.query, input.path);
  const result = await context.sandbox.exec(
    { program: "rg", args, timeoutMs: 25_000, maxOutputBytes: 500_000 },
    context.signal,
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(result.stderr || `rg exited with ${String(result.exitCode)}`);
  }
  const allMatches = result.stdout.split(/\r?\n/u).filter(Boolean);
  return {
    matches: allMatches.slice(0, input.maxResults),
    truncated: result.outputTruncated || allMatches.length > input.maxResults,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { value, truncated: false };
  if (maxBytes <= 0) return { value: "", truncated: value.length > 0 };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { value: value.slice(0, low), truncated: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
