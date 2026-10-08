# PSI Historical Assets

A small off-catalog metadata set preserves historical PSI and monitoring continuity. `shared/lib/psi-historical-assets.ts` owns `PSI_HISTORICAL_ASSETS`, `PSI_HISTORICAL_IDS` and `PSI_HISTORICAL_META_BY_ID`, separate from the tracked stablecoin registry (`shared/lib/stablecoins/registry.ts`, backed by per-coin files in `shared/data/stablecoins/coins/*.json` plus `shared/data/stablecoins/coins.generated.json`). These are authoritative historical assets, not a shadow computation awaiting promotion. This document retains its existing URL.

---

## Purpose

PSI historical assets preserve important collapse events in systems that would otherwise undercount past systemic stress after an asset leaves the tracked dashboard.

`shared/lib/psi-eligible.ts` combines active tracked assets with the historical set into `PSI_ELIGIBLE_STABLECOINS` / `PSI_ELIGIBLE_IDS`, excluding every non-active tracked entry. Depeg detection, DEWS, replay and backfill inherit this monitoring universe. `worker/src/cron/snapshot-supply.ts` separately composes `WORKER_ACTIVE_IDS` plus `PSI_HISTORICAL_IDS`; it snapshots only non-restored observations actually present in the cache.

Two scope details do not follow from that rule:

- `CORE_PSI_ELIGIBLE_IDS` (core-aggregate active + historical assets) is narrower than `PSI_ELIGIBLE_IDS`; live PSI, historical replay and recompute (`worker/src/lib/psi-history-universe.ts`, `worker/src/lib/psi-recompute.ts`) use that narrower universe and denominator.
- `shared/lib/stablecoin-id-registry.ts` includes historical assets in PSI-inclusive resolution, but public readable resolution excludes them. DDR first-seen membership excludes both UST and IRON (`policyUniverseIncluded=false`); historical terminal-validation examples do not enroll them in public forecasting.

---

## Current Inventory

The current metadata lives in `shared/lib/psi-historical-assets.ts`. Canonical IDs, provider IDs and the historical `algorithmic` backing enum are retained unchanged:

- UST's DefiLlama ID and legacy `ust-terra-classic` canonicalization preserve supply/depeg joins in replay and live grouping.
- IRON has no DefiLlama stablecoin ID; peak-collapse supply coverage is not established by its metadata. Any manual historical insert requires sourced, dated, bounded evidence and provenance; neither missing source data nor an approximate peak comment authorizes fabricated supply.

---

## Public UI Boundary

PSI historical assets are not part of public tracked metadata used for counts, filters or table inclusion:

- `ACTIVE_STABLECOIN_COUNT` remains the technical live-listing count, while `CORE_AGGREGATE_STABLECOIN_COUNT` drives market-aggregate copy; both static projections are kept in sync with their shared registries by tests
- `src/components/stablecoin-table-logic.ts` uses the client registry projection (`CLIENT_ACTIVE_IDS` / `CLIENT_ACTIVE_STABLECOINS` from `shared/lib/stablecoins/client-registry.ts`) as its default inclusion set
- taxonomy/filter pages derive their selectable universe from tracked metadata, not historical metadata

Operational consequence:

- raw cache-backed surfaces can contain a historical asset if upstream sync emits it
- public list/table UX filters those assets out by tracked ID
- public DEWS/radar alerts can render these assets through `shared/lib/psi-eligible-client.ts` and `src/components/dews-alert-feed.tsx`; that does not promote them into the catalog or Bank-Run-Gauge universe

---

## Maintenance

Adding, removing or publicly listing a PSI historical asset is an intentional maintainer decision. [Stablecoin Data Registry](./stablecoin-data.md#editing-rules) requires PSI, depeg and supply-history continuity checks before removal. Metadata eligibility does not imply available observations, complete supply history or catalog promotion.
