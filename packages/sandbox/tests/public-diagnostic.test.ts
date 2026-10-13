import { expect, it, vi } from "vitest";
import { PublicDiagnosticRunner, publicDiagnosticResources } from "../src/public-diagnostic.js";
import { DevflowError } from "@devflow/shared";
import type { DockerCommandRunner } from "../src/docker-sandbox-manager.js";

const image = `sha256:${"b".repeat(64)}`;
function fixture(mounts: unknown[] = []) {
  const run = vi.fn<DockerCommandRunner["run"]>(async (args) => ({
    exitCode: 0,
    stderr: "",
    durationMs: 1,
    outputTruncated: false,
    stdout:
      args[0] === "inspect"
        ? JSON.stringify([
            {
              Config: { Labels: { "devflow.managed": "true", "devflow.runId": "run" } },
              Mounts: mounts,
            },
          ])
        : args[0] === "commit"
          ? image
          : "observed",
  }));
  const input = {
    containerId: "devflow-run-uuid",
    runId: "run",
    command: {
      program: "node",
      args: ["public-test.js"],
      cwd: ".",
      environment: {},
      timeoutMs: 30000,
    },
    signal: new AbortController().signal,
    assertOwnership: vi.fn(async () => undefined),
  };
  return { run, input, runner: new PublicDiagnosticRunner({ run }) };
}
it("uses a private snapshot, scrubbed environment, no network and no shared candidate mount", async () => {
  const { run, input, runner } = fixture();
  const result = await runner.run(input);
  expect(result).toMatchObject({ isolated: true, snapshotImage: image });
  const args = run.mock.calls.find(([args]) => args[0] === "run")![0];
  expect(args).toEqual(
    expect.arrayContaining([
      "--read-only",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "/usr/bin/env",
      "-i",
      image,
    ]),
  );
  expect(args).not.toContain("--volume");
  expect(args).not.toContain("--volumes-from");
  expect(run.mock.calls.filter(([a]) => a[0] === "rm")).toHaveLength(1);
  expect(run.mock.calls.filter(([a]) => a[0] === "image")).toHaveLength(1);
  expect(run.mock.calls.map(([, options]) => options?.maxOutputBytes)).toEqual([
    128 * 1024,
    2 * 1024,
    32 * 1024,
    2 * 1024,
    2 * 1024,
  ]);
});
it("rejects mounted or foreign candidates before capturing or executing", async () => {
  const { runner, input, run } = fixture([{ Destination: "/workspace" }]);
  await expect(runner.run(input)).rejects.toThrow("mount-free");
  expect(run.mock.calls.some(([a]) => a[0] === "commit" || a[0] === "run")).toBe(false);
});
it("lost ownership prevents command dispatch and still cleans up the private image", async () => {
  const { runner, input, run } = fixture();
  input.assertOwnership
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("stale owner"));
  await expect(runner.run(input)).rejects.toThrow("stale owner");
  expect(run.mock.calls.some(([a]) => a[0] === "run")).toBe(false);
  expect(run.mock.calls.some(([a]) => a[0] === "image")).toBe(true);
});
it("bounds a hung ownership query and attempts both cleanup operations", async () => {
  const { runner, input, run } = fixture();
  input.assertOwnership.mockImplementationOnce(() => new Promise(() => undefined));
  input.signal = AbortSignal.timeout(20);
  await expect(runner.run(input)).rejects.toThrow();
  expect(run.mock.calls.some(([a]) => a[0] === "run")).toBe(false);
  expect(run.mock.calls.filter(([a]) => a[0] === "rm" || a[0] === "image")).toHaveLength(2);
});

it("preserves the original failure when cleanup also fails, including exact recoverable resources", async () => {
  const { runner, input, run } = fixture();
  const resources = publicDiagnosticResources("a".repeat(64));
  input.assertOwnership.mockRejectedValueOnce(
    new DevflowError({ code: "SANDBOX_LOST_OWNERSHIP", message: "Original lease expired" }),
  );
  run.mockRejectedValueOnce(new Error("Docker cleanup unavailable"));
  await expect(runner.run({ ...input, resources })).rejects.toMatchObject({
    code: "SANDBOX_LOST_OWNERSHIP",
    message: "Original lease expired",
    details: {
      primaryFailure: { code: "SANDBOX_LOST_OWNERSHIP" },
      cleanupFailure: { code: "SANDBOX_FAILED" },
      resources,
    },
  });
  expect(run.mock.calls).toHaveLength(2);
  expect(run.mock.calls[0]![0]).toEqual(["rm", "--force", resources.containerName]);
  expect(run.mock.calls[1]![0]).toEqual(["image", "rm", "--force", resources.snapshotTag]);
});

it("recovery only removes a persisted exact resource pair and never captures or executes", async () => {
  const { runner, run } = fixture();
  const resources = publicDiagnosticResources("c".repeat(64));
  await runner.cleanup({ resources });
  expect(run.mock.calls.map(([args]) => args[0])).toEqual(["rm", "image"]);
  run.mockClear();
  await expect(
    runner.cleanup({ resources: { ...resources, containerName: "devflow-coding-candidate" } }),
  ).rejects.toThrow("exact host");
  expect(run).not.toHaveBeenCalled();
});

it("a pre-cancelled operation starts no ownership or capture work but retains bounded cleanup", async () => {
  const { runner, input, run } = fixture();
  input.signal = AbortSignal.abort(new Error("cancelled before dispatch"));
  await expect(runner.run(input)).rejects.toThrow("cancelled before dispatch");
  expect(input.assertOwnership).not.toHaveBeenCalled();
  expect(run.mock.calls.map(([args]) => args[0])).toEqual(["rm", "image"]);
});
