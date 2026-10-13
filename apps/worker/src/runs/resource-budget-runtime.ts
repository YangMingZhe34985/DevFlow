import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentStateStore, LanguageModelPort } from "@devflow/agent";
import type { SandboxSession } from "@devflow/sandbox";
import { DevflowError } from "@devflow/shared";
import type { RepositoryIndexStore } from "@devflow/database";
import type { IndexSource } from "../localization/contracts.js";
import { estimatePlanRequest } from "./plan-agent-context.js";
import type {
  ResourceBudgetScheduler,
  ResourceBudgetOperationPlan,
  ResourceVector,
  ResourceBudgetReservation,
} from "./resource-budget-scheduler.js";

export interface ModelResourcePrice {
  /** All prices and caps use the same configured currency, in millionths. */
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
}

/** One dispatch context; the scheduler's persisted ledger belongs to the whole Run. */
export const resourceBudgetContext = new AsyncLocalStorage<ResourceBudgetRuntime>();

/** Compatibility metrics may remain synchronous; every execution boundary drains these admissions. */
export function recordLogicalResourceWork(calls: number): void {
  if (calls > 0) resourceBudgetContext.getStore()?.enqueueLogical(calls);
}

export function recordDecisionResourceWork(steps: number): void {
  if (steps > 0) resourceBudgetContext.getStore()?.enqueueSteps(steps);
}

export class ResourceBudgetRuntime {
  private queued: Promise<void> = Promise.resolve();
  private queueError: unknown;
  private continuationRate: number | undefined;
  private readonly wrappedSources = new WeakMap<IndexSource, IndexSource>();
  private readonly wrappedSandboxes = new WeakMap<SandboxSession, SandboxSession>();
  private readonly wrappedIndexes = new WeakMap<RepositoryIndexStore, RepositoryIndexStore>();

  constructor(
    readonly scheduler: ResourceBudgetScheduler,
    private readonly record: (event: Record<string, unknown>) => Promise<void>,
  ) {}

  enqueueLogical(calls: number): void {
    this.queued = this.queued.then(async () => {
      if (this.queueError) return;
      try {
        await this.consumeLogical(calls, "workflow-operation");
      } catch (error) {
        this.queueError = error;
      }
    });
  }

  enqueueSteps(steps: number): void {
    this.queued = this.queued.then(async () => {
      if (this.queueError) return;
      try {
        const id = `decision:${randomUUID()}`;
        await this.admit(id, operation(id, { steps }));
        await this.scheduler.settle(id, { steps });
      } catch (error) {
        this.queueError = error;
      }
    });
  }

  stateStore(store: AgentStateStore): AgentStateStore {
    let previousSteps = 0;
    let sessionRunId: string | undefined;
    return {
      load: async (runId) => {
        sessionRunId = runId;
        const state = await store.load(runId);
        previousSteps = state?.stepCount ?? 0;
        return state;
      },
      save: async (state) => {
        await this.flush();
        if (!sessionRunId)
          throw new DevflowError({
            code: "CONFLICT",
            message: "Coding budget state must be loaded before saving.",
          });
        // The absolute session step survives a failed checkpoint write. Replaying its
        // persistence does not pay for the same decision twice or admit another HTTP request.
        for (let step = previousSteps + 1; step <= state.stepCount; step++) {
          const id = `coding-decision:${sessionRunId}:${step}`;
          const plan = operation(id, { steps: 1 });
          const reserved = await this.scheduler.reserve(id, plan);
          if (reserved.reservation?.status === "SETTLED") continue;
          if (reserved.reservation?.status === "ADMITTED") {
            await this.scheduler.settle(id, { steps: 1 });
            continue;
          }
          if (!reserved.reserved) throw blocked(id, reserved.quote);
          const admission = await this.scheduler.admit(id);
          if (!admission.admitted) throw blocked(id, admission);
          await this.scheduler.settle(id, { steps: 1 });
        }
        await store.save(state);
        previousSteps = Math.max(previousSteps, state.stepCount);
      },
    };
  }

