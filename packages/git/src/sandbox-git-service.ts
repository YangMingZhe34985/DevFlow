import type { SandboxSession } from "@devflow/sandbox";
import { DevflowError } from "@devflow/shared";

import type { GitDiff, GitDiffOptions, GitService, GitStatus } from "./contracts.js";

export class SandboxGitService implements GitService {
  async status(sandbox: SandboxSession, signal?: AbortSignal): Promise<GitStatus> {
    const result = await sandbox.exec(
      {
        program: "git",
        args: ["status", "--porcelain=v1", "-z", "--branch"],
        timeoutMs: 20_000,
        maxOutputBytes: 500_000,
      },
      signal,
    );
    ensureSuccess(result.exitCode, result.stderr, "git status");
    const records = result.stdout.split("\0").filter(Boolean);
    const branchRecord = records.shift();
    const branch = branchRecord?.startsWith("## ")
      ? branchRecord.slice(3).split("...")[0]?.trim()
      : undefined;
    const files = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record === undefined || record.length < 4) continue;
      const indexStatus = record[0] ?? " ";
      const workTreeStatus = record[1] ?? " ";
      let filePath = record.slice(3);
      if (indexStatus === "R" || indexStatus === "C") {
        const renamedPath = records[index + 1];
        if (renamedPath !== undefined) {
          filePath = `${filePath} -> ${renamedPath}`;
          index += 1;
        }
      }
      files.push({ path: filePath, indexStatus, workTreeStatus });
    }
    const headSha = await this.head(sandbox, signal).catch(() => undefined);
    return {
      ...(branch === undefined || branch === "No commits yet on main" ? {} : { branch }),
      ...(headSha === undefined ? {} : { headSha }),
      files,
      clean: files.length === 0,
    };
  }

  async diff(
    sandbox: SandboxSession,
    options: GitDiffOptions = {},
    signal?: AbortSignal,
  ): Promise<GitDiff> {
    const commonArgs = buildDiffArgs(options);
    const maxBytes = options.maxBytes ?? 300_000;
    const patchResult = await sandbox.exec(
      {
        program: "git",
        args: ["diff", "--no-ext-diff", "--unified=3", ...commonArgs],
        timeoutMs: 30_000,
        maxOutputBytes: maxBytes,
      },
      signal,
    );
    ensureSuccess(patchResult.exitCode, patchResult.stderr, "git diff");
    const statsResult = await sandbox.exec(
      {
        program: "git",
        args: ["diff", "--numstat", ...commonArgs],
        timeoutMs: 20_000,
        maxOutputBytes: 200_000,
      },
      signal,
    );
    ensureSuccess(statsResult.exitCode, statsResult.stderr, "git diff --numstat");

    let filesChanged = 0;
    let additions = 0;
    let deletions = 0;
    let binary = false;
    for (const line of statsResult.stdout.split(/\r?\n/u).filter(Boolean)) {
      const [added, deleted] = line.split("\t");
      filesChanged += 1;
      if (added === "-" || deleted === "-") {
        binary = true;
      } else {
        additions += Number(added ?? 0);
        deletions += Number(deleted ?? 0);
      }
    }
    return {
      patch: patchResult.stdout,
      filesChanged,
      ...(binary ? {} : { additions, deletions }),
      truncated: patchResult.outputTruncated,
    };
  }

  async head(sandbox: SandboxSession, signal?: AbortSignal): Promise<string> {
    const result = await sandbox.exec(
      {
        program: "git",
        args: ["rev-parse", "HEAD"],
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
      },
      signal,
    );
    ensureSuccess(result.exitCode, result.stderr, "git rev-parse HEAD");
    return result.stdout.trim();
  }
}

function buildDiffArgs(options: GitDiffOptions): string[] {
  const args: string[] = [];
  if (options.cached === true) args.push("--cached");
  if (options.base !== undefined) args.push(options.base);
  if (options.paths !== undefined && options.paths.length > 0) {
    args.push("--", ...options.paths);
  }
  return args;
}

function ensureSuccess(exitCode: number | null, stderr: string, operation: string): void {
  if (exitCode !== 0) {
    throw new DevflowError({
      code: "TOOL_FAILED",
      message: `${operation} failed: ${stderr.trim() || `exit code ${String(exitCode)}`}`,
    });
  }
}
