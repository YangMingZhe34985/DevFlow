import { z } from "zod";

const GitHubNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u);

export const GitHubRepositorySchema = z.strictObject({
  owner: GitHubNameSchema,
  name: GitHubNameSchema,
});
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;

export const GitHubShaSchema = z.string().regex(/^[0-9a-f]{40}$/iu);

export const GitHubBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isSafeBranch, "Branch is not a safe Git reference.");

export const GitHubChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("UPSERT"),
    path: z.string().min(1).max(4_096).refine(isSafePath, "Path must be repository-relative."),
    contentBase64: z.string().max(20_000_000),
    mode: z.enum(["100644", "100755", "120000"]).default("100644"),
  }),
  z.strictObject({
    kind: z.literal("DELETE"),
    path: z.string().min(1).max(4_096).refine(isSafePath, "Path must be repository-relative."),
  }),
]);
export type GitHubChange = z.infer<typeof GitHubChangeSchema>;

export const GitHubResolveBaseRequestSchema = z.strictObject({
  repository: GitHubRepositorySchema,
  baseRef: GitHubBranchSchema.optional(),
});
export type GitHubResolveBaseRequest = z.infer<typeof GitHubResolveBaseRequestSchema>;

export const GitHubResolvedBaseSchema = z.strictObject({
  baseRef: GitHubBranchSchema,
  baseCommitSha: GitHubShaSchema,
});
export type GitHubResolvedBase = z.infer<typeof GitHubResolvedBaseSchema>;

export const GitHubRepositoryTreeRequestSchema = z.strictObject({
  repository: GitHubRepositorySchema,
  baseCommitSha: GitHubShaSchema,
});
export type GitHubRepositoryTreeRequest = z.infer<typeof GitHubRepositoryTreeRequestSchema>;

export const GitHubRepositoryTreeEntrySchema = z.strictObject({
  path: z.string().min(1).max(4_096).refine(isSafePath, "Path must be repository-relative."),
  kind: z.enum(["FILE", "SYMLINK", "DIRECTORY"]),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type GitHubRepositoryTreeEntry = z.infer<typeof GitHubRepositoryTreeEntrySchema>;

export const GitHubRepositoryTreeSchema = z.strictObject({
  entries: z.array(GitHubRepositoryTreeEntrySchema).max(100_000),
  truncated: z.boolean(),
});
export type GitHubRepositoryTree = z.infer<typeof GitHubRepositoryTreeSchema>;

export const GitHubPushRequestSchema = z
  .strictObject({
    operationKey: z.string().trim().min(1).max(255),
    repository: GitHubRepositorySchema,
    baseCommit: GitHubShaSchema,
    baseBranch: GitHubBranchSchema,
    branchName: GitHubBranchSchema,
    commitMessage: z.string().trim().min(1).max(8_000),
    changes: z.array(GitHubChangeSchema).min(1).max(2_000),
  })
  .superRefine((value, context) => {
    if (value.baseBranch === value.branchName) {
      context.addIssue({
        code: "custom",
        path: ["branchName"],
        message: "Direct pushes to the repository default/base branch are forbidden.",
      });
    }
    const paths = new Set<string>();
    for (const [index, change] of value.changes.entries()) {
      if (paths.has(change.path)) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "path"],
          message: "Each changed path may appear only once.",
        });
      }
      paths.add(change.path);
    }
  });
export type GitHubPushRequest = z.infer<typeof GitHubPushRequestSchema>;

export const GitHubPushResultSchema = z.strictObject({
  branchName: GitHubBranchSchema,
  commitSha: GitHubShaSchema,
  remoteUrl: z.string().url(),
  idempotent: z.boolean(),
});
export type GitHubPushResult = z.infer<typeof GitHubPushResultSchema>;

export const GitHubPullRequestRequestSchema = z
  .strictObject({
    operationKey: z.string().trim().min(1).max(255),
    repository: GitHubRepositorySchema,
    branchName: GitHubBranchSchema,
    baseBranch: GitHubBranchSchema,
    title: z.string().trim().min(1).max(256),
    body: z.string().max(65_536),
  })
  .refine((value) => value.branchName !== value.baseBranch, {
    path: ["branchName"],
    message: "A pull request head must differ from its base branch.",
  });
export type GitHubPullRequestRequest = z.infer<typeof GitHubPullRequestRequestSchema>;

export const GitHubPullRequestResultSchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["open", "closed"]),
  idempotent: z.boolean(),
});
export type GitHubPullRequestResult = z.infer<typeof GitHubPullRequestResultSchema>;

export interface GitHubProvider {
  resolveBaseCommit(
    input: GitHubResolveBaseRequest,
    signal?: AbortSignal,
  ): Promise<GitHubResolvedBase>;
  /** Read-only, credential-contained repository metadata for deterministic PLAN profiling. */
  readRepositoryTree(
    input: GitHubRepositoryTreeRequest,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryTree>;
  pushBranch(input: GitHubPushRequest, signal?: AbortSignal): Promise<GitHubPushResult>;
  createPullRequest(
    input: GitHubPullRequestRequest,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequestResult>;
}

export interface GitHubCredentialSource {
  /** Platform-only boundary. Tokens must never be returned from public operation results. */
  getToken(signal?: AbortSignal): Promise<string>;
}

export type GitHubApprovalKind = "GITHUB_PUSH" | "GITHUB_PULL_REQUEST";

export interface GitHubApprovalGrant {
  id: string;
  runId: string;
  kind: GitHubApprovalKind;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
}

export interface GitHubPublicationRecord {
  runId: string;
  repository: GitHubRepository;
  baseCommit: string;
  baseBranch: string;
  branchName: string;
  pushOperationKey: string;
  changesArtifactId?: string;
  commitSha?: string;
  branchUrl?: string;
  pullRequestOperationKey?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestState?: "open" | "closed";
}

export interface GitHubPublicationStore {
  findByRunId(runId: string): Promise<GitHubPublicationRecord | null>;
  recordPush(runId: string, operationKey: string, result: GitHubPushResult): Promise<void>;
  recordPullRequest(
    runId: string,
    operationKey: string,
    result: GitHubPullRequestResult,
  ): Promise<void>;
}

export type GitHubProviderErrorCode =
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "CONFLICT"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "NETWORK_FAILED"
  | "PROVIDER_FAILED";

export class GitHubProviderError extends Error {
  override readonly name = "GitHubProviderError";

  constructor(
    readonly code: GitHubProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  toJSON(): {
    code: GitHubProviderErrorCode;
    message: string;
    retryable: boolean;
    status?: number;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }
}

function isSafePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    !value.includes("\0") &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:\//u.test(normalized) &&
    !normalized.split("/").some((part) => part === "" || part === "." || part === "..") &&
    normalized !== ".git" &&
    !normalized.startsWith(".git/")
  );
}

function isSafeBranch(value: string): boolean {
  return (
    /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}
