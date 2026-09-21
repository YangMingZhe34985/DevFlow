import {
  DevflowError,
  type AdaptiveBudgetMetrics,
  type AgentPlan,
  type Complexity,
  type RunMetrics,
} from "@devflow/shared";

export type WorkflowMetricStage = "PLAN" | "EXECUTE" | "TEST" | "REPAIR" | "REVIEW";

export interface WorkflowBudgetOptions {
  maxSteps: number;
  maxReviewRetries: number;
  timeoutMs: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  startedAt?: number;
  /** Restores the run-wide counter after approval, retry, or Worker recovery. */
  initialAgentSteps?: number;
}

export interface WorkflowBudgetSnapshot {
  limits: {
    agentSteps: number;
    modelCalls: number;
    toolCalls: number;
    totalTokens: number;
    timeoutMs: number;
  };
  observed: {
    agentSteps: number;
    modelCalls: number;
    toolCalls: number;
    totalTokens: number;
    elapsedMs: number;
  };
  deadlineAt: string;
  budget?: AdaptiveBudgetMetrics;
}

export interface AdaptiveBudgetPlanInput {
  complexity: Complexity;
  estimatedSteps: number;
  confidence: number;
  hardLimit: number;
  consumedSteps?: number;
  minimumDownstreamSteps?: number;
  previousActiveLimit?: number;
}

export interface AdaptiveBudgetPlan {
  complexity: Complexity;
  rawEstimatedSteps: number;
  estimatedSteps: number;
  confidence: number;
  adaptiveMargin: number;
  softLimit: number;
  activeLimit: number;
  hardLimit: number;
  estimateClamped: boolean;
}

export interface RestoredAdaptiveBudgetState {
  plan: AdaptiveBudgetPlan;
  budgetExtensions: number;
  discoveryExtensionUsed: boolean;
}

export interface ExecuteBudgetLeaseInput {
  budget: AdaptiveBudgetPlan;
  consumedSteps: number;
  /** Remaining test- or review-repair opportunities after implementation. */
  remainingRepairAttempts: number;
}

export interface RepairBudgetLeaseInput {
  budget: AdaptiveBudgetPlan;
  consumedSteps: number;
  /** Includes the repair phase about to start. */
  remainingRepairAttempts: number;
}

export interface ReviewBudgetLeaseInput {
  budget: AdaptiveBudgetPlan;
  consumedSteps: number;
}

export interface StageBudgetLease {
  stage: "EXECUTE" | "REPAIR" | "REVIEW";
  /** The phase starts with this many model-decision steps. */
  initialSteps: number;
  /** Absolute phase ceiling if every eligible adaptive extension is granted. */
  maximumSteps: number;
  remainingActiveSteps: number;
  reviewReserve: number;
  repairReserve: number;
  mandatoryDownstreamSteps: number;
}

export type BudgetProgressKind = "DIFF_PROGRESS" | "DISCOVERY_PROGRESS" | "NO_PROGRESS" | "STALLED";

export interface BudgetExtensionInput {
  stage: WorkflowMetricStage;
  budget: AdaptiveBudgetPlan;
  consumedSteps: number;
  mandatoryDownstreamSteps: number;
  progress: BudgetProgressKind;
  progressFingerprintChanged?: boolean;
  discoveryExtensionUsed?: boolean;
  budgetExtensions?: number;
}

export type BudgetExtensionDecision =
  | {
      kind: "GRANTED";
      additionalSteps: number;
      newActiveLimit: number;
      budgetExtended: boolean;
      budgetExtensions: number;
      reason: "ACTIVE_REALLOCATION" | "DIFF_PROGRESS" | "DISCOVERY_PROGRESS";
    }
  | {
      kind: "DENIED";
      code: "ESTIMATED_BUDGET_EXCEEDED" | "MAX_STEPS_EXCEEDED" | "NO_PROGRESS";
      details: {
        stage: WorkflowMetricStage;
        consumedSteps: number;
        estimatedSteps: number;
        softLimit: number;
        activeLimit: number;
        hardLimit: number;
        mandatoryDownstreamSteps: number;
        progress: BudgetProgressKind;
      };
    };

