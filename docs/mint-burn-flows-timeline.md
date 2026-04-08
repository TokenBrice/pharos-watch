# Mint/Burn Flow Methodology - Version Timeline

Internal changelog reconstructed from git history. Covers Mint/Burn Flow `v1.0` through `v5.0` (2026-03-01 -> 2026-04-08).

---

## v5.0 - Bridge-transfer flow exclusion for omnichain tokens (Apr 8, 2026)

**Commit:** `unreleased`

- Bridge-aware classification now excludes mint-side bridge transfers as well as burn-side bridge transfers from counted economic-flow aggregates
- USDai's Ethereum tracker now recognizes its documented LayerZero OFT / OAdapter path instead of treating equal bridge mints and burns as economic issuance/redemption
- Bridge classification now runs after all parsed rows for the config chunk are assembled, so the classifier can see bridge mints and burns together
- Backfill and replay persistence now updates `flow_type` on existing rows, allowing post-deploy repair of previously inserted bridge-transfer noise

---

## v4.9 - Deterministic repair loops and adapter provenance disclosures (Mar 24, 2026)

**Commit:** `unreleased`

- Historical price repair now values unpriced rows from event-day `supply_history` instead of reusing current `price_cache` snapshots
- NULL-price healing and atomic-roundtrip sweeping now process deterministic ordered backlogs instead of relying on implicit D1 row order
- Daily digest FTQ classification now matches the public mint/burn API by using report-card score buckets instead of a separate hardcoded safe-haven list
- Coin `coverage` metadata now exposes adapter kinds plus `startBlockSource` and `startBlockConfidence` so blanket start-block defaults are visible to users

---

## v4.8 - Ethereum coverage wave for long-tail mint/burn tracking (Mar 24, 2026)

**Commit:** `unreleased`

- Added 40 new Ethereum transfer-based contract configs for tracked assets that already had shared Ethereum metadata
- Restored several previously removed long-tail assets now judged worth tracking again given current market-cap and product relevance
- Expanded potential public `/flows` coverage from the low 80s into the low 120s once the extended lane backfills the added assets

---

## v4.7 - Closed-day baseline, fixed aggregate 24h semantics, and coverage disclosures (Mar 10, 2026)

**Commit:** `unreleased`

- Pressure Shift now compares live 24-hour flows against the last 30 fully closed UTC-day baselines instead of mixing the active day into the baseline
- Aggregate `GET /api/mint-burn-flows?hours=N` keeps per-coin 24h fields fixed to the canonical 24-hour window while only `hourly[]` respects `hours`
- Aggregate flow responses now expose `scope`, `sync`, `windowHours`, and per-coin `coverage` metadata
- The public `/flows` page now labels the feature as Ethereum-only and visibly marks partial-history or lagging-coverage states
- Flow freshness is keyed to successful sync timestamps instead of latest event timestamps, avoiding false stale warnings during quiet periods

---

## v4.6 - Safe-frontier ingestion and counted event-history alignment (Mar 9, 2026)

**Commit:** `unreleased`

- Sync-state advancement now stops at the shared safe coverage frontier when any event definition is only partially scanned
- Missing block timestamps now cap advancement at the earliest unresolved block instead of silently skipping rows forever
- `GET /api/mint-burn-events` now exposes `flowType` and supports `scope=counted` for rows that participate in aggregates
- Stablecoin detail event-history views now default to counted economic-flow rows, excluding bridge burns, review-required burns, and atomic roundtrips
- Event rows with missing USD prices now render native token amounts instead of misleading dollar values

---

## v4.5 - Data quality: noise filtering, auto-heal, and activity gating (Mar 9, 2026)

**Commit:** `unreleased`

- Same-transaction mint+burn pairs for the same stablecoin are now flagged as `atomic_roundtrip` and excluded from all flow aggregates
- `sync-mint-burn` now auto-heals recent `amount_usd IS NULL` rows within a 48-hour window using `price_cache`
- Coins with less than $50K of absolute 24h flow now return `NR` for pressure shift instead of a misleading score
- Cron metadata now reports `atomicRoundtripsDetected` and `nullPricesHealed`

---

## v4.4 - Two-signal flow semantics and baseline-aware interpretation (Mar 7, 2026)

**Commit:** `unreleased`