  async flush(): Promise<void> {
    await this.queued;
    if (this.queueError) throw this.queueError;
  }

  /** Cached/denied/control calls still consume one logical decision, but no physical IO. */
  async logicalTool(callId: string): Promise<void> {
    await this.flush();
    await this.consumeLogical(1, `agent-tool:${callId}`);
  }

  private async consumeLogical(calls: number, label: string): Promise<void> {
    const id = label.startsWith("agent-tool:") ? label : `${label}:${randomUUID()}`;
    await this.admit(id, operation(id, { logicalToolCalls: calls }));
    await this.scheduler.settle(id, { logicalToolCalls: calls });
  }

  async check(plan: ResourceBudgetOperationPlan, label: string): Promise<void> {
    await this.flush();
    const quote = await this.scheduler.quote(plan);
    await this.record({
      budgetScheduler: { operationId: label, action: "QUOTE", quote, requestIssued: false },
    });
    if (!quote.fits) throw blocked(label, quote);
  }

  /** Price capacity using the same configured bound as actual model admission.
   * This is a quote, never consumption or a substitute for request admission. */
  async checkContinuation(resources: Partial<ResourceVector>, label: string): Promise<void> {
    const tokens = resources.tokens ?? 0;
    const priced =
      tokens === 0 || (resources.costMicros ?? 0) > 0 || this.continuationRate !== undefined;
    await this.check(
      {
        ...operation(label, {
          ...resources,
          ...(tokens > 0 && (resources.costMicros ?? 0) === 0 && this.continuationRate !== undefined
            ? { costMicros: Math.ceil((tokens * this.continuationRate) / 1_000_000) }
            : {}),
        }),
        costStatus: priced ? "PRICED" : "UNPRICED",
      },
      label,
    );
  }

  /** Trusted host work (parser/database), separate from model logical tool calls. */
  async internal<T>(
    label: string,
    estimate: Partial<ResourceVector>,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.io(label, estimate, run);
  }

  indexStore(store: RepositoryIndexStore): RepositoryIndexStore {
    const prior = this.wrappedIndexes.get(store);
    if (prior) return prior;
    // Publications are immutable by (scope, key). Keep only confirmed reads; a
    // publish may lose to another builder, so its proposed value is not evidence.
    // This cache belongs to one Run runtime and is never restored across workers.
    const cached = new Map<string, { value: unknown; bytes: number }>();
    const pending = new Map<string, Promise<unknown>>();
    const maxBytes = 16 * 1024 * 1024;
    let bytes = 0;
    const reused = async (value: unknown, key: string) => {
      await this.record({
        budgetScheduler: { action: "INDEX_CACHE_HIT", key, physicalIO: false },
      });
      return structuredClone(value);
    };
    const wrapped: RepositoryIndexStore = {
      get: async (scope, key) => {
        await this.flush();
        const identity = JSON.stringify([scope, key]);
        const hit = cached.get(identity);
        if (hit) {
          cached.delete(identity);
          cached.set(identity, hit);
          return reused(hit.value, identity);
        }
        const inflight = pending.get(identity);
        if (inflight) return reused(await inflight, identity);
        const read = this.io(
          "prg:index-get",
          { toolExecutions: 1, ioReads: 1, ioBytes: 1024 * 1024, timeMs: 5000 },
          () => store.get(scope, key),
          (value) => ({ ioBytes: Buffer.byteLength(JSON.stringify(value ?? null)) }),
        ).then((value) => {
          if (value !== undefined) {
            const size = Buffer.byteLength(JSON.stringify(value));
            if (size <= maxBytes) {
              while (bytes + size > maxBytes && cached.size) {
                const oldest = cached.keys().next().value!;
                bytes -= cached.get(oldest)!.bytes;
                cached.delete(oldest);
              }
              cached.set(identity, { value: structuredClone(value), bytes: size });
              bytes += size;
            }
          }
          return value;
        });
        pending.set(identity, read);
        try {
          return structuredClone(await read);
        } finally {
          pending.delete(identity); // misses and errors must remain retryable
        }
      },
      publish: (scope, key, value) =>
        this.io(
          "prg:index-publish",
          {
            toolExecutions: 1,
            ioWrites: 1,
            ioBytes: Buffer.byteLength(JSON.stringify(value)),
            timeMs: 5000,
          },
          () => store.publish(scope, key, value),
        ),
    };
    this.wrappedIndexes.set(store, wrapped);
    return wrapped;
  }

