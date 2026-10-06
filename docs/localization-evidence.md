# Implementation discovery and evidence handoff

DevFlow uses one bounded, read-only implementation navigator in Localization, optional Planner discovery, and symbol queries during Execute/Repair. A graph identifies relationships; current source windows provide behavioral evidence. A static match does not establish the cause of an Issue.

## Retrieval

Issue signals distinguish source paths with known extensions, qualified API names, declared local variables in reproductions and version hints. Public symbol queries precede generic description words. Candidate ranking separates implementation, forwarding entry points, tests, benchmarks/examples and metadata. Tests remain useful for finding APIs and relevant behavior.

The content index remains bounded. When requested symbols have no implementation candidate in a partial index, the router searches at most 24 files from its safe manifest catalogue, ranked for the current query. Warm queries can discover a different symbol without treating unindexed content as absent. Changed source overlays and deletions remain authoritative. Both the initial index and fallback obey existing source-byte limits.

## Navigation

The navigator follows parsed named/default/namespace imports, named export aliases and star exports, using the repository resolver for package/TypeScript paths. It distinguishes declarations and overloads from bodies, observes relevant conditionals in long functions, and can read called helpers. Property-assigned functions are represented as implementation symbols. Queue priorities favor observed forwarding relationships; revisiting the same path/symbol combination is bounded, including cycles.

Default Localization/discovery limits are eight source reads, 1 MiB of source, six windows and 10 KiB of snippets. Execute/Repair symbol queries use four reads, 512 KiB of source, three windows and 4 KiB of snippets. Manifest entries are capped at 50,000 and symbol traversal depth at six. Files larger than 512 KiB, protected/generated paths, incomplete reads and stale hashes cannot become implementation evidence. These are upper bounds; the stage's remaining budget may reduce them.

The search may inspect other public source when graph coverage is incomplete. Failure to find a symbol means evidence is missing within this exploration budget, not that the implementation does not exist.

## Handoff and progress

Localization retains concise candidate suggestions plus host-observed implementation windows. Each observation references its path, symbol, source range and complete source hash. The handoff records the graph/workspace revision, missing evidence and exploration stop reason. Planner projects current observed windows before lower-priority snippets, with shared evidence IDs instead of duplicated source. Stale revision evidence is excluded. No new field is required from the Planner model.

Repeated requests, cached reads, narrower ranges within already observed source or reworded hypotheses do not establish new exploration progress. Coverage remains remembered when low-priority context rows are evicted. New relevant source regions or relationships can justify another bounded exploration turn. Model call/token reserves preserve a final response and format recovery. Immutable verified source is cached within the Localization run; changed overlays require current reads.

Execute/Repair receive guidance to query symbols and read definitions/helpers when plan evidence is insufficient. A `queryRelations` result can contain `implementationEvidence`, `missingInformation` and `navigationMetrics` alongside the graph. Explicit path queries pass their requested symbols to navigation candidates, preserving priority through forwarding files with arbitrary names. The result grants no editing authority and is not a complete file read. New modification paths still require host-controlled replanning/approval; writes still require current full-file SHA and applicable complete-read checks.

Review remains tool-free. On `NEEDS_EVIDENCE`, the host can use this same navigator once per workflow, with up to three requests sharing four source reads (including graph metadata reads), 512 KiB of original text and 16 KiB of exact snippets. Protected public tests remain readable; private/evaluator paths, symlinks, stale hashes and incomplete content are excluded. Supplement consumption persists across Repair and recovery. Its source windows go to independent re-review; static relevance and a citation do not prove a defect or automatically resolve a finding.

## Validation limits

Engineering tests cover partial-index fallback, version/role ranking, alias/default/namespace forwarding, cycles, overloads, long function windows, protected/stale source, truthful context projection, revision invalidation and execution guards. Paid regression results are recorded separately in [v2 validation](validation-v2.md). The repeatedly exercised nine-Issue set is a regression set; it does not estimate performance on an unseen dataset. No Issue-specific file mappings or expected patches are part of this navigation implementation.
