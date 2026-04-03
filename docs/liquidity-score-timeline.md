# Liquidity Score Methodology - Version Timeline

Internal changelog reconstructed from git history. Covers Liquidity Score `v1.0` through `v4.8` (2026-02-19 -> 2026-04-03).

---

## v4.8 - Direct-source duplicate hardening for Balancer and staged exact ids (Apr 3, 2026)

**Commit:** `unreleased`

- All protocol-native direct API pool addresses now reserve their exact ids for later staged/fallback dedupe, even when the direct row itself falls below the scoring floor
- GeckoTerminal / CoinGecko discovery rows can no longer resurrect the same exact pool with incompatible TVL semantics just because the authoritative direct row was sub-threshold
- Balancer `balancer-v3` DeFiLlama rows flagged as stablecoin-only now align to a stable-pair dedupe identity when subtype metadata is missing, preventing duplicate stable-pool counts against the Balancer direct API

---

## v4.7 - Retained-pool DEX price publication (Apr 3, 2026)

**Commit:** `unreleased`

- `dex_prices` is now computed from the final retained priced-pool surface after dedupe, caps, and scoring filters
- Pools that are skipped as duplicates or dropped by retained-pool quality filters can no longer keep influencing `dexPriceUsd` or `price_sources_json`
- The published DEX price bridge now matches the same retained pool surface used by challenger publication and liquidity UI detail

---

## v4.6 - Protocol-native DEX coverage expansion (Mar 24, 2026)

**Commit:** `unreleased`

- Meteora DLMM now enters the direct-API merge path with measured TVL, 24h volume, balances, and fee data
- PancakeSwap V3 now adds protocol-native primary coverage across BSC and supported EVM chains through official Graph subgraphs
- Aerodrome Slipstream and Velodrome Slipstream now contribute pool-state TVL, balances, fee tiers, and DEX-price observations via the on-chain Sugar view contracts
- Direct-source precedence over overlapping DeFiLlama rows now requires measured non-zero 24h volume, so Slipstream rows expand coverage without displacing stronger DL rows when volume telemetry is absent
- Direct-source precedence now also supports a narrow optional-metadata wildcard for identity-poor DeFiLlama concentrated-liquidity rows, fixing Orca `orca-dex` vs `orca` duplicate pools without broadening staged or fallback dedup
- New concentrated-liquidity quality buckets score PancakeSwap and Slipstream fee tiers consistently with existing Uni V3 logic

---

## v4.5 - Coverage recall hardening and measurement-aware confidence (Mar 24, 2026)

**Commit:** `unreleased`

- GeckoTerminal and CoinGecko Onchain token crawls now read multiple bounded pages instead of truncating after page 1
- DexScreener and CoinGecko tickers fallback now trigger for weak partial coverage, not only for pure zero-pool / no-price rows
- Synthetic orderbook fallback rows now keep explicit provenance and no longer spoof themselves as organic `USDC` pairs
- Coverage confidence is now derived from retained-pool measurement quality, protocol breadth, source breadth, and synthetic/decayed TVL share instead of the old fixed `1.0 / 0.85 / 0.55` ladder
- Direct-API pools now default to a shorter maturity assumption (`30` days) and Fluid reserve normalization records whether balances were safely measured
- Shared GT/CG/staged/fallback pool-contribution logic was centralized to reduce merge-path drift

---

## v4.4 - Chain-aware pool identity dedupe and challenger snapshot publishing (Mar 19, 2026)

**Commit:** `unreleased`

- Direct API and staged/fallback pools now resolve tracked assets by `chain + address` first, with chain-scoped symbol fallback only when unique
- Cross-source pool dedupe now uses exact pool ids first and derived token-shape matches only when they are unique on both sides, instead of collapsing every same-pair pool through a coarse fingerprint
- Repeated sightings of the same physical pool across direct API, staged, and fallback sources now collapse before `dex_prices` weighting
- Depeg challenger inputs now publish from the full retained pool set instead of the visible top-pools subset
- Fluid pools with missing token decimals fall back to neutral balance rather than using unsafe raw reserve units

---

## v4.3 - Fluid DexReservesResolver balance integration (Mar 18, 2026)

**Commit:** `unreleased`

- Fluid pools on Ethereum, Arbitrum, Base, and Polygon now read balances from the official DexReservesResolver instead of staying on a neutral-balance fallback
- Fluid fee detail now comes from the on-chain pool config and is normalized to basis-point badges in the top-pools UI
- Measured Fluid balance ratios now feed pool quality, effective TVL, weighted balance ratio, and stress calculations on resolver-backed chains
- Fluid pools on BSC and Plasma still use neutral-balance fallback because the official resolver is not deployed there

---

## v4.2 - Measured direct-API balance health and normalized pool-detail metadata (Mar 18, 2026)

**Commit:** `unreleased`

- Balancer, Raydium, and Orca direct-API pools now preserve measured balance ratios and fee detail through scoring instead of merging with neutral placeholders
- Balancer weighted pools normalize pool balance against target token weights rather than raw reserve symmetry
- Orca vault balances are normalized from raw token units before balance-health calculation
- Top-pool fee tiers are now serialized as real basis points across UniV3, CG-onchain, and direct APIs

---

## v4.1 - Direct API precedence, primary-grade coverage, and fetcher hardening (Mar 18, 2026)

**Commit:** `unreleased`

