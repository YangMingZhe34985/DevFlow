import type { SandboxSession } from "@devflow/sandbox";

export interface GitStatusEntry {
  path: string;
  indexStatus: string;
  workTreeStatus: string;
}

export interface GitStatus {
  branch?: string;
  headSha?: string;
  files: readonly GitStatusEntry[];
  clean: boolean;
}

export interface GitDiffOptions {
  cached?: boolean;
  base?: string;
  paths?: readonly string[];
  maxBytes?: number;
}

export interface GitDiff {
  patch: string;
  filesChanged: number;
  additions?: number;
  deletions?: number;
  truncated: boolean;
}

export interface GitService {
  status(sandbox: SandboxSession, signal?: AbortSignal): Promise<GitStatus>;
  diff(sandbox: SandboxSession, options?: GitDiffOptions, signal?: AbortSignal): Promise<GitDiff>;
  head(sandbox: SandboxSession, signal?: AbortSignal): Promise<string>;
}
