import type { SandboxSession } from "@devflow/sandbox";
import { describe, expect, it, vi } from "vitest";

import {
  captureGitHubChanges,
  isGitHubRepositoryUri,
  parseGitHubRepositoryUri,
} from "../src/runs/github-changeset.js";

describe("GitHub change-set capture", () => {
  it("captures modifications, renames, deletions and untracked files without host access", async () => {
    const exec = vi
      .fn<SandboxSession["exec"]>()
      .mockResolvedValueOnce(commandResult("R100\0old.ts\0new.ts\0D\0gone.ts\0M\0mod.ts\0"))
      .mockResolvedValueOnce(commandResult("fresh.ts\0"))
      .mockResolvedValueOnce(
        commandResult(
          JSON.stringify([
            encoded("new.ts", "renamed"),
            encoded("mod.ts", "modified"),
            encoded("fresh.ts", "new"),
          ]),
        ),
      );
    const sandbox = { exec } as unknown as SandboxSession;

    await expect(captureGitHubChanges(sandbox, "a".repeat(40))).resolves.toEqual([
      { kind: "UPSERT", path: "fresh.ts", contentBase64: base64("new"), mode: "100644" },
      { kind: "DELETE", path: "gone.ts" },
      {
        kind: "UPSERT",
        path: "mod.ts",
        contentBase64: base64("modified"),
        mode: "100644",
      },
      {
        kind: "UPSERT",
        path: "new.ts",
        contentBase64: base64("renamed"),
        mode: "100644",
      },
      { kind: "DELETE", path: "old.ts" },
    ]);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: ["diff", "--name-status", "-z", "--find-renames", "a".repeat(40), "--"],
      }),
      undefined,
    );
  });

  it("accepts token-free GitHub HTTPS/SCP URIs and rejects embedded credentials", () => {
    expect(parseGitHubRepositoryUri("https://github.com/openai/devflow.git")).toEqual({
      owner: "openai",
      name: "devflow",
    });
    expect(parseGitHubRepositoryUri("git@github.com:openai/devflow.git")).toEqual({
      owner: "openai",
      name: "devflow",
    });
    expect(() => parseGitHubRepositoryUri("https://secret@github.com/openai/devflow.git")).toThrow(
      /requires an https/u,
    );
    expect(isGitHubRepositoryUri("https://github.com/openai/devflow.git")).toBe(true);
    expect(isGitHubRepositoryUri("https://gitlab.com/openai/devflow.git")).toBe(false);
  });

  it("always diffs from the fixed base even when the Agent changed HEAD", async () => {
    const exec = vi
      .fn<SandboxSession["exec"]>()
      .mockResolvedValueOnce(commandResult("M\0committed.ts\0"))
      .mockResolvedValueOnce(commandResult(""))
      .mockResolvedValueOnce(
        commandResult(JSON.stringify([encoded("committed.ts", "committed content")])),
      );
    const sandbox = { exec } as unknown as SandboxSession;

    await expect(captureGitHubChanges(sandbox, "b".repeat(40))).resolves.toEqual([
      {
        kind: "UPSERT",
        path: "committed.ts",
        contentBase64: base64("committed content"),
        mode: "100644",
      },
    ]);
    expect(exec.mock.calls[0]?.[0].args).toContain("b".repeat(40));
    expect(exec.mock.calls[0]?.[0].args).not.toContain("HEAD");
  });
});

function encoded(path: string, content: string) {
  return { path, contentBase64: base64(content), mode: "100644" };
}

function base64(value: string): string {
  return Buffer.from(value).toString("base64");
}

function commandResult(stdout: string) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
  };
}