  private async admit(
    id: string,
    plan: ResourceBudgetOperationPlan,
    options: { fitDeadline?: boolean } = {},
  ): Promise<ResourceBudgetReservation> {
    const reserved = await this.scheduler.reserve(id, plan, options);
    if (!reserved.reserved) {
      await this.record({
        budgetScheduler: { operationId: id, action: "RESERVE", ...reserved, requestIssued: false },
      });
      throw blocked(id, reserved.quote);
    }
    const admission = await this.scheduler.admit(id);
    if (!admission.admitted) {
      await this.record({ budgetScheduler: { operationId: id, action: "ADMIT", ...admission } });
      throw blocked(id, admission);
    }
    return admission.reservation;
  }

  model(
    model: LanguageModelPort,
    options: {
      stage: string;
      outputTokens: number;
      timeoutMs: number;
      recoveryTimeoutMs?: number;
      price?: ModelResourcePrice;
      /** Conservative bound across all reachable configured stage models. Unknown remains unpriced. */
      continuationMicrosPerMillionTokens?: number;
      /** Host-owned operation identity; never use an unqualified model tool-call ID. */
      operationId?: string;
      /** Team decisions consume the same Run steps; Coding retains its state-store accounting. */
      decisionSteps?: number;
      /** Host allows a shorter request lifetime within the remaining reserved execution path. */
      fitDeadline?: boolean;
    },
  ): LanguageModelPort {
    this.continuationRate = options.continuationMicrosPerMillionTokens;
    return {
      ...(model.prepareRequest ? { prepareRequest: model.prepareRequest.bind(model) } : {}),
      generate: async (request, requestOptions) => {
        await this.flush();
        requestOptions.signal.throwIfAborted();
        request =
          request.inputProjection || !model.prepareRequest
            ? request
            : await model.prepareRequest(request, requestOptions);
        // This wrapper is inside stage projection: these are the actual dispatched messages/schema.
        const inputTokens = estimatePlanRequest(request).estimatedInputTokens;
        const outputTokens = request.settings?.maxOutputTokens ?? options.outputTokens;
        const timeoutMs =
          options.stage === "REVIEW" &&
          ["low", "none"].includes(request.settings?.reasoningEffort ?? "")
            ? (options.recoveryTimeoutMs ?? options.timeoutMs)
            : options.timeoutMs;
        const priced = options.price !== undefined;
        const id = options.operationId ?? `llm:${options.stage}:${randomUUID()}`;
        const resources = {
          tokens: inputTokens + outputTokens,
          inputTokens,
          outputTokens,
          modelCalls: 1,
          steps: options.decisionSteps ?? 0,
          timeMs: timeoutMs,
          costMicros: modelCost(options.price, inputTokens, outputTokens),
        };
        if (request.resourceContinuation) {
          const continuation = { ...request.resourceContinuation };
          const futureTokens = continuation.tokens ?? 0;
          const futurePriced =
            futureTokens === 0 ||
            (continuation.costMicros ?? 0) > 0 ||
            options.continuationMicrosPerMillionTokens !== undefined;
          if (
            futureTokens > 0 &&
            (continuation.costMicros ?? 0) === 0 &&
            options.continuationMicrosPerMillionTokens !== undefined
          )
            continuation.costMicros = Math.ceil(
              (futureTokens * options.continuationMicrosPerMillionTokens) / 1_000_000,
            );
          await this.check(
            {
              kind: "SEQUENCE",
              id: `${id}:with-continuation`,
              operations: [
                { ...operation(id, resources), costStatus: priced ? "PRICED" : "UNPRICED" },
                {
                  ...operation(`${id}:continuation`, continuation),
                  costStatus: futurePriced ? "PRICED" : "UNPRICED",
                  reason:
                    "Reachable downstream capacity; unknown future input/output mix uses the maximum configured stage token rate.",
                },
              ],
            },
            `${options.stage}:request-and-continuation`,
          );
        }
        const admission = await this.admit(
          id,
          {
            ...operation(id, resources),
            costStatus: priced ? "PRICED" : "UNPRICED",
          },
          { fitDeadline: options.fitDeadline ?? false },
        );
        const started = Date.now();
        await this.record({
          budgetScheduler: {
            operationId: id,
            action: "INVOKE",
            stage: options.stage,
            dispatchStatus: "PENDING",
            resources: admission.quote.resources,
            configuredTimeoutMs: timeoutMs,
            ...(admission.executionDeadlineAt === undefined
              ? {}
              : { executionDeadlineAt: admission.executionDeadlineAt }),
            settings: request.settings,
            inputFingerprint: estimatePlanRequest(request).fingerprint,
          },
        });
        let response;
        try {
          const requestTimeout =
            admission.executionDeadlineAt === undefined
              ? timeoutMs
              : admission.executionDeadlineAt - Date.now();
          if (requestTimeout <= 0)
            throw blocked(id, {
              reason: "REQUEST_DEADLINE_EXPIRED_BEFORE_DISPATCH",
              executionDeadlineAt: admission.executionDeadlineAt,
            });
          response = await model.generate(request, {
            signal: AbortSignal.any([requestOptions.signal, AbortSignal.timeout(requestTimeout)]),
          });
        } catch (error) {
          const knownUsage = {
            modelCalls: 1,
            steps: options.decisionSteps ?? 0,
            timeMs: Math.max(0, Date.now() - started),
          };
          if (
            error instanceof DevflowError &&
            typeof error.details === "object" &&
            error.details !== null &&
            "requestIssued" in error.details &&
            error.details.requestIssued === false
          ) {
            // The trusted provider adapter can reject locally before HTTP. The invocation
            // and elapsed time occurred, but no provider token/cost exposure remains.
            const actual = {
              ...knownUsage,
              tokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              costMicros: 0,
            };
            await this.scheduler.settle(id, actual, { costStatus: "PRICED" });
            await this.record({
              budgetScheduler: {
                operationId: id,
                action: "NOT_DISPATCHED",
                dispatchStatus: "NOT_ISSUED",
                requestIssued: false,
                reason: "TRUSTED_LOCAL_REJECTION",
                errorCode: error.code,
                actual,
                costStatus: "PRICED",
              },
            });
            throw error;
          }
          // A transport failure does not establish zero token/cost usage. Persisted ADMITTED remains held.
          await this.scheduler.markUncertain(
            id,
            knownUsage,
            "Provider invocation ended without confirmed usage.",
          );
          await this.record({
            budgetScheduler: { operationId: id, action: "UNCERTAIN", dispatchStatus: "UNKNOWN" },
          });
          if (error instanceof Error && error.name === "TimeoutError")
            throw new DevflowError({
              code: "TIMEOUT",
              message: "Model invocation timed out without confirmed provider usage.",
              details: {
                operationId: id,
                stage: options.stage,
                dispatchStatus: "UNKNOWN",
                providerUsageConfirmed: false,
                configuredTimeoutMs: timeoutMs,
                ...(admission.executionDeadlineAt === undefined
                  ? {}
                  : { executionDeadlineAt: admission.executionDeadlineAt }),
              },
            });
          throw error;
        }
        const actual = {
          tokens: response.usage.totalTokens,
          inputTokens: response.usage.inputTokens,
          // Providers include reasoning in completion usage; never add it twice.
          outputTokens: response.usage.outputTokens,
          modelCalls: 1,
          steps: options.decisionSteps ?? 0,
          timeMs: Math.max(0, Date.now() - started),
          costMicros: modelCost(
            options.price,
            response.usage.inputTokens,
            response.usage.outputTokens,
          ),
        };
        await this.scheduler.settle(id, actual, { costStatus: priced ? "PRICED" : "UNPRICED" });
        await this.record({
          budgetScheduler: {
            operationId: id,
            action: "SETTLE",
            dispatchStatus: "ISSUED",
            requestIssued: true,
            actual,
            costStatus: priced ? "PRICED" : "UNPRICED",
          },
        });
        return response;
      },
    };
  }

