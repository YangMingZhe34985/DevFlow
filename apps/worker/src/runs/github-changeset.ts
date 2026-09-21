import { GitHubChangeSchema, type GitHubChange } from "@devflow/github";
import type { SandboxSession } from "@devflow/sandbox";
import { DevflowError } from "@devflow/shared";

export { isGitHubRepositoryUri, parseGitHubRepositoryUri } from "@devflow/github";

const MAX_CHANGESET_BYTES = 9_000_000;

export async function captureGitHubChanges(
  sandbox: SandboxSession,
  baseCommit: string,
  signal?: AbortSignal,
): Promise<readonly GitHubChange[]> {
  const fixedBase = /^[0-9a-f]{40}$/iu.test(baseCommit) ? baseCommit.toLowerCase() : undefined;
  if (fixedBase === undefined) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "GitHub publication requires a fixed full 40-character base commit.",
    });
  }
  const tracked = await sandbox.exec(
    {
      program: "git",
      // Compare the final working tree to the immutable task base, never to the
      // Agent-controlled HEAD. An Agent is allowed to commit its work, and such
      // a commit must not make the publication change set appear empty.
      args: ["diff", "--name-status", "-z", "--find-renames", fixedBase, "--"],
      timeoutMs: 30_000,
      maxOutputBytes: 2_000_000,
    },
    signal,
  );
  ensureCommand(tracked.exitCode, tracked.stderr, "enumerate tracked GitHub changes");
  const untracked = await sandbox.exec(
    {
      program: "git",
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      timeoutMs: 30_000,
      maxOutputBytes: 2_000_000,
    },
    signal,
  );
  ensureCommand(untracked.exitCode, untracked.stderr, "enumerate untracked GitHub changes");

  const changes = parseTrackedChanges(tracked.stdout);
  for (const filePath of splitNull(untracked.stdout)) changes.set(filePath, "UPSERT");
  const upserts = [...changes]
    .filter(([, kind]) => kind === "UPSERT")
    .map(([filePath]) => filePath)
    .sort();
  const contents = await readChangedFiles(sandbox, upserts, signal);
  const result: GitHubChange[] = [];
  for (const [filePath, kind] of [...changes].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (kind === "DELETE") {
      result.push(GitHubChangeSchema.parse({ kind, path: filePath }));
      continue;
    }
    const content = contents.get(filePath);
    if (content === undefined) {
      throw new DevflowError({
        code: "GITHUB_FAILED",
        message: `Changed file '${filePath}' could not be captured for GitHub publication.`,
      });
    }
    result.push(
      GitHubChangeSchema.parse({
        kind,
        path: filePath,
        contentBase64: content.contentBase64,
        mode: content.mode,
      }),
    );
  }
  return result;
}

interface CapturedFile {
  path: string;
  contentBase64: string;
  mode: "100644" | "100755" | "120000";
}

async function readChangedFiles(
  sandbox: SandboxSession,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, CapturedFile>> {
  if (paths.length === 0) return new Map();
  const result = await sandbox.exec(
    {
      program: "node",
      args: ["-e", CAPTURE_FILES_SCRIPT],
      stdin: JSON.stringify(paths),
      timeoutMs: 60_000,
      maxOutputBytes: MAX_CHANGESET_BYTES,
    },
    signal,
  );
  ensureCommand(result.exitCode, result.stderr, "capture GitHub changed files");
  if (result.outputTruncated) {
    throw new DevflowError({
      code: "GITHUB_FAILED",
      message: "GitHub change set exceeds the platform publication limit.",
    });
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Expected an array.");
    const files = new Map<string, CapturedFile>();
    for (const raw of parsed) {
      if (typeof raw !== "object" || raw === null) throw new Error("Invalid captured file.");
      const record = raw as Record<string, unknown>;
      const change = GitHubChangeSchema.parse({
        kind: "UPSERT",
        path: record.path,
        contentBase64: record.contentBase64,
        mode: record.mode,
      });
      if (change.kind !== "UPSERT") throw new Error("Expected an upsert.");
      files.set(change.path, change);
    }
    return files;
  } catch (error) {
    throw new DevflowError({
      code: "GITHUB_FAILED",
      message: "Sandbox returned an invalid GitHub change set.",
      cause: error,
    });
  }
}

function parseTrackedChanges(output: string): Map<string, "UPSERT" | "DELETE"> {
  const tokens = splitNull(output);
  const changes = new Map<string, "UPSERT" | "DELETE">();
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const firstPath = tokens[index++];
    if (status === undefined || firstPath === undefined) {
      throw malformedGitOutput();
    }
    const code = status[0];
    if (code === "R" || code === "C") {
      const secondPath = tokens[index++];
      if (secondPath === undefined) throw malformedGitOutput();
      if (code === "R") changes.set(firstPath, "DELETE");
      changes.set(secondPath, "UPSERT");
    } else {
      changes.set(firstPath, code === "D" ? "DELETE" : "UPSERT");
    }
  }
  return changes;
}

function splitNull(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

function ensureCommand(exitCode: number | null, stderr: string, operation: string): void {
  if (exitCode !== 0) {
    throw new DevflowError({
      code: "GITHUB_FAILED",
      message: `Could not ${operation}: ${stderr.trim() || `exit code ${String(exitCode)}`}`,
    });
  }
}

function malformedGitOutput(): DevflowError {
  return new DevflowError({
    code: "GITHUB_FAILED",
    message: "Git returned malformed change metadata for GitHub publication.",
  });
}

const CAPTURE_FILES_SCRIPT = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const root = fs.realpathSync(".");',
  'const paths = JSON.parse(fs.readFileSync(0, "utf8"));',
  "const inside = (candidate) => candidate === root || candidate.startsWith(root + path.sep);",
  "const result = paths.map((requested) => {",
  "  const absolute = path.resolve(root, requested);",
  '  if (!inside(absolute)) throw new Error("path escapes repository");',
  "  const info = fs.lstatSync(absolute);",
  "  let content;",
  "  let mode;",
  "  if (info.isSymbolicLink()) {",
  '    content = Buffer.from(fs.readlinkSync(absolute), "utf8");',
  '    mode = "120000";',
  "  } else {",
  '    if (!info.isFile()) throw new Error("changed path is not a file");',
  "    content = fs.readFileSync(absolute);",
  '    mode = (info.mode & 0o111) === 0 ? "100644" : "100755";',
  "  }",
  '  return { path: requested, contentBase64: content.toString("base64"), mode };',
  "});",
  "process.stdout.write(JSON.stringify(result));",
].join("\n");
