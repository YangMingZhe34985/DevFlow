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

const compose = ["compose", "-f", "docker/compose.yml"];
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("npm_execpath is required to run the migration.");
run("docker", ["version"]);
const initiallyRunning = new Set(
  run("docker", [...compose, "ps", "--status", "running", "--services"], process.env, true)
    .split(/\r?\n/u)
    .filter(Boolean),
);
const startedInfrastructure = !initiallyRunning.has("postgres");
run("docker", [...compose, "up", "--detach", "--wait", "postgres"]);

const databaseName = `devflow_p10_${String(Date.now())}`;
const databaseUser = process.env.POSTGRES_USER ?? "devflow";
const databasePassword = process.env.POSTGRES_PASSWORD ?? "devflow";
const databasePort = process.env.POSTGRES_PORT ?? "5432";
const databaseUrl = `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@localhost:${databasePort}/${databaseName}?schema=public`;

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

let failed = false;
try {
  const environment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    DEVFLOW_P10_INTEGRATION: "1",
  };
  run(
    process.execPath,
    [npmCli, "exec", "--workspace", "@devflow/database", "--", "prisma", "migrate", "deploy"],
    environment,
  );
  run(
    process.execPath,
    [
      path.resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "tests/integration/p10-github-persistence.test.ts",
      ...process.argv.slice(2),
    ],
    environment,
  );
} catch (error) {
  failed = true;
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

const residual = run(
  "docker",
  ["ps", "--all", "--filter", "label=devflow.managed=true", "--quiet"],
  process.env,
  true,
).trim();
if (startedInfrastructure) run("docker", [...compose, "down"]);
if (residual.length > 0) throw new Error("P10 integration left DevFlow sandbox containers behind.");
if (failed) process.exitCode = 1;
