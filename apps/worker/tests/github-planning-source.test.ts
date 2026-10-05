import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FakeGitHubProvider, GitHubRestProvider } from "../../../packages/github/src/index.js";
import { githubRepositorySource } from "../src/localization/github-source.js";

const repository = { owner: "public", name: "fixture" };
const baseCommitSha = "a".repeat(40);
const content = "export function value() { return 1; }\n";
const blobSha = createHash("sha1")
  .update(`blob ${Buffer.byteLength(content)}\0`)
  .update(content)
  .digest("hex");
const signal = () => new AbortController().signal;

describe("immutable GitHub planning source", () => {
  it("reads fixed tree blobs without commands, mutations or exposing credentials and caches bytes", async () => {
    const github = new FakeGitHubProvider({ repositoryFiles: { "src/value.ts": content } });
    const source = await githubRepositorySource({ github, repository, baseCommitSha }, signal());
    expect(github.repositoryTreeCalls).toEqual([{ repository, baseCommitSha }]);
    expect((await source.lookup!("src/value.ts", signal()))?.blobId).toBe(blobSha);
    expect(await source.read("src/value.ts", signal())).toEqual({ content, truncated: false });
    await source.read("src/value.ts", signal());
    expect(github.repositoryFileCalls).toHaveLength(1);
    expect((await source.lookup!("src/value.ts", signal()))?.contentHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(github.pushCalls).toHaveLength(0);
  });

  it("fails closed for mutable refs, symlinks, forbidden paths and oversized files", async () => {
    const github = new FakeGitHubProvider({
      repositoryTree: {
        truncated: false,
        entries: [
          { path: "link.ts", kind: "SYMLINK", sizeBytes: 2, blobSha },
          { path: ".env", kind: "FILE", sizeBytes: 2, blobSha },
          { path: "large.ts", kind: "FILE", sizeBytes: 600000, blobSha },
        ],
      },
    });
    await expect(
      githubRepositorySource({ github, repository, baseCommitSha: "main" }, signal()),
    ).rejects.toThrow();
    const source = await githubRepositorySource({ github, repository, baseCommitSha }, signal());
    for (const path of ["link.ts", ".env", "large.ts", "../secret"])
      await expect(source.read(path, signal())).rejects.toThrow();
    expect(github.repositoryFileCalls).toHaveLength(0);
  });

  it("rejects changed object content and preserves truncation and cancellation", async () => {
    const github = new FakeGitHubProvider({ repositoryFiles: { "src/value.ts": content } });
    vi.spyOn(github, "readRepositoryFile").mockResolvedValue({
      content: content + "x",
      sizeBytes: Buffer.byteLength(content) + 1,
      blobSha,
    });
    const source = await githubRepositorySource({ github, repository, baseCommitSha }, signal());
    await expect(source.read("src/value.ts", signal())).rejects.toThrow("identity");
    const controller = new AbortController();
    controller.abort();
    await expect(source.read("src/value.ts", controller.signal)).rejects.toThrow();
    const truncated = await githubRepositorySource(
      {
        github: new FakeGitHubProvider({ repositoryTree: { entries: [], truncated: true } }),
        repository,
        baseCommitSha,
      },
      signal(),
    );
    expect((await truncated.manifest(signal())).incomplete).toBe(true);
  });

  it("fetches only the fixed blob endpoint and verifies encoding and object hash", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            sha: blobSha,
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
            size: Buffer.byteLength(content),
          }),
        ),
    );
    const provider = new GitHubRestProvider({
      credentials: { getToken: async () => "fake-test-token" },
      fetch,
    });
    expect(await provider.readRepositoryFile({ repository, blobSha, maxBytes: 512 })).toEqual({
      content,
      blobSha,
      sizeBytes: Buffer.byteLength(content),
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://api.github.com/repos/public/fixture/git/blobs/${blobSha}`,
    );
    const result = JSON.stringify(
      await provider.readRepositoryFile({ repository, blobSha, maxBytes: 512 }),
    );
    expect(result).not.toContain("fake-test-token");
  });

  it("rejects invalid, changed and oversized provider bodies", async () => {
    for (const response of [
      { sha: blobSha, encoding: "base64", content: "@@@@", size: 3 },
      {
        sha: blobSha,
        encoding: "base64",
        content: Buffer.from("changed").toString("base64"),
        size: 7,
      },
      { sha: blobSha, encoding: "base64", content: "", size: 600000 },
    ]) {
      const provider = new GitHubRestProvider({
        credentials: { getToken: async () => "fake" },
        fetch: async () => new Response(JSON.stringify(response)),
      });
      await expect(
        provider.readRepositoryFile({ repository, blobSha, maxBytes: 512 }),
      ).rejects.toThrow();
    }
    const provider = new GitHubRestProvider({
      credentials: { getToken: async () => "fake" },
      fetch: async () => new Response("x".repeat(10000)),
    });
    await expect(
      provider.readRepositoryFile({ repository, blobSha, maxBytes: 10 }),
    ).rejects.toThrow("byte limit");
  });
});
