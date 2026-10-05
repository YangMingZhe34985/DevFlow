import { describe, expect, it } from "vitest";

import type { RepositoryIndexStore } from "@devflow/database";
import type { SandboxSession, LocalRepositorySnapshot } from "@devflow/sandbox";

import {
  exclusionReason,
  extractIssueSignals,
  hash,
  type IndexSource,
} from "../src/localization/contracts.js";
import { IssueLocalizer, reciprocalRankFusion } from "../src/localization/retrieval.js";
import { overlaySource, revisionedSandbox, sandboxSource } from "../src/localization/sources.js";
import { parseCandidate } from "../src/localization/parser.js";
import { createTools } from "../src/runs/approval-workflow-run-executor.js";
import { toolsForStage } from "../src/runs/workflow-stage-policy.js";
import { SandboxGitService } from "@devflow/git";

export class MemoryIndexStore implements RepositoryIndexStore {
  readonly entries = new Map<string, unknown>();
  async get(scope: string, key: string) {
    return this.entries.get(`${scope}:${key}`);
  }
  async publish(scope: string, key: string, value: unknown) {
    const id = `${scope}:${key}`;
    if (!this.entries.has(id)) this.entries.set(id, structuredClone(value));
  }
}

export function memorySource(files: Map<string, string>): IndexSource {
  return {
    async manifest() {
      return {
        entries: [...files].map(([path, content]) => ({
          path,
          contentHash: hash(content),
          sizeBytes: Buffer.byteLength(content),
          kind: "FILE" as const,
        })),
        incomplete: false,
      };
    },
    async read(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error("deleted");
      return { content, truncated: false };
    },
  };
}
const options = {
  repositoryId: "repo-a",
  accessScope: "scope-a",
  baseCommitSha: "a".repeat(40),
  runId: "run-1",
  workspaceRevision: 0,
  signal: new AbortController().signal,
};

