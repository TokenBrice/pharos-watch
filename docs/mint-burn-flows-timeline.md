# Mint/Burn Flow Methodology - Version Timeline

Internal changelog reconstructed from git history. Covers Mint/Burn Flow `v1.0` through `v4.2` (2026-03-01 -> 2026-03-04).

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
