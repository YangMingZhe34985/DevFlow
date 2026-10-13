import { expect, it } from "vitest";
import { InMemoryTeamStore } from "@devflow/database";
import { TeamEngine, teamDigest } from "../src/team/engine.js";
import {
  teamInvestigationHandoff,
  projectTeamHandoff,
  codingTeamFollowup,
  teamHandoffGaps,
  teamEvidencePack,
} from "../src/team/handoff.js";
import { teamOperationAudit, teamStopError } from "../src/team/observability.js";
import {
  planContextText,
  planHostState,
  planRequestEvidenceAudit,
} from "../src/runs/plan-agent-context.js";
import type { TeamSnapshot, TeamEvidence } from "@devflow/shared";
import type { EvidencePack } from "../src/localization/contracts.js";

async function fixture() {
  const engine = new TeamEngine({
    store: new InMemoryTeamStore(),
    lease: { owner: "worker", dispatchRevision: 0 },
    signal: AbortSignal.timeout(5000),
    decide: async () => {
      throw Error("No model");
    },
    observe: async () => [],
  });
  const s = await engine.initialize({
    runId: "run",
    repositoryId: "repo",
    sourceIdentity: "base",
    mode: "team",
  });
  const e = (id: string, kind: TeamEvidence["kind"] = "SOURCE_OBSERVATION"): TeamEvidence => ({
    id,
    runId: "run",
    repositoryId: "repo",
    sourceIdentity: "base",
    kind,
    path: id,
    fileSha256: "a".repeat(64),
    startLine: 1,
    endLine: 2,
    content: `first ${id}\nsecond`,
    contentSha256: teamDigest(`first ${id}\nsecond`),
    sourceOperationId: "read",
    supports: [],
    valid: true,
  });
  s.evidence = [
    e("tests/state.test.ts"),
    e("implementation.ts"),
    e("consumer.ts"),
    e("relationship", "RELATION_OBSERVATION"),
  ];
  s.selectedEvidenceIds = ["tests/state.test.ts", "implementation.ts", "relationship"];
  s.tasks = [
    {
      id: "investigation",
      key: "behavior",
      agentId: "agent",
      goal: "Trace behavior",
      sourceIdentity: "base",
      dependsOn: [],
      evidenceIds: [],
      status: "COMPLETED",
      result: {
        evidenceIds: ["implementation.ts"],
        hypotheses: ["The producer might be wrong"],
        missing: ["Consumer behavior remains unverified"],
      },
    },
  ];
  s.messages = [
    {
      id: "challenge",
      sequence: 1,
      from: "agent",
      to: s.coordinatorId,
      taskId: "investigation",
      type: "CHALLENGE",
      body: "Consumer contradicts the producer-only hypothesis",
      evidenceIds: ["consumer.ts"],
      idempotencyKey: "challenge",
      sourceIdentity: "base",
    },
  ];
  s.missing = []; // Coordinator omitting a gap cannot implicitly close it.
  s.status = "READY_FOR_PLAN";
  return s;
}

it("keeps already retrieved public assertions when Coordinator selects only implementation; rejects old-view test carryover", async () => {
  const state = await fixture();
  state.selectedEvidenceIds = ["implementation.ts"];
  const source = state.evidence[0]!;
  const test = {
    repositoryId: "repo",
    baseCommitSha: "base-commit",
    viewRevision: "base",
    path: source.path!,
    contentHash: source.fileSha256!,
    startLine: 1,
    endLine: 2,
    snippet: source.content,
    fileType: "TEST" as const,
  };
  const pack = teamEvidencePack(
    state,
    {
      viewRevision: "base",
      evidence: [
        test,
        { ...test, path: "stale.test.ts", viewRevision: "old" },
        { ...test, path: "foreign.test.ts", repositoryId: "foreign" },
      ],
      missingInformation: [],
    } as EvidencePack,
    "base-commit",
  );
  expect(pack.evidence.map((e) => e.path)).toEqual([
    "tests/state.test.ts",
    "implementation.ts",
    "consumer.ts",
  ]);
  expect(pack.teamHandoff?.challenges[0]?.body).toContain("contradicts");
});

it("preserves Investigator gaps, selected relations and counterevidence even when Coordinator omits them", async () => {
  const s = await fixture(),
    h = teamInvestigationHandoff(s);
  expect(h.references.map((e) => e.id)).toContain("consumer.ts");
  expect(h.tasks[0]?.missing).toContain("Consumer behavior remains unverified");
  expect(h.observations[0]?.kind).toBe("RELATION_OBSERVATION");
  expect(teamHandoffGaps(h, [])).toContain(
    "Unresolved investigation (investigation): Consumer behavior remains unverified",
  );
  const memory = codingTeamFollowup(s);
  expect(memory.tasks).toEqual(h.tasks);
  expect(memory.challenges[0]?.body).toContain("contradicts");
  expect(JSON.stringify(memory)).not.toContain("first consumer.ts");
  expect(memory.notice).toContain("Historical");
});

