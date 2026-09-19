import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadProjectEnvironment,
  PROJECT_ENV_PATH,
  PROJECT_ROOT,
  resolveProjectStateDirectory,
} from "../src/environment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI project environment", () => {
  it("resolves .env from the project root rather than process.cwd()", () => {
    expect(path.resolve(PROJECT_ROOT)).toBe(path.resolve("."));
    expect(PROJECT_ENV_PATH).toBe(path.join(path.resolve("."), ".env"));
  });

  it("resolves state storage from the project root rather than process.cwd()", () => {
    expect(resolveProjectStateDirectory(".devflow/state")).toBe(
      path.join(PROJECT_ROOT, ".devflow", "state"),
    );
    expect(resolveProjectStateDirectory("   ")).toBe(path.join(PROJECT_ROOT, ".devflow", "state"));
    expect(resolveProjectStateDirectory("D:\\devflow-state")).toBe("D:\\devflow-state");
  });

  it("loads an explicit UTF-8 env file without replacing existing variables", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "devflow-cli-env-"));
    temporaryDirectories.push(directory);
    const envPath = path.join(directory, ".env");
    await writeFile(envPath, "LLM_PROVIDER=openai-compatible\nUNICODE_VALUE=中文配置\n", "utf8");
    const environment: Record<string, string | undefined> = {
      LLM_PROVIDER: "openai",
    };

    const result = loadProjectEnvironment({ path: envPath, processEnv: environment });

    expect(result.error).toBeUndefined();
    expect(environment.LLM_PROVIDER).toBe("openai");
    expect(environment.UNICODE_VALUE).toBe("中文配置");
  });
});