const BASE_MARGIN: Readonly<Record<Complexity, number>> = {
  SIMPLE: 4,
  MEDIUM: 8,
  COMPLEX: 15,
};

const REPAIR_RATIO: Readonly<Record<Complexity, number>> = {
  SIMPLE: 0.2,
  MEDIUM: 0.3,
  COMPLEX: 0.4,
};

const EXPECTED_REPAIR_CYCLES: Readonly<Record<Complexity, number>> = {
  SIMPLE: 1,
  MEDIUM: 2,
  COMPLEX: 3,
};

/**
 * Converts the PLAN estimate into an initial soft budget. Run.maxSteps remains
 * the immutable hard limit; a previous grant is never reduced by replanning.
 */
export function planAdaptiveBudget(input: AdaptiveBudgetPlanInput): AdaptiveBudgetPlan {
  const hardLimit = positiveInteger(input.hardLimit, "hardLimit");
  const rawEstimatedSteps = positiveInteger(input.estimatedSteps, "estimatedSteps");
  const confidence = probability(input.confidence, "confidence");
  const consumedSteps = optionalNonnegativeInteger(input.consumedSteps, "consumedSteps");
  const minimumDownstreamSteps = optionalNonnegativeInteger(
    input.minimumDownstreamSteps,
    "minimumDownstreamSteps",
  );
  const previousActiveLimit = optionalNonnegativeInteger(
    input.previousActiveLimit,
    "previousActiveLimit",
  );

  if (consumedSteps > hardLimit) {
    throw maxStepsExceeded("PLAN", hardLimit, consumedSteps);
  }

  // hardLimit=1 is a supported but degenerate Run: PLAN can consume the only
  // step, after which the Workflow will correctly stop at the hard limit.
  const maximumEstimate = hardLimit === 1 ? 1 : hardLimit - 1;
  const estimatedSteps = clamp(rawEstimatedSteps, 1, maximumEstimate);
  const uncertaintyMargin = Math.ceil(estimatedSteps * (0.15 + 0.25 * (1 - confidence)));
  const calculatedMargin = Math.max(1, BASE_MARGIN[input.complexity], uncertaintyMargin);
  const estimatedSoftLimit = Math.min(hardLimit, estimatedSteps + calculatedMargin);
  const requiredLimit = Math.min(hardLimit, consumedSteps + minimumDownstreamSteps);
  const softLimit = Math.min(hardLimit, Math.max(estimatedSoftLimit, requiredLimit));
  const activeLimit = Math.min(hardLimit, Math.max(softLimit, previousActiveLimit, consumedSteps));
  const adaptiveMargin = Math.max(0, softLimit - estimatedSteps);

  return {
    complexity: input.complexity,
    rawEstimatedSteps,
    estimatedSteps,
    confidence,
    adaptiveMargin,
    softLimit,
    activeLimit,
    hardLimit,
    estimateClamped: rawEstimatedSteps !== estimatedSteps,
  };
}

export function planAdaptiveBudgetFromPlan(
  plan: AgentPlan,
  input: Omit<AdaptiveBudgetPlanInput, "complexity" | "estimatedSteps" | "confidence">,
): AdaptiveBudgetPlan {
  if (
    plan.complexity === undefined ||
    plan.estimatedSteps === undefined ||
    plan.confidence === undefined
  ) {
    const fallbackComplexity: Complexity =
      plan.steps.length <= 2 ? "SIMPLE" : plan.steps.length <= 5 ? "MEDIUM" : "COMPLEX";
    const fallbackEstimate = Math.max(1, 2 + 2 * plan.steps.length);
    // Historical approved plans predate adaptive budgeting. Preserve their old
    // full-hard-limit behavior instead of unexpectedly tightening a resumed Run.
    const fallback = planAdaptiveBudget({
      ...input,
      complexity: fallbackComplexity,
      estimatedSteps: fallbackEstimate,
      confidence: 0.35,
      previousActiveLimit: input.hardLimit,
    });
    return {
      ...fallback,
      adaptiveMargin: Math.max(0, fallback.hardLimit - fallback.estimatedSteps),
      softLimit: fallback.hardLimit,
      activeLimit: fallback.hardLimit,
    };
  }
  return planAdaptiveBudget({
    ...input,
    complexity: plan.complexity,
    estimatedSteps: plan.estimatedSteps,
    confidence: plan.confidence,
  });
}

