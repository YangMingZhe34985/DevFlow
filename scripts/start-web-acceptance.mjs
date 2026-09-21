import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

if (!existsSync(path.resolve(".env"))) {
  throw new Error(
    "Missing .env. Copy .env.example to .env and configure the required secrets first.",
  );
}

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("npm_execpath is required for Web acceptance startup.");

run(process.execPath, [npmCli, "run", "infra:up"]);
run(process.execPath, [npmCli, "run", "db:migrate:deploy"]);
if (!succeeds("docker", ["image", "inspect", "devflow-sandbox:local"])) {
  run(process.execPath, [npmCli, "run", "sandbox:build"]);
}

process.stdout.write("\nDevFlow acceptance services are starting.\n");
process.stdout.write("Open http://localhost:3000/acceptance when Web reports ready.\n");
process.stdout.write(
  "Press Ctrl+C to stop the app processes; run npm run infra:down after acceptance.\n\n",
);

const child = spawn(process.execPath, [npmCli, "run", "dev"], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "development" },
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal === null ? (code ?? 1) : 1;
});
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));

function run(program, args) {
  const result = spawnSync(program, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} exited with status ${String(result.status ?? 1)}.`);
  }
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
