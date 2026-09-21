import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("npm_execpath is required to build the Web E2E app.");

const nextEnvironmentPath = path.resolve("apps/web/next-env.d.ts");
const originalNextEnvironment = existsSync(nextEnvironmentPath)
  ? readFileSync(nextEnvironmentPath)
  : undefined;
let result;
try {
  result = spawnSync(process.execPath, [npmCli, "run", "build", "--workspace", "@devflow/web"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DEVFLOW_NEXT_DIST_DIR: ".next-e2e",
    },
    stdio: "inherit",
    windowsHide: true,
  });
} finally {
  if (originalNextEnvironment !== undefined) {
    writeFileSync(nextEnvironmentPath, originalNextEnvironment);
  }
}

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
