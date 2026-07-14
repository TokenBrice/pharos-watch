# Shadow Stablecoins

Two metadata entries are maintained outside the tracked public stablecoin set for historical PSI and depeg continuity:

- `ust-terra`
- `iron-iron-finance`

They live in `shared/lib/shadow-stablecoins.ts` and are intentionally separated from the tracked stablecoin registry (`shared/lib/stablecoins/registry.ts`, backed by per-coin files in `shared/data/stablecoins/coins/*.json` plus `shared/data/stablecoins/coins.generated.json`).

---

## Purpose

Shadow stablecoins preserve historically important collapse events in systems that would otherwise undercount past systemic stress after an asset is delisted from the public dashboard.

They are used where historical continuity matters:

- `shared/lib/psi-eligible.ts` combines active tracked + shadow assets into `PSI_ELIGIBLE_STABLECOINS`, excluding pre-launch and frozen tracked entries
- `worker/src/cron/detect-depegs.ts` and `worker/src/cron/compute-dews.ts` use the PSI-eligible set
- `worker/src/cron/stability-index.ts` filters the live cache against `PSI_ELIGIBLE_IDS`
- `worker/src/cron/snapshot-supply.ts` and `worker/src/api/backfill-supply-history.ts` use the PSI-eligible registry
- `worker/src/api/backfill-cg-prices.ts` also needs the PSI-eligible registry so replay-critical shadow price gaps can be repaired
- `worker/src/api/backfill-depegs.ts` can backfill shadow assets the same way it backfills tracked assets
- `worker/src/api/backfill-dews.ts` can replay DEWS rows over the PSI-eligible universe
- `worker/src/lib/psi-history-universe.ts` centralizes the historical PSI/DEWS replay universe
- `shared/lib/stablecoin-id-registry.ts` includes shadow entries in PSI-inclusive canonical ID resolution; public readable ID resolution excludes shadow-only entries

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

- `ACTIVE_STABLECOIN_COUNT` (from `src/lib/stablecoin-static-data.ts`, kept in sync with `ACTIVE_STABLECOINS.length` by a test) drives public counts in page metadata and copy
- `src/components/stablecoin-table-logic.ts` uses the client registry projection (`CLIENT_ACTIVE_IDS` / `CLIENT_ACTIVE_STABLECOINS` from `shared/lib/stablecoins/client-registry.ts`) as its default inclusion set
- taxonomy/filter pages derive their selectable universe from tracked metadata, not shadow metadata

Operational consequence:

- raw cache-backed surfaces can still contain a shadow asset if the upstream sync emits it
- public list/table UX filters those assets back out by tracked ID

---

## Gotchas

- Do not add a shadow asset to `shared/data/stablecoins/coins/*.json` unless it should become publicly tracked everywhere
- Do not remove a shadow asset without checking PSI, depeg backfill, and supply-history continuity first
- If a shadow asset gains a reliable live source, update both `shared/lib/shadow-stablecoins.ts` and the paths that depend on `PSI_ELIGIBLE_STABLECOINS`
