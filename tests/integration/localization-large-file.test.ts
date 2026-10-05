import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DockerSandboxManager } from "@devflow/sandbox";
import { replaceText } from "../../packages/tools/src/replace-text.js";
import type { ToolContext } from "@devflow/tools";
import { revisionedSandbox } from "../../apps/worker/src/localization/sources.js";
import { expect, it } from "vitest";

const dockerIt = process.env.DEVFLOW_DOCKER_INTEGRATION === "1" ? it : it.skip;
dockerIt(
  "edits and re-edits a large Docker file through the real localization revision guard",
  async () => {
    const root = path.resolve("tests/fixtures/calculator-bug");
    const sandbox = await new DockerSandboxManager({
      image: "devflow-sandbox:local",
      workspaceRoot: root,
    }).create({
      runId: randomUUID(),
      repository: { sourceUri: pathToFileURL(root).href },
      limits: { cpuCount: 1, memoryMb: 256, pids: 64, timeoutMs: 60000, networkEnabled: false },
    });
    const signal = AbortSignal.timeout(60000);
    try {
      const file = "src/large.js";
      const original = "// padding\n".repeat(14000) + "export const value = 1;\n";
      await sandbox.writeFile({ path: file, content: original }, signal);
      const tracked = revisionedSandbox(sandbox);
      const visible = await tracked.sandbox.readFile({ path: file, maxBytes: 4096 }, signal);
      expect(visible.truncated).toBe(true);
      const context = { sandbox: tracked.sandbox, signal } as ToolContext;
      const first = await replaceText(
        {
          path: file,
          oldText: "value = 1",
          newText: "value = 2",
          expectedOccurrences: 1,
          expectedSha256: visible.fileSha256!,
        },
        context,
      );
      expect(first.status).toBe("APPLIED");
      const second = await replaceText(
        {
          path: file,
          oldText: "value = 2",
          newText: "value = 3",
          expectedOccurrences: 1,
          expectedSha256: first.sha256,
        },
        context,
      );
      expect(second.status).toBe("APPLIED");
      expect((await sandbox.readFile({ path: file, maxBytes: 1_000_000 }, signal)).content).toBe(
        original.replace("value = 1", "value = 3"),
      );
      await sandbox.writeFile(
        { path: file, content: original.replace("value = 1", "value = 4") },
        signal,
      );
      await expect(
        tracked.sandbox.writeFile(
          { path: file, content: "must not write", expectedSha256: second.sha256 },
          signal,
        ),
      ).rejects.toThrow("changed since evidence");
      expect((await sandbox.readFile({ path: file, maxBytes: 1_000_000 }, signal)).content).toBe(
        original.replace("value = 1", "value = 4"),
      );
    } finally {
      await sandbox.dispose();
    }
  },
  120000,
);
