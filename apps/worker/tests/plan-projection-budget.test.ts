import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { PlanAgent } from "../src/runs/plan-agent.js";
import { codingPlannerTokenLease } from "../src/runs/coding-budget.js";

const content = Array.from(
  { length: 60 },
  (_, i) => `export const behavior${i} = "required observed evidence";`,
).join("\n");
const hash = createHash("sha256").update(content).digest("hex");
function fixture() {
  const read = vi.fn(async () => ({ content, truncated: false }));
  return {
    read,
    input: {
      title: "Preserve public behavior",
      description: "Handle the complete current state.",
      repositoryId: "fixture",
      baseCommitSha: "a".repeat(40),
      workspaceRevision: 1,
      signal: new AbortController().signal,
      source: {
        manifest: async () => ({
          entries: [
            {
              path: "src/state.ts",
              kind: "FILE" as const,
              sizeBytes: Buffer.byteLength(content),
              contentHash: hash,
            },
          ],
          incomplete: false,
        }),
        read,
      },
      supplementaryReads: [
        { path: "src/state.ts", startLine: 1, endLine: 60, reason: "Required candidate behavior" },
      ],
      discoveryCandidates: [
        { path: "src/state.ts", intent: "EDIT" as const, reason: "Evaluate current behavior" },
      ],
      limits: { maxTotalTokens: 60000, maxModelCalls: 2, finalOutputTokens: 8192 },
    },
  };
}

it("reconciles the actual complete required request before optional IO and never truncates it to force admission", async () => {
  const f = fixture();
  let fingerprint: string | undefined;
  const result = await new PlanAgent().prepare({
    ...f.input,
    onPreparedProjection: async ({ preflight, evidence }) => {
      expect(evidence[0]?.snippet).toBe(content);
      fingerprint = preflight.estimate.fingerprint;
      return { maxTotalTokens: preflight.requiredTokens - 1, allowOptionalNavigation: false };
    },
  });
  expect(result.status).toBe("BLOCKED");
  expect(result.attempt.preflight?.estimate.fingerprint).toBe(fingerprint);
  expect(result.attempt.preflight?.requiredTokens).toBe(
    result.attempt.preflight!.remainingTokens + 1,
  );
  expect(result.attempt.preflight?.repairReserveTokens).toBe(25078);
  expect(result.preparedFinalRequest?.settings?.maxOutputTokens).toBe(8192);
  expect(result.preparedFinalRequest?.messages[1]?.content).toContain("behavior59");
  expect(result.attempt.metrics.modelCalls).toBe(0);
  expect(f.read).toHaveBeenCalledTimes(1);
});

it("host lease errors fail before dispatch and do not consume a recovery attempt", async () => {
  const f = fixture();
  const result = await new PlanAgent().prepare({
    ...f.input,
    onPreparedProjection: async () => ({ maxTotalTokens: 60001 }),
  });
  expect(result.attempt.diagnostics.at(-1)?.code).toBe("PLAN_INVALID_HOST_LEASE");
  expect(result.attempt.metrics.modelCalls).toBe(0);
});

it("does not classify a host preparation failure as model failure or spend recovery", async () => {
  const f = fixture();
  const onGenerationError = vi.fn();
  const model = { generate: vi.fn() };
  const result = await new PlanAgent().run({
    ...f.input,
    model,
    onGenerationError,
    onPreparedProjection: async () => {
      throw new Error("Host continuation identity is unknown");
    },
  });
  expect(result.status).toBe("BLOCKED");
  expect(model.generate).not.toHaveBeenCalled();
  expect(onGenerationError).not.toHaveBeenCalled();
  expect(result.attempt.metrics.modelCalls).toBe(0);
});

it("drops optional navigation as whole records when the combined continuation no longer fits", async () => {
  const f = fixture();
  const main =
    "import { helper } from './helper.js';\nexport function run() { return helper(); }\n" + content;
  const helper =
    "export function helper() {\n" + "  // supporting detail\n".repeat(60) + "return true;\n}";
  const files = new Map([
    ["src/state.ts", main],
    ["src/helper.ts", helper],
  ]);
  const read = vi.fn(async (p: string) => ({ content: files.get(p)!, truncated: false }));
  let optionalSeen = false;
  const result = await new PlanAgent().prepare({
    ...f.input,
    source: {
      read,
      manifest: async () => ({
        entries: [...files].map(([path, text]) => ({
          path,
          kind: "FILE" as const,
          sizeBytes: Buffer.byteLength(text),
          contentHash: createHash("sha256").update(text).digest("hex"),
        })),
        incomplete: false,
      }),
    },
    onPreparedProjection: async ({ evidence, preflight, stage }) => {
      const optional = stage === "FINAL" && evidence.some((row) => row.path === "src/helper.ts");
      optionalSeen ||= optional;
      return { maxTotalTokens: optional ? preflight.requiredTokens - 1 : 60000 };
    },
  });
  expect(
    optionalSeen,
    JSON.stringify({
      diagnostics: result.attempt.diagnostics,
      calls: read.mock.calls,
      refs: result.attempt.evidenceRefs,
    }),
  ).toBe(true);
  expect(result.status).toBe("READY");
  expect(
    result.attempt.diagnostics.some((d) => d.code === "PLAN_OPTIONAL_EVIDENCE_BUDGET_STOP"),
  ).toBe(true);
  const view = JSON.parse(result.preparedFinalRequest!.messages[1]!.content!);
  expect(view.evidence).toHaveLength(1);
  expect(view.evidence[0].path).toBe("src/state.ts");
  expect(view.evidence[0].snippet).toContain("behavior57");
  expect(result.attempt.preflight?.repairReserveTokens).toBe(25078);
});

it("a fit prepared request retains its full evidence and unchanged output/recovery costs", async () => {
  const f = fixture();
  const result = await new PlanAgent().prepare({
    ...f.input,
    onPreparedProjection: async ({ preflight }) => {
      const lease = codingPlannerTokenLease({
        remainingTokens: 134072,
        downstreamTokens: 80000,
        configuredMaximumTokens: 60000,
        consumedTokens: preflight.consumedTokens,
        requiredRequestTokens: preflight.requiredTokens,
      });
      return { maxTotalTokens: lease.maxTotalTokens, allowOptionalNavigation: false };
    },
  });
  expect(result.status).toBe("READY");
  expect(result.attempt.metrics.archivedSnippetBytes).toBe(Buffer.byteLength(content));
  expect(result.attempt.preflight).toMatchObject({
    maxTotalTokens: 54072,
    repairReserveTokens: 25078,
    outputTokens: 8192,
    permitted: true,
  });
});
