import { describe, expect, it } from "vitest";

import {
  assertCredentialFreeRepositoryUri,
  repositoryUriContainsCredentials,
} from "../src/index.js";

describe("repository URI credential boundary", () => {
  it.each([
    "https://token@github.com/owner/repository.git",
    "https://user:password@example.com/repository.git",
    "oauth-token@github.com:owner/repository.git",
    "https://example.com/repository.git?access_token=secret",
  ])("rejects credential-bearing URI %s", (uri) => {
    expect(repositoryUriContainsCredentials(uri)).toBe(true);
    expect(() => assertCredentialFreeRepositoryUri(uri)).toThrow(/must not contain credentials/u);
  });

  it.each([
    "https://github.com/owner/repository.git",
    "git@github.com:owner/repository.git",
    "ssh://git@gitlab.example.com/owner/repository.git",
    "C:\\workspace\\repository",
  ])("accepts credential-free URI %s", (uri) => {
    expect(repositoryUriContainsCredentials(uri)).toBe(false);
    expect(() => assertCredentialFreeRepositoryUri(uri)).not.toThrow();
  });
});
