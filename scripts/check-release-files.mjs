import { execFileSync } from "node:child_process";
import { log } from "node:console";
import process from "node:process";
import { readFileSync, existsSync } from "node:fs";

// Review the actual Git candidate tree, including untracked public files.
const paths = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  ),
];
const problems = [];
const privatePath =
  /^(?:\.env(?:\..*)?$|\.devflow\/|\.codex\/|\.claude\/|docs\/(?:Devflow-|performance\/|archive\/|development\/)|benchmarks\/real-issues\/|tests\/fixtures\/planner-)/u;
const privateScriptPath =
  /^scripts\/(?:execute-recovery-v[^/]*\/|oracle-coverage-v[^/]*\/|plan-factorial-v[^/]*\/|plan-agent\/|phase17[12]\/|real-issues\/|(?:real-dataset-[^/]+|stage-[^/]+|staged-planner-[^/]+|summarize-[^/]+|score-real-dataset|localization-graph-fix-replay|review-length-recovery-live|build-historical-benchmark)\.mjs$)/u;
for (const path of paths) {
  if ((path !== ".env.example" && privatePath.test(path)) || privateScriptPath.test(path))
    problems.push({
      path,
      reason: "Private process/configuration file is in the Git candidate tree",
    });
  if (
    !existsSync(path) ||
    (path !== ".env.example" && !/\.(?:ts|tsx|mjs|md|json|ya?ml)$/u.test(path)) ||
    path.startsWith("tests/") ||
    path.includes("/tests/")
  )
    continue;
  const content = readFileSync(path, "utf8");
  if (/C:[/\\]+Users[/\\]+|Documents[/\\]+Codex/iu.test(content))
    problems.push({ path, reason: "Personal absolute path" });
  if (/\b(?:sk-|github_pat_|ghp_)[A-Za-z0-9_-]{24,}\b/u.test(content))
    problems.push({ path, reason: "Possible embedded credential (value omitted)" });
}
const releaseVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
if (!/^\d+\.\d+\.\d+$/u.test(releaseVersion))
  problems.push({ path: "package.json", reason: "Invalid release version" });
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (path !== "" && !/^(?:apps|packages)\/[^/]+$/u.test(path)) continue;
  const file = path ? `${path}/package.json` : "package.json";
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.version !== releaseVersion || metadata.version !== pkg.version)
    problems.push({ path: file, reason: "Release version mismatch" });
  for (const name of Object.keys(pkg.dependencies ?? {}))
    if (
      name.startsWith("@devflow/") &&
      (pkg.dependencies[name] !== releaseVersion ||
        metadata.dependencies?.[name] !== releaseVersion)
    )
      problems.push({ path: file, reason: `Workspace dependency mismatch: ${name}` });
}
log(
  JSON.stringify(
    { status: problems.length ? "FAILED" : "PASSED", candidateFiles: paths.length, problems },
    null,
    2,
  ),
);
if (problems.length) process.exitCode = 1;
