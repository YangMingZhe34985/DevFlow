/** T6 only: scripted exact edits through the real sandbox + autonomous runtime. */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { DockerSandboxManager, type LocalRepositorySnapshot } from "@devflow/sandbox";
import { runAttempts } from "../../../apps/worker/src/autonomous/attempts.ts";

const directory = ".devflow/external-set-suite/private/bridge/X11";
const input = JSON.parse(await fs.readFile(directory + "/scripted-input.json", "utf8"));
if (!input.rootfsAudit.passed) throw Error("Rootfs audit did not pass");
input.snapshot.files.sort((a: { path: string }, b: { path: string }) =>
  a.path.localeCompare(b.path, "en"),
);
const manager = new DockerSandboxManager({ image: input.imageId, workspaceRoot: process.cwd() });
let session: Awaited<ReturnType<typeof manager.create>> | undefined;
const signal = AbortSignal.timeout(300_000);
const events: unknown[] = [];
try {
  const result = await runAttempts({
    sandboxFactory: async () => {
      session = await manager.create(
        {
          runId: randomUUID(),
          owner: { executionOwner: "external-set", dispatchRevision: 0, segment: randomUUID() },
          repository: {
            sourceUri: path.resolve(".devflow/external-set-suite/public-base/X11"),
            snapshot: input.snapshot as LocalRepositorySnapshot,
          },
          limits: {
            cpuCount: 2,
            memoryMb: 4096,
            pids: 512,
            timeoutMs: 300_000,
            networkEnabled: false,
          },
        },
        signal,
      );
      const identity = JSON.parse(execFileSync("docker", ["inspect", session.id]).toString())[0];
      if (
        identity.HostConfig.NetworkMode !== "none" ||
        identity.Config.Labels["devflow.suite"] !== "external-set"
      )
        throw Error("Isolation mismatch");
      const before = await session.exec(
        {
          program: "bash",
          args: [
            "-c",
            'id -u; node --version; test ! -e /eval.sh && test ! -e /gold.patch && test ! -e /candidate.patch; git rev-list --all --count; git log --all --format=%T | sort -u | wc -l; test "$(readlink -f /testbed)" = /workspace',
          ],
        },
        signal,
      );
      if (
        before.exitCode !== 0 ||
        !before.stdout.startsWith("10001\n") ||
        before.stdout.split("\n")[3]?.trim() !== "1"
      )
        throw Error("Bridge identity/audit failed");
      await fs.writeFile(
        directory + "/runtime-audit.json",
        JSON.stringify({
          network: "none",
          user: "10001",
          before: before.stdout,
          rootfsAuditPassed: true,
        }),
      );
      return session;
    },
    maxAttempts: 1,
    issue: { title: input.task.title, body: input.task.description },
    checks: [],
    maxRevisions: 0,
    model: new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: input.edits.map((edit: unknown, i: number) => ({
          id: "edit-" + i,
          name: "edit_file",
          input: edit,
        })),
      }),
      fakeModelResponse({
        toolCalls: [
          {
            id: "submit",
            name: "submit",
            input: { summary: "Scripted T6 bridge; not real model capability." },
          },
        ],
      }),
    ]),
    limits: { maxTurns: 10, deadlineAt: Date.now() + 300_000 },
    protectedPath: (path) =>
      path.startsWith("tests/") ? "Public tests are read-only." : undefined,
    signal,
    onEvent: (event) => {
      events.push(event);
    },
  });
  if (result.selected.kernel.stopReason !== "SUBMITTED" || !result.selected.patch)
    throw Error("Fake bridge did not submit a patch");
  await fs.writeFile(directory + "/candidate.diff", result.selected.patch);
  await fs.writeFile(
    directory + "/runtime-result.json",
    JSON.stringify(
      {
        stop: result.selected.kernel.stopReason,
        changedFiles: result.selected.changedFiles,
        usage: result.usage,
        checks: result.selected.verification,
        selectedAttempt: result.selectedAttempt,
        note: "No public profile configured in T6; independent official grading is separate.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      stop: result.selected.kernel.stopReason,
      changedFiles: result.selected.changedFiles,
      model: "FakeLanguageModel",
      paid: false,
    }),
  );
} finally {
  await fs.writeFile(directory + "/runtime-events.json", JSON.stringify(events));
  await session?.dispose();
}
