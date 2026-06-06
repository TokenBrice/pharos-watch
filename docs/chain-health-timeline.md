# Chain Health Score Methodology - Version Timeline

Internal changelog reconstructed from the machine-readable methodology version source. Covers Chain Health Score `v1.0` through `v1.3`.

---

## v1.3 - Active-only inputs and stale report-card dependency (Jun 6, 2026)

- Live `GET /api/chains` aggregation now filters the stablecoins cache to active, non-frozen, non-defunct assets before deriving peg rates or summing chain supply
- The live aggregation universe now matches the active-only daily `snapshot-chain-supply` path
- `report_card_cache.degradedInputs` now downgrades `_meta.dependencies.reportCards` to `degraded` when cached Safety Scores were computed with stale report-card inputs

---

## v1.2 - Two-bucket backing diversity after active taxonomy cleanup (Apr 7, 2026)

- Reclassified `FPI`, `cUSD`, and `CEUR` out of the legacy algorithmic bucket because each is reserve-backed
- Removed the standalone `algorithmic` backing cohort from active filters and taxonomy pages
- Backing diversity now normalizes across the two live backing cohorts (`rwa-backed` and `crypto-backed`), so an even split scores `100`

---

## v1.1 - Chain environment factor and weight rebalance (Mar 16, 2026)

**Commit:** `f6978ec`

- Added a fifth factor, `chainEnvironment`, scored from chain resilience tiers
- Rebalanced weights to `quality 30%`, `chainEnvironment 20%`, `concentration 20%`, `pegStability 20%`, `backingDiversity 10%`
- `CHAIN_ENVIRONMENT_SCORES` now map tier `1 -> 100`, `2 -> 60`, `3 -> 20`
- Reduced backing-diversity influence and penalized fragile chain environments directly in the composite

---

## v1.0 - Initial Chain Health Score release (Mar 16, 2026)

**Commit:** `003eafd`

- Introduced chain-level health scoring as a `0-100` composite
- Initial factors were `quality 35%`, `concentration 25%`, `pegStability 25%`, and `backingDiversity 15%`
- Added `GET /api/chains`, `/chains/`, and `/chains/[chain]/`
- Shipped the first health bands: `robust`, `healthy`, `mixed`, `fragile`, and `concentrated`

---

## Notes

- Canonical machine-readable source: `shared/lib/chains/health-version.ts` (re-exported by `shared/lib/chain-health-version.ts`)
- Current runtime weights and factor helpers live in `shared/lib/chains/health.ts` and are re-exported by `shared/lib/chain-health.ts`
