# DevFlow 2.0 validation

Validation distinguishes model output completion, host acceptance, approved execution scope, actual edits, deterministic tests, independent Issue acceptance and model Review. Strict success requires all applicable stages and an accepted patch; a JSON proposal or repository test pass alone is insufficient.

The engineering suite passed 574 tests; 20 tests requiring explicit integration opt-in were skipped. TypeScript and Web production builds, lint, formatting, Prisma validation and the offline installation dry run passed. Source identity, protected-file rules, stage request settings, proposal recovery, graph versioning, precise edits, Repair evidence recovery, independent Review and no-progress detection are covered. The same 574 tests also passed from a copy of only the Git public candidate files, with the generated Prisma client supplied as an installation artifact; private dataset/evaluator files were absent. Historical Planner experiments are locally archived rather than included in the public production test suite.

The final nine-case run of the cleaned v2.0 tree completed on 2026-10-06 (local time), using one frozen production version, model configuration and independent scorer. Its original cohort results are:

| Gate                                                              | Original nine-case cohort |
| ----------------------------------------------------------------- | ------------------------- |
| Complete Planner decision, including explicit uncertainty         | 9/9                       |
| Host accepted main `PROPOSE` proposal                             | 7/9                       |
| Final `READY` scope and Execute reached                           | 7/9                       |
| Nonempty patch produced                                           | 6/9                       |
| Independent Issue, regression and integrity acceptance all passed | 6/9                       |
| Strict end-to-end acceptance                                      | 5/9                       |

One case, zod #5826, was interrupted by the preauthorized spending gate after entering Execute. It was separately rerun with an explicitly authorized spending-threshold continuation, keeping production code, model bindings, input revisions and the scorer unchanged. That continuation passed strict acceptance. Thus six of the nine cases have strict acceptance evidence after the financial continuation; this is distinct from the original single-cohort result of 5/9. Earlier staged successes are not substituted for failures in this table.

| Issue          | Original strict result                                                            | Separate financial continuation |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| date-fns #3129 | PASS                                                                              | —                               |
| date-fns #3614 | PASS                                                                              | —                               |
| zod #5296      | PASS                                                                              | —                               |
| zod #5593      | FAIL: implementation evidence missing after discovery                             | —                               |
| zod #5777      | FAIL: serializer implementation not located                                       | —                               |
| zod #5792      | FAIL: Repair estimated step budget exhausted; independent patch acceptance passed | —                               |
| zod #5824      | PASS                                                                              | —                               |
| zod #5825      | PASS                                                                              | —                               |
| zod #5826      | INTERRUPTED: spending gate                                                        | PASS                            |

The remaining bottlenecks are concrete. Localization and bounded Plan discovery can still prioritize benchmarks, export chains or guessed paths over the implementation. Execute sometimes produces incomplete changes; testing and source-informed Review caught undefined helpers, unused translation entries and an unchanged key-conversion branch in this validation. Repair can consume its estimated limit after a real edit when it continues reading without producing explicit diff evidence or finishing; zod #5792 stopped after eight Repair calls despite six unused hard-limit steps. The host's progress evidence and phase completion policy need further work, alongside model edit quality.

The dataset consists of nine public Issues from two TS/JS repositories, using fixed base revisions and an independent frozen acceptance/integrity scorer. Private traces, billing, source snapshots and evaluator material are not shipped in this public tree. Public synthetic fixtures and ordinary tests remain available. Consequently, a clean public checkout can run engineering tests, but cannot reproduce the private paid dataset controller without separately provisioned data and credentials.

Known limits include incomplete implementation discovery, model-dependent patch quality and evidence gaps in bounded Review contexts. Static graphs do not model every runtime dependency. Current source-linked evidence proves provenance, not behavioral correctness. Costs and outcomes vary with provider settings and retry paths. Broader cross-repository evaluation is needed before estimating a general repair success rate.
