# External-set construction tools

These files are independent of the existing E01–E10 suite. Generated artifacts and
all official grading material stay under `.devflow/external-set-suite/`; no model
provider or credentials are loaded by the scripted control runner.

Current acceptance and remaining work are recorded in
`.devflow/v4-research/external-set-build-report.md`. This is a partial construction,
not a ready 20–24-case benchmark. `--live` is implemented but fails closed until
a complete audited final manifest exists. This construction must not issue paid requests.

## Reproducible stages

1. `bootstrap.py` freezes the dataset revisions, LFS hashes and upstream harness.
   `stage1_catalog.py` derives candidates and private records. Do not regenerate
   this catalog over appended replacement records.
2. `stage1_resources.py --cases <aliases>` quotes immutable manifests and layer
   sizes. `acquire_images.py` performs admitted pulls with a persistent acquisition
   record and a cumulative stage-one 10 GiB guard. The latest quote file describes
   only that query; the acquisition ledger retains all pulls.
3. Use the isolated Python 3.12 runtime with the frozen private dependencies for
   `stage1_preflight.py --cases <aliases> --campaign <new-id>`. It preserves the
   official image's working-tree instrumentation, checks committed source trees,
   and calls the pinned official test-spec builder and grader offline.
4. `stage1_bridge_image.py --case <alias>` creates a base-only flattened image;
   `stage1_bridge_prepare.py --case <alias>` audits its full rootfs, prepares the
   bounded snapshot, and exports scripted edits in a separate trusted container.
   Edits are host-private, not files copied to the solver.
5. `stage1_fake_bridge.ts` is the initial X11 T6 proof. `stage1_state.py` derives
   gates from completed controls. Old failed campaigns remain immutable.
6. After stage-one acceptance, `node --import tsx
scripts/v4/external-set/prepare.ts` freezes four public-only fixtures. Then run
   `evaluate.ts --cases X11,X19,X21,XRJ2 --script golden|empty|wrong --python
<frozen-python-executable> --campaign <new-id>` separately for each control.
   The entry reuses `runAttempts` and the real Docker sandbox; private official
   grading starts only after the solver container is disposed. A dispatch identity
   is single-use. Do not remove it to disguise a retry; use a new documented
   campaign if a harness defect requires another free calibration.
7. R2: `public_profiles.py` freezes proposals using only public base configuration
   and public base failures. `profile_validate.py` executes three base controls
   and a separate private gold control in solver-equivalent offline containers.
   Java's `java_cache.py` inventories only official-image dependencies;
   `toolchain_environment.py` retains the original non-secret JDK environment.
8. `r2_bridge.py` creates a new flat generation with opaque caches removed.
   `strong_audit.py` verifies base file hashes, installed project copies,
   workspace links, caches and residual private material. `activate_r2.py` refuses
   activation unless all image/profile/audit identities and receipts match.
   `prepare.ts` preserves the configured profile and snapshots old preparation.
9. `stage2_r2_state.py` derives R2 acceptance from the twelve `stage2-r2` controls.
   It retains the old state and writes explicitly incomplete final outputs until
   twenty or more cases meet every gate. `stage3_plan.py` only quotes the next
   phase; it neither pulls images nor claims acceptance.
10. `cleanup_audit_exports.py` checks completed audit SHA and deletes only its
    enumerated rootfs exports; source archives, image identities and audit receipts
    remain. Rerunning a full audit needs a new export from that exact image.

Do not rerun `stage1_report.py` over the preserved R1/R2 narrative, or
`stage2_state.py` over the receipt-derived R2 state; those are original R1 tools.

All evaluation/build/export containers are owned and labelled, run without network,
and are cleaned individually. Upstream and flattened images are retained; audited
rootfs exports are removed with deletion receipts. There is no Docker prune operation. Image reservations use
compressed layer sizes; uncompressed image sizes and host file sizes are separate.

## Tests

```text
python -B -X utf8 -m unittest discover -s tests/external-set -p test_*.py -v
npx --no-install vitest run tests/external-set --maxWorkers=2
npx --no-install tsc --project scripts/v4/external-set/tsconfig.json
```

Rootfs pattern/hash checks are scoped to known full private materials and Git
roots; they do not prove absence of every possible encoded or compressed leak.
Source snapshots contain only the upstream base tree. Public tests are read-only;
official test names, scripts, patches and grading observations never enter solver
or reviewer context. A successful scripted patch proves integration, not model
capability, public-validation completion or Independent Review approval.

## Future live entry (implementation only; not executed during construction)

Use the same environment as `phase0-dataset.ts` (`node --env-file=.env --import tsx`).
Explicit `--cases`, `--budget-cny` and `--per-case-cny` are mandatory. Stage models
resolve through Worker environment configuration. `DEVFLOW_MODEL_PRICES_JSON`
must contain verified prices for both selected provider:model identities; unknown
or invalid prices fail closed. No API credentials are written to results.

Every live batch uses a new UUID directory under `private/experiments`, with
durable per-case reservations. The per-case amount reaches the existing Kernel
via `runAttempts`, including its Review reservation. Unknown consumption remains
reserved. No restart or duplicate invocation may reuse an old experiment identity.
The entry validates final manifest image, snapshot and profile identities before
dispatch, uses the configured public profile, and disposes the solver before
reading private grading files. `strictPatchPass` and `strictWorkflowPass` are
reported separately. Tests exercise this cap through the real Kernel with Fake
models; they are not proof that a paid model can solve an external Issue.

## Phase three

`stage3_acquire.py --batch A|B|C|D` consumes the immutable resource plan with a
durable ledger, preserving failed/unknown and earlier replacement reservations.
It enforces per-batch and 41 GiB aggregate limits without recycling spent quota.
`stage3_runner.py --batches ABCD` advances batches serially, with at most two
independent case workers. Any builder error stops before the next batch.

`stage3_case.py` requires official base/empty negatives and three gold passes,
builds a public-base-only flattened image, creates the bounded snapshot,
calibrates a public-module profile using only public base failures, checks gold
separately, and runs the strong audit. Successful exports are removed only after
their SHA matches the audit. No paid model is involved.

`stage3_freeze.py --batch <letter>` rechecks the underlying receipts, source
provenance, snapshot, image and private hashes, then updates the report and STATUS.
`--final` permits readiness only with 20–24 fully qualified cases and no receipt
errors. The final authoritative files are `manifest.json`, `inputs.json`,
`images.json` and `stage3-state.json`. Do not rerun the earlier R1/R2 report/state
generators over this final freeze. Future live runs must still provide explicit
batch/case budgets; dataset readiness is not permission to spend.

`stage3_resource_profiles.py` rechecks an unchanged public profile under the
exact solver resource limits (including the RAM+swap limit); it never selects a
new command from private grading results. `stage3_self_check.py` runs after the
final freeze and records engineering checks, public-field isolation, resource
accounting and owned-export cleanup without invoking any model.