describe("bounded Issue localization", () => {
  it("invalidates cached misses after content changes and never publishes an interrupted manifest root", async () => {
    const store = new MemoryIndexStore();
    const files = new Map([["plain.py", "unrelated = 1"]]);
    const localizer = new IssueLocalizer(store);
    const request = { ...options, source: memorySource(files), description: "needle" };
    expect((await localizer.retrieve(request)).evidence).toHaveLength(0);
    expect((await localizer.retrieve(request)).metrics.duplicateQueries).toBe(1);
    files.set("plain.py", "needle = 2");
    const changed = await localizer.retrieve({ ...request, workspaceRevision: 1 });
    expect(changed.evidence[0]!.snippet).toContain("needle = 2");
    expect(changed.metrics.duplicateQueries).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(changed))).toBeLessThanOrEqual(12_000);

    const controller = new AbortController();
    const interrupted = new MemoryIndexStore();
    const publish = interrupted.publish.bind(interrupted);
    interrupted.publish = async (scope, key, value) => {
      await publish(scope, key, value);
      if (key.startsWith("manifest-chunk:")) controller.abort();
    };
    await expect(
      new IssueLocalizer(interrupted).retrieve({ ...request, signal: controller.signal }),
    ).rejects.toThrow();
    expect([...interrupted.entries.keys()].some((key) => key.includes(":manifest:"))).toBe(false);
    interrupted.publish = publish;
    const resumed = await new IssueLocalizer(interrupted).retrieve(request);
    expect(resumed.evidence[0]!.snippet).toContain("needle = 2");
  });
  it("bounds reads despite stale size metadata and explains duplicate anchors or invalid stack lines", async () => {
    const content = "// query\n" + " ".repeat(60_000);
    const source: IndexSource = {
      async manifest() {
        return {
          entries: Array.from({ length: 100 }, (_, i) => ({
            path: `file${i}.py`,
            sizeBytes: 1,
            kind: "FILE" as const,
          })),
          incomplete: false,
        };
      },
      async read() {
        return { content, truncated: false };
      },
    };
    const pack = await new IssueLocalizer().retrieve({
      ...options,
      source,
      description: "query file0.py:999999:1 file1.py",
    });
    expect(pack.metrics.readBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(pack.incomplete).toBe(true);
    expect(pack.missingInformation.join(" ")).toContain("Duplicate-content anchor");
    expect(pack.missingInformation.join(" ")).toContain("Stack line outside current file");
    expect(pack.evidence[0]!.endLine).toBeLessThanOrEqual(2);
  });
  it("merges Git additions, changes, deletions and rename tombstones into the immutable base", async () => {
    const files = new Map([
      ["src/renamed.ts", "export const a = 1;"],
      ["src/new.ts", "export const added = 2;"],
      ["src/changed.ts", "export const changed = 3;"],
    ]);
    const sandbox = {
      async exec() {
        return {
          exitCode: 0,
          stdout:
            "R  src/renamed.ts\0src/old.ts\0 D src/deleted.ts\0?? src/new.ts\0 M src/changed.ts\0",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          outputTruncated: false,
        };
      },
      async listFiles({ path }: { path: string }) {
        const content = files.get(path);
        return {
          entries:
            content === undefined
              ? []
              : [{ path, kind: "FILE", sizeBytes: Buffer.byteLength(content) }],
          truncated: false,
        };
      },
      async readFile({ path }: { path: string }) {
        return { path, content: files.get(path)!, encoding: "utf8", truncated: false };
      },
    } as unknown as SandboxSession;
    const base = {
      files: ["src/old.ts", "src/deleted.ts", "src/changed.ts"].map((path) => ({
        path,
        kind: "FILE",
        sizeBytes: 19,
        sha256: hash("export const a = 1;"),
        contentBase64: Buffer.from("export const a = 1;").toString("base64"),
      })),
    } as LocalRepositorySnapshot;
    const manifest = await overlaySource(base, sandbox).manifest(options.signal);
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual([
      "src/changed.ts",
      "src/new.ts",
      "src/renamed.ts",
    ]);
    expect(manifest.entries.find((entry) => entry.path === "src/changed.ts")?.contentHash).toBe(
      hash(files.get("src/changed.ts")!),
    );
  });

  it("rejects a patch after an observed file changes", async () => {
    let content = "export const target = 1;";
    const sandbox = {
      async readFile({ path }: { path: string }) {
        return { path, content, encoding: "utf8", truncated: false };
      },
      async applyPatch() {
        throw new Error("must not reach patch application");
      },
    } as unknown as SandboxSession;
    const tracked = revisionedSandbox(sandbox);
    await tracked.sandbox.readFile({ path: "src/a.ts" });
    content = "export const target = 2;";
    await expect(
      tracked.sandbox.applyPatch({
        patch:
          "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const target = 1;\n+export const target = 3;\n",
      }),
    ).rejects.toThrow("changed since evidence");
  });
  it("reuses unchanged parses across Runs; updates, renames and deletes follow the manifest", async () => {
    const files = new Map([
      ["src/a.ts", "export function fixBug() { return 1; }"],
      ["test/a.test.ts", "fixBug();"],
    ]);
    const localizer = new IssueLocalizer(new MemoryIndexStore());
    const request = {
      ...options,
      source: memorySource(files),
      description: "fix `fixBug` in src/a.ts and test/a.test.ts",
    };
    const cold = await localizer.retrieve(request);
    const warm = await localizer.retrieve({ ...request, runId: "run-2" });
    expect(cold.metrics.parsedFiles).toBe(2);
    expect(warm.metrics.parsedFiles).toBe(0);
    expect(warm.metrics.cacheState).toBe("WARM");
    files.set("src/a.ts", "export function fixBug() { return 2; }");
    const changed = await localizer.retrieve({ ...request, workspaceRevision: 1 });
    expect(changed.metrics.parsedFiles).toBe(1);
    expect(changed.evidence.find((e) => e.path === "src/a.ts")?.snippet).toContain("return 2");
    files.set("src/renamed.ts", files.get("src/a.ts")!);
    files.delete("src/a.ts");
    const renamed = await localizer.retrieve({ ...request, workspaceRevision: 2 });
    expect(renamed.metrics.parsedFiles).toBe(0);
    expect(renamed.evidence.map((e) => e.path)).not.toContain("src/a.ts");
    expect(renamed.evidence.map((e) => e.path)).toContain("src/renamed.ts");
    files.set("src/new.ts", "export function fixBugAgain() { return 3; }");
    const added = await localizer.retrieve({
      ...request,
      workspaceRevision: 3,
      description: "src/new.ts fixBugAgain()",
    });
    expect(added.evidence.map((e) => e.path)).toContain("src/new.ts");
    const version = await localizer.retrieve({ ...request, parserVersion: "changed-parser" });
    expect(version.metrics.parsedFiles).toBeGreaterThan(0);
  });

  it("isolates caches by access scope/repository and never publishes a cancelled parse", async () => {
    const store = new MemoryIndexStore();
    const localizer = new IssueLocalizer(store);
    const request = {
      ...options,
      source: memorySource(new Map([["src/a.ts", "export function alpha() {}"]])),
      description: "src/a.ts alpha()",
    };
    await localizer.retrieve(request);
    expect(
      (await localizer.retrieve({ ...request, accessScope: "scope-b" })).metrics.parsedFiles,
    ).toBe(1);
    expect(
      (await localizer.retrieve({ ...request, repositoryId: "repo-b" })).metrics.parsedFiles,
    ).toBe(1);
    const abort = new AbortController();
    abort.abort();
    await expect(localizer.retrieve({ ...request, signal: abort.signal })).rejects.toThrow();
    const [a, b] = await Promise.all([localizer.retrieve(request), localizer.retrieve(request)]);
    expect(a.evidence).toEqual(b.evidence);
  });

  it("handles natural language, same-name symbols across modules, syntax errors and other languages", async () => {
    const files = new Map([
      ["packages/a/login.ts", "export function login() { return 'invalid password'; }"],
      ["packages/b/login.ts", "export function login() { return 'session expired'; }"],
      ["docs/login.md", "登录失败：invalid password 表示密码错误"],
      ["src/login.py", "def login():\n    return 'invalid password'"],
    ]);
    const pack = await new IssueLocalizer().retrieve({
      ...options,
      source: memorySource(files),
      description: '登录错误 "invalid password" login()',
    });
    expect(pack.evidence.map((e) => e.path)).toEqual(
      expect.arrayContaining(["packages/a/login.ts", "packages/b/login.ts", "src/login.py"]),
    );
    expect((await parseCandidate("function broken( {", "ts", options.signal)).status).toBe(
      "PARSE_ERROR",
    );
    expect((await parseCandidate("def login(): pass", "py", options.signal)).status).toBe(
      "LEXICAL",
    );
  });

  it("keeps strong anchors and deterministically fuses lanes with zero absent contributions", () => {
    const rank = reciprocalRankFusion([["b", "a"], ["a"], []], ["z"]);
    expect(rank.map((row) => row.path)).toEqual(["z", "a", "b"]);
    expect(rank[2]?.score).toBeCloseTo(1 / 61);
    expect(
      extractIssueSignals("错误 src/a.ts:12:3 `doWork` test: rejects invalid input").stackFrames,
    ).toEqual([{ path: "src/a.ts", line: 12 }]);
  });

  it("reports no-result, oversize, forbidden paths, and exhausted evidence budgets", async () => {
    const files = new Map([
      ["src/a.ts", "export const a = 1;"],
      ["src/huge.ts", "x".repeat(70_000)],
      [".env", "DO_NOT_LEAK"],
      ["../escape.ts", "secret"],
      ["package-lock.json", "DO_NOT_LEAK"],
    ]);
    const pack = await new IssueLocalizer().retrieve({
      ...options,
      source: memorySource(files),
      description: "nonexistentIdentifier",
      tokenBudget: 2000,
    });
    expect(pack.evidence).toHaveLength(0);
    expect(pack.missingInformation.join(" ")).toContain("No supported evidence");
    expect(JSON.stringify(pack)).not.toContain("DO_NOT_LEAK");
    expect(pack.metrics.excluded).toMatchObject({
      FORBIDDEN: 2,
      OVERSIZE: 1,
      LOCK_METADATA_ONLY: 1,
    });
    for (const path of [
      "/etc/passwd",
      "../a.ts",
      "x/../../b.ts",
      ".git/config",
      "D:\\secret",
      "src/.env.local",
    ])
      expect(exclusionReason(path)).toBe("FORBIDDEN");
  });

  it("rejects stale snippets and symlinks; failed commands also advance the effective view", async () => {
    let reads = 0;
    const source = memorySource(new Map([["src/a.ts", "export const target = 1;"]]));
    source.read = async () => ({
      content: ++reads === 1 ? "export const target = 1;" : "export const target = 2;",
      truncated: false,
    });
    const pack = await new IssueLocalizer().retrieve({
      ...options,
      source,
      description: "src/a.ts target",
    });
    expect(pack.evidence).toHaveLength(0);
    expect(pack.missingInformation.join(" ")).toContain("Stale evidence rejected");
    const sandbox = {
      id: "x",
      workspacePath: "/workspace",
      listFiles: async () => ({
        entries: [{ path: "link.ts", kind: "SYMLINK" }],
        truncated: false,
      }),
      exec: async () => {
        throw new Error("partial write");
      },
    } as unknown as SandboxSession;
    await expect(sandboxSource(sandbox).read("link.ts", options.signal)).rejects.toThrow();
    const tracked = revisionedSandbox(sandbox);
    await expect(tracked.sandbox.exec({ program: "node", args: [] })).rejects.toThrow();
    expect(tracked.revision()).toBe(1);
  });

  it("wires evidence into PLAN and the policy-controlled EXECUTE tool without Review access", async () => {
    const pack = await new IssueLocalizer().retrieve({
      ...options,
      source: memorySource(new Map([["src/a.ts", "export const target = 1;"]])),
      description: "src/a.ts target",
    });
    expect(pack.evidence[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    const enabled = createTools(new SandboxGitService(), undefined, async () => pack);
    expect(toolsForStage(enabled.tools, "IMPLEMENTATION").map((tool) => tool.name)).toContain(
      "locateIssue",
    );
    expect(toolsForStage(enabled.tools, "REVIEW_REPAIR").map((tool) => tool.name)).not.toContain(
      "locateIssue",
    );
    expect(createTools(new SandboxGitService()).tools.map((tool) => tool.name)).not.toContain(
      "locateIssue",
    );
  });
});
