import type { RunId, StepId } from "@devflow/shared";

import type { ToolDescriptor, ToolExecutionRequest, ToolPermission } from "./contracts.js";

export type ToolPolicyDecision =
  | { decision: "ALLOW" }
  | { decision: "DENY"; reason: string }
  | { decision: "REQUIRE_APPROVAL"; reason: string };

export interface ToolPolicyContext {
  runId: RunId;
  stepId: StepId;
}

export interface ToolPolicy {
  evaluate(
    tool: ToolDescriptor,
    request: ToolExecutionRequest,
    context: ToolPolicyContext,
  ): Promise<ToolPolicyDecision>;
}

export class DenyAllToolPolicy implements ToolPolicy {
  async evaluate(
    tool: ToolDescriptor,
    _request: ToolExecutionRequest,
    _context: ToolPolicyContext,
  ): Promise<ToolPolicyDecision> {
    return {
      decision: "DENY",
      reason: `Tool '${tool.name}' is denied because no explicit policy is configured.`,
    };
  }
}

export class ExplicitToolPolicy implements ToolPolicy {
  private readonly allowed: ReadonlySet<ToolPermission>;

  constructor(allowedPermissions: readonly ToolPermission[]) {
    this.allowed = new Set(allowedPermissions);
  }

  async evaluate(
    tool: ToolDescriptor,
    _request: ToolExecutionRequest,
    _context: ToolPolicyContext,
  ): Promise<ToolPolicyDecision> {
    return this.allowed.has(tool.permission)
      ? { decision: "ALLOW" }
      : {
          decision: "DENY",
          reason: `Permission '${tool.permission}' is not enabled for tool '${tool.name}'.`,
        };
  }
}

// TODO(P2-tools): replace the in-memory explicit policy with persisted approvals.