  sandbox(sandbox: SandboxSession): SandboxSession {
    const prior = this.wrappedSandboxes.get(sandbox);
    if (prior) return prior;
    const wrapped: SandboxSession = {
      id: sandbox.id,
      workspacePath: sandbox.workspacePath,
      exec: (input, signal) =>
        this.io(
          "sandbox.exec",
          {
            toolExecutions: 1,
            ioBytes: input.maxOutputBytes ?? 1024 * 1024,
            timeMs: input.timeoutMs ?? 30_000,
          },
          () => sandbox.exec(input, signal),
          (result) => ({
            ioBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
          }),
        ),
      listFiles: (input, signal) =>
        this.io("sandbox.listFiles", { toolExecutions: 1, ioReads: 1, timeMs: 30_000 }, () =>
          sandbox.listFiles(input, signal),
        ),
      readFile: (input, signal) =>
        this.io(
          "sandbox.readFile",
          { toolExecutions: 1, ioReads: 1, ioBytes: input.maxBytes ?? 512 * 1024, timeMs: 30_000 },
          () => sandbox.readFile(input, signal),
          (result) => ({ ioBytes: Buffer.byteLength(result.content) }),
        ),
      writeFile: (input, signal) =>
        this.io(
          "sandbox.writeFile",
          {
            toolExecutions: 1,
            ioWrites: 1,
            ioBytes: Buffer.byteLength(input.content),
            timeMs: 30_000,
          },
          () => sandbox.writeFile(input, signal),
        ),
      applyPatch: (input, signal) =>
        this.io(
          "sandbox.applyPatch",
          {
            toolExecutions: 1,
            ioWrites: 1,
            ioBytes: Buffer.byteLength(input.patch),
            timeMs: 30_000,
          },
          () => sandbox.applyPatch(input, signal),
        ),
      // Disposal is mandatory cleanup, including after deadline/cancellation. It cannot grant editing capacity.
      dispose: () => sandbox.dispose(),
    };
    this.wrappedSandboxes.set(sandbox, wrapped);
    return wrapped;
  }

