import { createHash } from "node:crypto";
import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import {
  createConfiguredLanguageModel,
  type LanguageModelPort,
  type ModelResponse,
  type VercelAiModelParameters,
} from "@devflow/agent";
import {
  DevflowError,
  type RunMetrics,
  type TeamDecision,
  type TeamEvidence,
  type TeamSnapshot,
} from "@devflow/shared";
import type { WorkerEnvironment } from "../config/env.js";
import { resolveStageModel, type ModelStage } from "../config/stage-models.js";
import {
  exclusionReason,
  hash,
  isTestFile,
  type EvidenceItem,
  type EvidencePack,
  type IndexSource,
} from "../localization/contracts.js";
import { IssueLocalizer } from "../localization/retrieval.js";
import { RepositoryRelationGraph, relationGraphDigest } from "../localization/relation-graph.js";
import {
  ResourceBudgetRuntime,
  resourceBudgetContext,
  type ModelResourcePrice,
} from "../runs/resource-budget-runtime.js";
import {
  estimateOperationPlan,
  type ResourceBudgetLedger,
  type ResourceBudgetOperationPlan,
} from "../runs/resource-budget-scheduler.js";
import { localizationLease } from "../runs/localization-lease.js";
import { recordModelResponse, recordStageStep, recordToolWork } from "../runs/workflow-metrics.js";
import { TeamEngine, teamDigest, type TeamDecisionView } from "./engine.js";
import { teamBudgetStore } from "./budget-store.js";
import { projectTeamRequest } from "./context.js";

