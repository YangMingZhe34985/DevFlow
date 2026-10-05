import { posix } from "node:path";

/** The bounded workspace syntax shared by module resolution and package graph facts. */
export function workspacePackages(configuration: Record<string, string>) {
  const patterns: string[] = [];
  try {
    const root = JSON.parse(configuration["package.json"] ?? "{}");
    const workspaces = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages;
    if (Array.isArray(workspaces))
      patterns.push(...workspaces.filter((p): p is string => typeof p === "string"));
  } catch {
    // Invalid/missing metadata is reported by the graph and compiler configuration reader.
  }
  const pnpm = configuration["pnpm-workspace.yaml"];
  if (pnpm) {
    let reading = false;
    for (const line of pnpm.split(/\r?\n/)) {
      if (/^packages:\s*(?:#.*)?$/.test(line)) {
        reading = true;
        continue;
      }
      if (reading && /^\S/.test(line) && !line.startsWith("#")) break;
      if (reading) {
        const match = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
        if (match) patterns.push(match[1]!.trim());
      }
    }
  }
  const glob = (pattern: string) =>
    new RegExp(
      "^" +
        pattern
          .replace(/[.+?^$(){}|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "@@ALL@@")
          .replace(/\*/g, "[^/]*")
          .replace(/@@ALL@@/g, ".*") +
        "$",
    );
  const included = patterns.filter((p) => !p.startsWith("!")).map(glob);
  const excluded = patterns.filter((p) => p.startsWith("!")).map((p) => glob(p.slice(1)));
  const packages: { name: string; path: string }[] = [];
  for (const [path, text] of Object.entries(configuration)) {
    if (!/(?:^|\/)package\.json$/.test(path)) continue;
    const directory = posix.dirname(path);
    if (!included.some((p) => p.test(directory)) || excluded.some((p) => p.test(directory)))
      continue;
    try {
      const pkg = JSON.parse(text);
      if (typeof pkg.name === "string" && /^(@[\w.-]+\/)?[\w.-]+$/.test(pkg.name))
        packages.push({ name: pkg.name, path });
    } catch {
      // Do not invent an identity for an invalid package manifest.
    }
  }
  return packages;
}
