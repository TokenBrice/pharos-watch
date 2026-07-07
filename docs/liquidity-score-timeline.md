# Liquidity Score Methodology - Version Timeline

Internal changelog reconstructed from git history. Covers Liquidity Score `v1.0` through `v5.84` (2026-02-19 -> 2026-06-29).

---

## v5.84 - Composite Curve LP pair-quality normalization (June 29, 2026)

- Composite Curve LP quote tokens such as 3Crv and FRAXBP now inherit the best pair-quality score of their underlying stablecoin basket instead of falling back to the unknown-token haircut
- LUSD/3Crv-style metapools still retain the balance-health penalty for one-sided inventory, but no longer take an additional unknown-token penalty for the 3Crv quote leg
- The normalization is shared across configured composite pool aliases rather than special-cased to one stablecoin

---

## v5.83 - Top-asset recovery guard quality baseline (June 19, 2026)

- The top-asset coverage guard discounts previously published rows whose raw TVL was dominated by near-zero effective liquidity before deciding whether a recovery run must fail hard
- Raw top-10 covered TVL remains visible in cron metadata; the guard now also records quality-adjusted top-10 guard TVL for near/hard threshold decisions
- True top-asset coverage collapses still fail hard when the previous baseline had meaningful effective liquidity

---

## v5.82 - Large zero-volume pool retention hardening (June 19, 2026)

- Large retained pools must clear the minimum 24-hour volume floor even when a source marks volume as unmeasured
- Pool-state-only direct sources can still expand coverage with smaller eligible pools, but large zero-volume rows no longer bypass the retained-pool anti-poisoning guard
- Volume-to-TVL outlier checks, blocked-DEX filtering, protocol caps, and post-filter aggregate rebuilds continue to run around the stricter retained-pool gate

---

## v5.81 - Unsupported-chain Curve fallback coverage (June 14, 2026)

- GeckoTerminal and CoinGecko Onchain Curve pools remain skipped on Ethereum, Base, Arbitrum, and Polygon, where the native Curve API already owns Curve pool enrichment and price observations
- Curve pools on chains not covered by the native Curve API, such as Plasma, can now pass through secondary discovery after the normal TVL, price-sanity, protocol-cap, and dedupe gates
- Unsupported-chain Curve rows can contribute retained liquidity, challenger-pool evidence, and DEX price observations instead of being dropped solely because their DEX id starts with `curve`

---

## v5.8 - Retained-pool DEX price ownership hardening (June 6, 2026)

- Retained pools below the documented `$50K` DEX price-observation floor can still contribute to liquidity scoring when otherwise eligible, but no longer publish `dex_price_usd` or `price_sources_json`
- DEX price median weighting now keys on source family rather than protocol label: DeFiLlama/direct API `1.0x`, CoinGecko Onchain/GeckoTerminal `0.85x`, DexScreener/CoinGecko tickers `0.55x`
- Fallback rows that claim high-trust protocol names can no longer receive primary-source median weight solely from that venue label
- CoinGecko ticker/orderbook scoring fallback is now limited to absent, no-price, or tiny DEX coverage. DexScreener still repairs weak partial on-chain coverage, but centralized synthetic books no longer churn already-covered DEX assets such as USDe during time-budgeted fallback passes

---

## v5.7 - Peg-aware staged discovery price gate (May 20, 2026)

- Secondary discovery pools with a measured tracked-token price now need that price to pass the existing peg-aware DEX observation sanity gate before their TVL can be staged or merged
- The scoring merge applies the same price gate to already-staged rows, so malformed CoinGecko Onchain / GeckoTerminal rows cannot inflate coin-level or global TVL while waiting for staging TTL cleanup
- Carbon DeFi chain-suffixed secondary-source ids now normalize to the DefiLlama `carbon-defi` protocol cap, adding a cap-level backstop for Carbon rows
- Rows without a measured token price still flow through the existing TVL sanity ceiling, volume/TVL ratio, dedupe, protocol-cap, and retained-pool quality gates

---

## v5.6 - Staged discovery TVL sanity ceiling (May 7, 2026)

- Secondary discovery rows now reject non-finite, negative, or impossible pool TVL values before staging
- The scoring merge applies the same TVL sanity ceiling to already-staged rows, so stale malformed discovery data cannot affect global TVL, drift diagnostics, retained-pool scoring, or DEX price observations
- Valid high-liquidity rows below the ceiling still flow through the existing dedupe, protocol-cap, and retained-pool quality gates

