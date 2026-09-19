import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { config } from "dotenv";

config({ path: path.resolve(".env"), quiet: true });

function run(program, args, environment = process.env, capture = false) {
  const result = spawnSync(program, args, {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
  if (!capture && result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} exited with status ${String(result.status ?? 1)}`);
  }
  return result.stdout ?? "";
}

function succeeds(program, args) {
  return (
    spawnSync(program, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    }).status === 0
  );
}

const compose = ["compose", "-f", "docker/compose.yml"];
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("npm_execpath is required to run the migration.");
run("docker", ["version"]);
const initiallyRunning = new Set(
  run("docker", [...compose, "ps", "--status", "running", "--services"], process.env, true)
    .split(/\r?\n/u)
    .filter(Boolean),
);
const startedInfrastructure = !(initiallyRunning.has("postgres") && initiallyRunning.has("redis"));
run("docker", [...compose, "up", "--detach", "--wait", "postgres", "redis"]);
if (
  process.env.DEVFLOW_REBUILD_SANDBOX === "1" ||
  !succeeds("docker", ["image", "inspect", "devflow-sandbox:local"])
) {
  run("docker", [
    "build",
    "-f",
    "docker/sandbox/Dockerfile",
    "-t",
    "devflow-sandbox:local",
    "docker/sandbox",
  ]);
}

const databaseName = `devflow_p9_${String(Date.now())}`;
const databaseUser = process.env.POSTGRES_USER ?? "devflow";
const databasePassword = process.env.POSTGRES_PASSWORD ?? "devflow";
const databasePort = process.env.POSTGRES_PORT ?? "5432";
const databaseUrl = `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@localhost:${databasePort}/${databaseName}?schema=public`;
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

run("docker", [
  ...compose,
  "exec",
  "--no-TTY",
  "postgres",
  "createdb",
  "--username",
  databaseUser,
  databaseName,
]);

let testFailed = false;
try {
  const integrationEnvironment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    TEST_REDIS_URL: redisUrl,
    DEVFLOW_P9_INTEGRATION: "1",
  };
  run(
    process.execPath,
    [npmCli, "exec", "--workspace", "@devflow/database", "--", "prisma", "migrate", "deploy"],
    integrationEnvironment,
  );
  run(
    process.execPath,
    [
      path.resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "tests/integration/p9-interactive-workflow.test.ts",
      ...process.argv.slice(2),
    ],
    integrationEnvironment,
  );
} catch (error) {
  testFailed = true;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  run("docker", [
    ...compose,
    "exec",
    "--no-TTY",
    "postgres",
    "dropdb",
    "--if-exists",
    "--force",
    "--username",
    databaseUser,
    databaseName,
  ]);
}

const residualContainers = run(
  "docker",
  ["ps", "--all", "--filter", "label=devflow.managed=true", "--quiet"],
  process.env,
  true,
).trim();
if (startedInfrastructure) run("docker", [...compose, "down"]);
if (residualContainers.length > 0) {
  throw new Error("P9 integration left DevFlow sandbox containers behind.");
}
if (testFailed) process.exitCode = 1;
