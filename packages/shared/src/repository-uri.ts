import { DevflowError } from "./errors.js";

/**
 * Detects credentials embedded in a repository URI before the value can be
 * persisted, logged, or passed to `git clone`.
 */
export function repositoryUriContainsCredentials(sourceUri: string): boolean {
  const value = sourceUri.trim();
  try {
    const url = new URL(value);
    const isSsh = url.protocol === "ssh:" || url.protocol === "git+ssh:";
    if (url.password.length > 0) return true;
    if (url.username.length > 0 && !(isSsh && url.username === "git")) return true;
    if (url.hash.length > 0) return true;
    for (const key of url.searchParams.keys()) {
      if (/(?:access|auth|credential|key|password|secret|signature|token)/iu.test(key)) {
        return true;
      }
    }
  } catch {
    // SCP-like Git syntax is not a WHATWG URL. Only the conventional, non-secret
    // `git@host:path` identity is accepted at this boundary.
    const scp = /^([^@\s]+)@([^:\s]+):(.+)$/u.exec(value);
    if (scp !== null && scp[1] !== "git") return true;
  }
  return false;
}

export function assertCredentialFreeRepositoryUri(sourceUri: string): void {
  if (!repositoryUriContainsCredentials(sourceUri)) return;
  throw new DevflowError({
    code: "VALIDATION_ERROR",
    message:
      "Repository URIs must not contain credentials. Configure credentials at the platform boundary.",
  });
}
