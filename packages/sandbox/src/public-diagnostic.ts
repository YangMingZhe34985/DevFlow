import { createHash, randomUUID } from "node:crypto";
import { DevflowError } from "@devflow/shared";
import type { CommandResult, CommandSpec } from "./contracts.js";
import type { DockerCommandRunner, DockerCommandOptions } from "./docker-sandbox-manager.js";

export interface PublicDiagnosticResources {
  containerName: string;
  snapshotTag: string;
}
export function publicDiagnosticResources(operationId: string): PublicDiagnosticResources {
  if (!/^[a-f0-9]{64}$/u.test(operationId))
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Diagnostic operation requires a host SHA identity.",
    });
  return {
    containerName: `devflow-diagnostic-${operationId}`,
    snapshotTag: `devflow-diagnostic:${operationId}`,
  };
}
function validateResources(resources: PublicDiagnosticResources): void {
  const id = resources.containerName.slice("devflow-diagnostic-".length);
  if (
    !resources.containerName.startsWith("devflow-diagnostic-") ||
    !/^[a-f0-9]{64}$/u.test(id) ||
    resources.snapshotTag !== `devflow-diagnostic:${id}`
  )
    throw new DevflowError({
      code: "PERMISSION_DENIED",
      message: "Cleanup requires an exact host diagnostic resource pair.",
    });
}

// The command comes exclusively from the host's frozen public verification profile.
// The candidate is never mounted into this container. Even a test that writes source
// can only change this disposable copy, not the approved Coding workspace.
const WRAPPER = String.raw`
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const command=JSON.parse(process.argv[1]);
fs.cpSync('/workspace','/scratch/workspace',{recursive:true,dereference:false,
  filter:p=>p!='/workspace/.git'&&!p.startsWith('/workspace/.git/')});
const cwd=path.resolve('/scratch/workspace',command.cwd||'.');
if(cwd!='/scratch/workspace'&&!cwd.startsWith('/scratch/workspace/'))throw Error('Diagnostic cwd outside snapshot');
const result=cp.spawnSync(command.program,command.args||[],{cwd,stdio:'inherit',
  env:{PATH:process.env.PATH,HOME:'/scratch',TMPDIR:'/scratch',CI:'true',
    ...command.environment},timeout:command.timeoutMs});
if(result.error){console.error(result.error.message);
  console.log('@@DEVFLOW_DIAGNOSTIC@@'+JSON.stringify({status:result.error.code==='ETIMEDOUT'?'TIMEOUT':result.error.code==='ENOENT'?'DEPENDENCY_MISSING':'ENVIRONMENT_ERROR'}));
  process.exit(125);}
console.log('@@DEVFLOW_DIAGNOSTIC@@'+JSON.stringify({status:result.status===null?'ENVIRONMENT_ERROR':'CHECK_COMPLETED'}));
process.exit(result.status===null?125:result.status);
`;

export class PublicDiagnosticRunner {
  constructor(private readonly runner: DockerCommandRunner) {}

