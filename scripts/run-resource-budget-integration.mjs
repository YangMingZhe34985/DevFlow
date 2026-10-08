import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { config } from "dotenv";

config({ path: path.resolve(".env"), quiet: true });
const compose = ["compose", "-f", "docker/compose.yml"];
function run(command, args, env = process.env, capture = false) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!capture && result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with status ${String(result.status)}`);
  return result.stdout ?? "";
}

const running = new Set(
  run("docker", [...compose, "ps", "--status", "running", "--services"], process.env, true)
    .trim()
    .split(/\r?\n/u),
);
const startedPostgres = !running.has("postgres");
run("docker", [...compose, "up", "--detach", "--wait", "postgres"]);
const name = `devflow_budget_${Date.now()}`;
const user = process.env.POSTGRES_USER ?? "devflow";
const password = process.env.POSTGRES_PASSWORD ?? "devflow";
const port = process.env.POSTGRES_PORT ?? "5432";
const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${port}/${name}?schema=public`;
let created = false;
try {
  run("docker", [...compose, "exec", "--no-TTY", "postgres", "createdb", "--username", user, name]);
  created = true;
  const env = {
    ...process.env,
    DATABASE_URL: url,
    TEST_DATABASE_URL: url,
    DEVFLOW_RESOURCE_BUDGET_INTEGRATION: "1",
  };
  run(
    process.execPath,
    [
      path.resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "deploy",
      "--config",
      path.resolve("packages/database/prisma.config.ts"),
    ],
    env,
  );
  run(
    process.execPath,
    [
      path.resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "tests/integration/resource-budget-postgres.test.ts",
    ],
    env,
  );
} finally {
  if (created)
    run("docker", [
      ...compose,
      "exec",
      "--no-TTY",
      "postgres",
      "dropdb",
      "--if-exists",
      "--force",
      "--username",
      user,
      name,
    ]);
  // Do not stop Redis or any pre-existing application infrastructure.
  if (startedPostgres) run("docker", [...compose, "stop", "postgres"]);
}