/** Rehydrates the adaptive controller while treating the current Run hard limit as authoritative. */
export function restoreAdaptiveBudgetState(
  metrics: RunMetrics,
  hardLimit: number,
): RestoredAdaptiveBudgetState | undefined {
  const persisted = metrics.budget;
  if (persisted === undefined) return undefined;
  const hard = positiveInteger(hardLimit, "hardLimit");
  if (metrics.steps > hard) throw maxStepsExceeded("PLAN", hard, metrics.steps);
  const maximumEstimate = hard === 1 ? 1 : hard - 1;
  const estimatedSteps = clamp(persisted.estimatedSteps, 1, maximumEstimate);
  const minimumSoftLimit = hard === 1 ? 1 : estimatedSteps + 1;
  const softLimit = clamp(persisted.softLimit, minimumSoftLimit, hard);
  const activeLimit = clamp(
    Math.max(persisted.activeLimit, softLimit, metrics.steps),
    softLimit,
    hard,
  );
  const rawEstimatedSteps = persisted.rawEstimatedSteps ?? persisted.estimatedSteps;
  return {
    plan: {
      complexity: persisted.complexity,
      rawEstimatedSteps,
      estimatedSteps,
      confidence: persisted.confidence,
      adaptiveMargin: Math.max(0, softLimit - estimatedSteps),
      softLimit,
      activeLimit,
      hardLimit: hard,
      estimateClamped: persisted.estimateClamped === true || rawEstimatedSteps !== estimatedSteps,
    },
    budgetExtensions: persisted.budgetExtensions,
    discoveryExtensionUsed: persisted.discoveryExtensionUsed ?? false,
  };
}

/** Allocates an initial implementation lease while retaining repair/review capacity. */
export function allocateExecuteBudget(input: ExecuteBudgetLeaseInput): StageBudgetLease {
  const consumedSteps = assertBudgetPosition(input.budget, input.consumedSteps);
  const remainingRepairAttempts = nonnegativeIntegerStrict(
    input.remainingRepairAttempts,
    "remainingRepairAttempts",
  );
  const remainingActiveSteps = Math.max(0, input.budget.activeLimit - consumedSteps);
  // A very small Run must still be able to enter the current phase. Reserve
  // downstream work from the capacity left after one current-stage decision.
  const reviewReserve = Math.min(2, Math.max(0, remainingActiveSteps - 1));
  const afterReview = Math.max(0, remainingActiveSteps - reviewReserve);
  const repairReserve =
    remainingRepairAttempts === 0
      ? 0
      : Math.min(
          Math.max(0, afterReview - 1),
          Math.ceil(afterReview * REPAIR_RATIO[input.budget.complexity]),
        );
  const preferredInitialSteps = Math.max(0, afterReview - repairReserve);

  const hardRemaining = Math.max(0, input.budget.hardLimit - consumedSteps);
  const mandatoryReview = Math.min(2, Math.max(0, hardRemaining - 1));
  // Keep one hard Repair decision available when retries remain. The rest of
  // the complexity-shaped Repair pool is only a soft reservation and may be
  // reallocated after genuine Execute progress.
  const mandatoryRepair =
    remainingRepairAttempts > 0 && hardRemaining - 1 > mandatoryReview ? 1 : 0;
  const mandatoryDownstreamSteps = mandatoryReview + mandatoryRepair;
  const maximumSteps = Math.max(0, hardRemaining - mandatoryDownstreamSteps);

  return {
    stage: "EXECUTE",
    initialSteps: Math.min(preferredInitialSteps, maximumSteps),
    maximumSteps,
    remainingActiveSteps,
    reviewReserve,
    repairReserve,
    mandatoryDownstreamSteps,
  };
}

