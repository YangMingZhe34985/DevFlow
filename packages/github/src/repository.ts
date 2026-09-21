import { DevflowError } from "@devflow/shared";

import { GitHubRepositorySchema, type GitHubRepository } from "./contracts.js";

export function parseGitHubRepositoryUri(sourceUri: string): GitHubRepository {
  let owner: string | undefined;
  let name: string | undefined;
  const scp = /^git@github\.com:([^/]+)\/(.+)$/iu.exec(sourceUri);
  if (scp !== null) {
    owner = scp[1];
    name = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(sourceUri);
    } catch (error) {
      throw invalidRepositoryUri(error);
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw invalidRepositoryUri();
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) throw invalidRepositoryUri();
    [owner, name] = segments;
  }
  return GitHubRepositorySchema.parse({ owner, name: name?.replace(/\.git$/iu, "") });
}

export function isGitHubRepositoryUri(sourceUri: string): boolean {
  if (/^[^@\s]+@github\.com:/iu.test(sourceUri)) return true;
  try {
    return new URL(sourceUri).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

function invalidRepositoryUri(cause?: unknown): DevflowError {
  return new DevflowError({
    code: "VALIDATION_ERROR",
    message: "GitHub repository requires an https://github.com/owner/repository.git URI.",
    ...(cause === undefined ? {} : { cause }),
  });
}
