import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DockerSandboxManager,
  type DockerCommandOptions,
  type DockerCommandResult,
  type DockerCommandRunner,
  type SandboxCreateOptions,
} from "../src/index.js";

class RecordingDockerRunner implements DockerCommandRunner {
  readonly calls: readonly string[][] = [];

  constructor(private readonly failOperation?: string) {}

  async run(
    args: readonly string[],
    _options?: DockerCommandOptions,
  ): Promise<DockerCommandResult> {
    (this.calls as string[][]).push([...args]);
    const failed = args[0] === this.failOperation;
    return {
      exitCode: failed ? 1 : 0,
      stdout: failed ? "" : "ok\n",
      stderr: failed ? "simulated failure" : "",
      durationMs: 1,
      outputTruncated: false,
    };
  }
}

function createOptions(runId: string): SandboxCreateOptions {
  return {
    runId,
    repository: { sourceUri: pathToFileURL(process.cwd()).href },
    limits: {
      cpuCount: 1,
      memoryMb: 512,
      pids: 64,
      timeoutMs: 1_000,
      networkEnabled: false,
    },
  };
}

describe("DockerSandboxManager", () => {
  it("creates, uses and removes a container without a host execution fallback", async () => {
    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const session = await manager.create(createOptions(randomUUID()));

    await session.exec({ program: "node", args: ["--version"] });
    await session.dispose();

    expect(runner.calls.map((args) => args[0])).toEqual([
      "create",
      "start",
      "cp",
      "exec",
      "exec",
      "rm",
    ]);
    const command = runner.calls[4] ?? [];
    expect(command).toContain("/workspace");
    expect(command).toContain("node");
    expect(command).toContain("--version");
    expect(runner.calls[0]).toEqual(
      expect.arrayContaining([
        "--cpus",
        "1",
        "--memory",
        "512m",
        "--memory-swap",
        "512m",
        "--pids-limit",
        "64",
        "--network",
        "none",
        "--security-opt",
        "no-new-privileges",
      ]),
    );
  });

  it("removes a partially-created container when startup fails", async () => {
    const runner = new RecordingDockerRunner("start");
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });

    await expect(manager.create(createOptions(randomUUID()))).rejects.toMatchObject({
      code: "SANDBOX_FAILED",
    });
    expect(runner.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("rejects path traversal before invoking Docker", async () => {
    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const session = await manager.create(createOptions(randomUUID()));
    const callsBeforeRead = runner.calls.length;

    await expect(session.readFile({ path: "../outside.txt" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(runner.calls).toHaveLength(callsBeforeRead);
    await session.dispose();
  });

  it("requires network access for remote clones and emits structured clone arguments", async () => {
    const deniedRunner = new RecordingDockerRunner();
    const deniedManager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: deniedRunner,
    });
    const denied = createOptions(randomUUID());
    denied.repository = { sourceUri: "https://example.invalid/repository.git" };
    await expect(deniedManager.create(denied)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(deniedRunner.calls).toHaveLength(0);

    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const allowed = createOptions(randomUUID());
    allowed.repository = {
      sourceUri: "https://example.invalid/repository.git",
      baseRef: "main",
    };
    allowed.limits.networkEnabled = true;
    const session = await manager.create(allowed);

    expect(runner.calls[2]).toEqual(
      expect.arrayContaining([
        "git",
        "clone",
        "--branch",
        "main",
        "--single-branch",
        "--",
        "https://example.invalid/repository.git",
        "/workspace",
      ]),
    );
    await session.dispose();
  });

  it("validates resource and environment limits before container creation", async () => {
    const runner = new RecordingDockerRunner();
    const manager = new DockerSandboxManager({
      image: "devflow-sandbox:test",
      workspaceRoot: path.resolve("."),
      commandRunner: runner,
    });
    const invalid = createOptions(randomUUID());
    invalid.limits.memoryMb = 5;

    await expect(manager.create(invalid)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runner.calls).toHaveLength(0);
  });
});
