import { AsyncLocalStorage } from "node:async_hooks";
import { DevflowError, type TeamLease } from "@devflow/shared";

/** Host execution identity propagates through existing stores without changing model/tool inputs. */
export const databaseExecutionLease = new AsyncLocalStorage<TeamLease & { runId: string }>();
export function currentDatabaseLease(runId: string): TeamLease | undefined {
  const scope = databaseExecutionLease.getStore();
  if (scope && scope.runId !== runId)
    throw new DevflowError({ code: "CONFLICT", message: "DATABASE_EXECUTION_RUN_MISMATCH" });
  return scope;
}
