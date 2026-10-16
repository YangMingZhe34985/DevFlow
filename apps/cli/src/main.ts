import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createConfiguredLanguageModel,
  runAgentLoop,
  type SupportedLlmProvider,
  type VercelAiModelConfig,
} from "@devflow/agent";
import { DockerSandboxManager, type SandboxSession } from "@devflow/sandbox";
import { DevflowError, toDevflowError } from "@devflow/shared";
import {
  createBashTool,
  createEditFileTool,
  createReadFileTool,
  createSubmitTool,
} from "@devflow/tools";

import { loadProjectEnvironment } from "./environment.js";
import { configureUtf8Terminal, printEvent } from "./terminal.js";

interface CliOptions {
  repositoryPath: string;
  task: string;
  maxTurns: number;
  timeoutMs: number;
  image: string;
}

const SYSTEM_PROMPT = `You are an autonomous software engineer working on the repository at /workspace inside an isolated Linux sandbox without network access.
Investigate with bash and read_file, change files with edit_file, run the project's tests to check your work, and call submit with a short summary when the task is done.`;

function printUsage(): void {
  console.log(`DevFlow CLI agent

Usage:
  npm run dev:cli -- --repo <repository-path> [options] "<task>"

Options:
  --repo <path>         Repository copied into the Docker sandbox (default: .)
  --max-turns <number>  Maximum model turns (default: DEVFLOW_MAX_STEPS or 40)
  --timeout-ms <number> Total run deadline (default: DEVFLOW_TIMEOUT_MS or 900000)
  --image <name>        Sandbox image (default: DEVFLOW_SANDBOX_IMAGE)
  --help                Show this help

Required environment:
  LLM_PROVIDER=openai|openai-compatible
  LLM_MODEL=<model>
  LLM_API_KEY=<api-key>
  LLM_BASE_URL=<url>    Required only for openai-compatible`);
}

async function main(): Promise<number> {
  configureUtf8Terminal();
  loadProjectEnvironment();
  if (process.argv.slice(2).includes("--help")) {
    printUsage();
    return 0;
  }
  const options = parseArguments(process.argv.slice(2));
  const model = createConfiguredLanguageModel(readModelConfig());
  const runId = randomUUID();
  const cancellation = new AbortController();
  const onInterrupt = (): void => {
    if (!cancellation.signal.aborted) {
      console.error("\nCancellation requested; cleaning up the sandbox...");
      cancellation.abort();
    }
  };
  process.once("SIGINT", onInterrupt);
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(options.timeoutMs)]);

  const manager = new DockerSandboxManager({
    image: options.image,
    workspaceRoot: options.repositoryPath,
  });
  let sandbox: SandboxSession | undefined;
  try {
    console.log(`Run ${runId}`);
    console.log(`Creating Docker sandbox from ${options.repositoryPath}...`);
    sandbox = await manager.create(
      {
        runId,
        repository: { sourceUri: pathToFileURL(options.repositoryPath).href },
        limits: {
          cpuCount: readPositiveNumber("DEVFLOW_SANDBOX_CPUS", 2),
          memoryMb: readPositiveNumber("DEVFLOW_SANDBOX_MEMORY_MB", 2_048),
          pids: readPositiveNumber("DEVFLOW_SANDBOX_PIDS", 128),
          timeoutMs: options.timeoutMs,
          networkEnabled: false,
        },
      },
      signal,
    );
    const result = await runAgentLoop({
      model,
      system: SYSTEM_PROMPT,
      task: options.task,
      tools: [
        createBashTool({ sandbox }),
        createReadFileTool({ sandbox }),
        createEditFileTool({ sandbox }),
        createSubmitTool(),
      ],
      limits: { maxTurns: options.maxTurns, deadlineAt: Date.now() + options.timeoutMs },
      signal,
      onEvent: printEvent,
    });

    console.log("\n=== Final Git Diff ===");
    if (signal.aborted) {
      console.log("(diff skipped because the run was cancelled)");
    } else {
      const diff = await sandbox.exec(
        { program: "git", args: ["diff"], timeoutMs: 60_000, maxOutputBytes: 500_000 },
        signal,
      );
      console.log(diff.stdout.length > 0 ? diff.stdout : "(no tracked changes)");
    }
    const usage = result.usage;
    console.log(
      `Result: ${result.stopReason}; turns=${String(result.turns)}; modelCalls=${String(usage.modelCalls)}; inputTokens=${String(usage.inputTokens)}; outputTokens=${String(usage.outputTokens)}`,
    );
    if (result.summary !== undefined) console.log(result.summary);
    return result.stopReason === "SUBMITTED" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    if (sandbox !== undefined) {
      console.log("Cleaning up Docker sandbox...");
      await sandbox.dispose();
    }
  }
}

function parseArguments(args: readonly string[]): CliOptions {
  let repositoryPath = path.resolve(".");
  let maxTurns = readPositiveNumber("DEVFLOW_MAX_STEPS", 40);
  let timeoutMs = readPositiveNumber("DEVFLOW_TIMEOUT_MS", 900_000);
  let image = process.env.DEVFLOW_SANDBOX_IMAGE ?? "devflow-sandbox:local";
  const taskParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo") {
      repositoryPath = path.resolve(requiredOption(args, ++index, "--repo"));
    } else if (argument === "--max-turns") {
      maxTurns = parsePositiveInteger(requiredOption(args, ++index, "--max-turns"), "--max-turns");
    } else if (argument === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(
        requiredOption(args, ++index, "--timeout-ms"),
        "--timeout-ms",
      );
    } else if (argument === "--image") {
      image = requiredOption(args, ++index, "--image");
    } else if (argument?.startsWith("--") === true) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: `Unknown option '${argument}'.`,
      });
    } else if (argument !== undefined) {
      taskParts.push(argument);
    }
  }

  const task = taskParts.join(" ").trim();
  if (task.length === 0) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "A task description is required. Run with --help for usage.",
    });
  }
  return { repositoryPath, task, maxTurns, timeoutMs, image };
}

function readModelConfig(): VercelAiModelConfig {
  const provider = process.env.LLM_PROVIDER;
  if (provider !== "openai" && provider !== "openai-compatible") {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "LLM_PROVIDER must be 'openai' or 'openai-compatible'.",
    });
  }
  const model = requiredEnvironment("LLM_MODEL");
  const apiKey = requiredEnvironment("LLM_API_KEY");
  return {
    provider: provider satisfies SupportedLlmProvider,
    model,
    apiKey,
    ...(process.env.LLM_BASE_URL === undefined ? {} : { baseUrl: process.env.LLM_BASE_URL }),
    ...(process.env.LLM_PROVIDER_NAME === undefined
      ? {}
      : { providerName: process.env.LLM_PROVIDER_NAME }),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `Required environment variable ${name} is not configured.`,
    });
  }
  return value;
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined ? fallback : parsePositiveInteger(value, name);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `${name} must be a positive integer.`,
    });
  }
  return parsed;
}

function requiredOption(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: `${option} requires a value.`,
    });
  }
  return value;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const normalized = toDevflowError(error, {
      code: "INTERNAL_ERROR",
      message: "DevFlow CLI failed.",
    });
    console.error(`${normalized.code}: ${normalized.message}`);
    process.exitCode = 1;
  });
