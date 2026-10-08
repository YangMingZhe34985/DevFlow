import { createHash } from "node:crypto";

import type { BudgetLedgerStore } from "@devflow/database";
import { DevflowError } from "@devflow/shared";

export const RESOURCE_DIMENSIONS = [
  "tokens",
  "inputTokens",
  "outputTokens",
  "modelCalls",
  "logicalToolCalls",
  "toolExecutions",
  "ioReads",
  "ioWrites",
  "ioBytes",
  "steps",
  "timeMs",
  "costMicros",
] as const;
export type ResourceDimension = (typeof RESOURCE_DIMENSIONS)[number];
export type ResourceVector = Record<ResourceDimension, number>;
export type ResourceLimits = Partial<ResourceVector>;

export type ResourceBudgetOperationPlan =
  | {
      kind: "OPERATION";
      id: string;
      requirement: "REQUIRED" | "OPTIONAL";
      state: "PENDING" | "CACHED" | "COMPLETED";
      resources: Partial<ResourceVector>;
      reason?: string;
      costStatus?: "PRICED" | "UNPRICED";
    }
  | {
      kind: "SEQUENCE";
      id: string;
      operations: readonly ResourceBudgetOperationPlan[];
    }
  | {
      kind: "EXCLUSIVE";
      id: string;
      /** The workflow transition that makes these branches mutually exclusive. */
      exclusivityKey: string;
      shared?: ResourceBudgetOperationPlan;
      branches: readonly ResourceBudgetOperationPlan[];
    };

export interface ResourceBudgetEstimate {
  resources: ResourceVector;
  operations: {
    id: string;
    state: "PENDING" | "CACHED" | "COMPLETED";
    requirement: "REQUIRED" | "OPTIONAL";
    resources: ResourceVector;
  }[];
  omittedOperationIds: string[];
  unpricedOperationIds: string[];
}

export interface ResourceBudgetQuote extends ResourceBudgetEstimate {
  planDigest: string;
  fits: boolean;
  remaining: Partial<ResourceVector>;
  shortfalls: Partial<ResourceVector>;
  reason?: "LIMIT_EXCEEDED" | "COST_UNKNOWN" | "LEDGER_VIOLATION";
}

export interface ResourceBudgetReservation {
  id: string;
  planDigest: string;
  quote: ResourceBudgetQuote;
  status: "RESERVED" | "ADMITTED" | "SETTLED" | "RELEASED";
  reservedAt: number;
  admittedAt?: number;
  settledAt?: number;
  actual?: ResourceVector;
  settlementDigest?: string;
  costStatus?: "PRICED" | "UNPRICED";
  releaseReason?: string;
}

export interface ResourceBudgetLedger {
  schemaVersion: 1;
  runId: string;
  limits: ResourceLimits;
  startedAt: number;
  deadlineAt: number;
  consumed: ResourceVector;
  reservations: Record<string, ResourceBudgetReservation>;
  observations: Record<string, string>;
  unpricedOperationIds: string[];
  violations: {
    operationId: string;
    dimension: ResourceDimension;
    estimated: number;
    actual: number;
  }[];
  /** Quote errors remain visible when spare run capacity safely covers them. */
  estimateVariances?: {
    operationId: string;
    dimension: ResourceDimension;
    estimated: number;
    actual: number;
  }[];
  lastDecision?: {
    operationId: string;
    at: number;
    quote: ResourceBudgetQuote;
    requestIssued: false;
  };
}

export interface ResourceBudgetSchedulerOptions {
  runId: string;
  store: BudgetLedgerStore;
  limits: ResourceLimits;
  startedAt: number;
  deadlineAt: number;
  initialConsumed?: Partial<ResourceVector>;
  clock?: () => number;
}

export interface ResourceBudgetAdmission {
  admitted: boolean;
  requestIssued: false;
  reservation: ResourceBudgetReservation;
  reason?:
    "ALREADY_ADMITTED" | "ALREADY_SETTLED" | "RELEASED" | "LIMIT_EXCEEDED" | "LEDGER_VIOLATION";
  shortfalls?: Partial<ResourceVector>;
}

