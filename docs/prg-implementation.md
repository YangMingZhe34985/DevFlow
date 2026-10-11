# PRG implementation and acceptance

Development baseline: `57f025b`, version 2.3.1. Safety branch:
`codex/pre-prg-v231-20261011`. Implementation branch: `codex/prg-v24`.
The original design remains in `PRG：Progressive Repository Graph 算法设计.md`.

## Batch A — structure and identity

`RepositoryAtlas` builds hierarchy from the existing allowed manifest without reading
source. Module boundaries require a visible package/build descriptor; directory names
alone do not prove a module's responsibility. Missing entries in a partial manifest
remain unknown. Source scanning is a separate budgeted operation.

Complete immutable manifests use content-addressed shards in `RepositoryIndexStore`.
Root publication follows shard publication. Mutable overlays and partial inventories
cannot publish shared roots. A manifest adapter reuses the acquired inventory and
preserves the original source IO accounting boundary.

Validation: 11 Atlas/router tests passed; `npm run build:core` and targeted formatting
passed. Coverage includes 2,000 files, nested modules, paging, excluded materials,
partial inventory, duplicate paths, configuration/file changes and overlay isolation.
Cold construction performs one manifest acquisition and zero source reads; warm
construction uses persisted shards and performs neither. Production wiring and Docker
acceptance follow in batch D; no capability or real experiment claim is made here.

## Batch B — syntax facts and static navigation

Pinned `@vscode/tree-sitter-wasm@0.3.1` supplies its own matching runtime and Python,
Java and C++ grammars. Parsing runs in an empty-environment worker, with a 512 KiB
input bound, an eight-second deadline and bounded syntax output. TS/JS retains the
TypeScript 5.9.3 resolver. No repository scripts, language servers or plugins execute.

Current source SHA and configuration identity bind facts. Immutable syntax shards
can be reused; manifest-dependent bindings are recomputed. Declarations and uniquely
resolved import files are static facts. Call/reference locations are exposed without
claiming overload, macro or runtime dispatch targets. Reverse coverage stays partial.

Validation: 47 parser, source-unit and graph regressions passed, including WASM on
Windows, TS aliases, overloads, macros, syntax failure, cache reuse and invalidation.
Core compilation passed. Shared Worker query wiring remains batch D work.

## Batch C — dynamic investigation and durable boundaries

The existing Localization Agent accepts `legacy`, `legacy-dynamic` and `prg` modes.
Dynamic modes remove the four-request/two-search/three-read stage allowances; Run
limits and per-operation admission still apply. Read range, snippet and full-file
bounds remain. Actual provider-prepared input is measured before generation without
reducing configured output. A larger bounded host evidence archive is projected as
complete records rather than injected wholesale.

Versioned investigation checkpoints retain source identity, source cache, evidence,
candidate/hypothesis state, completed queries/ranges, progress and original consumption.
Safe evidence boundaries resume without repeating completed work. Unconfirmed model
or IO reservations block rather than replay. Repeated requests stop immediately; two
rounds without new source stop without a summary call. The original lease policy is
retained for `legacy`; dynamic mode quotes remaining capacity beyond downstream needs.

Validation: 37 investigation, legacy-agent and lease tests passed. Tests include six
model requests with five fresh reads, duplicate/no-progress stops, resume with original
consumption, unknown dispatch refusal and pre-IO downstream rejection. Worker-wide
admission, mode freezing and production handoff are implemented in batch D.

## Release and paid-test gate

Keep version 2.3.1 throughout implementation. Complete free engineering acceptance,
freeze code/configuration, and notify the user before any paid PRG test. Real tests
require a subsequent instruction. Planned order: E05, E06, E10; dynamic legacy controls
follow only for strictly successful or materially advancing cases. No private scoring
answers enter retrieval or model context. The cumulative authorized ceiling is ¥175;
reload the ledger before experiments. One strictly passing PRG case plus engineering
acceptance is the agreed v2.4.0 gate, not proof of general success rate or attribution.
