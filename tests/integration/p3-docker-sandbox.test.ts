import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  DockerSandboxManager,
  type CommandResult,
  type SandboxLimits,
  type SandboxSession,
} from "@devflow/sandbox";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const dockerIt = process.env.DEVFLOW_DOCKER_INTEGRATION === "1" ? it : it.skip;
const fixturePath = path.resolve("tests/fixtures/calculator-bug");

describe("P3 Docker sandbox", () => {
  dockerIt(
    "applies resource, network, environment, cwd and output limits",
    async () => {
      const runId = randomUUID();
      const manager = createManager();
      let sandbox: SandboxSession | undefined;
      let sandboxId = "";
      try {
        sandbox = await createSandbox(manager, runId, {
          cpuCount: 0.5,
          memoryMb: 128,
          pids: 32,
          timeoutMs: 10_000,
          networkEnabled: false,
        });
        sandboxId = sandbox.id;
        const inspection = await inspectContainer(sandbox.id);

        expect(inspection.HostConfig.NanoCpus).toBe(500_000_000);
        expect(inspection.HostConfig.Memory).toBe(128 * 1024 * 1024);
        expect(inspection.HostConfig.MemorySwap).toBe(128 * 1024 * 1024);
        expect(inspection.HostConfig.PidsLimit).toBe(32);
        expect(inspection.HostConfig.NetworkMode).toBe("none");
        expect(inspection.Config.WorkingDir).toBe("/workspace");
        expect(inspection.Config.Env).toContain("P3_UNICODE=环境正常");

        await expectSuccess(
          sandbox.exec({
            program: "node",
            args: ["-e", "require('node:fs').mkdirSync('nested', { recursive: true })"],
          }),
        );
        const cwdAndEnvironment = await sandbox.exec({
          program: "node",
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({ cwd: process.cwd(), value: process.env.P3_UNICODE }))",
          ],
          cwd: "nested",
        });
        expect(JSON.parse(cwdAndEnvironment.stdout)).toEqual({
          cwd: "/workspace/nested",
          value: "环境正常",
        });

        const boundedOutput = await sandbox.exec({
          program: "node",
          args: ["-e", "process.stdout.write('x'.repeat(10000))"],
          maxOutputBytes: 128,
        });
        expect(Buffer.byteLength(boundedOutput.stdout, "utf8")).toBeLessThanOrEqual(128);
        expect(boundedOutput.outputTruncated).toBe(true);
      } finally {
        await sandbox?.dispose();
      }
      expect(await containerExists(sandboxId)).toBe(false);
    },
    120_000,
  );

  dockerIt(
    "blocks lexical path traversal and symlink escape",
    async () => {
      const manager = createManager();
      const sandbox = await createSandbox(manager, randomUUID());
      const sandboxId = sandbox.id;
      try {
        await expect(sandbox.readFile({ path: "../etc/passwd" })).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
        await expectSuccess(
          sandbox.exec({
            program: "node",
            args: ["-e", "require('node:fs').symlinkSync('/etc', 'escape', 'dir')"],
          }),
        );
        await expect(sandbox.readFile({ path: "escape/passwd" })).rejects.toMatchObject({
          code: "SANDBOX_FAILED",
        });
        await expect(
          sandbox.writeFile({ path: "escape/devflow-p3", content: "blocked" }),
        ).rejects.toMatchObject({ code: "SANDBOX_FAILED" });

        const escapedCwd = await sandbox.exec({
          program: "node",
          args: ["-e", "process.stdout.write(process.cwd())"],
          cwd: "escape",
        });
        expect(escapedCwd.exitCode).not.toBe(0);
        expect(escapedCwd.stderr).toContain("symlink escape outside /workspace");
      } finally {
        await sandbox.dispose();
      }
      expect(await containerExists(sandboxId)).toBe(false);
    },
    120_000,
  );

  dockerIt(
    "removes the container after command timeout and cancellation",
    async () => {
      const timeoutManager = createManager();
      const timedSandbox = await createSandbox(timeoutManager, randomUUID(), {
        cpuCount: 1,
        memoryMb: 128,
        pids: 32,
        timeoutMs: 5_000,
        networkEnabled: false,
      });
      const timedSandboxId = timedSandbox.id;
      const timedResult = await timedSandbox.exec({
        program: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 200,
      });
      expect(timedResult.timedOut).toBe(true);
      expect(await containerExists(timedSandboxId)).toBe(false);
      await timedSandbox.dispose();

      const cancelManager = createManager();
      const cancelledSandbox = await createSandbox(cancelManager, randomUUID());
      const cancelledSandboxId = cancelledSandbox.id;
      const cancellation = new AbortController();
      const timer = setTimeout(() => cancellation.abort(), 250);
      try {
        await expect(
          cancelledSandbox.exec(
            {
              program: "node",
              args: ["-e", "setInterval(() => {}, 1000)"],
              timeoutMs: 10_000,
            },
            cancellation.signal,
          ),
        ).rejects.toMatchObject({ code: "CANCELLED" });
      } finally {
        clearTimeout(timer);
        await cancelledSandbox.dispose();
      }
      expect(await containerExists(cancelledSandboxId)).toBe(false);
    },
    120_000,
  );

  dockerIt(
    "cleans a partially initialized container after checkout failure",
    async () => {
      const runId = randomUUID();
      const manager = createManager();
      await expect(
        manager.create({
          runId,
          repository: {
            sourceUri: pathToFileURL(fixturePath).href,
            baseCommit: "deadbeef",
          },
          limits: defaultLimits(),
        }),
      ).rejects.toMatchObject({ code: "SANDBOX_FAILED" });
      expect(await containerExists(containerName(runId))).toBe(false);
    },
    120_000,
  );
});

function createManager(): DockerSandboxManager {
  return new DockerSandboxManager({
    image: "devflow-sandbox:local",
    workspaceRoot: fixturePath,
  });
}

async function createSandbox(
  manager: DockerSandboxManager,
  runId: string,
  limits: SandboxLimits = defaultLimits(),
): Promise<SandboxSession> {
  return await manager.create({
    runId,
    repository: { sourceUri: pathToFileURL(fixturePath).href },
    limits,
    environment: { P3_UNICODE: "环境正常" },
  });
}

function defaultLimits(): SandboxLimits {
  return {
    cpuCount: 1,
    memoryMb: 256,
    pids: 64,
    timeoutMs: 30_000,
    networkEnabled: false,
  };
}

async function inspectContainer(containerId: string): Promise<{
  Config: { Env: string[]; WorkingDir: string };
  HostConfig: {
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    NetworkMode: string;
    PidsLimit: number;
  };
}> {
  const { stdout } = await execFileAsync("docker", ["inspect", containerId], {
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(stdout)[0] as {
    Config: { Env: string[]; WorkingDir: string };
    HostConfig: {
      Memory: number;
      MemorySwap: number;
      NanoCpus: number;
      NetworkMode: string;
      PidsLimit: number;
    };
  };
}

async function expectSuccess(promise: Promise<CommandResult>): Promise<void> {
  const result = await promise;
  expect(result.exitCode, result.stderr).toBe(0);
}

async function containerExists(containerId: string): Promise<boolean> {
  if (containerId.length === 0) return false;
  try {
    await execFileAsync("docker", ["inspect", containerId], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function containerName(runId: string): string {
  return ("devflow-" + runId.replace(/[^a-zA-Z0-9_.-]/gu, "-")).slice(0, 63);
}
