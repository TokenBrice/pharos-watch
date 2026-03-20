# Yield Intelligence Methodology - Version Timeline

Internal changelog reconstructed from git history. Covers Yield Intelligence `v1.0` through `v4.4` (2026-03-01 -> 2026-03-20).

---

## v4.4 - On-chain rate bootstrapping and pipeline hardening (Mar 20, 2026)

**Commit:** `unreleased`

- On-chain rate configs now emit a seed row with `currentApy: 0` and `exchangeRate` when no previous rate exists, breaking a bootstrapping deadlock that prevented all 13 Tier 1 vaults from ever computing APY
- `buildOnChainSourceKey()` consolidated from 3 duplicate definitions (sync-yield-data, resolve, sources) into a single export from yield-helpers
- `isYieldRelevantDlPool` pre-filter sets (pool IDs and variant symbols) promoted from per-call allocations to module-level constants
- `hydrateYieldRankingsWithLiveSafety` coverage ratio guard fixed to use active card count instead of total card count

---

## v4.3 - Wrapper-preserving ingestion and hydration hardening (Mar 19, 2026)

**Commit:** `unreleased`

- Wrapper-relevant DeFiLlama pools are now preserved through pre-filtering even when upstream `stablecoin` flags are false
- Deterministic on-chain rows now use `onchain:<stablecoinId>` source keys so source-aware history cannot collide with curated pool UUIDs
- `/api/yield-rankings` retains rows with fallback safety (`40` / `NR`) when report-card hydration is incomplete instead of dropping coverage
- Retained benchmark fallback snapshots stay marked degraded, and malformed stored `warning_signals` payloads no longer fail `yield-history`

---

## v4.2 - Source-aware history and confidence-weighted arbitration (Mar 10, 2026)

**Commit:** `unreleased`

- `yield_history` now persists per-source rows with best-source markers instead of a single mixed best series
- 7d and 30d APY metrics are computed from source-specific history, preventing source-switch contamination
- Rankings now include provenance for benchmark freshness, safety coverage, source-switch state, and selection reasoning
- Cross-source arbitration can reject divergent discovered or fallback sources when canonical sources disagree materially

---

## v4.1 - Conservative LUSD Stability Pool source (Mar 7, 2026)

**Commit:** `unreleased`

- Added a deterministic LUSD source using Liquity Stability Pool deposits and CommunityIssuance totals
- APR converts projected LQTY emissions to USD using CoinGecko spot price and intentionally excludes ETH liquidation gains
- LUSD can now surface both the B.Protocol Stability Pool source and auto-discovered lending alternatives

---

## v4.0 - Multi-source rankings and alternative-source transparency (Mar 3, 2026)

**Commit:** `b94e042`

- `yield_data` primary key changed to `(stablecoin_id, source_key)` with per-source rows
- `is_best` now marks the highest-APY source per coin while non-best alternatives are retained
- Tier-2 matching aggregates all valid sources (native map, wrapper map, symbol fallback)
- `/api/yield-rankings` now includes `altSources[]` and the UI exposes `+N` alternative-source details

---

## v3.3 - Coverage ratchet: deterministic overrides + address-aware discovery (Mar 3, 2026)

**Commits:** `d9bf617`, `39f3f95`, `2a45230`, `ce2293d`

- Auto-discovery added minimum APY/TVL filters and expanded protocol allowlist coverage
- Deterministic pool overrides were introduced for hard-to-match symbols, including explicit safety bypass handling
- `findBestLendingPool()` now falls back to underlying token address matches when symbol matching fails
- Price-derived fallback was explicitly extended to BUIDL when no usable on-chain or DeFiLlama source exists

---

## v3.2 - Inherited blacklistability alignment for inline safety scoring (Mar 2, 2026)

**Commit:** `595f176`

- Yield sync safety scoring switched to shared `isBlacklistable()` logic, including reserve inheritance
- Risk penalties in PYS now better reflect inherited blacklist exposure
- Reduced divergence between yield-page safety grades and safety-score outputs

---

## v3.1 - Auto-discovery hardening and finite-math safeguards (Mar 1, 2026)

**Commits:** `2e2a0aa`, `9decd36`, `4402307`

- NAV tokens were included in inline safety scoring instead of defaulting to implicit NR behavior
- Yield sync now reuses cached DeFiLlama pools from DEX sync to reduce upstream fetch failures
- Non-finite 30-day APY volatility values are sanitized before D1 writes

---

## v3.0 - Automatic lending-opportunity discovery (Mar 1, 2026)

**Commit:** `2b1a551`

- Added allowlist-based auto-discovery over DeFiLlama lending pools
- Eligibility is gated by safety score before pool selection
- Introduced `defillama-auto` source type and `lending-opportunity` yield classification

---

## v2.1 - Warning-signal telemetry and fxUSD native mapping (Mar 1, 2026)

**Commits:** `dcdefde`, `35f8021`

- Added `warning_signals` persistence with spike, divergence, trend, reward-heavy, and TVL-outflow checks
- Signal detection now uses market-median APY and prior TVL context per coin
- Tier-2 deterministic source coverage added an explicit fxUSD native mapping

---

## v2.0 - Wave-1 coverage expansion and numerical hardening (Mar 1, 2026)

**Commits:** `f5ecd72`, `6b327eb`

- Added wave-1 variant and pool mappings for additional native-yield stablecoins
- Near-zero-mean handling in stability/variance math prevents coefficient-of-variation blowups
- Safety fallback and finite-value guards were formalized for ranking writes

---

## v1.1 - Launch-audit corrections for APY windowing and display (Mar 1, 2026)

**Commit:** `873842c`

- 7-day APY switched to timestamp-window filtering instead of proportional sample slicing
- Tier-1 previous exchange-rate reads were reused from cached lookup state
- Yield stability display normalized as a true 0-100 percentage in UI components

---

## v1.0 - Initial Yield Intelligence release (Mar 1, 2026)

**Commits:** `0709a1d`, `569664e`, `22695dc`, `81ba632`, `0e7b8b3`

- Introduced three-tier APY resolution (on-chain rate, DeFiLlama pool, NAV price-derived fallback)
- Launched the PYS model (risk penalty + variance sustainability multiplier + scaling factor)
- Added `yield_data` / `yield_history` tables and public `yield-rankings` / `yield-history` API handlers

---

## Notes

- Yield methodology did not initially ship with explicit version tracking; the early entries above were reconstructed from methodology-impacting commit boundaries.
- Canonical machine-readable source: `shared/lib/yield-methodology-version.ts`.
