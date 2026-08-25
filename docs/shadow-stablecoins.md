# Shadow Stablecoins

A small set of metadata entries is maintained outside the tracked public stablecoin set for historical PSI and depeg continuity. `shared/lib/shadow-stablecoins.ts` owns that inventory and each entry's fields; the entries are intentionally separated from the tracked stablecoin registry (`shared/lib/stablecoins/registry.ts`, backed by per-coin files in `shared/data/stablecoins/coins/*.json` plus `shared/data/stablecoins/coins.generated.json`).

---

## Purpose

Shadow stablecoins preserve historically important collapse events in systems that would otherwise undercount past systemic stress after an asset is delisted from the public dashboard.

`shared/lib/psi-eligible.ts` combines active tracked assets with the shadow set into `PSI_ELIGIBLE_STABLECOINS` / `PSI_ELIGIBLE_IDS`, excluding every non-active tracked entry. Any consumer of that set inherits shadow assets, so depeg detection, DEWS, supply snapshots, and the price/depeg/DEWS replay and backfill paths reach shadow assets through it rather than through their own lists.

Two scope details do not follow from that rule:

- `CORE_PSI_ELIGIBLE_IDS` (core-aggregate active + shadow) is narrower than `PSI_ELIGIBLE_IDS`, and the [Stability Index](./stability-index.md) filters the live cache and published DEWS rows against the narrower set; historical PSI replay and recompute (`worker/src/lib/psi-history-universe.ts`, `worker/src/lib/psi-recompute.ts`) build their universe and denominator from that same narrower set
- `shared/lib/stablecoin-id-registry.ts` includes shadow entries in PSI-inclusive canonical ID resolution, while public readable ID resolution excludes shadow-only entries

---

## Current Inventory

The current entries and their metadata live in `shared/lib/shadow-stablecoins.ts` and are not restated here. Two per-asset notes matter beyond that metadata:

- the collapse-era UST entry carries a DefiLlama stablecoin ID, so it also resolves through the live DefiLlama-ID registry path, and historical PSI replay and live PSI depeg grouping both canonicalize legacy `ust-terra-classic` depeg rows onto it so shadow supply history and collapse-era depegs join back together
- the IRON Finance entry has no DefiLlama stablecoin ID and exists mainly for registry/backfill/history continuity; its supply history needs a manual database insert for the peak-collapse period, because neither DefiLlama nor CoinGecko exposes market-cap data for it

---

## Public UI Boundary

Shadow stablecoins are not part of the public tracked-set metadata used for dashboard counts, filters, and table inclusion:

- `ACTIVE_STABLECOIN_COUNT` remains the technical live-listing count, while `CORE_AGGREGATE_STABLECOIN_COUNT` drives market-aggregate copy; both static projections are kept in sync with their shared registries by tests
- `src/components/stablecoin-table-logic.ts` uses the client registry projection (`CLIENT_ACTIVE_IDS` / `CLIENT_ACTIVE_STABLECOINS` from `shared/lib/stablecoins/client-registry.ts`) as its default inclusion set
- taxonomy/filter pages derive their selectable universe from tracked metadata, not shadow metadata

Operational consequence:

- raw cache-backed surfaces can still contain a shadow asset if the upstream sync emits it
- public list/table UX filters those assets back out by tracked ID

---

## Maintenance

Adding, removing, or promoting a shadow asset is a maintainer operation. [Stablecoin Data Registry](./stablecoin-data.md#editing-rules) owns those rules, including the continuity checks required before a shadow asset is removed.