export interface ResourceBudgetReservationResult {
  reserved: boolean;
  quote: ResourceBudgetQuote;
  reservation?: ResourceBudgetReservation;
}

/**
 * Run-level authority. Quotes are advisory; only a successful persisted admission
 * authorizes dispatch. An admitted operation has exactly one execution owner;
 * recovery must reconcile its result rather than dispatch it again.
 */
export class ResourceBudgetScheduler {
  private constructor(private readonly options: ResourceBudgetSchedulerOptions) {}

  static async open(options: ResourceBudgetSchedulerOptions): Promise<ResourceBudgetScheduler> {
    validateLimits(options.limits);
    integer(options.startedAt, "startedAt");
    integer(options.deadlineAt, "deadlineAt");
    if (options.deadlineAt <= options.startedAt) throw invalid("Deadline must follow run start.");
    const scheduler = new ResourceBudgetScheduler(options);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const record = await options.store.get(options.runId);
      if (record !== null) {
        const ledger = validateLedger(record.value, options.runId);
        if (digest(ledger.limits) !== digest(options.limits)) {
          throw conflict("Run hard limits cannot be replaced on resume.");
        }
        // Existing start/deadline and consumed resources always win on resume.
        return scheduler;
      }
      const ledger: ResourceBudgetLedger = {
        schemaVersion: 1,
        runId: options.runId,
        limits: { ...options.limits },
        startedAt: options.startedAt,
        deadlineAt: Math.min(
          options.deadlineAt,
          options.startedAt + (options.limits.timeMs ?? options.deadlineAt - options.startedAt),
        ),
        consumed: normalizeResources(options.initialConsumed ?? {}),
        reservations: {},
        observations: {},
        unpricedOperationIds: [],
        violations: [],
      };
      if (await options.store.compareAndSwap(options.runId, null, ledger)) return scheduler;
    }
    throw conflict("Budget ledger initialization was contended.");
  }

  async snapshot(): Promise<ResourceBudgetLedger> {
    return (await this.read()).ledger;
  }

  async quote(plan: ResourceBudgetOperationPlan): Promise<ResourceBudgetQuote> {
    return quoteAgainst((await this.read()).ledger, plan, this.now());
  }

  /** Persist before dispatch. Optional leaves are removed only when necessary. */
  async reserve(
    operationId: string,
    plan: ResourceBudgetOperationPlan,
  ): Promise<ResourceBudgetReservationResult> {
    identifier(operationId);
    const planDigest = digest(plan);
    return await this.change<ResourceBudgetReservationResult>((ledger) => {
      const existing = ledger.reservations[operationId];
      if (existing !== undefined) {
        if (existing.planDigest !== planDigest)
          throw conflict("Operation identity was reused with a different plan.");
        return {
          value: {
            reserved: existing.status === "RESERVED",
            quote: existing.quote,
            reservation: existing,
          },
          changed: false,
        };
      }
      const now = this.now();
      const quote = quoteAgainst(ledger, plan, now);
      ledger.lastDecision = { operationId, at: now, quote, requestIssued: false };
      if (!quote.fits) return { value: { reserved: false, quote }, changed: true };
      const reservation: ResourceBudgetReservation = {
        id: operationId,
        planDigest,
        quote,
        status: "RESERVED",
        reservedAt: now,
      };
      ledger.reservations[operationId] = reservation;
      return { value: { reserved: true, quote, reservation }, changed: true };
    });
  }

  /** Only the CAS winner receives admitted=true. A resumed inflight call is held. */
  async admit(operationId: string): Promise<ResourceBudgetAdmission> {
    return await this.change<ResourceBudgetAdmission>((ledger) => {
      const reservation = requiredReservation(ledger, operationId);
      if (reservation.status !== "RESERVED") {
        const reason =
          reservation.status === "ADMITTED"
            ? "ALREADY_ADMITTED"
            : reservation.status === "SETTLED"
              ? "ALREADY_SETTLED"
              : "RELEASED";
        return {
          value: { admitted: false, requestIssued: false, reservation, reason },
          changed: false,
        };
      }
      const remaining = availableResources(ledger, this.now(), operationId);
      const shortfalls = resourceShortfalls(reservation.quote.resources, remaining);
      if (this.now() >= ledger.deadlineAt) shortfalls.timeMs = Math.max(1, shortfalls.timeMs ?? 0);
      if (hasHardViolation(ledger) || Object.keys(shortfalls).length > 0) {
        return {
          value: {
            admitted: false,
            requestIssued: false,
            reservation,
            reason: hasHardViolation(ledger) ? "LEDGER_VIOLATION" : "LIMIT_EXCEEDED",
            shortfalls,
          },
          changed: false,
        };
      }
      reservation.status = "ADMITTED";
      reservation.admittedAt = this.now();
      return { value: { admitted: true, requestIssued: false, reservation }, changed: true };
    });
  }

  /**
   * Actual usage is never clamped. Quote variance is recorded; exceeding Run
   * capacity or displacing another reservation blocks further dispatch.
   */
  async settle(
    operationId: string,
    actual: Partial<ResourceVector>,
    options: { costStatus?: "PRICED" | "UNPRICED" } = {},
  ): Promise<ResourceBudgetLedger> {
    const resources = normalizeResources(actual);
    return await this.change((ledger) => {
      const reservation = requiredReservation(ledger, operationId);
      const costStatus =
        options.costStatus ??
        (actual.costMicros === undefined && reservation.quote.unpricedOperationIds.length > 0
          ? "UNPRICED"
          : "PRICED");
      const settlementDigest = digest({ resources, costStatus });
      if (reservation.status === "SETTLED") {
        if (reservation.settlementDigest !== settlementDigest)
          throw conflict("Settlement identity was reused with different usage.");
        return { value: ledger, changed: false };
      }
      if (reservation.status !== "ADMITTED")
        throw conflict("Only an admitted operation can settle.");
      for (const dimension of RESOURCE_DIMENSIONS) {
        if (resources[dimension] > reservation.quote.resources[dimension]) {
          (ledger.estimateVariances ??= []).push({
            operationId,
            dimension,
            estimated: reservation.quote.resources[dimension],
            actual: resources[dimension],
          });
        }
      }
      ledger.consumed = addResources(ledger.consumed, resources);
      reservation.status = "SETTLED";
      reservation.actual = resources;
      reservation.costStatus = costStatus;
      reservation.settlementDigest = settlementDigest;
      reservation.settledAt = this.now();
      const otherHeld = addResources(
        ...Object.values(ledger.reservations)
          .filter((entry) => entry.status === "RESERVED" || entry.status === "ADMITTED")
          .map((entry) => entry.quote.resources),
      );
      for (const dimension of RESOURCE_DIMENSIONS) {
        const limit =
          dimension === "timeMs" ? ledger.deadlineAt - ledger.startedAt : ledger.limits[dimension];
        const committed =
          dimension === "timeMs"
            ? Math.max(0, this.now() - ledger.startedAt) + otherHeld.timeMs
            : ledger.consumed[dimension] + otherHeld[dimension];
        if (limit !== undefined && committed > limit) {
          ledger.violations.push({ operationId, dimension, estimated: limit, actual: committed });
        }
      }
      if (costStatus === "UNPRICED" && !ledger.unpricedOperationIds.includes(operationId))
        ledger.unpricedOperationIds.push(operationId);
      return { value: ledger, changed: true };
    });
  }

  async release(operationId: string, reason: string): Promise<ResourceBudgetLedger> {
    return await this.change((ledger) => {
      const reservation = requiredReservation(ledger, operationId);
      if (reservation.status === "RELEASED") return { value: ledger, changed: false };
      if (reservation.status !== "RESERVED")
        throw conflict("An inflight operation cannot be released without a measured settlement.");
      reservation.status = "RELEASED";
      reservation.releaseReason = reason;
      return { value: ledger, changed: true };
    });
  }

  /**
   * Legacy counters are absolute observations, never additive charges. Call only
   * after covered operations have settled. Separate dimensions (e.g. legacy steps
   * versus measured provider tokens) need no cross-stream ordering.
   */
  async reconcileObservation(
    observationId: string,
    cumulative: Partial<ResourceVector>,
  ): Promise<ResourceBudgetLedger> {
    identifier(observationId);
    const normalized = normalizeResources(cumulative);
    const observationDigest = digest(cumulative);
    return await this.change((ledger) => {
      const previous = ledger.observations[observationId];
      if (previous !== undefined) {
        if (previous !== observationDigest)
          throw conflict("Observation identity was reused with different cumulative usage.");
        return { value: ledger, changed: false };
      }
      for (const dimension of RESOURCE_DIMENSIONS) {
        if (
          cumulative[dimension] === undefined ||
          normalized[dimension] <= ledger.consumed[dimension]
        )
          continue;
        const inflight = Object.values(ledger.reservations).some(
          (entry) => entry.status === "ADMITTED" && entry.quote.resources[dimension] > 0,
        );
        if (inflight)
          throw conflict(`Cannot reconcile ${dimension} before covered inflight usage is settled.`);
        ledger.consumed[dimension] = normalized[dimension];
      }
      ledger.observations[observationId] = observationDigest;
      return { value: ledger, changed: true };
    });
  }

  private now(): number {
    return integer((this.options.clock ?? Date.now)(), "clock");
  }

  private async read(): Promise<{ revision: number; ledger: ResourceBudgetLedger }> {
    const record = await this.options.store.get(this.options.runId);
    if (record === null) throw conflict("The durable budget ledger disappeared.");
    return { revision: record.revision, ledger: validateLedger(record.value, this.options.runId) };
  }

  private async change<T>(
    transition: (ledger: ResourceBudgetLedger) => { value: T; changed: boolean },
  ): Promise<T> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const { revision, ledger } = await this.read();
      const outcome = transition(ledger);
      if (!outcome.changed) return structuredClone(outcome.value);
      if (await this.options.store.compareAndSwap(this.options.runId, revision, ledger))
        return structuredClone(outcome.value);
    }
    throw conflict("Budget ledger update was contended; no dispatch was authorized.");
  }
}

