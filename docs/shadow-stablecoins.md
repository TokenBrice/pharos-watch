# Shadow Stablecoins

Two metadata entries are maintained outside the tracked public stablecoin set for historical PSI and depeg continuity:

- `ust-terra`
- `iron-iron-finance`

They live in `shared/lib/shadow-stablecoins.ts` and are intentionally separated from the tracked stablecoin registry (`shared/lib/stablecoins/index.ts`, backed by `shared/data/stablecoins/*.json`).

---

## Purpose

Shadow stablecoins preserve historically important collapse events in systems that would otherwise undercount past systemic stress after an asset is delisted from the public dashboard.

They are used where historical continuity matters:

- `shared/lib/psi-eligible.ts` combines `TRACKED_STABLECOINS` + `SHADOW_STABLECOINS` into `PSI_ELIGIBLE_STABLECOINS`
- `worker/src/cron/detect-depegs.ts` and `worker/src/cron/compute-dews.ts` use the PSI-eligible set
- `worker/src/cron/stability-index.ts` filters the live cache against `PSI_ELIGIBLE_IDS`
- `worker/src/cron/snapshot-supply.ts` and `worker/src/api/backfill-supply-history.ts` use the PSI-eligible registry
- `worker/src/api/backfill-depegs.ts` can backfill shadow assets the same way it backfills tracked assets
- `shared/lib/stablecoin-id-registry.ts` includes shadow entries in canonical ID resolution

---

## Current Inventory

### `ust-terra`

- `llamaId: "3"`
- `detailProvider: "defillama"`
- `geckoId: "terrausd"`
- Included in the live DefiLlama-ID registry path via `REGISTRY_BY_LLAMA_ID`
- Historical PSI replay and live PSI depeg grouping also canonicalize legacy `ust-terra-classic` depeg rows onto `ust-terra` so shadow supply history and collapse-era depegs join back together

### `iron-iron-finance`

- No DefiLlama stablecoin ID
- `detailProvider: "coingecko"`
- `geckoId: "iron-stablecoin"`
- Exists mainly for registry/backfill/history continuity; the source file notes that supply history needs manual DB insertion for the peak-collapse period

---

## Public UI Boundary

Shadow stablecoins are not part of the public tracked-set metadata used for dashboard counts, filters, and table inclusion:

- `ACTIVE_STABLECOINS.length` drives public counts in page metadata and copy
- `ACTIVE_IDS` is the default inclusion set used by `src/components/stablecoin-table-logic.ts`, and filtered table subsets are built from `ACTIVE_STABLECOINS`
- taxonomy/filter pages derive their selectable universe from tracked metadata, not shadow metadata

Operational consequence:

- raw cache-backed surfaces can still contain a shadow asset if the upstream sync emits it
- public list/table UX filters those assets back out by tracked ID

---

## Gotchas

- Do not add a shadow asset to `shared/data/stablecoins/*.json` unless it should become publicly tracked everywhere
- Do not remove a shadow asset without checking PSI, depeg backfill, and supply-history continuity first
- If a shadow asset gains a reliable live source, update both `shared/lib/shadow-stablecoins.ts` and the paths that depend on `PSI_ELIGIBLE_STABLECOINS`

---

## File Index

| File | Role |
|---|---|
| `shared/lib/shadow-stablecoins.ts` | Shadow-asset metadata definitions |
| `shared/lib/psi-eligible.ts` | Tracked + shadow PSI eligibility registry |
| `shared/lib/stablecoin-id-registry.ts` | Canonical ID / external-ID resolution including shadow entries |
| `worker/src/cron/stability-index.ts` | PSI computation uses `PSI_ELIGIBLE_IDS` |
| `worker/src/cron/detect-depegs.ts` | Live depeg detection metadata boundary |
| `worker/src/cron/compute-dews.ts` | DEWS iteration over PSI-eligible assets |
| `worker/src/cron/snapshot-supply.ts` | Daily supply snapshot filter includes PSI-eligible assets |
| `worker/src/api/backfill-supply-history.ts` | Admin supply-history backfill over PSI-eligible assets |
| `worker/src/api/backfill-depegs.ts` | Admin depeg-history backfill over PSI-eligible assets |