it("retains open/blocked task reasons but cannot import another source view as current claims", async () => {
  const s = await fixture();
  s.tasks[0]!.status = "BLOCKED";
  s.tasks[0]!.reason = "BUDGET_STOP";
  s.tasks.push({
    ...s.tasks[0]!,
    id: "old",
    sourceIdentity: "old",
    result: { hypotheses: ["obsolete"], evidenceIds: [], missing: ["obsolete gap"] },
  });
  const h = teamInvestigationHandoff(s);
  expect(h.tasks).toHaveLength(1);
  expect(teamHandoffGaps(h, []).some((m) => m.includes("BUDGET_STOP"))).toBe(true);
  expect(JSON.stringify(h)).not.toContain("obsolete");
});

it.each(["stale", "missing", "foreign", "corrupt"])(
  "rejects %s counterevidence instead of discarding it from handoff",
  async (kind) => {
    const s = await fixture(),
      e = s.evidence[2]!;
    if (kind === "stale") e.sourceIdentity = "old";
    if (kind === "missing") s.evidence.splice(2, 1);
    if (kind === "foreign") e.runId = "other";
    if (kind === "corrupt") e.content += "tampered";
    expect(() => teamInvestigationHandoff(s)).toThrow(/TEAM_HANDOFF/);
  },
);

it("measures actual Plan visibility without treating a cached consumer as visible or sufficient", async () => {
  const s = await fixture(),
    h = teamInvestigationHandoff(s);
  const rows = s.evidence
    .filter((e) => e.kind === "SOURCE_OBSERVATION")
    .map((e) => ({
      id: `plan-${e.id}`,
      path: e.path!,
      contentHash: e.fileSha256!,
      startLine: 1,
      endLine: 2,
      snippet: e.content,
      snippetHash: teamDigest(e.content),
      repositoryId: "repo",
      baseCommitSha: "a".repeat(40),
      workspaceRevision: 0,
      viewRevision: "base",
      sourceVerified: true,
      truncated: true,
      symbol: null,
      fileType: e.id.includes("test") ? ("TEST" as const) : ("SOURCE" as const),
      reason: "Read",
    }));
  expect(
    projectTeamHandoff(h, rows.slice(0, 2)).references.find((e) => e.id === "consumer.ts")?.display,
  ).toBe("NOT_FULLY_VISIBLE");
  expect(
    projectTeamHandoff(
      h,
      rows.map((r) => ({ ...r, contentHash: "b".repeat(64) })),
    )
      .references.filter((e) => e.kind === "SOURCE_OBSERVATION")
      .every((e) => e.display === "NOT_FULLY_VISIBLE"),
  ).toBe(true);
  const input = {
    title: "Preserve all public behavior",
    description: "Test, implementation and consumer",
    repositoryId: "repo",
    baseCommitSha: "a".repeat(40),
    workspaceRevision: 0,
    evidence: { teamHandoff: h, missingInformation: [] } as unknown as EvidencePack,
  };
  const text = planContextText(planHostState(input, "base"), rows, input, []);
  const payload = JSON.parse(text);
  expect(payload.teamInvestigation.tasks[0].missing).toContain(
    "Consumer behavior remains unverified",
  );
  const audit = planRequestEvidenceAudit({ messages: [{ role: "USER", content: text }] });
  expect(audit?.shown).toHaveLength(3);
  expect(
    audit?.teamReferences.filter((r: { display: string }) => r.display === "RANGE_COVERED"),
  ).toHaveLength(3);
  expect(audit?.assessment).toBe("VISIBILITY_ONLY_NOT_BEHAVIORAL_SUFFICIENCY");
  expect(
    planRequestEvidenceAudit({ messages: [{ role: "USER", content: "repair malformed JSON" }] }),
  ).toBeUndefined();
});

it.each(["COMPLETED", "NOT_ISSUED", "UNKNOWN", "PREPARED"] as const)(
  "reports %s model state without guessing HTTP counts or hiding unknown dispatch",
  async (status) => {
    const s = await fixture();
    s.status = "STOPPED";
    s.stopReason = status === "NOT_ISSUED" ? "BUDGET_STOP" : "MODEL_OUTPUT_INVALID";
    s.operations = [{ id: "model", agentId: s.coordinatorId, kind: "MODEL", status, input: {} }];
    s.agents[0]!.decisionCount = 1;
    const audit = teamOperationAudit(s),
      error = teamStopError(s);
    expect(audit.httpRequests).toBeNull();
    expect(audit.decisionAttempts).toBe(1);
    expect(audit.evidence.missingVisibilityRecords).toBe(status === "COMPLETED" ? 1 : 0);
    expect(error.code).toBe(
      status === "NOT_ISSUED" ? "EXECUTION_BUDGET_EXCEEDED" : "MODEL_OUTPUT_INVALID",
    );
    expect((error.details as { requestIssued?: boolean }).requestIssued).toBe(
      status === "COMPLETED" ? true : status === "NOT_ISSUED" ? false : undefined,
    );
    const restored = JSON.parse(JSON.stringify(s)) as TeamSnapshot;
    expect(teamOperationAudit(restored)).toEqual(audit);
  },
);
