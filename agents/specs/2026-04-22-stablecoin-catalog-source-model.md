# Stablecoin Catalog Source Model And Cutover

Date: 2026-04-22
Owner: Codex
Status: approved-for-implementation
Source plan: `agents/plans/2026-04-22-full-audit-remediation-implementation-plan.md`

## Purpose

This document is the `Gate-WS7A` design artifact for `S-02` / `CC-05`. It locks the catalog source model, mixed-source support, cutover order, rollback approach, and required validation before any `WS-7` implementation PR starts.

## Chosen Source Model

Chosen model: **hybrid per-coin source files with generated aggregate views**.

Target layout:

- keep canonical order in `shared/data/stablecoins/canonical-order.json`
- introduce one source file per tracked asset under a new generated-input root, for example:
  - `shared/data/stablecoins/coins/<stablecoin-id>.json`
- preserve the current category/shard semantics (`usd-major`, `usd-minor`, `non-usd`, `commodity`, `pre-launch`) as **derived metadata**, not as the primary persisted grouping
- generate aggregate category views from the per-coin sources for compatibility during migration

Why this model:

- it achieves the audit’s actual goal of reducing merge-conflict and review blast radius
- it lets runtime consumers keep a stable loader API while the source-of-truth becomes fine-grained
- it avoids locking the repo into another coarse “smaller grouped shards” intermediate that would still need a second migration later

## Mixed-Source Support

Required during migration: **yes**.

The generator/foundation from `PR-11` must support reading:

- legacy shard arrays:
  - `usd-major.json`
  - `usd-minor.json`
  - `non-usd.json`
  - `commodity.json`
  - `pre-launch.json`
- new per-coin files under `shared/data/stablecoins/coins/`

Mixed-source rule:

- a stablecoin ID may exist in exactly one source system at a time
- the generator must fail if the same ID appears in both a legacy shard and the new per-coin directory
- the generator must produce the same runtime aggregate structures regardless of source origin

## Cutover Order

Phase order:

1. `PR-11` foundation
   - add per-coin source directory
   - add generator that merges legacy shards + per-coin sources
   - keep existing loader outputs stable
   - add duplicate-ID and mixed-source validation
2. `PR-12a` migration batch 1
   - migrate `pre-launch` and `commodity`
   - these are smaller and have lower blast radius
3. `PR-12b` migration batch 2
   - migrate `non-usd`
4. `PR-12c` migration batch 3 + cleanup
   - migrate `usd-major` and `usd-minor`
   - remove legacy shard ingestion path
   - keep generated compatibility views if still useful for docs/scripts, otherwise delete them

Rationale:

- smaller, lower-risk categories go first
- the largest, highest-conflict shards go last after the mixed-source generator is proven
- `pre-launch` first validates that Pages/UI-only flows still work under the new source model without immediately touching the biggest active sets

## Runtime And Script Compatibility Requirements

The following must continue to work unchanged across the migration:

- `shared/lib/stablecoins/registry.ts`
- `shared/lib/stablecoins/index.ts`
- `scripts/check-stablecoin-data.ts`
- `scripts/check-doc-counts.mjs`
- docs and code that currently reference `shared/data/stablecoins/*.json`

Compatibility rule:

- runtime loader imports should continue to expose `TRACKED_STABLECOINS`, `TRACKED_META_BY_ID`, `ACTIVE_STABLECOINS`, and `PRE_LAUNCH_STABLECOINS` with no consumer changes required outside the `WS-7` lane

## Validation Requirements

Every `WS-7` implementation PR must run:

- `npm run check:stablecoin-data`
- `npm run check:doc-counts`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`

Additional requirements:

- `PR-11` must add mixed-source validation for duplicate IDs and missing canonical-order coverage
- each migration batch PR must prove that the migrated IDs exist only in the new source model
- cleanup PR must prove legacy shard ingestion is fully removable

## Documentation Impacts

The migration must update these docs as the source model changes:

- `docs/stablecoin-data.md`
- `docs/architecture.md`
- any docs that currently describe `shared/data/stablecoins/*.json` as the primary source format

During mixed-source migration, docs must explicitly say:

- per-coin files are becoming the source of truth
- legacy shards remain temporarily supported only for migration compatibility

## Rollback / Backout Approach

Rollback principle: **the generator foundation is the backout safety net**.

If a migration batch causes problems:

- restore the migrated coin files to their previous legacy shard
- remove the corresponding per-coin files for that batch
- rerun validation

Because mixed-source support remains in place until `PR-12c`, rollback of `PR-12a` or `PR-12b` is file movement only, not a runtime loader rewrite.

No `WS-7` PR may delete legacy ingestion support until all migration batches are complete and validated.

## Approval / Signoff

This artifact is the required signoff checkpoint for:

- `PR-11`
- `PR-13` if live-reserve scaling touches catalog-driven partitioning or assumes the new source layout

Implementation may proceed under this design unless a later code discovery forces a documented amendment to this artifact.

Signoff:

- Reviewer: Codex
- Date: 2026-04-22
- Approval note: mixed-source generator foundation approved; `PR-11` and any catalog-dependent `PR-13` work may proceed under this source model unless the migration code uncovers a concrete contradiction.
