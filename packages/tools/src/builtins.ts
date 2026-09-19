import type { GitService } from "@devflow/git";
import { z } from "zod";

import type { ToolRegistry } from "./registry.js";

export const CORE_TOOL_NAMES = [
  "listFiles",
  "readFile",
  "searchCode",
  "writeFile",
  "applyPatch",
  "runCommand",
  "gitStatus",
  "gitDiff",
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

const searchCodeInput = z.object({
  query: z.string().min(1),
  path: z.string().default("."),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().max(500).default(100),
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
    execute: (input, context) => context.sandbox.listFiles(input, context.signal),
  });

  registry.register({
    name: "readFile",
    description: "Read a UTF-8 text file inside the repository workspace.",
    inputSchema: readFileInput,
    outputSchema: z.unknown(),
    permission: "READ",
    timeoutMs: 15_000,
    execute: (input, context) => context.sandbox.readFile(input, context.signal),
  });

  registry.register({
    name: "searchCode",
    description: "Search repository text with ripgrep and return matching lines.",
    inputSchema: searchCodeInput,
    outputSchema: z.object({ matches: z.array(z.string()), truncated: z.boolean() }),
    permission: "READ",
    timeoutMs: 30_000,
    async execute(input, context) {
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
    },
  });

  registry.register({
    name: "writeFile",
    description: "Write a UTF-8 file inside the repository workspace.",
    inputSchema: writeFileInput,
    outputSchema: z.unknown(),
    permission: "WRITE",
    timeoutMs: 20_000,
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
    execute: (input, context) => context.sandbox.exec(input, context.signal),
  });

  registry.register({
    name: "gitStatus",
    description: "Read the current Git branch, HEAD and working tree status.",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    permission: "GIT",
    timeoutMs: 20_000,
    execute: (_input, context) => git.status(context.sandbox, context.signal),
  });

  registry.register({
    name: "gitDiff",
    description: "Read the current Git diff and summary from the sandbox repository.",
    inputSchema: gitDiffInput,
    outputSchema: z.unknown(),
    permission: "GIT",
    timeoutMs: 30_000,
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
}
