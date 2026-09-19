import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

function run(program, args, environment = process.env) {
  const result = spawnSync(program, args, {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
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

run("docker", ["version"]);
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
} else {
  process.stdout.write("Using existing devflow-sandbox:local image.\n");
}
run(
  process.execPath,
  [
    path.resolve("node_modules/vitest/vitest.mjs"),
    "run",
    "tests/integration/p3-docker-sandbox.test.ts",
    ...process.argv.slice(2),
  ],
  { ...process.env, DEVFLOW_DOCKER_INTEGRATION: "1" },
);