---

## v5.5 - Absolute TVL Depth fallback recalibration and Slipstream sqrt_ratio price (Apr 17, 2026)

- Absolute TVL Depth fallback (used when a coin has no live `circulatingUsd`) now mirrors the ratio formula's anchor via a $1B implied reference mcap: `35 * log10(tvl / 700_000)` replaces the legacy `20 * log10(tvl / 100_000) + 20`
- Yields: $700K → 0, $5M → 30, $140M → 80, ~$500M → clamps at 100 — parity with the ratio branch at 0.07%/0.5%/14%/50% depth of a $1B reference coin
- Coins without market-cap data no longer gain ~24 points of unearned TVL Depth on equivalent liquidity
- Aerodrome/Velodrome Slipstream price observations now derive from on-chain `sqrt_ratio` (Q64.96) via a new `sqrtRatioToSpotPrice` helper; reserve ratios are not spot prices for concentrated-liquidity pools
- Slipstream pools where `sqrt_ratio` is unusable and one side has no tracked USD price are now dropped entirely instead of falling back to a biased reserve-ratio derivation
- Historical rows under v5.4 and earlier remain reconstructable under their original calibration via `shared/lib/liquidity-score-version.ts`

---

## v5.4 - Curve enrichment scoping and staged UUID dedupe (Apr 14, 2026)

- Curve API enrichment is now applied only to Curve DeFiLlama rows; non-Curve pools that share the same token symbols no longer inherit Curve registry metadata, balance ratios, token prices, or metapool-adjusted TVL
- Provider ids with underscores or provider suffixes, such as CoinGecko `uniswap_v3` and `uniswap-v4-ethereum`, normalize to the same pool-identity protocol family as DeFiLlama ids
- Staged discovery can now skip a staged exact pool-id row when it uniquely matches one primary DeFiLlama UUID row by chain, protocol, token set, and pool-shape family
- Ambiguous same-pair staged buckets still remain separate, so legitimate parallel pools are not collapsed by the relaxed optional-metadata wildcard

---

## v5.3 - PancakeSwap trailing-hour volume window (Apr 8, 2026)

- PancakeSwap V3 direct volume now sums official `poolHourDatas.volumeUSD` buckets across a bounded trailing 24-hour window instead of reading the latest `poolDayDatas` row as if it were rolling 24h volume
- Intraday PancakeSwap volume no longer undercounts until UTC rollover just because the current UTC day bucket is only partially populated
- Fresh non-swap day buckets can no longer zero out yesterday's still-relevant trading activity, because the direct fetch now relies on hourly swap buckets instead of latest-day bucket selection
- The PancakeSwap hourly fetch keeps bounded batching under The Graph's `first: 1000` row cap and avoids adding a historical block lookup dependency

---

## v5.2 - Orderbook ticker contract refresh and Balancer exact-address identity (Apr 8, 2026)

- CoinGecko orderbook fallback no longer depends on the deprecated `trust_score` field, which CoinGecko now returns as `null`
- Orderbook ticker intake now validates freshness, finite USD price/volume, and exchange identity directly from observed payload fields instead of a legacy trust badge
- Balancer direct pools now use the API's exact `address` field for identity and dedupe instead of the 32-byte vault pool id, restoring exact-id confirmation against staged discovery and overlap checks

---

## v5.1 - Authoritative protocol confirmation for staged discovery (Apr 7, 2026)

- Staged discovery rows can no longer invent new pools inside protocol families that already have a clean protocol-native direct source
- When a direct protocol-native fetch succeeds cleanly on a supported chain, staged GT/CG/DS rows for Balancer, Fluid, Raydium, Orca, Meteora, PancakeSwap, Aerodrome, and Velodrome must match an authoritative exact pool id or they are excluded
- The guard fails open when the authoritative fetch is degraded or unavailable, so staged discovery still acts as recovery coverage during native-source incidents
- Liquidity cron metadata now records `stagedPoolsSkippedByAuthoritativeProtocol` separately from normal exact-id and derived-identity dedupe skips

---

## v5.0 - Size-aware scoring: relative TVL depth, recalibrated volume, quality retention (Apr 5, 2026)

