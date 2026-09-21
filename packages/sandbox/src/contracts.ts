import { z } from "zod";

import type { RunId } from "@devflow/shared";

export const CommandSpecSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()).max(1_000).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().max(2_000_000).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  maxOutputBytes: z.number().int().positive().max(10_000_000).optional(),
});
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

export const SandboxLimitsSchema = z.object({
  cpuCount: z.number().positive().max(64),
  memoryMb: z.number().int().min(6).max(131_072),
  pids: z.number().int().positive().max(16_384),
  timeoutMs: z.number().int().positive().max(7_200_000),
  networkEnabled: z.boolean(),
});
export type SandboxLimits = z.infer<typeof SandboxLimitsSchema>;

const SnapshotPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/u.test(value) &&
      !value.split(/[\\/]/u).includes("..") &&
      !value.split(/[\\/]/u).includes(".git"),
    "Snapshot path must be a safe repository-relative path outside .git.",
  );

const SnapshotFileSchema = z.object({
  kind: z.literal("FILE"),
  path: SnapshotPathSchema,
  mode: z.number().int().min(0).max(0o777),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  contentBase64: z.string(),
});

const SnapshotSymlinkSchema = z.object({
  kind: z.literal("SYMLINK"),
  path: SnapshotPathSchema,
  mode: z.number().int().min(0).max(0o777),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  target: z.string().min(1).max(32_768),
});

/**
 * A credential-free snapshot of the effective LOCAL Git working tree.
 * Git metadata is intentionally represented only as provenance; .git is never archived.
 */
export const LocalRepositorySnapshotSchema = z.object({
  version: z.literal(1),
  sourceHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
  sourceBranch: z.string().min(1).optional(),
  requestedBaseRef: z.string().min(1).optional(),
  requestedBaseCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/u)
    .optional(),
  totalBytes: z.number().int().nonnegative(),
  files: z.array(z.discriminatedUnion("kind", [SnapshotFileSchema, SnapshotSymlinkSchema])),
});
export type LocalRepositorySnapshot = z.infer<typeof LocalRepositorySnapshotSchema>;

export const SandboxRepositorySourceSchema = z.object({
  sourceUri: z.string().min(1),
  baseRef: z.string().min(1).optional(),
  baseCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/iu)
    .optional(),
  snapshot: LocalRepositorySnapshotSchema.optional(),
});
export type SandboxRepositorySource = z.infer<typeof SandboxRepositorySourceSchema>;

export interface SandboxCreateOptions {
  runId: RunId;
  repository: SandboxRepositorySource;
  limits: SandboxLimits;
  environment?: Readonly<Record<string, string>>;
}

export const SandboxCreateOptionsSchema = z.object({
  runId: z.string().uuid(),
  repository: SandboxRepositorySourceSchema,
  limits: SandboxLimitsSchema,
  environment: z.record(z.string(), z.string()).optional(),
});

export interface ListFilesRequest {
  path?: string;
  recursive?: boolean;
  maxEntries?: number;
}

export interface ListFilesResult {
  entries: readonly {
    path: string;
    kind: "FILE" | "DIRECTORY" | "SYMLINK";
    sizeBytes?: number;
  }[];
  truncated: boolean;
}

export interface ReadFileRequest {
  path: string;
  maxBytes?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  encoding: "utf8";
  truncated: boolean;
}

export interface WriteFileRequest {
  path: string;
  content: string;
  expectedSha256?: string;
}

export interface WriteFileResult {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ApplyPatchRequest {
  patch: string;
}

export interface ApplyPatchResult {
  applied: boolean;
  changedFiles: readonly string[];
  diagnostics: readonly string[];
}

export interface SandboxSession {
  readonly id: string;
  readonly workspacePath: string;

  exec(command: CommandSpec, signal?: AbortSignal): Promise<CommandResult>;
  listFiles(input: ListFilesRequest, signal?: AbortSignal): Promise<ListFilesResult>;
  readFile(input: ReadFileRequest, signal?: AbortSignal): Promise<ReadFileResult>;
  writeFile(input: WriteFileRequest, signal?: AbortSignal): Promise<WriteFileResult>;
  applyPatch(input: ApplyPatchRequest, signal?: AbortSignal): Promise<ApplyPatchResult>;
  dispose(): Promise<void>;
}

export interface SandboxManager {
  create(options: SandboxCreateOptions, signal?: AbortSignal): Promise<SandboxSession>;
  destroy(sandboxId: string): Promise<void>;
}
