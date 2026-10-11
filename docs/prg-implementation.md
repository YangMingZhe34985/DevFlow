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

## Release and paid-test gate

Keep version 2.3.1 throughout implementation. Complete free engineering acceptance,
freeze code/configuration, and notify the user before any paid PRG test. Real tests
require a subsequent instruction. Planned order: E05, E06, E10; dynamic legacy controls
follow only for strictly successful or materially advancing cases. No private scoring
answers enter retrieval or model context. The cumulative authorized ceiling is ¥175;
reload the ledger before experiments. One strictly passing PRG case plus engineering
acceptance is the agreed v2.4.0 gate, not proof of general success rate or attribution.
