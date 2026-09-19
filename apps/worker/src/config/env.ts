import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { z } from "zod";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
config({ path: resolve(packageDirectory, "../../.env"), quiet: true });

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z.string().url().optional(),
);
const optionalProvider = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z.enum(["openai", "openai-compatible"]).optional(),
);

const WorkerEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3_002),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  DATABASE_URL: z.string().min(1),
  RUN_QUEUE_NAME: z.string().min(1).default("devflow-runs"),
  WORKER_LEASE_MS: z.coerce.number().int().min(5_000).default(60_000),
  WORKER_CANCEL_POLL_MS: z.coerce.number().int().min(100).default(1_000),
  WORKER_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  LLM_PROVIDER: optionalProvider,
  LLM_MODEL: optionalString,
  LLM_API_KEY: optionalString,
  LLM_BASE_URL: optionalUrl,
  LLM_PROVIDER_NAME: optionalString,
  DEVFLOW_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  DEVFLOW_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(900_000),
  DEVFLOW_STATE_DIR: z.string().min(1).default(".devflow/state"),
  DEVFLOW_SANDBOX_IMAGE: z.string().min(1).default("devflow-sandbox:local"),
  DEVFLOW_SANDBOX_CPUS: z.coerce.number().positive().max(64).default(2),
  DEVFLOW_SANDBOX_MEMORY_MB: z.coerce.number().int().min(6).default(2_048),
  DEVFLOW_SANDBOX_PIDS: z.coerce.number().int().min(1).default(128),
  DEVFLOW_SANDBOX_NETWORK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type WorkerEnvironment = z.infer<typeof WorkerEnvironmentSchema>;

export function loadWorkerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerEnvironment {
  return WorkerEnvironmentSchema.parse(environment);
}