/** Allocates one repair lease without permanently locking future repair attempts. */
export function allocateRepairBudget(input: RepairBudgetLeaseInput): StageBudgetLease {
  const consumedSteps = assertBudgetPosition(input.budget, input.consumedSteps);
  const remainingRepairAttempts = nonnegativeIntegerStrict(
    input.remainingRepairAttempts,
    "remainingRepairAttempts",
  );
  const remainingActiveSteps = Math.max(0, input.budget.activeLimit - consumedSteps);
  const reviewReserve = Math.min(2, Math.max(0, remainingActiveSteps - 1));
  const availableRepairSteps = Math.max(0, remainingActiveSteps - reviewReserve);
  const expectedCycles = Math.min(
    EXPECTED_REPAIR_CYCLES[input.budget.complexity],
    remainingRepairAttempts,
  );
  const preferredInitialSteps =
    expectedCycles === 0 ? 0 : Math.ceil(availableRepairSteps / expectedCycles);

  const hardRemaining = Math.max(0, input.budget.hardLimit - consumedSteps);
  const mandatoryDownstreamSteps = Math.min(2, Math.max(0, hardRemaining - 1));
  const maximumSteps = Math.max(0, hardRemaining - mandatoryDownstreamSteps);
  const initialSteps = Math.min(preferredInitialSteps, maximumSteps);

  return {
    stage: "REPAIR",
    initialSteps,
    maximumSteps,
    remainingActiveSteps,
    reviewReserve,
    repairReserve: Math.max(0, availableRepairSteps - initialSteps),
    mandatoryDownstreamSteps,
  };
}

/** Reserves a normal review plus its single permitted structured-format repair. */
export function allocateReviewBudget(input: ReviewBudgetLeaseInput): StageBudgetLease {
  const consumedSteps = assertBudgetPosition(input.budget, input.consumedSteps);
  const remainingActiveSteps = Math.max(0, input.budget.activeLimit - consumedSteps);
  const maximumSteps = Math.max(0, input.budget.hardLimit - consumedSteps);
  return {
    stage: "REVIEW",
    initialSteps: Math.min(2, remainingActiveSteps, maximumSteps),
    maximumSteps,
    remainingActiveSteps,
    reviewReserve: 0,
    repairReserve: 0,
    mandatoryDownstreamSteps: 0,
  };
}

/**
 * Makes a deterministic decision at a phase lease boundary. The function first
 * reuses unallocated active budget, then grows activeLimit in bounded quanta.
 */
export function evaluateBudgetExtension(input: BudgetExtensionInput): BudgetExtensionDecision {
  const consumedSteps = assertBudgetPosition(input.budget, input.consumedSteps);
  const mandatoryDownstreamSteps = nonnegativeIntegerStrict(
    input.mandatoryDownstreamSteps,
    "mandatoryDownstreamSteps",
  );
  const budgetExtensions = optionalNonnegativeInteger(input.budgetExtensions, "budgetExtensions");

  if (consumedSteps >= input.budget.hardLimit) {
    return deniedExtension(input, consumedSteps, mandatoryDownstreamSteps, "MAX_STEPS_EXCEEDED");
  }
  if (
    input.progress === "STALLED" ||
    (input.progress === "DIFF_PROGRESS" && input.progressFingerprintChanged !== true)
  ) {
    return deniedExtension(input, consumedSteps, mandatoryDownstreamSteps, "NO_PROGRESS");
  }
  if (input.progress === "NO_PROGRESS") {
    return deniedExtension(input, consumedSteps, mandatoryDownstreamSteps, "NO_PROGRESS");
  }
  if (input.progress === "DISCOVERY_PROGRESS" && input.discoveryExtensionUsed === true) {
    return deniedExtension(
      input,
      consumedSteps,
      mandatoryDownstreamSteps,
      "ESTIMATED_BUDGET_EXCEEDED",
    );
  }

  const hardAvailable = Math.max(
    0,
    input.budget.hardLimit - consumedSteps - mandatoryDownstreamSteps,
  );
  if (hardAvailable === 0) {
    return deniedExtension(input, consumedSteps, mandatoryDownstreamSteps, "MAX_STEPS_EXCEEDED");
  }

  const quantum = Math.max(2, Math.ceil(input.budget.estimatedSteps * 0.15));
  const activeAvailable = Math.max(
    0,
    input.budget.activeLimit - consumedSteps - mandatoryDownstreamSteps,
  );
  if (activeAvailable > 0) {
    return {
      kind: "GRANTED",
      additionalSteps: Math.min(quantum, activeAvailable),
      newActiveLimit: input.budget.activeLimit,
      budgetExtended: false,
      budgetExtensions,
      reason: "ACTIVE_REALLOCATION",
    };
  }

  const requestedActiveLimit = Math.max(
    input.budget.activeLimit + quantum,
    consumedSteps + mandatoryDownstreamSteps + 1,
  );
  const newActiveLimit = Math.min(input.budget.hardLimit, requestedActiveLimit);
  const extensionAvailable = Math.max(0, newActiveLimit - consumedSteps - mandatoryDownstreamSteps);
  if (extensionAvailable === 0) {
    return deniedExtension(input, consumedSteps, mandatoryDownstreamSteps, "MAX_STEPS_EXCEEDED");
  }

  return {
    kind: "GRANTED",
    additionalSteps: Math.min(quantum, extensionAvailable),
    newActiveLimit,
    budgetExtended: true,
    budgetExtensions: budgetExtensions + 1,
    reason: input.progress === "DIFF_PROGRESS" ? "DIFF_PROGRESS" : "DISCOVERY_PROGRESS",
  };
}