export async function investigateWithTeam(input: {
  database: DatabaseAdapter;
  run: RunExecutionRecord;
  environment: WorkerEnvironment;
  source: IndexSource;
  baseCommit: string;
  evidence: EvidencePack;
  signal: AbortSignal;
  metrics: RunMetrics;
  feedback?: NonNullable<TeamSnapshot["feedback"]>;
  parameters?: VercelAiModelParameters;
  modelFactory?: (
    run: RunExecutionRecord,
    parameters?: VercelAiModelParameters,
  ) => LanguageModelPort;
  /** Unbudgeted transport hook; the team operation owns the atomic Scheduler receipt. */
  roleModelFactory?: (stage: ModelStage) => LanguageModelPort;
}): Promise<EvidencePack> {
  const { database, run, environment, signal } = input;
  if (
    !environment.DEVFLOW_TEAM_ENABLED ||
    !database.teams ||
    !database.budgetLedgers ||
    !run.executionOwner
  )
    throw new DevflowError({
      code: "CONFLICT",
      message: "Team mode requires enabled, persistent, leased production execution.",
      details: { requestIssued: false },
    });
  const runtime = resourceBudgetContext.getStore();
  if (!runtime || !input.source.identity)
    throw new DevflowError({
      code: "CONFLICT",
      message: "Team requires an immutable view and the original Run scheduler.",
    });
  const store = database.teams,
    lease = { owner: run.executionOwner, dispatchRevision: run.dispatchRevision };
  const bindings = {
    COORDINATOR: resolveStageModel(
      run.executionMode === "single" ? "EXECUTE" : "COORDINATOR",
      environment,
      run,
    ),
    INVESTIGATOR: resolveStageModel("INVESTIGATOR", environment, run),
  };
  const frozenBindings = Object.fromEntries(
    ["COORDINATOR", "INVESTIGATOR", "PLANNER", "EXECUTE", "REVIEW"].map((stage) => [
      stage,
      resolveStageModel(stage as ModelStage, environment, run).provenance,
    ]),
  );
  const sourceIdentity = input.source.identity;
  const record = async (payload: Record<string, unknown>) => {
    await database.events.append(
      {
        runId: run.id,
        type: "WORKFLOW_CHECKPOINT",
        occurredAt: new Date().toISOString(),
        payload: JSON.parse(JSON.stringify({ ...payload, metrics: input.metrics })),
      },
      lease,
    );
  };
  const cache = new Map<string, Promise<Awaited<ReturnType<IndexSource["read"]>>>>();
  let listing: Promise<Awaited<ReturnType<IndexSource["manifest"]>>> | undefined;
  const source: IndexSource = {
    ...input.source,
    resourceIOOwner: "MEMORY",
    manifest: () => (listing ??= input.source.manifest(signal)),
    read: (path) => {
      if (exclusionReason(path))
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: `Read not allowed: ${path}`,
          details: { requestIssued: false },
        });
      const existing = cache.get(path);
      if (existing) return existing;
      const pending = (async () => {
        const entry = (await source.manifest(signal)).entries.find((e) => e.path === path);
        if (entry?.kind !== "FILE")
          throw new DevflowError({
            code: "INSUFFICIENT_EVIDENCE",
            message: `Path not verified as a regular file in the current public manifest (an incomplete manifest does not prove absence): ${path}`,
            details: { requestIssued: false },
          });
        const value = await input.source.read(path, signal);
        if (value.truncated || Buffer.byteLength(value.content) > 512 * 1024)
          throw new DevflowError({
            code: "INSUFFICIENT_EVIDENCE",
            message: `Complete source identity unavailable: ${path}`,
            details: { requestIssued: false },
          });
        return value;
      })();
      cache.set(path, pending);
      pending.catch(() => cache.delete(path));
      return pending;
    },
  };
  const graph = new RepositoryRelationGraph({
    repositoryId: run.repository.id,
    baseCommitSha: input.baseCommit,
    source,
    prg: run.localizationMode === "prg",
    ...(database.repositoryIndexes
      ? { factStore: runtime.indexStore(database.repositoryIndexes) }
      : {}),
  });
  let graphTail: Promise<unknown> = Promise.resolve();
  const graphWork = <T>(work: () => Promise<T>): Promise<T> => {
    const next = graphTail.then(work);
    graphTail = next.catch(() => undefined);
    return next;
  };
  const fact = (content: string, op: string, fields: Partial<TeamEvidence>): TeamEvidence => ({
    id: teamDigest({ content, sourceIdentity, ...fields }),
    runId: run.id,
    repositoryId: run.repository.id,
    sourceIdentity,
    kind: "SOURCE_OBSERVATION",
    content,
    contentSha256: teamDigest(content),
    sourceOperationId: op,
    supports: [],
    valid: true,
    ...fields,
  });
  const sourceFact = async (path: string, startLine: number, endLine: number, op: string) => {
    if (startLine < 1 || endLine < startLine || endLine - startLine >= 200)
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "READ requires 1 <= startLine <= endLine and at most 200 lines.",
        details: { requestIssued: false },
      });
    const value = await source.read(path, signal),
      lines = value.content.split(/\r?\n/u);
    if (startLine > lines.length)
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: `startLine exceeds ${lines.length} lines.`,
        details: { requestIssued: false },
      });
    const content = lines.slice(startLine - 1, endLine).join("\n");
    if (Buffer.byteLength(content) > 16384)
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "Requested lines exceed 16 KiB. Choose a smaller complete line range.",
        details: { requestIssued: false },
      });
    return fact(content, op, {
      path,
      fileSha256: hash(value.content),
      startLine,
      endLine: Math.min(endLine, lines.length),
    });
  };
  const seed: TeamEvidence[] = input.evidence.evidence.map((e) =>
    fact(e.snippet, "initial-public-retrieval", {
      path: e.path,
      fileSha256: e.contentHash,
      startLine: e.startLine,
      endLine: e.endLine,
    }),
  );
  const allPrices = environment.DEVFLOW_MODEL_PRICES_JSON
    ? (JSON.parse(environment.DEVFLOW_MODEL_PRICES_JSON) as Record<string, ModelResourcePrice>)
    : {};
  const prices = ["COORDINATOR", "INVESTIGATOR", "PLANNER", "EXECUTE", "REVIEW"].map((stage) => {
    const b = resolveStageModel(stage as ModelStage, environment, run);
    return allPrices[`${b.provenance.provider}:${b.provenance.model}`];
  });
  const rate = prices.every(Boolean)
    ? Math.max(
        ...prices.flatMap((p) => [p!.inputMicrosPerMillionTokens, p!.outputMicrosPerMillionTokens]),
      )
    : undefined;
  const downstreamId = "team:shared-downstream";
  const reserveDownstream = async (_view: TeamDecisionView) => {
    const allEvidence = (await store.load(run.id))!.evidence.filter((e) => e.valid);
    const budget = localizationLease({
      dynamic: true,
      remainingTokens: 0,
      title: run.task.title,
      description: run.task.description,
      evidence: allEvidence
        .filter((e) => e.kind === "SOURCE_OBSERVATION")
        .map((e) => ({ snippet: e.content })),
      outputs: {
        localization: bindings.INVESTIGATOR.settings.maxOutputTokens ?? 4096,
        planner: resolveStageModel("PLANNER", environment, run).settings.maxOutputTokens ?? 8192,
        execute: resolveStageModel("EXECUTE", environment, run).settings.maxOutputTokens ?? 8192,
        repair: 8192,
        review: resolveStageModel("REVIEW", environment, run).settings.maxOutputTokens ?? 16384,
      },
      deadlines: {
        planner: environment.DEVFLOW_PLAN_AGENT_TIMEOUT_MS ?? 120000,
        coding: 60000,
        validation: 300000,
        review: environment.DEVFLOW_REVIEW_REQUEST_TIMEOUT_MS,
        recovery: environment.DEVFLOW_REVIEW_RECOVERY_TIMEOUT_MS,
        finalize: environment.DEVFLOW_FINALIZE_TIMEOUT_MS,
      },
    });
    const resources = estimateOperationPlan(budget.downstreamOperationPlan).resources;
    const plan: ResourceBudgetOperationPlan = {
      kind: "OPERATION",
      id: downstreamId,
      requirement: "REQUIRED",
      state: "PENDING",
      resources: {
        ...resources,
        ...(rate === undefined
          ? {}
          : { costMicros: Math.ceil((resources.tokens * rate) / 1_000_000) }),
      },
      costStatus: rate === undefined ? "UNPRICED" : "PRICED",
    };
    const reserved = await runtime.scheduler.replaceHold(downstreamId, plan);
    if (!reserved.reserved)
      throw new DevflowError({
        code: "MAX_STEPS_EXCEEDED",
        message: "Run cannot fund investigation and required downstream work.",
        details: { requestIssued: false, quote: reserved.quote },
      });
  };
  const engine = new TeamEngine({
    store,
    lease,
    signal,
    parallelInvestigators: (group, execute) => runtime.scheduler.parallelDispatch(group, execute),
    beforeDecision: reserveDownstream,
    decide: async (view, operation) => {
      const role = view.role === "INVESTIGATOR" ? "INVESTIGATOR" : "COORDINATOR",
        binding = bindings[role];
      const raw =
        input.roleModelFactory?.(view.role === "SOLVER" ? "EXECUTE" : role) ??
        input.modelFactory?.(run, input.parameters) ??
        createConfiguredLanguageModel({
          ...binding.config,
          ...(input.parameters ? { parameters: input.parameters } : {}),
        });
      let received: ModelResponse | undefined;
      const observed: LanguageModelPort = {
        ...(raw.prepareRequest ? { prepareRequest: raw.prepareRequest.bind(raw) } : {}),
        generate: async (req, options) => {
          await database.events.append(
            {
              runId: run.id,
              type: "LLM_REQUEST",
              occurredAt: new Date().toISOString(),
              payload: {
                purpose: role,
                operationId: operation.id,
                agentId: view.agentId,
                inputFingerprint: req.inputProjection?.fingerprint ?? teamDigest(req.messages),
              },
            },
            lease,
          );
          received = await raw.generate(req, options);
          return received;
        },
      };
      const scheduler = runtime.scheduler.withStore(
        teamBudgetStore({
          runId: run.id,
          base: database.budgetLedgers!,
          team: store,
          lease,
          receipt: (s, value) => {
            const reservation = (value as ResourceBudgetLedger).reservations[operation.id];
            const op = s.operations.find((o) => o.id === operation.id)!;
            if (reservation?.status === "SETTLED" && received) {
              op.status = "COMPLETED";
              op.output = decisionOf(received);
            }
          },
        }),
      );
      const scoped = new ResourceBudgetRuntime(scheduler, record);
      const model = scoped.model(observed, {
        stage: role,
        operationId: operation.id,
        decisionSteps: 1,
        outputTokens: binding.settings.maxOutputTokens ?? 8192,
        timeoutMs: environment.DEVFLOW_PLAN_AGENT_TIMEOUT_MS ?? 120000,
        ...(allPrices[`${binding.provenance.provider}:${binding.provenance.model}`]
          ? { price: allPrices[`${binding.provenance.provider}:${binding.provenance.model}`]! }
          : {}),
      });
      const configured: LanguageModelPort = {
        prepareRequest: async (req, options) =>
          raw.prepareRequest
            ? raw.prepareRequest(
                { ...req, settings: { ...binding.settings, ...req.settings } },
                options,
              )
            : { ...req, settings: { ...binding.settings, ...req.settings } },
        generate: model.generate.bind(model),
      };
      const projection = await projectTeamRequest(view, configured, signal, {
        bytes: binding.contextTokens * 3,
        tokens: binding.contextTokens,
        outputTokens: binding.settings.maxOutputTokens ?? 8192,
      });
      // Persist exactly what the prepared Provider request contains before dispatch.
      for (let attempt = 0; attempt < 16; attempt++) {
        const snapshot = (await store.load(run.id))!,
          revision = snapshot.revision;
        snapshot.operations.find((o) => o.id === operation.id)!.visibleEvidenceIds =
          projection.shown.map((e) => e.id);
        snapshot.revision++;
        if (await store.compareAndSwap(run.id, revision, snapshot, lease)) break;
        if (attempt === 15)
          throw new DevflowError({
            code: "CONFLICT",
            message: "Cannot persist team request projection.",
            details: { requestIssued: false },
          });
      }
      const content = JSON.stringify({
        operationId: operation.id,
        agentId: view.agentId,
        projection,
        modelBinding: binding.provenance,
      });
      await database.artifacts.create({
        runId: run.id,
        kind: "OTHER",
        name: `team-request-${createHash("sha256").update(operation.id).digest("hex")}.json`,
        content,
        mimeType: "application/json",
        sha256: hash(content),
        sizeBytes: Buffer.byteLength(content),
        metadata: { visibility: "HOST_ONLY" },
      });
      await record({
        team: {
          action: "DECISION_REQUEST",
          operationId: operation.id,
          agentId: view.agentId,
          role,
          shown: projection.shown,
          omitted: projection.omitted,
        },
      });
      const response = await model.generate(projection.request, { signal });
      recordModelResponse(input.metrics, "PLAN", response);
      recordStageStep(input.metrics, "PLAN", 1, true);
      await database.events.append(
        {
          runId: run.id,
          type: "LLM_RESPONSE",
          occurredAt: new Date().toISOString(),
          payload: JSON.parse(
            JSON.stringify({
              purpose: role,
              operationId: operation.id,
              agentId: view.agentId,
              usage: response.usage,
              latencyMs: response.latencyMs,
              finishReason: response.finishReason,
            }),
          ),
        },
        lease,
      );
      return decisionOf(response) as TeamDecision;
    },
    observe: async (action, op) => {
      const receipt: { observations?: TeamEvidence[] } = {};
      const scheduler = runtime.scheduler.withStore(
        teamBudgetStore({
          runId: run.id,
          base: database.budgetLedgers!,
          team: store,
          lease,
          receipt: (s, value) => {
            if (
              (value as ResourceBudgetLedger).reservations[op.id]?.status !== "SETTLED" ||
              !receipt.observations
            )
              return;
            const current = s.operations.find((o) => o.id === op.id)!;
            const agent = s.agents.find((a) => a.id === op.agentId)!;
            for (const e of receipt.observations) {
              if (
                e.runId !== run.id ||
                e.sourceIdentity !== s.sourceIdentity ||
                e.contentSha256 !== teamDigest(e.content)
              )
                throw new DevflowError({
                  code: "CONFLICT",
                  message: "Invalid observation receipt",
                });
              if (!s.evidence.some((row) => row.id === e.id)) s.evidence.push(e);
              agent.acquiredEvidenceIds ??= [];
              if (!agent.acquiredEvidenceIds.includes(e.id)) agent.acquiredEvidenceIds.push(e.id);
            }
            current.status = "COMPLETED";
            current.output = receipt.observations.map((e) => e.id);
          },
        }),
      );
      const reservation = await scheduler.reserve(op.id, {
        kind: "OPERATION",
        id: op.id,
        requirement: "REQUIRED",
        state: "PENDING",
        resources: { logicalToolCalls: 1 },
      });
      if (!reservation.reserved || !(await scheduler.admit(op.id)).admitted)
        throw new DevflowError({
          code: "MAX_STEPS_EXCEEDED",
          message: "Team tool admission denied",
          details: { requestIssued: false, quote: reservation.quote },
        });
      const perform = async (): Promise<TeamEvidence[]> => {
        try {
          if (action.type === "READ")
            return [await sourceFact(action.path, action.startLine, action.endLine, op.id)];
          if (action.type === "SEARCH") {
            const pack = await new IssueLocalizer(
              database.repositoryIndexes
                ? runtime.indexStore(database.repositoryIndexes)
                : undefined,
            ).retrieve({
              repositoryId: run.repository.id,
              accessScope: run.repository.id,
              baseCommitSha: input.baseCommit,
              runId: run.id,
              workspaceRevision: 0,
              description: action.query,
              source,
              signal,
              tokenBudget: 6000,
            });
            const result: TeamEvidence[] = [];
            for (const e of pack.evidence)
              result.push(
                await sourceFact(
                  e.path,
                  e.startLine,
                  Math.min(e.endLine, e.startLine + 199),
                  op.id,
                ),
              );
            return result;
          }
          return graphWork(async () => {
            if (action.paths.some((p) => exclusionReason(p)))
              throw new DevflowError({
                code: "VALIDATION_ERROR",
                message: "Relation paths must refer to permitted public files.",
                details: { requestIssued: false },
              });
            await runtime.internal(
              "team:relation-expansion",
              { toolExecutions: 1, timeMs: 20000 },
              () => graph.inspect(action.paths, signal),
            );
            const view = graph.issueView(action.paths, [], 12000, action.symbols);
            if (!view.files.length && !view.relations.length) return [];
            return [
              fact(
                JSON.stringify({
                  files: view.files,
                  relations: view.relations,
                  incomplete: view.incomplete,
                  limitations: view.limitations,
                }),
                op.id,
                { kind: "RELATION_OBSERVATION" },
              ),
            ];
          });
        } catch (error) {
          if (
            error instanceof DevflowError &&
            ["VALIDATION_ERROR", "INSUFFICIENT_EVIDENCE"].includes(error.code)
          )
            return [
              fact(JSON.stringify({ code: error.code, message: error.message, action }), op.id, {
                kind: "TOOL_ERROR",
              }),
            ];
          throw error;
        }
      };
      receipt.observations = await perform();
      await scheduler.settle(op.id, { logicalToolCalls: 1 });
      recordToolWork(input.metrics, "PLAN", { calls: 1, executions: 0, alreadyAccounted: true });
      return receipt.observations;
    },
    onChange: async (s) =>
      record({
        team: {
          action: "CHECKPOINT",
          revision: s.revision,
          status: s.status,
          taskCount: s.tasks.length,
          messageCount: s.messages.length,
          decisions: s.agents.reduce((n, a) => n + a.decisionCount, 0),
        },
      }),
  });
  if (input.feedback) await engine.reopen(run.id, sourceIdentity, seed, input.feedback);
  await engine.initialize({
    runId: run.id,
    repositoryId: run.repository.id,
    sourceIdentity,
    mode: run.executionMode === "single" ? "single" : "team",
    ...(run.teamConfiguration ? { config: run.teamConfiguration } : {}),
    evidence: seed,
    modelBindings: frozenBindings,
  });
  const saved = await store.load(run.id);
  const ledger = await runtime.scheduler.snapshot();
  const used = saved!.agents.reduce((n, a) => n + a.decisionCount, 0);
  const state = await engine.run(
    run.id,
    { title: run.task.title, description: run.task.description },
    used + Math.max(0, (ledger.limits.steps ?? run.maxSteps) - ledger.consumed.steps),
  );
  const history = JSON.stringify(state);
  await database.artifacts.create({
    runId: run.id,
    kind: "OTHER",
    name: "team-history-v1.json",
    mimeType: "application/json",
    content: history,
    sha256: hash(history),
    sizeBytes: Buffer.byteLength(history),
    metadata: { visibility: "HOST_ONLY", teamRevision: state.revision },
  });
  const graphSnapshot = graph.snapshot();
  const graphContent = JSON.stringify(graphSnapshot);
  await database.artifacts.create({
    runId: run.id,
    kind: "OTHER",
    name: input.feedback
      ? "repository-relations-team-overlay-v1.json"
      : "repository-relations-plan-v1.json",
    mimeType: "application/json",
    content: graphContent,
    sha256: hash(graphContent),
    sizeBytes: Buffer.byteLength(graphContent),
    metadata: {
      visibility: "HOST_ONLY",
      version: graphSnapshot.version,
      graphSha256: relationGraphDigest(graphSnapshot),
    },
  });
  await runtime.scheduler
    .release(
      downstreamId,
      "Team investigation ended; downstream dispatch will be individually admitted",
    )
    .catch(async (error) => {
      if ((await runtime.scheduler.snapshot()).reservations[downstreamId]) throw error;
    });
  if (state.status !== "READY_FOR_PLAN")
    throw new DevflowError({
      code: state.stopReason === "STALLED" ? "AGENT_STALLED" : "INSUFFICIENT_EVIDENCE",
      message: `Collaboration ended: ${state.stopReason ?? state.status}`,
      details: { missing: state.missing, requestIssued: false, teamRevision: state.revision },
    });
  const selected = state.evidence.filter(
    (e) => e.valid && state.selectedEvidenceIds.includes(e.id),
  );
  const sources = selected.filter(
    (e) => e.kind === "SOURCE_OBSERVATION" && e.path && e.fileSha256 && e.startLine && e.endLine,
  );
  const evidence: EvidenceItem[] = sources.map((e) => ({
    repositoryId: run.repository.id,
    baseCommitSha: input.baseCommit,
    viewRevision: input.evidence.viewRevision,
    path: e.path!,
    contentHash: e.fileSha256!,
    startLine: e.startLine!,
    endLine: e.endLine!,
    symbol: null,
    reason: "Team-selected public observation; cause remains a hypothesis",
    retrievalSource: ["TEAM", e.sourceOperationId],
    score: 1,
    snippet: e.content,
    language: e.path!.split(".").at(-1) ?? "unknown",
    module: e.path!.split("/").slice(0, -1).join("/"),
    fileType: isTestFile(e.path!) ? "TEST" : "SOURCE",
    parseStatus: "LEXICAL",
    signature: null,
    directImports: [],
    truncated: true,
  }));
  return {
    ...input.evidence,
    evidence: evidence.length ? evidence : input.evidence.evidence,
    missingInformation: [
      ...input.evidence.missingInformation,
      ...state.missing,
      ...state.tasks
        .filter((t) => t.sourceIdentity === state.sourceIdentity)
        .flatMap((t) => t.result?.hypotheses ?? [])
        .map((h) => `Unverified team hypothesis to assess: ${h}`),
    ],
  };
}

function decisionOf(response: ModelResponse): unknown {
  if (response.finishReason !== "STOP")
    return { incomplete: true, finishReason: response.finishReason };
  if (response.output !== undefined) return response.output;
  try {
    return JSON.parse(response.text ?? "");
  } catch {
    return { invalidOutput: response.text ?? "" };
  }
}