- All scoring dimensions are now size-independent. TVL Depth measures effective TVL relative to market cap instead of absolute dollar value. Volume Activity has a recalibrated curve with a realistic ceiling (tops out at ~32% V/T instead of ~500%). Pool Quality measures venue quality retention ratio (qualityAdjustedTvl / totalTvl, rescaled) instead of absolute quality-adjusted TVL.
- TVL Depth uses effective-TVL-to-market-cap ratio on a log scale (`35 × log10(ratio / 0.0007)`), with absolute fallback for coins without market cap data
- Volume Activity recalibrated: `38 × (log10(V/T) + 3)` — zero line at 0.1% V/T, tops at ~43% V/T. USDC/USDT now score 86-90 instead of 52-56
- Pool Quality measures quality retention (`qualityAdjustedTvl / totalTvl`, rescaled from 15-80% range to 0-100). Fully size-independent
- Weights rebalanced from `35/20/22.5/15/7.5` to `30/20/20/20/10` — structural quality (Pool Quality + Durability = 40%) now matches depth + activity (50%)
- Coins like BOLD and LUSD with high relative depth ratios see significant score improvements; large-cap coins with low relative depth see depth dimension scores decrease but compensate through volume, durability, and diversity

---

## v4.9 - Blocked dead Bunni DEX inputs (Apr 3, 2026)

- Bunni is now blocked during crawl intake and DeFiLlama pool processing instead of being treated as a live DEX venue
- Retained-pool filters and challenger publication ignore Bunni even if stale rows or unexpected inputs survive earlier gates
- Liquidity scores, `dexPriceUsd`, and downstream DEX cross-checks no longer count Bunni TVL, pool counts, or protocol medians

---

## v4.8 - Direct-source duplicate hardening for Balancer and staged exact ids (Apr 3, 2026)

- All protocol-native direct API pool addresses now reserve their exact ids for later staged/fallback dedupe, even when the direct row itself falls below the scoring floor
- GeckoTerminal / CoinGecko discovery rows can no longer resurrect the same exact pool with incompatible TVL semantics just because the authoritative direct row was sub-threshold
- Balancer `balancer-v3` DeFiLlama rows flagged as stablecoin-only now align to a stable-pair dedupe identity when subtype metadata is missing, preventing duplicate stable-pool counts against the Balancer direct API

---

## v4.7 - Retained-pool DEX price publication (Apr 3, 2026)

- `dex_prices` is now computed from the final retained priced-pool surface after dedupe, caps, and scoring filters
- Pools that are skipped as duplicates or dropped by retained-pool quality filters can no longer keep influencing `dexPriceUsd` or `price_sources_json`
- The published DEX price bridge now matches the same retained pool surface used by challenger publication and liquidity UI detail

---

## v4.6 - Protocol-native DEX coverage expansion (Mar 24, 2026)

- Meteora DLMM now enters the direct-API merge path with measured TVL, 24h volume, balances, and fee data
- PancakeSwap V3 now adds protocol-native primary coverage across BSC and supported EVM chains through official Graph subgraphs
- Aerodrome Slipstream and Velodrome Slipstream now contribute pool-state TVL, balances, fee tiers, and DEX-price observations via the on-chain Sugar view contracts
- Direct-source precedence over overlapping DeFiLlama rows now requires measured non-zero 24h volume, so Slipstream rows expand coverage without displacing stronger DL rows when volume telemetry is absent
- Direct-source precedence now also supports a narrow optional-metadata wildcard for identity-poor DeFiLlama concentrated-liquidity rows, fixing Orca `orca-dex` vs `orca` duplicate pools without broadening staged or fallback dedup
- New concentrated-liquidity quality buckets score PancakeSwap and Slipstream fee tiers consistently with existing Uni V3 logic

---

## v4.5 - Coverage recall hardening and measurement-aware confidence (Mar 24, 2026)

- GeckoTerminal and CoinGecko Onchain token crawls now read multiple bounded pages instead of truncating after page 1
- DexScreener and CoinGecko tickers fallback now trigger for weak partial coverage, not only for pure zero-pool / no-price rows
- Synthetic orderbook fallback rows now keep explicit provenance and no longer spoof themselves as organic `USDC` pairs
- Coverage confidence is now derived from retained-pool measurement quality, protocol breadth, source breadth, and synthetic/decayed TVL share instead of the old fixed `1.0 / 0.85 / 0.55` ladder
- Direct-API pools now default to a shorter maturity assumption (`30` days) and Fluid reserve normalization records whether balances were safely measured
- Shared GT/CG/staged/fallback pool-contribution logic was centralized to reduce merge-path drift