export function buildAdaptiveBudgetMetrics(
  budget: AdaptiveBudgetPlan,
  usage: {
    planSteps?: number;
    executeSteps?: number;
    repairSteps?: number;
    reviewSteps?: number;
    budgetExtensions?: number;
    activeLimit?: number;
    discoveryExtensionUsed?: boolean;
  } = {},
): AdaptiveBudgetMetrics {
  const planSteps = optionalNonnegativeInteger(usage.planSteps, "planSteps");
  const executeSteps = optionalNonnegativeInteger(usage.executeSteps, "executeSteps");
  const repairSteps = optionalNonnegativeInteger(usage.repairSteps, "repairSteps");
  const reviewSteps = optionalNonnegativeInteger(usage.reviewSteps, "reviewSteps");
  const budgetExtensions = optionalNonnegativeInteger(usage.budgetExtensions, "budgetExtensions");
  const actualSteps = planSteps + executeSteps + repairSteps + reviewSteps;
  if (actualSteps > budget.hardLimit) {
    throw maxStepsExceeded("PLAN", budget.hardLimit, actualSteps);
  }
  const activeLimit = Math.min(
    budget.hardLimit,
    Math.max(
      budget.softLimit,
      budget.activeLimit,
      actualSteps,
      usage.activeLimit === undefined
        ? 0
        : nonnegativeIntegerStrict(usage.activeLimit, "activeLimit"),
    ),
  );
  return {
    complexity: budget.complexity,
    estimatedSteps: budget.estimatedSteps,
    confidence: budget.confidence,
    softLimit: budget.softLimit,
    activeLimit,
    hardLimit: budget.hardLimit,
    planSteps,
    executeSteps,
    repairSteps,
    reviewSteps,
    unusedSteps: activeLimit - actualSteps,
    budgetExtensions,
    rawEstimatedSteps: budget.rawEstimatedSteps,
    adaptiveMargin: budget.adaptiveMargin,
    estimateClamped: budget.estimateClamped,
    discoveryExtensionUsed: usage.discoveryExtensionUsed ?? false,
  };
}

export class WorkflowBudgetLedger {
  readonly maxAgentSteps: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
  readonly deadlineAt: number;
  private readonly startedAt: number;
  private readonly timeoutMs: number;
  private consumedAgentSteps: number;

  static fromMetrics(options: WorkflowBudgetOptions, metrics: RunMetrics): WorkflowBudgetLedger {
    return new WorkflowBudgetLedger({
      ...options,
      initialAgentSteps: Math.max(options.initialAgentSteps ?? 0, metrics.steps),
    });
  }