export function normalizeResources(input: Partial<ResourceVector>): ResourceVector {
  const result = {} as ResourceVector;
  for (const key of Object.keys(input)) {
    if (!(RESOURCE_DIMENSIONS as readonly string[]).includes(key))
      throw invalid(`Unknown resource dimension: ${key}.`);
  }
  for (const dimension of RESOURCE_DIMENSIONS)
    result[dimension] = integer(input[dimension] ?? 0, dimension);
  // Exclusive branches carry independent maxima for input/output; do not add
  // those maxima back into an already computed total-token envelope.
  if (input.tokens === undefined)
    result.tokens = integer(result.inputTokens + result.outputTokens, "tokens");
  return result;
}

export function addResources(...vectors: readonly Partial<ResourceVector>[]): ResourceVector {
  const result = normalizeResources({});
  for (const vector of vectors) {
    const normalized = normalizeResources(vector);
    for (const dimension of RESOURCE_DIMENSIONS)
      result[dimension] = integer(result[dimension] + normalized[dimension], dimension);
  }
  return result;
}

/** Use only for branches selected by a mutually exclusive workflow transition. */
export function maxResources(...vectors: readonly Partial<ResourceVector>[]): ResourceVector {
  const maximum = normalizeResources({});
  for (const vector of vectors) {
    const normalized = normalizeResources(vector);
    for (const dimension of RESOURCE_DIMENSIONS) {
      maximum[dimension] = Math.max(maximum[dimension], normalized[dimension]);
    }
  }
  return maximum;
}

