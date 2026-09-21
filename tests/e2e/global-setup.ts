import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";

const SERVER_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3300";
const serverUrl = new URL(SERVER_URL);
const SERVER_PORT = serverUrl.port || (serverUrl.protocol === "https:" ? "443" : "80");
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (await isReachable(SERVER_URL)) {
    throw new Error(
      `Playwright Web port is already in use at ${SERVER_URL}; stop that process or set PLAYWRIGHT_BASE_URL to a free local URL.`,
    );
  }

  const server = spawn(
    process.execPath,
    [
      path.resolve("node_modules/next/dist/bin/next"),
      "start",
      "apps/web",
      "--hostname",
      serverUrl.hostname,
      "--port",
      SERVER_PORT,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        DEVFLOW_NEXT_DIST_DIR: ".next-e2e",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  const capture = (chunk: Buffer): void => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
  };
  server.stdout?.on("data", capture);
  server.stderr?.on("data", capture);

  try {
    await waitUntilReachable(server, SERVER_URL, START_TIMEOUT_MS, () => output);
  } catch (error) {
    await stopServer(server);
    throw error;
  }
  return async () => await stopServer(server);
}

async function waitUntilReachable(
  server: ChildProcess,
  url: string,
  timeoutMs: number,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js E2E server exited with ${String(server.exitCode)}.\n${output()}`);
    }
    if (await isReachable(url)) return;
    await delay(100);
  }
  throw new Error(`Next.js E2E server did not become ready.\n${output()}`);
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await waitForExit(server, STOP_TIMEOUT_MS);
    return;
  }
  server.kill();
  if (await waitForExit(server, STOP_TIMEOUT_MS)) return;
  server.kill("SIGKILL");
  await waitForExit(server, STOP_TIMEOUT_MS);
}

async function waitForExit(server: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (server.exitCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      server.removeListener("exit", exited);
      resolve(false);
    }, timeoutMs);
    const exited = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    server.once("exit", exited);
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