  constructor(options: WorkflowBudgetOptions) {
    this.maxAgentSteps = positiveInteger(options.maxSteps, "maxSteps");
    this.maxModelCalls =
      options.maxModelCalls ?? options.maxSteps + 2 * (options.maxReviewRetries + 2);
    this.maxToolCalls = options.maxToolCalls ?? Math.max(12, 3 * options.maxSteps);
    this.maxTotalTokens = options.maxTotalTokens ?? 250_000;
    this.startedAt = options.startedAt ?? Date.now();
    this.timeoutMs = positiveInteger(options.timeoutMs, "timeoutMs");
    this.deadlineAt = this.startedAt + this.timeoutMs;
    this.consumedAgentSteps = optionalNonnegativeInteger(
      options.initialAgentSteps,
      "initialAgentSteps",
    );
    if (this.consumedAgentSteps > this.maxAgentSteps) {
      throw maxStepsExceeded("PLAN", this.maxAgentSteps, this.consumedAgentSteps);
    }
  }

  get consumedAgentStepCount(): number {
    return this.consumedAgentSteps;
  }

  get remainingAgentSteps(): number {
    return Math.max(0, this.maxAgentSteps - this.consumedAgentSteps);
  }

  remainingModelCalls(metrics: RunMetrics): number {
    return Math.max(0, this.maxModelCalls - metrics.modelCalls);
  }

  remainingToolCalls(metrics: RunMetrics): number {
    return Math.max(0, this.maxToolCalls - metrics.toolCalls);
  }

  remainingTotalTokens(metrics: RunMetrics): number {
    return Math.max(0, this.maxTotalTokens - metrics.tokenUsage.totalTokens);
  }

  /** Advances recovery state monotonically; replaying an older checkpoint cannot rewind it. */
  restoreAgentSteps(steps: number, stage: WorkflowMetricStage = "PLAN"): void {
    const restored = nonnegativeIntegerStrict(steps, "steps");
    const observed = Math.max(this.consumedAgentSteps, restored);
    if (observed > this.maxAgentSteps) {
      throw maxStepsExceeded(stage, this.maxAgentSteps, observed);
    }
    this.consumedAgentSteps = observed;
  }

  synchronizeAgentSteps(metrics: RunMetrics, stage: WorkflowMetricStage = "PLAN"): void {
    this.restoreAgentSteps(metrics.steps, stage);
  }

  consumeAgentSteps(steps: number, stage: WorkflowMetricStage): void {
    const observed = this.consumedAgentSteps + nonnegativeIntegerStrict(steps, "steps");
    if (observed > this.maxAgentSteps) {
      throw maxStepsExceeded(stage, this.maxAgentSteps, observed);
    }
    this.consumedAgentSteps = observed;
  }

  consumeStructuredStep(stage: "PLAN" | "REVIEW"): void {
    this.consumeAgentSteps(1, stage);
  }

  consumeRuntimeSteps(steps: number, stage: "EXECUTE" | "REPAIR"): void {
    this.consumeAgentSteps(steps, stage);
  }

  requireAgentSteps(stage: WorkflowMetricStage): void {
    if (this.remainingAgentSteps === 0) {
      throw maxStepsExceeded(stage, this.maxAgentSteps, this.consumedAgentSteps + 1);
    }
  }

  requireModelCall(stage: WorkflowMetricStage, metrics: RunMetrics): void {
    const observed = metrics.modelCalls + 1;
    if (observed > this.maxModelCalls) {
      this.exceeded(stage, "modelCalls", this.maxModelCalls, observed);
    }
  }

  requireToolCalls(stage: WorkflowMetricStage, metrics: RunMetrics, calls = 1): void {
    const requested = nonnegativeIntegerStrict(calls, "calls");
    const observed = metrics.toolCalls + requested;
    if (observed > this.maxToolCalls) {
      this.exceeded(stage, "toolCalls", this.maxToolCalls, observed);
    }
  }

  snapshot(metrics: RunMetrics, budget?: AdaptiveBudgetMetrics): WorkflowBudgetSnapshot {
    return {
      limits: {
        agentSteps: this.maxAgentSteps,
        modelCalls: this.maxModelCalls,
        toolCalls: this.maxToolCalls,
        totalTokens: this.maxTotalTokens,
        timeoutMs: this.timeoutMs,
      },
      observed: {
        agentSteps: this.consumedAgentSteps,
        modelCalls: metrics.modelCalls,
        toolCalls: metrics.toolCalls,
        totalTokens: metrics.tokenUsage.totalTokens,
        elapsedMs: Math.max(0, Date.now() - this.startedAt),
      },
      deadlineAt: new Date(this.deadlineAt).toISOString(),
      ...(budget === undefined ? {} : { budget }),
    };
  }