- Direct API pools now replace overlapping DeFiLlama pools before scoring via address/fingerprint dedup, instead of being appended after fallback sources
- Direct API sources now merge before staged discovery and DexScreener/CG-ticker recovery paths, preventing lower-confidence sources from claiming the same pool first
- direct_api-only rows now classify as `primary` coverage, but confidence is no longer forced to `1.0`; it now depends on measured-vs-synthetic retained TVL quality
- Raydium and Orca fetchers were hardened against live API drift (Raydium lowercase `poolType`, Orca cursor pagination / retry handling)
- Fluid pool volume is now normalized to one-sided USD volume instead of summing both raw token legs
- Balancer intake is now constrained to supported stable/weighted pool families on mapped chains only

---

## v4.0 - Log-scale volume, cross-chain removal, durability rebalance (Mar 10, 2026)

**Commit:** `unreleased`

- Volume activity moved from a linear scale to `33.3 * log10(vtRatio / 0.005)`, lifting mid-market scores without letting extreme churn dominate
- The cross-chain component was removed from the composite score, with its weight redistributed to TVL depth and pool quality
- Durability weights were rebalanced to `15% organic fraction`, `35% TVL stability`, `25% volume consistency`, and `25% maturity`
- Locked-liquidity was removed from durability because the discovery-stage data is not reliable enough to keep scoring it directly

---

## v3.4 - Retained-pool recomputation and trusted staged-price hardening (Mar 9, 2026)

**Commit:** `unreleased`

- Aggregate score inputs are now recomputed from the retained pool set after filtering and TVL caps, preventing dropped pools from leaking stale influence
- HHI now uses the full retained pool set before display truncation, and global 7d volume is deduped by physical pool
- Staged discovery merges now preserve raw DEX metadata and pool-quality multipliers while deduping against token-pair fingerprints
- DEX price observations require a consistent `$50K` post-confidence TVL floor across source families

---

## v3.3 - Separated discovery pipeline with staged pool confidence decay (Mar 9, 2026)

**Commit:** `unreleased`

- Discovery sources now run on a dedicated half-hourly trigger (`6,36 * * * *`) with a 12-minute shared run budget instead of sharing a short scoring-run budget
- Individual discovery candidates are capped by a 25-second per-coin crawl budget so one slow asset cannot consume the full run
- Staged pools merge into scoring with freshness confidence decay `max(0.5, 1 - ageHours/48)` and fall out after 24 hours
- Chain-aware source routing now skips irrelevant networks, reducing wasted crawl attempts
- Tiered priority with exponential backoff prevents repeated looping on pool-less coins

---

## v3.2 - Effective TVL symbol-fallback inflation fix (Mar 2, 2026)

**Commit:** `71cc096`

- Fixed effective TVL inflation when non-Curve pools matched Curve entries by symbol fallback
- Metapool-adjusted TVL now applies only to address-matched Curve pools
- Symbol-fallback pools keep their own TVL for effective TVL computation

---

## v3.1 - Anti-duplication and TVL cap normalization (Feb 28-Mar 1, 2026)

**Commits:** `0b6bfb8`, `617ab25`, `1224015`, `0e54c20`

- Added token-pair fingerprint deduplication across DeFiLlama and CG/GT/DS sources
- Added per-pool and protocol-level TVL caps anchored to DeFiLlama protocol ceilings
- Distributed protocol cap reductions into chain totals to keep global sums coherent

---

## v3.0 - Coverage expansion with fallback sources (Feb 28, 2026)

**Commits:** `6b2e006`, `ef9bb2b`

- Added DexScreener fallback for coins still at zero pools after primary crawl
- Added CoinGecko tickers fallback for orderbook-heavy assets (for example, KAU/KAG)
- Reduced false zero-liquidity outcomes for long-tail assets

---

## v2.2 - No-pool rows switched to NR semantics (Feb 27, 2026)

**Commit:** `06c6681`

- Coins without DEX pools now persist `liquidity_score = NULL` instead of `0`
- Daily liquidity snapshots for zero-pool coins also store `NULL`
- Allows downstream systems to distinguish not-rated from low-rated

---

## v2.1 - Onchain source upgrade + locked-liquidity durability term (Feb 25, 2026)

**Commits:** `361e240`, `4f6d9ed`

- Upgraded primary pool discovery to CoinGecko Onchain (with GT fallback)
- Added locked-liquidity input to durability
- Durability weights changed from `40/25/20/15` to `35/25/20/15/5`

---

## v2.0 - Six-component v2 model (Feb 19, 2026)

**Commit:** `0254445`

- Replaced the 5-component model with a 6-component model
- Weights changed from `35/25/20/10/10` to `30/20/20/15/7.5/7.5`
- Introduced effective TVL, durability decomposition, and component persistence

---

## v1.0 - Initial DEX liquidity release (Feb 19, 2026)

**Commits:** `a7ae273`, `443ac1b`, `f26fdf3`

- Initial DEX liquidity score pipeline shipped
- Initial component set: TVL depth, volume, pool quality, pair diversity, cross-chain
- API endpoint and dashboard integration launched

---

## Notes

- Liquidity methodology did not initially ship with explicit version tracking; versions above were assigned retroactively from score-impacting commit boundaries.
- Canonical windows for historical labeling are encoded in `shared/lib/liquidity-score-version.ts`. The historical methodology-version migration now lives inside `worker/migrations/0000_baseline.sql` after the D1 squash.
