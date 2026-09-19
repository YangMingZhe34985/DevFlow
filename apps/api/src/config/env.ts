import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { z } from "zod";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
config({ path: resolve(packageDirectory, "../../.env"), quiet: true });

const ApiEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  RUN_QUEUE_NAME: z.string().min(1).default("devflow-runs"),
});

export type ApiEnvironment = z.infer<typeof ApiEnvironmentSchema>;

export function loadApiEnvironment(environment: NodeJS.ProcessEnv = process.env): ApiEnvironment {
  return ApiEnvironmentSchema.parse(environment);
}
