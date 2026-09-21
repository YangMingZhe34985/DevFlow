const KNOWN_GITHUB_SECRET = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu;
const AUTHORIZATION = /\b(?:authorization|token)\s*[:=]\s*(?:bearer\s+|token\s+)?[^\s,;]+/giu;

export function redactGitHubSecrets(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted
    .replace(KNOWN_GITHUB_SECRET, "[REDACTED]")
    .replace(AUTHORIZATION, "authorization=[REDACTED]");
}

export function safeProviderMessage(
  value: unknown,
  secrets: readonly string[] = [],
  maxLength = 1_000,
): string {
  const raw =
    value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
  const redacted = redactGitHubSecrets(raw, secrets)
    .replace(/[\r\n\t]+/gu, " ")
    .trim();
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}
