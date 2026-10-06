import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import { ReviewProbeRequestSchema, type ReviewResult } from "@devflow/shared";
import type {
  ReadonlyProbeRunner,
  ReadonlyProbeExecution,
  ReadonlyProbeInput,
} from "@devflow/sandbox";
import type { IndexSource } from "../localization/contracts.js";
import { graphPathAllowed } from "../localization/relation-graph.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export type ProbeRequest = z.infer<typeof ReviewProbeRequestSchema>;
const requestIdentity = (r: ProbeRequest) =>
  hash(
    JSON.stringify([
      r.findingId,
      r.publicEntrypoint,
      r.language,
      r.code,
      r.expectedObservation,
      r.taskBasis,
      r.probeId ?? null,
    ]),
  );
export interface ProbeObservation extends ReadonlyProbeExecution {
  probeId: string;
  findingId: string;
  view: "BASELINE" | "CURRENT";
  revision: string;
  scriptSha256: string;
  dependencyIdentity: string;
  sourceHashes: Record<string, string>;
  cacheKey: string;
  cached?: boolean;
  logProjectionTruncated?: boolean;
  expectedObservation: string;
  taskBasis: string;
}
export const ReviewProbeFeedbackSchema = z.object({
  probeId: z.string(),
  findingId: z.string(),
  requestHash: z.string(),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type ReviewProbeFeedback = z.infer<typeof ReviewProbeFeedbackSchema>;
export const ReviewProbeStateSchema = z.object({
  version: z.literal(1),
  requests: z.array(ReviewProbeRequestSchema).max(2),
  executions: z.number().int().min(0).max(6),
  correctionsUsed: z.number().int().min(0).max(1).default(0),
  requestVersions: z.array(ReviewProbeRequestSchema).max(3).default([]),
  aliases: z
    .array(
      z.object({
        clientLabel: z.string().min(1),
        probeId: z.string().min(1),
        findingId: z.string().min(1),
      }),
    )
    .max(2)
    .default([]),
  failures: z.array(ReviewProbeFeedbackSchema).max(24).default([]),
  observations: z
    .array(
      z.object({
        status: z.enum(["COMPLETED", "TIMEOUT", "DEPENDENCY_MISSING", "UNAVAILABLE"]),
        exitCode: z.number().int().nullable(),
        stdout: z.string().max(32 * 1024),
        stderr: z.string().max(32 * 1024),
        outputTruncated: z.boolean(),
        durationMs: z.number().nonnegative(),
        behaviorOutcome: z
          .enum(["EXPECTATION_MET", "EXPECTATION_FAILED", "SCRIPT_ERROR", "NO_ASSERTION"])
          .optional(),
        assertions: z
          .array(
            z.object({
              ok: z.boolean(),
              expected: z.string().max(2000),
              actual: z.string().max(2000),
            }),
          )
          .max(4)
          .optional(),
        probeId: z.string().min(1),
        findingId: z.string().min(1),
        view: z.enum(["BASELINE", "CURRENT"]),
        revision: z.string().min(1),
        scriptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        dependencyIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
        cacheKey: z.string().regex(/^[a-f0-9]{64}$/u),
        expectedObservation: z.string().min(1),
        taskBasis: z.string().min(1),
      }),
    )
    .max(6),
});
export type ReviewProbeState = z.infer<typeof ReviewProbeStateSchema>;
export function projectReviewProbes(
  observations: readonly ProbeObservation[],
  paths: readonly string[],
): ProbeObservation[] {
  const allowed = new Set(paths);
  return observations.map((o) => ({
    ...o,
    sourceHashes: Object.fromEntries(
      Object.entries(o.sourceHashes).filter(([path]) => allowed.has(path)),
    ),
    stdout: o.stdout.slice(0, 4000),
    stderr: o.stderr.slice(0, 4000),
    logProjectionTruncated: o.stdout.length > 4000 || o.stderr.length > 4000,
  }));
}
export function emptyReviewProbeState(): ReviewProbeState {
  return ReviewProbeStateSchema.parse({
    version: 1,
    requests: [],
    executions: 0,
    observations: [],
  });
}

function probeFailure(error: unknown) {
  const message = String(error).slice(0, 2000);
  const code = /BUDGET|LIMIT|oversized|too large/u.test(message)
    ? "BUDGET_INSUFFICIENT"
    : /POLICY|Non-public/u.test(message)
      ? "POLICY_REJECTED"
      : /entrypoint|regular file/u.test(message)
        ? "ENTRYPOINT_NOT_FOUND"
        : /DEPENDENCY|import|module/u.test(message)
          ? "IMPORT_ERROR"
          : "SOURCE_UNAVAILABLE";
  return {
    code,
    message,
    retryable: [
      "POLICY_REJECTED",
      "ENTRYPOINT_NOT_FOUND",
      "IMPORT_ERROR",
      "SOURCE_UNAVAILABLE",
    ].includes(code),
  };
}

export async function preparePublicProbe(
  source: IndexSource,
  request: ProbeRequest,
  signal: AbortSignal,
  beforeRead: () => void = () => undefined,
): Promise<{ input: ReadonlyProbeInput; sourceHashes: Record<string, string> }> {
  if (Buffer.byteLength(request.code) > 16 * 1024 || !graphPathAllowed(request.publicEntrypoint))
    throw new Error("PROBE_POLICY_REJECTED: script size or non-public entrypoint");
  beforeRead();
  const manifest = await source.manifest(signal);
  const files = new Set(
    manifest.entries
      .filter((e) => e.kind === "FILE" && graphPathAllowed(e.path))
      .map((e) => e.path),
  );
  if (!files.has(request.publicEntrypoint))
    throw new Error("PROBE_SOURCE_UNAVAILABLE: public entrypoint not a regular file");
  const modules: Record<string, string> = {},
    sourceHashes: Record<string, string> = {};
  const pending = [request.publicEntrypoint];
  let bytes = 0;
  const compile = (name: string, code: string) =>
    name.endsWith(".json")
      ? code
      : ts.transpileModule(code, {
          fileName: name,
          reportDiagnostics: true,
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
        }).outputText;
  modules["__review_probe__.ts"] = compile("__review_probe__.ts", request.code);
  const enqueue = (name: string, compiled: string) => {
    for (const match of compiled.matchAll(/\brequire\(["']([^"']+)["']\)/gu)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const root = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      if (!graphPathAllowed(root)) throw new Error("PROBE_POLICY_REJECTED: non-public import");
      const stem = root.replace(/\.(?:[cm]?js|[cm]?ts)$/u, "");
      const resolved = [
        root,
        stem + ".ts",
        stem + ".js",
        stem + ".cts",
        stem + ".cjs",
        root + "/index.ts",
        root + "/index.js",
      ].find((p) => files.has(p));
      if (!resolved) throw new Error(`DEPENDENCY_MISSING: ${root}`);
      if (!Object.hasOwn(modules, resolved)) pending.push(resolved);
    }
  };
  enqueue("__review_probe__.ts", modules["__review_probe__.ts"]);
  while (pending.length) {
    signal.throwIfAborted();
    const name = pending.shift()!;
    if (Object.hasOwn(modules, name)) continue;
    if (Object.keys(sourceHashes).length >= 256)
      throw new Error("PROBE_SOURCE_BUDGET: more than 256 modules");
    beforeRead();
    const read = await source.read(name, signal);
    bytes += Buffer.byteLength(read.content);
    if (read.truncated || bytes > 16 * 1024 * 1024)
      throw new Error("PROBE_SOURCE_BUDGET: incomplete or oversized source");
    sourceHashes[name] = hash(read.content);
    modules[name] = compile(name, read.content);
    enqueue(name, modules[name]);
  }
  if (Buffer.byteLength(JSON.stringify(modules)) > 24 * 1024 * 1024)
    throw new Error("PROBE_SOURCE_BUDGET: compiled input too large");
  return {
    input: { entrypoint: request.publicEntrypoint, script: request.code, modules },
    sourceHashes,
  };
}

export async function collectReviewProbes(input: {
  requests: ProbeRequest[];
  findings: ReviewResult["findings"];
  state: ReviewProbeState;
  baseline: IndexSource;
  current: IndexSource;
  baseRevision: string;
  currentRevision: string;
  runner: ReadonlyProbeRunner;
  image: string;
  signal: AbortSignal;
  save: (state: ReviewProbeState) => Promise<void>;
  beforeWork: (kind: "READ" | "EXECUTE" | "IMAGE", reserveTimeMs: number) => void;
  prepare?: (
    view: "BASELINE" | "CURRENT",
    request: ProbeRequest,
  ) => ReturnType<typeof preparePublicProbe>;
}): Promise<{
  observations: ProbeObservation[];
  unresolved: string[];
  feedback: ReviewProbeFeedback[];
  progress: boolean;
}> {
  const observations: ProbeObservation[] = [],
    unresolved: string[] = [],
    feedback: ReviewProbeFeedback[] = [];
  let progress = false;
  const report = async (
    request: ProbeRequest,
    probeId: string,
    error: ReturnType<typeof probeFailure>,
  ) => {
    const row = {
      ...error,
      probeId,
      findingId: request.findingId,
      requestHash: requestIdentity(request),
    };
    if (
      !feedback.some(
        (f) => f.probeId === probeId && f.requestHash === row.requestHash && f.code === row.code,
      )
    ) {
      feedback.push(row);
      unresolved.push(`${probeId}: ${row.code}: ${row.message}`);
    }
    if (
      !input.state.failures.some(
        (f) => f.probeId === probeId && f.requestHash === row.requestHash && f.code === row.code,
      )
    ) {
      if (input.state.failures.length < 24) input.state.failures.push(row);
      progress ||= row.retryable;
      await input.save(input.state);
    }
  };
  let dependencyIdentity: string;
  try {
    input.beforeWork("IMAGE", 0);
    dependencyIdentity = await input.runner.imageIdentity(input.image, input.signal);
  } catch (error) {
    if (input.signal.aborted) throw error;
    for (const request of input.requests)
      await report(request, request.probeId ?? "unprepared", {
        code: "IMAGE_UNAVAILABLE",
        message: String(error).slice(0, 2000),
        retryable: false,
      });
    return { observations, unresolved, feedback, progress };
  }
  const requested = [...input.requests];
  // Repair invalidates CURRENT observations; reuse the public script and immutable base.
  for (const prior of input.state.requests)
    if (
      input.findings.some(
        (f) =>
          f.findingId === prior.findingId &&
          f.disposition !== "RESOLVED" &&
          f.disposition !== "CONTRADICTED" &&
          f.disposition !== "DEFERRED",
      ) &&
      !requested.some((r) => r.probeId === prior.probeId || r.findingId === prior.findingId)
    )
      requested.push(prior);
  for (const request of requested.slice(0, 2)) {
    if (!input.findings.some((f) => f.findingId === request.findingId)) {
      unresolved.push("UNKNOWN_FINDING_ID");
      continue;
    }
    const sameFinding = input.state.requests.filter((r) => r.findingId === request.findingId);
    const alias = input.state.aliases.find((a) => a.clientLabel === request.probeId);
    const resolvedId = alias?.probeId ?? request.probeId;
    const prior = resolvedId
      ? input.state.requests.find((r) => r.probeId === resolvedId)
      : sameFinding.length === 1
        ? sameFinding[0]
        : undefined;
    if (
      request.probeId &&
      ((alias && alias.findingId !== request.findingId) ||
        (prior && prior.findingId !== request.findingId) ||
        (!prior && (sameFinding.length > 0 || /^probe-[a-f0-9]{16}$/u.test(request.probeId))))
    ) {
      await report(request, request.probeId, {
        code: "UNKNOWN_PROBE_ID",
        message:
          "Corrections must use the same finding's host probe ID or registered client alias; unknown old IDs cannot open a new request",
        retryable: false,
      });
      continue;
    }
    const probeId =
      prior?.probeId ?? "probe-" + requestIdentity({ ...request, probeId: undefined }).slice(0, 16);
    const normalized = { ...request, probeId };
    const requestHash = requestIdentity(normalized);
    if (prior && requestIdentity({ ...prior, probeId }) !== requestHash) {
      const priorHash = requestIdentity({ ...prior, probeId });
      if (
        input.state.correctionsUsed >= 1 ||
        !input.state.failures.some(
          (f) => f.probeId === probeId && f.requestHash === priorHash && f.retryable,
        )
      ) {
        await report(normalized, probeId, {
          code: "PROBE_CORRECTION_LIMIT",
          message:
            "One correction of a failed request is allowed; successful probes cannot be rewritten",
          retryable: false,
        });
        continue;
      }
      input.state.correctionsUsed++;
      input.state.requestVersions.push({ ...prior, probeId });
      input.state.requests[input.state.requests.indexOf(prior)] = normalized;
      await input.save(input.state);
    } else if (!prior) {
      if (input.state.requests.length >= 2) {
        await report(normalized, probeId, {
          code: "PROBE_REQUEST_LIMIT",
          message: "Two logical probes are already reserved",
          retryable: false,
        });
        continue;
      }
      input.state.requests.push(normalized);
      if (request.probeId)
        input.state.aliases.push({
          clientLabel: request.probeId,
          probeId,
          findingId: request.findingId,
        });
      await input.save(input.state);
    } else if (!prior.probeId) {
      input.state.requests[input.state.requests.indexOf(prior)] = normalized;
      await input.save(input.state);
    }
    for (const view of ["BASELINE", "CURRENT"] as const) {
      try {
        const revision = view === "BASELINE" ? input.baseRevision : input.currentRevision;
        const prepared = input.prepare
          ? await input.prepare(view, request)
          : await preparePublicProbe(
              view === "BASELINE" ? input.baseline : input.current,
              request,
              input.signal,
              () => input.beforeWork("READ", 0),
            );
        const scriptSha256 = hash(request.code);
        const cacheKey = hash(
          JSON.stringify([
            dependencyIdentity,
            ts.version,
            requestHash,
            Object.entries(prepared.sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
          ]),
        );
        const cached = input.state.observations.find(
          (o) =>
            o.cacheKey === cacheKey &&
            o.status === "COMPLETED" &&
            !o.outputTruncated &&
            ["EXPECTATION_MET", "EXPECTATION_FAILED"].includes(o.behaviorOutcome ?? ""),
        );
        if (cached) {
          observations.push({
            ...cached,
            findingId: request.findingId,
            view,
            revision,
            cached: true,
          });
          continue;
        }
        if (input.state.executions >= 6) {
          unresolved.push(`${probeId}/${view}: PROBE_EXECUTION_LIMIT`);
          continue;
        }
        input.beforeWork("EXECUTE", 30_000);
        // Reserve before dispatch. Cancellation/restart cannot reset an uncertain execution.
        input.state.executions++;
        await input.save(input.state);
        const execution = await input.runner.run(prepared.input, dependencyIdentity, input.signal);
        const observation: ProbeObservation = {
          ...execution,
          probeId,
          findingId: request.findingId,
          view,
          revision,
          scriptSha256,
          dependencyIdentity,
          sourceHashes: prepared.sourceHashes,
          cacheKey,
          expectedObservation: request.expectedObservation,
          taskBasis: request.taskBasis,
        };
        input.state.observations.push(observation);
        await input.save(input.state);
        observations.push(observation);
        if (
          execution.status !== "COMPLETED" ||
          execution.outputTruncated ||
          !["EXPECTATION_MET", "EXPECTATION_FAILED"].includes(execution.behaviorOutcome ?? "")
        ) {
          const code = execution.outputTruncated
            ? "OUTPUT_TRUNCATED"
            : execution.status !== "COMPLETED"
              ? execution.status
              : (execution.behaviorOutcome ?? "NO_ASSERTION");
          await report(normalized, probeId, {
            code,
            message: `${view}: ${execution.stderr || code}`.slice(0, 2000),
            retryable: code !== "UNAVAILABLE",
          });
        } else progress = true;
      } catch (error) {
        if (input.signal.aborted) throw error;
        await report(normalized, probeId, probeFailure(error));
      }
    }
  }
  return { observations, unresolved, feedback, progress };
}