export function estimateOperationPlan(
  plan: ResourceBudgetOperationPlan,
  options: { omitOptional?: boolean; omittedOperationIds?: readonly string[] } = {},
): ResourceBudgetEstimate {
  const seen = new Set<string>();
  const omitted = new Set(options.omittedOperationIds ?? []);
  const estimate: ResourceBudgetEstimate = {
    resources: normalizeResources({}),
    operations: [],
    omittedOperationIds: [],
    unpricedOperationIds: [],
  };
  const visit = (node: ResourceBudgetOperationPlan): ResourceVector => {
    identifier(node.id);
    if (seen.has(node.id))
      throw invalid(
        `Duplicate operation identity: ${node.id}; shared work belongs in the shared node.`,
      );
    seen.add(node.id);
    if (node.kind === "OPERATION") {
      if (
        !["REQUIRED", "OPTIONAL"].includes(node.requirement) ||
        !["PENDING", "CACHED", "COMPLETED"].includes(node.state)
      )
        throw invalid("Operation requirement or execution state is invalid.");
      const resources = normalizeResources(node.resources);
      if (
        node.requirement === "OPTIONAL" &&
        (options.omitOptional === true || omitted.has(node.id))
      ) {
        estimate.omittedOperationIds.push(node.id);
        return normalizeResources({});
      }
      const pending = node.state === "PENDING";
      const effective = pending ? resources : normalizeResources({});
      estimate.operations.push({
        id: node.id,
        state: node.state,
        requirement: node.requirement,
        resources: effective,
      });
      if (
        pending &&
        (node.costStatus === "UNPRICED" ||
          (resources.modelCalls > 0 &&
            node.costStatus !== "PRICED" &&
            node.resources.costMicros === undefined))
      )
        estimate.unpricedOperationIds.push(node.id);
      return effective;
    }
    if (node.kind === "SEQUENCE") return addResources(...node.operations.map(visit));
    if (
      node.kind !== "EXCLUSIVE" ||
      node.exclusivityKey.trim().length === 0 ||
      node.branches.length === 0
    )
      throw invalid(
        "Exclusive branches require a workflow transition identity and at least one branch.",
      );
    const shared = node.shared === undefined ? normalizeResources({}) : visit(node.shared);
    const maximum = maxResources(...node.branches.map(visit));
    return addResources(shared, maximum);
  };
  estimate.resources = visit(plan);
  return estimate;
}

