import { DevflowError } from "@devflow/shared";
import { inputHash, preparedInput, serializeModelRequest } from "./model-budget.js";
import { projectCodingSessionHistory } from "./coding-session.js";
import { invalidateHistoricalReads } from "./working-set.js";
import type { ModelMessage, ModelRequest } from "./model.js";

type JsonBlock = { start: number; end: number; value: unknown };
const identity = (value: unknown) => inputHash(JSON.stringify(value));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Parse complete JSON records embedded in host text. Never slice a source string or JSON value. */
function blocks(text: string): JsonBlock[] {
  const result: JsonBlock[] = [];
  for (let start = 0; start < text.length; start++) {
    if (!["{", "["].includes(text[start]!) || (start > 0 && text[start - 1] !== "\n")) continue;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      if (!quoted && depth === 0) {
        try {
          result.push({ start, end: end + 1, value: JSON.parse(text.slice(start, end + 1)) });
        } catch {
          /* not a JSON record */
        }
        start = end;
        break;
      }
    }
  }
  return result;
}
function children(value: unknown): [string, unknown][] {
  return value !== null && typeof value === "object" ? Object.entries(value) : [];
}
export interface ContextProjectionArtifact {
  version: "context-projection-v1";
  historySha256: string;
  viewSha256: string;
  inputFingerprint: string;
  beforeBytes: number;
  afterBytes: number;
  estimatedInputTokens: number;
  wireBytes: number;
  omitted: { record: string; reason: string }[];
  references: { sha256: string; record: string; pointer: string }[];
  records: { id: string; tier: "P0" | "P1" | "P2"; viewIndex: number | null }[];
  evidence: { version: "repair-evidence-v1"; sections: Record<string, string> };
  evidenceSha256: string;
}

/** Immutable history/evidence stays outside request selection; this store never authorizes edits. */
export class ContextEvidenceStore {
  readonly sections: Record<string, string> = {};
  constructor(readonly history: readonly ModelMessage[]) {
    history.forEach((message, index) => this.record(message, index));
  }
  record(message: ModelMessage, index: number): string {
    const id = identity({ message, index });
    this.sections[`record:${id}`] = JSON.stringify(message, null, 2);
    return id;
  }
  atom(value: unknown) {
    const id = identity(value);
    this.sections[`atom:${id}`] =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return id;
  }
}

export function recoverContextAtom(
  evidence: ContextProjectionArtifact["evidence"],
  sha256: string,
): unknown {
  const stored = evidence.sections[`atom:${sha256}`];
  if (stored !== undefined) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (identity(parsed) === sha256) return parsed;
    } catch {
      /* a raw text atom */
    }
    if (identity(stored) === sha256) return stored;
  }
  throw new DevflowError({
    code: "CONFLICT",
    message: "Context evidence reference is missing or changed.",
  });
}

