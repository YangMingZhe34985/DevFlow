import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import type { NextConfig } from "next";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(packageDirectory, "../..");
config({ path: resolve(workspaceRoot, ".env"), quiet: true });

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@devflow/shared"],
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