  /** Immutable in-memory snapshots are explicitly exempt; network/index IO is observed once. */
  source(source: IndexSource, inMemory = false): IndexSource {
    if (inMemory || source.resourceIOOwner === "MEMORY" || source.resourceIOOwner === "SANDBOX")
      return source;
    const prior = this.wrappedSources.get(source);
    if (prior) return prior;
    const wrapped: IndexSource = {
      ...source,
      manifest: (signal) =>
        this.io("source.manifest", { toolExecutions: 1, ioReads: 1, timeMs: 30_000 }, () =>
          source.manifest(signal),
        ),
      read: (path, signal) =>
        this.io(
          "source.read",
          { toolExecutions: 1, ioReads: 1, ioBytes: 512 * 1024, timeMs: 30_000 },
          () => source.read(path, signal),
          (result) => ({ ioBytes: Buffer.byteLength(result.content) }),
        ),
      ...(source.lookup
        ? {
            lookup: (path: string, signal: AbortSignal) =>
              this.io("source.lookup", { toolExecutions: 1, ioReads: 1, timeMs: 30_000 }, () =>
                source.lookup!(path, signal),
              ),
          }
        : {}),
      ...(source.changes
        ? {
            changes: (signal: AbortSignal) =>
              this.io("source.changes", { toolExecutions: 1, ioReads: 1, timeMs: 30_000 }, () =>
                source.changes!(signal),
              ),
          }
        : {}),
    };
    this.wrappedSources.set(source, wrapped);
    return wrapped;
  }

