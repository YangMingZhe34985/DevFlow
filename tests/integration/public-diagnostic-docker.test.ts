import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DockerSandboxManager,
  NodeDockerCommandRunner,
  PublicDiagnosticRunner,
} from "@devflow/sandbox";

describe.skipIf(process.env.DEVFLOW_RESOURCE_BUDGET_INTEGRATION !== "1")(
  "optional public diagnostic isolation",
  () => {
    it("executes in a disposable copy; writes, credentials, network and pass claims cannot affect the candidate", async () => {
      const runId = randomUUID(),
        runner = new NodeDockerCommandRunner();
      const manager = new DockerSandboxManager({
        image: "devflow-sandbox:local",
        workspaceRoot: path.resolve("tests/fixtures"),
      });
      const sandbox = await manager.create({
        runId,
        repository: { sourceUri: path.resolve("tests/fixtures/calculator-bug") },
        limits: { cpuCount: 1, memoryMb: 1024, pids: 128, timeoutMs: 60000, networkEnabled: false },
        environment: { PRIVATE_RUNTIME_MARKER: "must-not-inherit" },
      });
      try {
        const original = await sandbox.readFile({ path: "src/calculator.js" });
        const result = await new PublicDiagnosticRunner(runner)
          .run({
            containerId: sandbox.id,
            runId,
            signal: AbortSignal.timeout(60000),
            assertOwnership: async () => undefined,
            command: {
              program: "node",
              args: [
                "-e",
                `const fs=require('fs'),assert=require('assert');
          assert.equal(process.env.PRIVATE_RUNTIME_MARKER,undefined);
          assert.deepEqual(fs.readdirSync('/sys/class/net'),['lo']);
          fs.writeFileSync('src/calculator.js','isolated mutation');
          assert.throws(()=>fs.writeFileSync('/workspace/src/calculator.js','forbidden'));
          console.log('ISOLATED_PUBLIC_OBSERVATION');`,
              ],
              cwd: ".",
              environment: {},
              timeoutMs: 30000,
            },
          })
          .catch((error) => {
            throw new Error(JSON.stringify(error));
          });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain("ISOLATED_PUBLIC_OBSERVATION");
        expect((await sandbox.readFile({ path: "src/calculator.js" })).fileSha256).toBe(
          original.fileSha256,
        );
      } finally {
        await sandbox.dispose();
      }
    }, 90000);
  },
);