  async run(input: {
    containerId: string;
    runId: string;
    command: CommandSpec;
    signal: AbortSignal;
    resources?: PublicDiagnosticResources;
    /** Fences both capture and result publication using the original Run lease. */
    assertOwnership: () => Promise<void>;
    /** Every Docker execution, including cleanup, is attributed by the host. */
    execute?: (label: string, work: () => Promise<unknown>) => Promise<unknown>;
  }): Promise<CommandResult & { snapshotImage: string; isolated: true; diagnosticStatus: string }> {
    if (!/^devflow-[a-zA-Z0-9-]+$/u.test(input.containerId))
      throw new DevflowError({ code: "PERMISSION_DENIED", message: "Managed candidate required." });
    const started = Date.now();
    const deadline = AbortSignal.timeout(Math.min(input.command.timeoutMs ?? 30_000, 30_000));
    const signal = AbortSignal.any([input.signal, deadline]);
    const resources =
      input.resources ??
      publicDiagnosticResources(createHash("sha256").update(randomUUID()).digest("hex"));
    validateResources(resources);
    const { snapshotTag: tag, containerName: name } = resources;
    let image = "";
    let primaryFailure: unknown;
    let failed = false;
    let completed:
      | (CommandResult & { snapshotImage: string; isolated: true; diagnosticStatus: string })
      | undefined;
    const run = async (label: string, args: string[], options: DockerCommandOptions = {}) => {
      const work = () => this.runner.run(args, { signal, ...options });
      return (await bounded(
        () => (input.execute ? input.execute(label, work) : work()),
        options.signal ?? signal,
      )) as Awaited<ReturnType<DockerCommandRunner["run"]>>;
    };
    try {
      await bounded(input.assertOwnership, signal);
      const inspected = await run("inspect-candidate", ["inspect", input.containerId], {
        maxOutputBytes: 128 * 1024,
      });
      if (inspected.exitCode !== 0) throw new Error("Candidate container unavailable");
      const [candidate] = JSON.parse(inspected.stdout);
      if (
        candidate?.Config?.Labels?.["devflow.runId"] !== input.runId ||
        candidate.Config.Labels["devflow.managed"] !== "true" ||
        (candidate.Mounts?.length ?? 0) > 0
      )
        throw new DevflowError({
          code: "PERMISSION_DENIED",
          message: "Diagnostic requires owned, mount-free candidate snapshot.",
        });
      const memory = Math.min(
        1024 ** 3,
        candidate.HostConfig?.Memory > 0 ? candidate.HostConfig.Memory : 1024 ** 3,
      );
      const cpu = Math.min(1, (candidate.HostConfig?.NanoCpus || 1e9) / 1e9);
      const pids = Math.min(
        128,
        candidate.HostConfig?.PidsLimit > 0 ? candidate.HostConfig.PidsLimit : 128,
      );
      const scratch = Math.min(512 * 1024 ** 2, Math.floor(memory / 2));
      // Docker pauses by default. The old explicit --pause flag emits a stdout
      // warning on Docker 29 and is removed in 30, corrupting the image receipt.
      const committed = await run("capture-snapshot", ["commit", input.containerId, tag], {
        maxOutputBytes: 2 * 1024,
      });
      image = committed.stdout.trim();
      if (committed.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(image))
        throw new DevflowError({
          code: "SANDBOX_FAILED",
          message: "Diagnostic snapshot capture failed",
          details: {
            exitCode: committed.exitCode,
            outputTruncated: committed.outputTruncated,
            diagnostic: committed.stderr.slice(0, 2048),
            identity: image.slice(0, 128),
          },
        });
      await bounded(input.assertOwnership, signal);
      const command = { ...input.command, timeoutMs: Math.max(1, 30_000 - (Date.now() - started)) };
      const result = await run(
        "execute-public-check",
        [
          "run",
          "--name",
          name,
          "--label",
          "devflow.managed=true",
          "--label",
          "devflow.purpose=diagnostic",
          "--label",
          `devflow.runId=${input.runId}`,
          "--label",
          `devflow.sourceContainer=${input.containerId}`,
          "--read-only",
          "--network",
          "none",
          "--cpus",
          String(cpu),
          "--memory",
          String(memory),
          "--memory-swap",
          String(memory),
          "--pids-limit",
          String(pids),
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "10001:10001",
          "--workdir",
          "/scratch",
          "--tmpfs",
          `/scratch:rw,nosuid,size=${scratch},uid=10001,gid=10001,mode=700`,
          "--entrypoint",
          "/usr/bin/env",
          image,
          "-i",
          "PATH=/usr/local/bin:/usr/bin:/bin",
          "HOME=/scratch",
          "TMPDIR=/scratch",
          "node",
          "-e",
          WRAPPER,
          JSON.stringify(command),
        ],
        { maxOutputBytes: 32 * 1024 },
      );
      await bounded(input.assertOwnership, signal);
      const observation = result.stdout.trimEnd().split("\n").at(-1);
      let diagnosticStatus = "ENVIRONMENT_ERROR";
      if (!result.outputTruncated && observation?.startsWith("@@DEVFLOW_DIAGNOSTIC@@")) {
        try {
          const value = JSON.parse(observation.slice("@@DEVFLOW_DIAGNOSTIC@@".length));
          if (
            ["CHECK_COMPLETED", "TIMEOUT", "DEPENDENCY_MISSING", "ENVIRONMENT_ERROR"].includes(
              value.status,
            )
          )
            diagnosticStatus = value.status;
        } catch {
          /* No complete host observation means no behavior conclusion. */
        }
      }
      completed = {
        ...result,
        exitCode: result.exitCode ?? 125,
        timedOut: diagnosticStatus === "TIMEOUT",
        diagnosticStatus,
        durationMs: Date.now() - started,
        snapshotImage: image,
        isolated: true,
      };
    } catch (error) {
      failed = true;
      primaryFailure = error;
    }
    // Cancellation must still remove only resources belonging to this operation.
    // Cleanup is separately bounded and metered; it never reruns the diagnostic.
    try {
      await this.cleanup({ resources, ...(input.execute ? { execute: input.execute } : {}) });
    } catch (cleanupError) {
      const primary = primaryFailure instanceof DevflowError ? primaryFailure : undefined;
      throw new DevflowError({
        code: primary?.code ?? "SANDBOX_FAILED",
        message:
          primaryFailure instanceof Error
            ? primaryFailure.message
            : "Diagnostic cleanup incomplete.",
        details: {
          primaryFailure:
            primary?.toJSON() ??
            (primaryFailure instanceof Error ? { message: primaryFailure.message } : null),
          cleanupFailure:
            cleanupError instanceof DevflowError
              ? cleanupError.toJSON()
              : { message: String(cleanupError) },
          resources,
        },
        cause: primaryFailure ?? cleanupError,
      });
    }
    if (failed) throw primaryFailure;
    if (!completed)
      throw new DevflowError({ code: "SANDBOX_FAILED", message: "Diagnostic result missing." });
    return completed;
  }