  private async io<T>(
    label: string,
    estimated: Partial<ResourceVector>,
    run: () => Promise<T>,
    actual?: (value: T) => Partial<ResourceVector>,
  ): Promise<T> {
    await this.flush();
    const id = `${label}:${randomUUID()}`;
    await this.admit(id, operation(id, estimated));
    const started = Date.now();
    let value: T;
    try {
      value = await run();
    } catch (error) {
      // The operation was attempted; unknown bytes retain the conservative estimate.
      await this.scheduler.settle(id, { ...estimated, timeMs: Math.max(0, Date.now() - started) });
      throw error;
    }
    // A persistence error retains its original identity; never settle twice with a new duration.
    await this.scheduler.settle(id, {
      ...estimated,
      ...actual?.(value),
      timeMs: Math.max(0, Date.now() - started),
    });
    return value;
  }
}

export function operation(
  id: string,
  resources: Partial<ResourceVector>,
): ResourceBudgetOperationPlan & { kind: "OPERATION" } {
  return { kind: "OPERATION", id, requirement: "REQUIRED", state: "PENDING", resources };
}

/** Price each projected request using its own binding; preserve the execution-path algebra. */
export function priceModelOperationPlan(
  plan: ResourceBudgetOperationPlan,
  priceFor: (operationId: string) => ModelResourcePrice | undefined,
): ResourceBudgetOperationPlan {
  if (plan.kind === "EXCLUSIVE")
    return {
      ...plan,
      ...(plan.shared ? { shared: priceModelOperationPlan(plan.shared, priceFor) } : {}),
      branches: plan.branches.map((branch) => priceModelOperationPlan(branch, priceFor)),
    };
  if (plan.kind !== "OPERATION")
    return {
      ...plan,
      operations: plan.operations.map((op) => priceModelOperationPlan(op, priceFor)),
    };
  if (!(
    plan.resources.modelCalls ||
    plan.resources.tokens ||
    plan.resources.inputTokens ||
    plan.resources.outputTokens
  ))
    return plan;
  const price = priceFor(plan.id);
  // An aggregate with no input/output split cannot be priced as an all-input request.
  const splitKnown =
    plan.resources.inputTokens !== undefined && plan.resources.outputTokens !== undefined;
  return {
    ...plan,
    costStatus: price && splitKnown ? "PRICED" : "UNPRICED",
    resources: {
      ...plan.resources,
      costMicros:
        price && splitKnown
          ? modelCost(price, plan.resources.inputTokens!, plan.resources.outputTokens!)
          : 0,
    },
  };
}

function modelCost(price: ModelResourcePrice | undefined, input: number, output: number): number {
  return price
    ? Math.ceil(
        (input * price.inputMicrosPerMillionTokens + output * price.outputMicrosPerMillionTokens) /
          1_000_000,
      )
    : 0;
}

function blocked(operationId: string, diagnostics: unknown): DevflowError {
  return new DevflowError({
    code: "EXECUTION_BUDGET_EXCEEDED",
    message: "Resource Budget Scheduler denied the operation before dispatch.",
    details: { operationId, requestIssued: false, diagnostics: diagnostics as never },
  });
}
