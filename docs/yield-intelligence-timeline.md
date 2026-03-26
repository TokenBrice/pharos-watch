# Yield Intelligence Methodology - Version Timeline

Internal changelog reconstructed from git history. Covers Yield Intelligence `v1.0` through `v5.1` (2026-03-01 -> 2026-03-26).

---

## v5.1 - Yield Infrastructure Automation (Mar 26, 2026)

- Chain-scoped Layer 3 symbol matching prevents cross-chain false positives in auto-lending discovery
- Variant symbol auto-scanner detects new wrapper tokens (sXXX/stXXX/wXXX prefix and SAVE/VAULT/EARN/STAKE suffix patterns) in advisory mode
- Monthly yield coverage audit cron (`0 6 1 * *`, 1st of month at 06:00 UTC) provides protocol expansion recommendations
- Protocol recommendations classify missing protocols as high-confidence (>$10M, 3+ pools) or review-needed

---

## v5.0 - Yield Coverage Expansion — Protocol-Native API Wave (Mar 25, 2026)

- 10 protocol-native adapters added: Hashnote USYC, Ondo oracle, Morpho GraphQL, Pendle REST, Yearn Kong GraphQL, Beefy REST, Aave V3 on-chain, Compound V3 on-chain, BIMA Earn
- USTB + thBILL promoted to on-chain ERC-4626 exchange rate reads (previously T-bill proxy only)
- cusd-cap flagged yield-bearing
- 19 new lending protocols added to the auto-discovery allowlist
- TVL floor lowered for smaller ecosystems
- DeFiLlama yield history backfill for instant 365-day charts

---

## v4.11 - Protocol-native BIMA savings fallback for USBD (Mar 24, 2026)

**Commit:** `unreleased`

- `usbd-bima` now resolves through BIMA's public `earn/pools` feed when no usable DeFiLlama `sUSBD` wrapper pool is available
- Protocol-owned earn APIs are now treated as curated yield sources in the arbitration layer
- The source-link registry and public about-page data-source copy now include BIMA's earn surface

## v4.10 - Richer freshness provenance and curated lending source links (Mar 24, 2026)

**Commit:** `unreleased`

- Rankings provenance now exposes source-observation age and comparison-anchor timing for derived sources such as price-derived and on-chain APYs
- This removes the prior optimistic `age = 0` behavior for derived rows whose underlying snapshots may be materially older than the sync run
- The lending allowlist now has curated source-link coverage for every supported protocol label

## v4.9 - Publish-safe retention and deterministic adapter quarantine (Mar 24, 2026)

**Commit:** `unreleased`

- Yield rankings payloads are now preflighted before live-row mutation, reducing DB/cache divergence risk when publication would fail
- Degraded runs now retain prior current rows by skipping destructive yield cleanup instead of pruning optimistically under impaired inputs
- `dusd-dtrinity` and `reusd-re-protocol` were removed from the generic Tier 1 ERC-4626 reader until protocol-specific deterministic adapters exist

## v4.8 - Explicit edge-case overrides for remaining high-signal lending markets (Mar 24, 2026)

**Commit:** `unreleased`

- Polaris pUSD now resolves through a deterministic Silo v2 lending override, fixing the prior bypass-only configuration gap
- Added deterministic exact-symbol lending overrides for USDX, USDO, and USDM
- These overrides bypass the generic C- safety gate only for a short named list of high-signal edge cases rather than lowering the global discovery threshold

---

## v4.7 - Early NAV fallback support and deeper long-tail lending coverage (Mar 24, 2026)

**Commit:** `unreleased`

- Price-derived APY now uses the oldest available 7-45 day price anchor instead of requiring a strict 30-day sample, improving early NAV-token coverage
- Auto-discovered lending floors moved from `$500K / 0.5%` to `$100K / 0.1%` to capture still-meaningful long-tail markets
- Added More Markets and SmarDex USDN to the curated lending allowlist, plus an explicit Polaris pUSD safety bypass for vetted yield-bearing coverage

---

## v4.6 - Rate-derived treasury expansion and broader lending discovery (Mar 24, 2026)

**Commit:** `unreleased`

- Added rate-derived Treasury fallback coverage for `usyc-hashnote` and `thbill-theo`
- Expanded the curated lending allowlist with live-observed protocols including Loopscale, Vesper, Lista Lending, Liqwid, Overnight, Lagoon, and NAVI Lending
- Lowered the lending auto-discovery TVL floor from `$1.0M` to `$0.5M` to capture still-meaningful long-tail markets without admitting dust pools

---

## v4.5 - Fail-closed source validation and retained-market benchmark continuity (Mar 23, 2026)

**Commit:** `unreleased`

- Direct DeFiLlama yield fetches now degrade when the payload shape is invalid or when the response contains zero relevant stablecoin pools
- Yield sync now surfaces full deterministic Tier 1 outages as degraded runs instead of quietly publishing as if on-chain coverage were optional for that cycle
- Retained Treasury benchmark fallbacks preserve the last market-derived benchmark fields across degraded streaks, and rankings-cache publication blocks on severe shrink relative to the previous cache

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
