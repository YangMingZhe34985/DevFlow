import { describe, expect, it, vi } from "vitest";

import {
  GitHubProviderError,
  GitHubRestProvider,
  type GitHubCredentialSource,
  type GitHubPushRequest,
} from "../src/index.js";

const token = "github_pat_platform_only_secret_1234567890";
const credentials: GitHubCredentialSource = { getToken: async () => token };
const input: GitHubPushRequest = {
  operationKey: "run-1:push:0",
  repository: { owner: "devflow", name: "fixture" },
  baseCommit: "a".repeat(40),
  baseBranch: "main",
  branchName: "devflow/run-1",
  commitMessage: "Fix fixture",
  changes: [
    {
      kind: "UPSERT",
      path: "src/fix.ts",
      contentBase64: Buffer.from("fixed\n").toString("base64"),
      mode: "100644",
    },
    { kind: "DELETE", path: "src/old.ts" },
  ],
};

describe("GitHubRestProvider", () => {
  it("resolves the remote default branch or an explicit ref to a full commit SHA", async () => {
    const paths: string[] = [];
    const provider = new GitHubRestProvider({
      credentials,
      apiBaseUrl: "https://api.github.test",
      fetch: async (rawUrl) => {
        const path = new URL(String(rawUrl)).pathname;
        paths.push(path);
        if (path === "/repos/devflow/fixture") {
          return json(200, { default_branch: "trunk" });
        }
        if (path.endsWith("/commits/trunk")) return json(200, { sha: "b".repeat(40) });
        if (path.endsWith("/commits/release%2Fv2")) {
          return json(200, { sha: "c".repeat(40) });
        }
        return json(404, { message: "Not Found" });
      },
    });

    await expect(provider.resolveBaseCommit({ repository: input.repository })).resolves.toEqual({
      baseRef: "trunk",
      baseCommitSha: "b".repeat(40),
    });
    await expect(
      provider.resolveBaseCommit({ repository: input.repository, baseRef: "release/v2" }),
    ).resolves.toEqual({ baseRef: "release/v2", baseCommitSha: "c".repeat(40) });
    expect(paths).toEqual([
      "/repos/devflow/fixture",
      "/repos/devflow/fixture/commits/trunk",
      "/repos/devflow/fixture/commits/release%2Fv2",
    ]);
  });

  it("supports anonymous public-repository discovery and reports an invalid ref", async () => {
    const anonymousCredentials: GitHubCredentialSource = {
      getToken: async () => {
        throw new GitHubProviderError("AUTHENTICATION_FAILED", "not configured", false);
      },
    };
    let authorization: string | null = "unexpected";
    const provider = new GitHubRestProvider({
      credentials: anonymousCredentials,
      apiBaseUrl: "https://api.github.test",
      fetch: async (_rawUrl, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return json(404, { message: "Not Found" });
      },
    });

    await expect(
      provider.resolveBaseCommit({ repository: input.repository, baseRef: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", retryable: false });
    expect(authorization).toBeNull();
  });

  it("reads a bounded repository tree from the immutable base commit without exposing credentials", async () => {
    const requestedUrls: string[] = [];
    let authorization: string | null = null;
    const provider = new GitHubRestProvider({
      credentials,
      apiBaseUrl: "https://api.github.test",
      fetch: async (rawUrl, init) => {
        requestedUrls.push(String(rawUrl));
        authorization = new Headers(init?.headers).get("authorization");
        return json(200, {
          sha: "f".repeat(40),
          tree: [
            { path: "src", mode: "040000", type: "tree", sha: "1".repeat(40) },
            {
              path: "src/index.ts",
              mode: "100644",
              type: "blob",
              sha: "2".repeat(40),
              size: 42,
            },
            {
              path: "current",
              mode: "120000",
              type: "blob",
              sha: "3".repeat(40),
              size: 12,
            },
            { path: "vendor/sdk", mode: "160000", type: "commit", sha: "4".repeat(40) },
          ],
          truncated: true,
        });
      },
    });

    const tree = await provider.readRepositoryTree({
      repository: input.repository,
      baseCommitSha: "e".repeat(40),
    });

    expect(requestedUrls).toEqual([
      `https://api.github.test/repos/devflow/fixture/git/trees/${"e".repeat(40)}?recursive=1`,
    ]);
    expect(authorization).toBe(`Bearer ${token}`);
    expect(tree).toEqual({
      entries: [
        { path: "src", kind: "DIRECTORY" },
        { path: "src/index.ts", kind: "FILE", sizeBytes: 42 },
        { path: "current", kind: "SYMLINK", sizeBytes: 12 },
        { path: "vendor/sdk", kind: "DIRECTORY" },
      ],
      truncated: true,
    });
    expect(JSON.stringify(tree)).not.toContain(token);
  });

  it("creates blobs, tree, commit and ref from a fixed base, then detects duplicate delivery", async () => {
    let refCreated = false;
    const requests: Array<{
      method: string;
      path: string;
      body?: unknown;
      authorization: string | null;
    }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (rawUrl, init) => {
      const url = new URL(String(rawUrl));
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({
        method,
        path: url.pathname,
        ...(body === undefined ? {} : { body }),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (method === "GET" && url.pathname.endsWith("/git/ref/heads/devflow%2Frun-1")) {
        return refCreated
          ? json(200, {
              ref: "refs/heads/devflow/run-1",
              object: {
                sha: "d".repeat(40),
                type: "commit",
                url: "https://api.github.test/commit",
              },
            })
          : json(404, { message: "Not Found" });
      }
      if (method === "GET" && url.pathname.endsWith(`/git/commits/${"a".repeat(40)}`)) {
        return json(200, { sha: "a".repeat(40), message: "base", tree: { sha: "b".repeat(40) } });
      }
      if (method === "GET" && url.pathname.endsWith(`/git/commits/${"d".repeat(40)}`)) {
        return json(200, {
          sha: "d".repeat(40),
          message: "Fix fixture\n\nDevFlow-Operation: run-1:push:0",
          tree: { sha: "c".repeat(40) },
        });
      }
      if (method === "POST" && url.pathname.endsWith("/git/blobs")) {
        return json(201, { sha: "1".repeat(40) });
      }
      if (method === "POST" && url.pathname.endsWith("/git/trees")) {
        return json(201, { sha: "c".repeat(40) });
      }
      if (method === "POST" && url.pathname.endsWith("/git/commits")) {
        return json(201, {
          sha: "d".repeat(40),
          message: "created",
          tree: { sha: "c".repeat(40) },
        });
      }
      if (method === "POST" && url.pathname.endsWith("/git/refs")) {
        refCreated = true;
        return json(201, { ref: "refs/heads/devflow/run-1", object: { sha: "d".repeat(40) } });
      }
      return json(500, { message: "unexpected request" });
    });
    const provider = new GitHubRestProvider({
      credentials,
      apiBaseUrl: "https://api.github.test",
      webBaseUrl: "https://github.test",
      fetch: fetchMock,
    });

    const created = await provider.pushBranch(input);
    const duplicate = await provider.pushBranch(input);

    expect(created).toMatchObject({ commitSha: "d".repeat(40), idempotent: false });
    expect(duplicate).toMatchObject({ commitSha: "d".repeat(40), idempotent: true });
    expect(requests.filter((request) => request.path.endsWith("/git/refs"))).toHaveLength(1);
    expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
    expect(requests.find((request) => request.path.endsWith("/git/trees"))?.body).toEqual({
      base_tree: "b".repeat(40),
      tree: [
        { path: "src/fix.ts", mode: "100644", type: "blob", sha: "1".repeat(40) },
        { path: "src/old.ts", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(JSON.stringify({ created, duplicate, input })).not.toContain(token);
  });

  it("redacts credential-like text from provider and network failures", async () => {
    const provider = new GitHubRestProvider({
      credentials,
      apiBaseUrl: "https://api.github.test",
      fetch: async () => json(500, { message: `upstream echoed ${token}` }),
    });
    let failure: unknown;
    try {
      await provider.pushBranch(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitHubProviderError);
    expect(failure).toMatchObject({ code: "PROVIDER_FAILED", retryable: true, status: 500 });
    expect(JSON.stringify((failure as GitHubProviderError).toJSON())).not.toContain(token);
    expect((failure as Error).message).toContain("[REDACTED]");
  });
});

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