  assertWithinLimits(stage: WorkflowMetricStage, metrics: RunMetrics): void {
    if (metrics.modelCalls > this.maxModelCalls) {
      this.exceeded(stage, "modelCalls", this.maxModelCalls, metrics.modelCalls);
    }
    if (metrics.toolCalls > this.maxToolCalls) {
      this.exceeded(stage, "toolCalls", this.maxToolCalls, metrics.toolCalls);
    }
    if (metrics.tokenUsage.totalTokens > this.maxTotalTokens) {
      this.exceeded(stage, "totalTokens", this.maxTotalTokens, metrics.tokenUsage.totalTokens);
    }
    const now = Date.now();
    if (now >= this.deadlineAt) {
      this.exceeded(stage, "timeoutMs", this.timeoutMs, now - this.startedAt);
    }
  }

  remainingTimeoutMs(stage: WorkflowMetricStage): number {
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      this.exceeded(stage, "timeoutMs", this.timeoutMs, Date.now() - this.startedAt);
    }
    return Math.max(1, remaining);
  }

  private exceeded(
    stage: WorkflowMetricStage,
    budgetType: string,
    limit: number,
    observed: number,
  ): never {
    throw new DevflowError({
      code: "EXECUTION_BUDGET_EXCEEDED",
      message: `${stage} exceeded the ${budgetType} execution budget.`,
      details: { stage, budgetType, limit, observed },
    });
  }
}

function deniedExtension(
  input: BudgetExtensionInput,
  consumedSteps: number,
  mandatoryDownstreamSteps: number,
  code: "ESTIMATED_BUDGET_EXCEEDED" | "MAX_STEPS_EXCEEDED" | "NO_PROGRESS",
): BudgetExtensionDecision {
  return {
    kind: "DENIED",
    code,
    details: {
      stage: input.stage,
      consumedSteps,
      estimatedSteps: input.budget.estimatedSteps,
      softLimit: input.budget.softLimit,
      activeLimit: input.budget.activeLimit,
      hardLimit: input.budget.hardLimit,
      mandatoryDownstreamSteps,
      progress: input.progress,
    },
  };
}

function assertBudgetPosition(budget: AdaptiveBudgetPlan, consumedSteps: number): number {
  const consumed = nonnegativeIntegerStrict(consumedSteps, "consumedSteps");
  if (consumed > budget.hardLimit) {
    throw maxStepsExceeded("PLAN", budget.hardLimit, consumed);
  }
  if (
    budget.softLimit > budget.activeLimit ||
    budget.activeLimit > budget.hardLimit ||
    budget.estimatedSteps > budget.softLimit
  ) {
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "Adaptive budget limits are inconsistent.",
      details: {
        estimatedSteps: budget.estimatedSteps,
        softLimit: budget.softLimit,
        activeLimit: budget.activeLimit,
        hardLimit: budget.hardLimit,
      },
    });
  }
  return consumed;
}

function maxStepsExceeded(
  stage: WorkflowMetricStage,
  limit: number,
  observed: number,
): DevflowError {
  return new DevflowError({
    code: "MAX_STEPS_EXCEEDED",
    message: `${stage} cannot continue without exceeding the Run hard step limit.`,
    details: { stage, budgetType: "agentSteps", limit, observed },
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw invalidNumber(name, "a positive integer", value);
  }
  return value;
}

function nonnegativeIntegerStrict(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw invalidNumber(name, "a nonnegative integer", value);
  }
  return value;
}

function optionalNonnegativeInteger(value: number | undefined, name: string): number {
  return value === undefined ? 0 : nonnegativeIntegerStrict(value, name);
}

function probability(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidNumber(name, "between 0 and 1", value);
  }
  return value;
}

function invalidNumber(name: string, expected: string, value: number): DevflowError {
  return new DevflowError({
    code: "VALIDATION_ERROR",
    message: `${name} must be ${expected}.`,
    details: { field: name, value },
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
