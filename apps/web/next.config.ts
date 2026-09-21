import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import type { NextConfig } from "next";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(packageDirectory, "../..");
config({ path: resolve(workspaceRoot, ".env"), quiet: true });

const configuredDistDirectory = process.env.DEVFLOW_NEXT_DIST_DIR?.trim();
if (
  configuredDistDirectory !== undefined &&
  (configuredDistDirectory.length === 0 ||
    configuredDistDirectory === "." ||
    configuredDistDirectory === ".." ||
    configuredDistDirectory.includes("/") ||
    configuredDistDirectory.includes("\\"))
) {
  throw new Error("DEVFLOW_NEXT_DIST_DIR must be a single directory name inside apps/web.");
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@devflow/shared"],
  distDir: configuredDistDirectory ?? ".next",
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