/** Exact duplicate interning plus whole-record selection. No LLM compression, source truncation or authority changes. */
export async function optimizeContextProjection(input: {
  request: ModelRequest;
  history?: readonly ModelMessage[];
  maxBytes: number;
  maxInputTokens?: number;
  priorityPaths?: readonly string[];
  prepare?(request: ModelRequest): Promise<ModelRequest>;
  onCapacityFailure?(artifact: ContextProjectionArtifact): Promise<void>;
}): Promise<{ request: ModelRequest; artifact: ContextProjectionArtifact }> {
  const store = new ContextEvidenceStore(structuredClone(input.history ?? input.request.messages));
  const requestBase = { ...input.request };
  delete requestBase.inputProjection;
  const source = invalidateHistoricalReads(projectCodingSessionHistory(input.request.messages));
  const latestPlan = source.findLastIndex(
    (m) => m.role === "USER" && m.content.startsWith("Approved plan (follow this plan):"),
  );
  const rows = source.map((message, index) => {
    const text = typeof message.content === "string" ? message.content : undefined;
    return {
      message,
      index,
      id: store.record(message, index),
      blocks: text ? blocks(text) : [],
      tier: (message.role === "SYSTEM" ||
      message.role === "USER" ||
      (message.role === "TOOL" && message.isError)
        ? "P0"
        : (message.role === "TOOL" &&
              !(
                message.content &&
                typeof message.content === "object" &&
                (message.content as { stale?: boolean }).stale
              )) ||
            /refut|contradict|counterevidence|反证/iu.test(JSON.stringify(message))
          ? "P1"
          : "P2") as "P0" | "P1" | "P2",
    };
  });
  const canonical = new Map<string, { index: number; pointer: string; record: string }>();
  const collect = (value: unknown, index: number, pointer: string) => {
    if (bytes(value) >= 512) {
      store.atom(value);
      canonical.set(identity(value), { index, pointer, record: rows[index]!.id });
    }
    for (const [key, child] of children(value))
      collect(child, index, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
  };
  // Latest records own identical values. A current diagnostic/code is never replaced by stale source.
  for (const row of rows) {
    for (let i = 0; i < row.blocks.length; i++)
      collect(row.blocks[i]!.value, row.index, `json:${i}`);
    if (row.message.role === "TOOL") collect(row.message.content, row.index, "content");
  }
  const references: ContextProjectionArtifact["references"] = [];
  const canonicalRecords = new Set<string>();
  const plain = new Map<string, { index: number; record: string; text: string }>();
  for (const row of rows) {
    if (
      typeof row.message.content !== "string" ||
      row.message.role === "SYSTEM" ||
      row.message.content.startsWith("Task:\n")
    )
      continue;
    let from = 0;
    for (const block of [
      ...row.blocks,
      { start: row.message.content.length, end: row.message.content.length, value: null },
    ]) {
      for (const paragraph of row.message.content.slice(from, block.start).split(/\n\n/u))
        if (Buffer.byteLength(paragraph) > 512) {
          store.atom(paragraph);
          plain.set(identity(paragraph), { index: row.index, record: row.id, text: paragraph });
        }
      from = block.end;
    }
  }
  const internPlain = (text: string, index: number) =>
    text
      .split(/\n\n/u)
      .map((paragraph) => {
        const id = identity(paragraph),
          owner = plain.get(id);
        if (!owner || owner.index === index) return paragraph;
        canonicalRecords.add(owner.record);
        references.push({ sha256: id, record: owner.record, pointer: "verbatim-text" });
        return `[HOST_CONTEXT_REF_TEXT sha256=${id} record=${owner.record}; exact paragraph retained in that visible record]`;
      })
      .join("\n\n");
  const intern = (value: unknown, index: number, pointer: string): unknown => {
    const digest = identity(value),
      owner = canonical.get(digest);
    if (bytes(value) >= 512 && owner && (owner.index !== index || owner.pointer !== pointer)) {
      canonicalRecords.add(owner.record);
      references.push({ sha256: digest, record: owner.record, pointer: owner.pointer });
      return { $contextRef: { sha256: digest, record: owner.record, pointer: owner.pointer } };
    }
    if (Array.isArray(value)) return value.map((v, i) => intern(v, index, `${pointer}/${i}`));
    if (value && typeof value === "object")
      return Object.fromEntries(
        children(value).map(([key, child]) => [
          key,
          intern(child, index, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
        ]),
      );
    return value;
  };
  const view = rows.map((row) => {
    const message = row.message;
    if (
      message.role === "SYSTEM" ||
      (message.role === "USER" && message.content.startsWith("Task:\n"))
    )
      return message;
    if (message.role === "TOOL")
      return { ...message, content: intern(message.content, row.index, "content") };
    if (!row.blocks.length) return { ...message, content: internPlain(message.content, row.index) };
    let content = "",
      from = 0;
    row.blocks.forEach((block, i) => {
      content +=
        internPlain(message.content.slice(from, block.start), row.index) +
        JSON.stringify(
          row.index === latestPlan ? block.value : intern(block.value, row.index, `json:${i}`),
        );
      from = block.end;
    });
    content += internPlain(message.content.slice(from), row.index);
    return { ...message, content };
  });
  const retained = new Set(rows.map((row) => row.index));
  const omitted: ContextProjectionArtifact["omitted"] = [];
  const evidence = { version: "repair-evidence-v1" as const, sections: store.sections };
  const evidenceSha256 = inputHash(JSON.stringify(evidence));
  const render = () => {
    const kept = rows.filter((row) => retained.has(row.index));
    const lookup = kept
      .filter((row) => canonicalRecords.has(row.id))
      .map((row) => ({
        record: row.id,
        viewIndex: kept.findIndex((other) => other.index === row.index),
      }));
    const messages: ModelMessage[] = kept.map((row) => view[row.index]!);
    if (references.length || omitted.length)
      messages.push({
        role: "SYSTEM",
        content:
          "HOST_CONTEXT_REFERENCES: $contextRef replaces only an exactly identical complete JSON value retained in a listed visible record. Resolve its JSON pointer; no source bytes were shortened. Omitted history is recoverable as read-only data via readEvidenceArtifact, not write authority.\n" +
          JSON.stringify({ evidenceSha256, canonicalRecords: lookup, omitted }),
      });
    return { ...requestBase, messages };
  };
  const measure = async (request: ModelRequest) => {
    const prepared = input.prepare ? await input.prepare(request) : request;
    const projection = preparedInput(prepared);
    const serializedBytes =
      projection?.serializedBytes ?? Buffer.byteLength(serializeModelRequest(prepared));
    return {
      request: prepared,
      bytes: serializedBytes,
      tokens: projection?.estimatedInputTokens ?? Math.ceil(serializedBytes / 3),
      fingerprint: projection?.fingerprint ?? inputHash(serializeModelRequest(prepared)),
      wireBytes: projection?.wireBytes ?? serializedBytes,
    };
  };
  const before = await measure(requestBase);
  const pending = new Set<string>();
  for (const message of source) {
    if (message.role === "ASSISTANT")
      for (const call of message.toolCalls ?? []) pending.add(call.id);
    if (message.role === "TOOL" && !pending.delete(message.toolCallId))
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: "CONTEXT_ORPHAN_RESULT: recover the complete interaction before projection",
        details: { requestIssued: false },
      });
  }
  if (pending.size)
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message: "CONTEXT_PENDING_ACTIONS: finish host observations before projection",
      details: { requestIssued: false },
    });
  let current = await measure(render());
  const fits = () =>
    current.bytes <= input.maxBytes &&
    current.tokens <= (input.maxInputTokens ?? Number.MAX_SAFE_INTEGER);
  // Old successful stale source pairs can leave the view only as complete interactions.
  // Errors, counterevidence, current source, mutations and all host/task records stay pinned.
  const groups: number[][] = [];
  for (const row of rows) {
    if (row.message.role === "ASSISTANT") groups.push([row.index]);
    else if (row.message.role === "TOOL") groups.at(-1)?.push(row.index);
  }
  for (const group of groups.slice(0, -1)) {
    if (fits()) break;
    if (group.some((i) => canonicalRecords.has(rows[i]!.id))) continue;
    const tools = group.map((i) => rows[i]!.message).filter((m) => m.role === "TOOL");
    if (
      group.some(
        (i) => rows[i]!.message.role === "ASSISTANT" && (rows[i]!.message.content as string).trim(),
      )
    )
      continue;
    if (
      !tools.length ||
      tools.some(
        (m) =>
          m.role !== "TOOL" ||
          m.isError ||
          !["readFile", "batchReadFiles", "gitDiff", "queryRelations", "searchCode"].includes(
            m.toolName,
          ) ||
          !(
            m.content &&
            typeof m.content === "object" &&
            (m.content as { stale?: boolean }).stale === true
          ),
      )
    )
      continue;
    if (
      group.some((i) =>
        /refut|contradict|counterevidence|already_satisfied|deferred|反证/iu.test(
          JSON.stringify(rows[i]!.message),
        ),
      )
    )
      continue;
    for (const index of group) {
      retained.delete(index);
      omitted.push({ record: rows[index]!.id, reason: "P2_STALE_COMPLETE_INTERACTION" });
    }
    current = await measure(render());
  }
  // Only explicitly unrelated, older read groups may leave P1. Dependencies,
  // diagnostic sources and approved/INSPECT paths supplied by the host remain whole.
  if (input.priorityPaths)
    for (const group of groups.slice(0, -1)) {
      if (fits()) break;
      if (group.some((i) => !retained.has(i) || canonicalRecords.has(rows[i]!.id))) continue;
      const tools = group.map((i) => rows[i]!.message).filter((m) => m.role === "TOOL");
      if (
        !tools.length ||
        group.some(
          (i) =>
            rows[i]!.message.role === "ASSISTANT" && (rows[i]!.message.content as string).trim(),
        )
      )
        continue;
      if (
        tools.some(
          (m) =>
            m.role !== "TOOL" || m.isError || !["readFile", "batchReadFiles"].includes(m.toolName),
        )
      )
        continue;
      const files = tools.flatMap((m) => {
        const value = m.content as { path?: unknown; files?: unknown[] };
        return m.role === "TOOL" && m.toolName === "batchReadFiles" ? (value.files ?? []) : [value];
      });
      if (!files.length) continue;
      if (
        files.some(
          (v) =>
            !v ||
            typeof v !== "object" ||
            typeof (v as { path?: unknown }).path !== "string" ||
            input.priorityPaths!.includes((v as { path: string }).path),
        )
      )
        continue;
      if (
        group.some((i) =>
          /refut|contradict|counterevidence|反证/iu.test(JSON.stringify(rows[i]!.message)),
        )
      )
        continue;
      for (const index of group) {
        retained.delete(index);
        omitted.push({ record: rows[index]!.id, reason: "P1_UNRELATED_WHOLE_RECORD" });
      }
      current = await measure(render());
    }
  const artifact: ContextProjectionArtifact = {
    version: "context-projection-v1",
    historySha256: identity(input.history ?? input.request.messages),
    viewSha256: identity(current.request.messages),
    inputFingerprint: current.fingerprint,
    beforeBytes: before.bytes,
    afterBytes: current.bytes,
    estimatedInputTokens: current.tokens,
    wireBytes: current.wireBytes,
    omitted,
    references,
    records: rows.map((row) => ({
      id: row.id,
      tier: row.tier,
      viewIndex: retained.has(row.index)
        ? rows
            .filter((other) => retained.has(other.index))
            .findIndex((other) => other.index === row.index)
        : null,
    })),
    evidence,
    evidenceSha256,
  };
  if (!fits()) {
    await input.onCapacityFailure?.(artifact);
    throw new DevflowError({
      code: "VALIDATION_ERROR",
      message:
        "CONTEXT_NECESSARY_EVIDENCE_EXCEEDS_CAPACITY: required whole records do not fit; no request issued.",
      details: {
        requestIssued: false,
        requiredBytes: current.bytes,
        maxBytes: input.maxBytes,
        requiredInputTokens: current.tokens,
        maxInputTokens: input.maxInputTokens ?? null,
        missingBytes: Math.max(0, current.bytes - input.maxBytes),
        missingTokens: Math.max(
          0,
          current.tokens - (input.maxInputTokens ?? Number.MAX_SAFE_INTEGER),
        ),
        evidenceSha256,
      },
    });
  }
  return {
    request: current.request,
    artifact,
  };
}
