import { z } from "zod";

// Persisted entities use PostgreSQL UUID columns. Keeping the transport schema
// equally strict turns malformed IDs into boundary errors instead of DB errors.
export const EntityIdSchema = z.string().uuid();

export type RepositoryId = string;
export type TaskId = string;
export type RunId = string;
export type StepId = string;
export type ToolCallId = string;
export type EventId = string;
export type ArtifactId = string;
export type ApprovalId = string;
