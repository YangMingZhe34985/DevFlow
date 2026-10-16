/** Freeze public-only fixtures from already audited local bridge artifacts. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { adaptPublic } from "./adapter.js";

const suite = path.resolve(".devflow/external-set-suite");
const read = async (name: string) => JSON.parse(await fs.readFile(path.join(suite, name), "utf8"));
const state = await read("stage1-state.json");
if (!state.readyForStage2) throw Error("Stage-1 gate has not passed");
const candidates = (await read("stage1-candidates.json")).candidates;
const active = await read("private/r2/active-bridges.json");
const prepared = [];
for (const caseId of ["X11", "X19", "X21", "XRJ2"]) {
  const candidate = candidates.find((c: { caseId: string }) => c.caseId === caseId);
  const record = await read(`private/${candidate.instanceId}/record.json`);
  const bridge = active[caseId];
  if (bridge !== `private/r2/bridges/${caseId}`) throw Error("Unknown bridge path");
  const input = await read(`${bridge}/scripted-input.json`);
  const image = await read(`${bridge}/image.json`);
  const audit = await read(`${bridge}/rootfs-audit.json`);
  if (
    !audit.passed ||
    !audit.strongAuditPassed ||
    audit.imageId !== image.imageId ||
    image.sourceBaseCommit !== candidate.baseCommit
  )
    throw Error("Bridge audit/source identity mismatch: " + caseId);
  const snapshotText = JSON.stringify(input.snapshot);
  const snapshotSha256 = createHash("sha256").update(snapshotText).digest("hex");
  const fixture = adaptPublic(record, {
    caseId,
    dataset: candidate.dataset,
    revision: candidate.datasetRevision,
    imageId: image.imageId,
    snapshotSha256,
  });
  const directory = path.join(suite, "public", caseId);
  await fs.mkdir(directory, { recursive: true });
  const profileText = await fs.readFile(path.join(directory, "public-profile.json"), "utf8");
  const profile = JSON.parse(profileText);
  if (
    profile.status !== "CONFIGURED" ||
    profile.sourceBaseCommit !== candidate.baseCommit ||
    !profile.checks.length
  )
    throw Error("Public profile is not verified: " + caseId);
  fixture.publicChecks = profile;
  await fs.writeFile(path.join(directory, "fixture.json"), JSON.stringify(fixture, null, 2));
  await fs.writeFile(path.join(directory, "snapshot.json"), snapshotText);
  const privateHashes: Record<string, string> = {};
  for (const name of ["record.json", "gold.patch", "test.patch", "eval.sh"])
    privateHashes[name] = createHash("sha256")
      .update(await fs.readFile(path.join(suite, "private", candidate.instanceId, name)))
      .digest("hex");
  const preparationPath = path.join(suite, "private", candidate.instanceId, "preparation.json");
  const oldPreparation = await fs.readFile(preparationPath).catch(() => undefined);
  if (oldPreparation)
    await fs
      .writeFile(preparationPath + ".r1-preserved", oldPreparation, { flag: "wx" })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
  await fs.writeFile(
    path.join(suite, "private", candidate.instanceId, "preparation.json"),
    JSON.stringify(
      {
        caseId,
        source: fixture.source,
        imageId: image.imageId,
        snapshotSha256,
        publicProfileSha256: createHash("sha256").update(profileText).digest("hex"),
        strongAuditRef: audit.strongAuditRef,
        privateHashes,
        harness: state.harness,
        testGroupMapping: {
          baseline: "PASS_TO_PASS",
          core: "FAIL_TO_PASS",
          reproduction: "NOT_CONFIGURED",
        },
      },
      null,
      2,
    ),
  );
  prepared.push({
    caseId,
    instanceId: candidate.instanceId,
    imageId: image.imageId,
    snapshotSha256,
  });
}
await fs.writeFile(
  path.join(suite, "stage2-preparation.json"),
  JSON.stringify(
    {
      version: 1,
      readyForLive: false,
      status: "CONTROLS_PENDING",
      prepared,
      note: "Not the final 20–24-case manifest; private grading is separate from public checks.",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ prepared: prepared.length, readyForLive: false }));