  /** Recovery may delete these exact resources; it must never rerun an unknown diagnostic. */
  async cleanup(input: {
    resources: PublicDiagnosticResources;
    execute?: (label: string, work: () => Promise<unknown>) => Promise<unknown>;
  }): Promise<void> {
    validateResources(input.resources);
    const failures: { label: string; message: string }[] = [];
    for (const [label, args] of [
      ["cleanup-container", ["rm", "--force", input.resources.containerName]],
      ["cleanup-snapshot", ["image", "rm", "--force", input.resources.snapshotTag]],
    ] as const) {
      try {
        const signal = AbortSignal.timeout(5000);
        const work = () => this.runner.run([...args], { signal, maxOutputBytes: 2 * 1024 });
        const cleaned = (await bounded(
          () => (input.execute ? input.execute(label, work) : work()),
          signal,
        )) as Awaited<ReturnType<DockerCommandRunner["run"]>>;
        if (cleaned.exitCode !== 0 && !/No such (?:container|image)/iu.test(cleaned.stderr))
          throw new Error(`Diagnostic ${label} failed; exact owned resource requires cleanup.`);
      } catch (error) {
        failures.push({
          label,
          message:
            error instanceof Error ? error.message.slice(0, 1500) : "Unknown cleanup failure",
        });
      }
    }
    if (failures.length)
      throw new DevflowError({
        code: "SANDBOX_FAILED",
        message: "Diagnostic cleanup incomplete.",
        details: { resources: input.resources, failures },
      });
  }
}

async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error("Diagnostic deadline exceeded"));
      signal.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
