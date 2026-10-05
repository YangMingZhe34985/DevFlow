# DevFlow 2.0 workflow

The Worker runs one production proposal Planner and one tool-calling execution runtime. Historical grounded/iterative Planner implementations and experiment runners are excluded from the public tree. Compatibility schemas and execution guards remain for existing persisted approvals; they are not alternative production agents.

```text
Immutable repository + Issue
  -> bounded retrieval / Localization
  -> Planner proposal
  -> human approval
  -> Execute -> deterministic Test
                  -> targeted Repair -> Test
  -> independent Review
       -> targeted Repair / evidence response -> Test -> Review
  -> diff artifact -> optional approved GitHub delivery
```

Planner's proposal contains `decision`, `goal`, `approach`, `candidateFiles`, `verification` and `uncertainties`. Exact symbols and evidence IDs are optional hints. `EDIT` proposes a source repair target; `INSPECT` is read-only supporting evidence. Missing modification paths trigger investigation; intentional new files require `operation: CREATE`. Empty or all-inspection proposals permit only bounded investigation. The host constructs approval scope from verified source identity; candidate suggestions never grant permission.

Protected edits are excluded from write scope. A protected test suggestion alongside a viable source direction can continue as read-only investigation. A solution depending entirely on prohibited edits stops with a scope conflict. Execute and Repair verify the approved path and current full-file SHA before edits; whole-file writes also require complete observed content. Historical artifacts cannot authorize current writes.

Localization builds a versioned, bounded TS/JS static dependency/export artifact. Planner uses source evidence and a graph view; Execute and Repair can request `queryRelations`. The model chooses whether to call it. Current overlays invalidate changed relationships; incomplete graphs allow ordinary public source reads. The artifact is useful evidence, not a proof of root cause or an editing boundary. It does not cover arbitrary runtime dependencies or every language.

Review receives bounded current source around changed hunks, unchanged nearby branches, hashes/revision, public protection rules, diff and test output. It has no repository tools. Findings are marked source-linked only when their quote matches the supplied source; that is provenance, not semantic proof. Unsupported findings remain unresolved and cannot automatically pass.

Repair can finish with a change, an already-satisfied finding, contradiction, missing evidence or scope conflict. Optional source citations are checked against observed code and its current complete hash. The response goes back through Test and independent Review. No-op writes, repeated reads and repeated failures do not establish mutation progress or justify continued budget expansion.

Repository tests, independent Issue acceptance, integrity checks and model Review are distinct evidence. A passed test suite or a valid proposal alone is not a successful Issue repair. See [validation](validation-v2.md) for measured limits and [model configuration](stage-models.md) for stage bindings.
