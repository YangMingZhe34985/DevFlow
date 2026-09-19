import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, type DotenvConfigOutput } from "dotenv";

export const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const PROJECT_ENV_PATH = path.join(PROJECT_ROOT, ".env");

export interface LoadProjectEnvironmentOptions {
  path?: string;
  processEnv?: Record<string, string | undefined>;
}

export function resolveProjectStateDirectory(
  configuredDirectory: string | undefined,
  projectRoot = PROJECT_ROOT,
): string {
  const selected = configuredDirectory?.trim() || ".devflow/state";
  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(projectRoot, selected);
}

export function loadProjectEnvironment(
  options: LoadProjectEnvironmentOptions = {},
): DotenvConfigOutput {
  return config({
    path: options.path ?? PROJECT_ENV_PATH,
    quiet: true,
    override: false,
    ...(options.processEnv === undefined ? {} : { processEnv: options.processEnv }),
  });
}
