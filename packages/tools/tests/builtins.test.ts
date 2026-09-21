import { randomUUID } from "node:crypto";

import type { GitService } from "@devflow/git";
import type {
  ApplyPatchRequest,
  ApplyPatchResult,
  CommandResult,
  CommandSpec,
  ListFilesRequest,
  ListFilesResult,
  ReadFileRequest,
  ReadFileResult,
  SandboxSession,
  WriteFileRequest,
  WriteFileResult,
} from "@devflow/sandbox";
import { describe, expect, it } from "vitest";

import {
  DefaultToolExecutor,
  ExplicitToolPolicy,
  registerCoreTools,
  ToolRegistry,
} from "../src/index.js";

class FakeSandbox implements SandboxSession {
  readonly id = "fake";
  readonly workspacePath = "/workspace";
  readonly files = new Map([["src/a.js", "export const value = 'needle';\n"]]);
  readonly commands: CommandSpec[] = [];

  async exec(command: CommandSpec): Promise<CommandResult> {
    this.commands.push(command);
    return {
      exitCode: 0,
      stdout: command.program === "rg" ? "src/a.js:1:23:needle\n" : "2 tests passed\n",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      outputTruncated: false,
    };
  }

  async listFiles(_input: ListFilesRequest): Promise<ListFilesResult> {
    return {
      entries: [...this.files].map(([filePath, content]) => ({
        path: filePath,
        kind: "FILE" as const,
        sizeBytes: Buffer.byteLength(content),
      })),
      truncated: false,
    };
  }

  async readFile(input: ReadFileRequest): Promise<ReadFileResult> {
    return {
      path: input.path,
      content: this.files.get(input.path) ?? "",
      encoding: "utf8",
      truncated: false,
    };
  }

  async writeFile(input: WriteFileRequest): Promise<WriteFileResult> {
    this.files.set(input.path, input.content);
    return { path: input.path, sha256: "0".repeat(64), sizeBytes: input.content.length };
  }

  async applyPatch(_input: ApplyPatchRequest): Promise<ApplyPatchResult> {
    return { applied: true, changedFiles: ["src/a.js"], diagnostics: [] };
  }

  async dispose(): Promise<void> {}
}

const git: GitService = {
  async status() {
    return { files: [], clean: true };
  },
  async diff() {
    return { patch: "diff --git a/src/a.js b/src/a.js", filesChanged: 1, truncated: false };
  },
  async head() {
    return "abc123";
  },
};

function createExecutor(permissions: ("READ" | "WRITE" | "EXECUTE" | "GIT")[]) {
  const registry = new ToolRegistry();
  registerCoreTools(registry, git);
  return new DefaultToolExecutor(registry, new ExplicitToolPolicy(permissions));
}

function context(sandbox: SandboxSession) {
  return {
    runId: randomUUID(),
    stepId: randomUUID(),
    sandbox,
    signal: new AbortController().signal,
    async emit() {},
  };
}

describe("P1 built-in tools", () => {
  it("reads, searches, writes and runs commands only through SandboxSession", async () => {
    const sandbox = new FakeSandbox();
    const executor = createExecutor(["READ", "WRITE", "EXECUTE", "GIT"]);
    const toolContext = context(sandbox);

    const listed = await executor.execute({ name: "listFiles", input: {} }, toolContext);
    const read = await executor.execute(
      { name: "readFile", input: { path: "src/a.js" } },
      toolContext,
    );
    const searched = await executor.execute(
      { name: "searchCode", input: { query: "needle" } },
      toolContext,
    );
    const written = await executor.execute(
      { name: "writeFile", input: { path: "src/a.js", content: "fixed\n" } },
      toolContext,
    );
    const command = await executor.execute(
      { name: "runCommand", input: { program: "npm", args: ["test"] } },
      toolContext,
    );

    expect([listed.ok, read.ok, searched.ok, written.ok, command.ok]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(sandbox.files.get("src/a.js")).toBe("fixed\n");
    expect(sandbox.commands.map(({ program }) => program)).toEqual(["rg", "npm"]);
  });

  it("denies writes unless WRITE is explicitly allowed", async () => {
    const sandbox = new FakeSandbox();
    const executor = createExecutor(["READ"]);

    const result = await executor.execute(
      { name: "writeFile", input: { path: "src/a.js", content: "blocked" } },
      context(sandbox),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(sandbox.files.get("src/a.js")).toContain("needle");
  });

  it("batches bounded file reads and searches", async () => {
    const sandbox = new FakeSandbox();
    sandbox.files.set("src/large-a.txt", "a".repeat(80 * 1_024));
    sandbox.files.set("src/large-b.txt", "b".repeat(80 * 1_024));
    const executor = createExecutor(["READ"]);
    const toolContext = context(sandbox);

    const read = await executor.execute(
      {
        name: "batchReadFiles",
        input: { paths: ["src/large-a.txt", "src/large-b.txt"], maxBytesPerFile: 64 * 1_024 },
      },
      toolContext,
    );
    const search = await executor.execute(
      {
        name: "batchSearchCode",
        input: {
          searches: [
            { query: "needle", path: "src" },
            { query: "value", path: "src", maxResults: 1 },
          ],
        },
      },
      toolContext,
    );

    expect(read).toMatchObject({
      ok: true,
      output: {
        totalBytes: 128 * 1_024,
        truncated: true,
        files: [
          { ok: true, path: "src/large-a.txt", contentBytes: 64 * 1_024, truncated: true },
          { ok: true, path: "src/large-b.txt", contentBytes: 64 * 1_024, truncated: true },
        ],
      },
    });
    expect(search).toMatchObject({
      ok: true,
      output: {
        totalMatches: 2,
        results: [
          { ok: true, query: "needle", matches: ["src/a.js:1:23:needle"] },
          { ok: true, query: "value", matches: ["src/a.js:1:23:needle"] },
        ],
      },
    });
    expect(sandbox.commands.filter(({ program }) => program === "rg")).toHaveLength(2);
  });

  it("publishes execution metadata and a compact Git summary", async () => {
    const sandbox = new FakeSandbox();
    const registry = new ToolRegistry();
    registerCoreTools(registry, git);
    const executor = new DefaultToolExecutor(registry, new ExplicitToolPolicy(["GIT"]));

    expect(registry.get("readFile")).toMatchObject({
      readOnly: true,
      parallelSafe: true,
      mutatesWorkspace: false,
    });
    expect(registry.get("writeFile")).toMatchObject({
      readOnly: false,
      parallelSafe: false,
      mutatesWorkspace: true,
    });
    const summary = await executor.execute({ name: "gitDiffSummary", input: {} }, context(sandbox));
    expect(summary).toMatchObject({
      ok: true,
      output: { filesChanged: 1, changedFiles: [], truncated: false },
    });
  });
});