function quoteAgainst(
  ledger: ResourceBudgetLedger,
  plan: ResourceBudgetOperationPlan,
  now: number,
): ResourceBudgetQuote {
  const remaining = availableResources(ledger, now);
  const planDigest = digest(plan);
  let estimate = estimateOperationPlan(plan);
  const optional = estimate.operations
    .filter((entry) => entry.requirement === "OPTIONAL")
    .map((entry) => entry.id)
    .reverse();
  const removed: string[] = [];
  const quote = (): ResourceBudgetQuote => {
    const shortfalls = resourceShortfalls(estimate.resources, remaining);
    if (now >= ledger.deadlineAt) shortfalls.timeMs = Math.max(1, shortfalls.timeMs ?? 0);
    const reason = hasHardViolation(ledger)
      ? "LEDGER_VIOLATION"
      : ledger.limits.costMicros !== undefined &&
          (estimate.unpricedOperationIds.length > 0 || ledger.unpricedOperationIds.length > 0)
        ? "COST_UNKNOWN"
        : Object.keys(shortfalls).length > 0
          ? "LIMIT_EXCEEDED"
          : undefined;
    return {
      ...estimate,
      planDigest,
      fits: reason === undefined,
      remaining,
      shortfalls,
      ...(reason === undefined ? {} : { reason }),
    };
  };
  while (!quote().fits && optional.length > 0) {
    removed.push(optional.shift()!);
    estimate = estimateOperationPlan(plan, { omittedOperationIds: removed });
  }
  return quote();
}

function availableResources(
  ledger: ResourceBudgetLedger,
  now: number,
  excludedReservation?: string,
): Partial<ResourceVector> {
  const held = addResources(
    ...Object.values(ledger.reservations)
      .filter(
        (entry) =>
          entry.id !== excludedReservation &&
          (entry.status === "RESERVED" || entry.status === "ADMITTED"),
      )
      .map((entry) => entry.quote.resources),
  );
  const remaining: Partial<ResourceVector> = {};
  for (const dimension of RESOURCE_DIMENSIONS) {
    const limit = dimension === "timeMs" ? undefined : ledger.limits[dimension];
    if (limit !== undefined)
      remaining[dimension] = Math.max(0, limit - ledger.consumed[dimension] - held[dimension]);
  }
  // The Run time limit is wall time; parallel tool latency is not charged twice.
  remaining.timeMs = Math.max(0, ledger.deadlineAt - now - held.timeMs);
  return remaining;
}