---

## v4.4 - Chain-aware pool identity dedupe and challenger snapshot publishing (Mar 19, 2026)

- Direct API and staged/fallback pools now resolve tracked assets by `chain + address` first, with chain-scoped symbol fallback only when unique
- Cross-source pool dedupe now uses exact pool ids first and derived token-shape matches only when they are unique on both sides, instead of collapsing every same-pair pool through a coarse fingerprint
- Repeated sightings of the same physical pool across direct API, staged, and fallback sources now collapse before `dex_prices` weighting
- Depeg challenger inputs now publish from the full retained pool set instead of the visible top-pools subset
- Fluid pools with missing token decimals fall back to neutral balance rather than using unsafe raw reserve units

---

## v4.3 - Fluid DexReservesResolver balance integration (Mar 18, 2026)

- Fluid pools on Ethereum, Arbitrum, Base, and Polygon now read balances from the official DexReservesResolver instead of staying on a neutral-balance fallback
- Fluid fee detail now comes from the on-chain pool config and is normalized to basis-point badges in the top-pools UI
- Measured Fluid balance ratios now feed pool quality, effective TVL, weighted balance ratio, and stress calculations on resolver-backed chains
- Fluid pools on BSC and Plasma still use neutral-balance fallback because the official resolver is not deployed there

---

## v4.2 - Measured direct-API balance health and normalized pool-detail metadata (Mar 18, 2026)

- Balancer, Raydium, and Orca direct-API pools now preserve measured balance ratios and fee detail through scoring instead of merging with neutral placeholders
- Balancer weighted pools normalize pool balance against target token weights rather than raw reserve symmetry
- Orca vault balances are normalized from raw token units before balance-health calculation
- Top-pool fee tiers are now serialized as real basis points across UniV3, CG-onchain, and direct APIs

---

## v4.1 - Direct API precedence, primary-grade coverage, and fetcher hardening (Mar 18, 2026)

- Direct API pools now replace overlapping DeFiLlama pools before scoring via address/fingerprint dedup, instead of being appended after fallback sources
- Direct API sources now merge before staged discovery and DexScreener/CG-ticker recovery paths, preventing lower-confidence sources from claiming the same pool first
- direct_api-only rows now classify as `primary` coverage, but confidence is no longer forced to `1.0`; it now depends on measured-vs-synthetic retained TVL quality
- Raydium and Orca fetchers were hardened against live API drift (Raydium lowercase `poolType`, Orca cursor pagination / retry handling)
- Fluid pool volume is now normalized to one-sided USD volume instead of summing both raw token legs
- Balancer intake is now constrained to supported stable/weighted pool families on mapped chains only

---

## v4.0 - Log-scale volume, cross-chain removal, durability rebalance (Mar 10, 2026)

- Volume activity moved from a linear scale to `33.3 * log10(vtRatio / 0.005)`, lifting mid-market scores without letting extreme churn dominate
- The cross-chain component was removed from the composite score, with its weight redistributed to TVL depth and pool quality
- Durability weights were rebalanced to `15% organic fraction`, `35% TVL stability`, `25% volume consistency`, and `25% maturity`
- Locked-liquidity was removed from durability because the discovery-stage data is not reliable enough to keep scoring it directly

---

## v3.4 - Retained-pool recomputation and trusted staged-price hardening (Mar 9, 2026)

- Aggregate score inputs are now recomputed from the retained pool set after filtering and TVL caps, preventing dropped pools from leaking stale influence
- HHI now uses the full retained pool set before display truncation, and global 7d volume is deduped by physical pool
- Staged discovery merges now preserve raw DEX metadata and pool-quality multipliers while deduping against token-pair fingerprints
- DEX price observations require a consistent `$50K` post-confidence TVL floor across source families

---

## v3.3 - Separated discovery pipeline with staged pool confidence decay (Mar 9, 2026)

- Discovery sources now run on a dedicated independent 20-minute cron (`3,23,43 * * * *`) with a ~15-minute run budget instead of sharing a short scoring-run budget
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