- Per-coin flow UI now separates raw 24h net flow from baseline-relative pressure shift
- API now exposes `pressureShiftScore`, `pressureShiftState`, `netFlowDirection24h`, `has24hActivity`, and baseline context fields
- `flowIntensity` remains in the API as a deprecated compatibility alias for `pressureShiftScore`
- Printer/shredder visuals now follow actual net flow direction instead of score sign

---

## v4.3 - NR gating for no-activity flow windows (Mar 4, 2026)

**Commit:** `unreleased`

- Coins with no mint/burn activity in the active 24h window now publish `null` Flow Intensity (`NR`) instead of a synthetic neutral value
- Bank Run Gauge excludes those NR windows from the market-cap-weighted composite
- Frontend flow-intensity UI now renders NR explicitly for null windows

---

## v4.2 - Signed zero-baseline flow-intensity semantics (Mar 4, 2026)

**Commit:** `unreleased`

- Flow Intensity Score moved from midpoint `0-100` to signed `-100 to +100` semantics
- Bank Run Gauge score moved to signed `-100 to +100` with neutral baseline at `0`
- Band thresholds were remapped around zero while preserving `CRISIS` to `SURGE` labels
- Frontend midpoint conversion shim was removed so UI consumes canonical signed API values directly

---

## v4.1 - Reliability remediation and controlled backfill recovery (Mar 4, 2026)

**Commit:** `20f56c3`

- Added run-state rotation and per-chain budget quotas to improve deterministic coverage under limits
- Added degraded/error status escalation from sustained low coverage or API failures
- Added authenticated chunked backfill endpoint (`POST /api/backfill-mint-burn`) using ingestion pipeline logic

---

## v4.0 - reUSD deposit amount scale correction (Mar 4, 2026)

**Commit:** `a49abfa`

- Corrected reUSD `Deposited` event decimals from `6` to `18`
- Removed reUSD mint-volume inflation caused by scale mismatch
- Added regression test for known on-chain deposit payload decoding

---

## v3.2 - Event-time USD valuation for flow amounts (Mar 3, 2026)

**Commit:** `89ef4fa`

- Event valuation now prefers historical `supply_history` price snapshots for the event day
- Added event-level valuation provenance (`price_used`, `price_timestamp`, `price_source`)
- Added parsed/dropped row accounting for ingestion observability

---

## v3.1 - Alchemy migration and chain-aware scan controls (Mar 3, 2026)

**Commits:** `32f1e37`, `8193ab3`, `3b66c98`

- Replaced Etherscan log ingestion with Alchemy JSON-RPC (`eth_getLogs`)
- Added batch timestamp resolution from `eth_getBlockByNumber` with retry guards
- Added chain-aware scan and safety controls (including Optimism support)

---

## v3.0 - reUSD multi-chain coverage and aggregate dedup fix (Mar 2, 2026)

**Commits:** `34893a5`, `aa2bcb8`

- Added reUSD mint/burn event tracking across Ethereum, Arbitrum, Base, and Avalanche
- Added nth-data-slot amount decoding for non-standard event payload layouts
- Fixed aggregate loop to deduplicate by stablecoin ID, preventing duplicate rows and weighted overcounts

---

## v2.1 - Grade-aware flight-to-quality classification (Mar 1, 2026)

**Commits:** `dcdefde`, `c1c1839`

- FTQ safe/risky classification moved from hardcoded IDs to report-card score buckets
- Fallback to hardcoded safe havens now only applies when report-card cache is stale or missing
- Largest-event attribution aligned to requested `hours` window semantics

---

## v2.0 - USDT treasury-event capture and partial-data gauge support (Mar 1, 2026)

**Commits:** `2144236`, `1eddad0`

- Added `startBlock` per config to avoid pre-deployment scans
- Added USDT `Issue`/`Redeem` ingestion for mint/burn activity not emitted as `Transfer`
- Gauge now computes from available non-null FIS inputs instead of returning null when any coin is immature

---

## v1.0 - Initial Mint/Burn Flow release (Mar 1, 2026)

**Commits:** `06ad0d9`, `e36a0c1`, `2473c86`, `fea681c`

- Introduced phase-1 mint/burn contract coverage for 10 tracked stablecoins
- Shipped FIS, Bank Run Gauge bands, and flight-to-quality detection thresholds
- Shipped incremental sync cron plus aggregate/per-coin API endpoints

---

## Notes

- Mint/burn methodology did not initially ship with explicit version tracking; versions above were assigned retroactively from methodology-impacting commit boundaries.
- Canonical machine-readable source: `shared/lib/mint-burn-flow-version.ts`.