export function resourceShortfalls(
  required: ResourceVector,
  remaining: Partial<ResourceVector>,
): Partial<ResourceVector> {
  const shortfalls: Partial<ResourceVector> = {};
  for (const dimension of RESOURCE_DIMENSIONS) {
    if (remaining[dimension] !== undefined && required[dimension] > remaining[dimension]!)
      shortfalls[dimension] = required[dimension] - remaining[dimension]!;
  }
  return shortfalls;
}

function validateLimits(limits: ResourceLimits): void {
  normalizeResources(limits);
  for (const [dimension, value] of Object.entries(limits)) {
    if (value === undefined) throw invalid(`Undefined hard limit: ${dimension}.`);
  }
}

function validateLedger(value: unknown, runId: string): ResourceBudgetLedger {
  if (value === null || typeof value !== "object")
    throw conflict("Budget ledger is missing or invalid.");
  const ledger = value as ResourceBudgetLedger;
  if (
    ledger.schemaVersion !== 1 ||
    ledger.runId !== runId ||
    typeof ledger.reservations !== "object" ||
    ledger.reservations === null ||
    typeof ledger.observations !== "object" ||
    ledger.observations === null ||
    !Array.isArray(ledger.violations) ||
    !Array.isArray(ledger.unpricedOperationIds)
  )
    throw conflict("Budget ledger identity or schema is invalid.");
  validateLimits(ledger.limits);
  validateFullVector(ledger.consumed);
  integer(ledger.startedAt, "startedAt");
  integer(ledger.deadlineAt, "deadlineAt");
  if (ledger.deadlineAt <= ledger.startedAt) throw conflict("Budget ledger deadline is invalid.");
  for (const [id, reservation] of Object.entries(ledger.reservations)) {
    identifier(id);
    if (
      reservation.id !== id ||
      !["RESERVED", "ADMITTED", "SETTLED", "RELEASED"].includes(reservation.status)
    )
      throw conflict("Budget reservation identity or state is invalid.");
    validateFullVector(reservation.quote.resources);
    if (
      reservation.status === "SETTLED" &&
      (reservation.actual === undefined || reservation.settlementDigest === undefined)
    )
      throw conflict("Settled budget reservation has no measured usage.");
    if (reservation.actual !== undefined) validateFullVector(reservation.actual);
  }
  return structuredClone(ledger);
}

function validateFullVector(value: ResourceVector): void {
  normalizeResources(value);
  if (RESOURCE_DIMENSIONS.some((dimension) => value[dimension] === undefined))
    throw conflict(
      "Persisted resource vector is incomplete; consumption cannot be inferred as zero.",
    );
}

function hasHardViolation(ledger: ResourceBudgetLedger): boolean {
  return (
    ledger.violations.length > 0 ||
    RESOURCE_DIMENSIONS.some(
      (dimension) =>
        dimension !== "timeMs" &&
        ledger.limits[dimension] !== undefined &&
        ledger.consumed[dimension] > ledger.limits[dimension]!,
    )
  );
}

function requiredReservation(ledger: ResourceBudgetLedger, id: string): ResourceBudgetReservation {
  const reservation = ledger.reservations[id];
  if (reservation === undefined) throw conflict(`Unknown resource reservation: ${id}.`);
  return reservation;
}

function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw invalid(`${name} must be a nonnegative safe integer.`);
  return value;
}

function identifier(value: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value === "__proto__" ||
    value === "constructor" ||
    value === "prototype"
  )
    throw invalid("A nonempty safe operation identity is required.");
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function invalid(message: string): DevflowError {
  return new DevflowError({ code: "VALIDATION_ERROR", message });
}
function conflict(message: string): DevflowError {
  return new DevflowError({ code: "CONFLICT", message });
}
