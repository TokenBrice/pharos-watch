# Pricing Pipeline Methodology - Version Timeline

Internal changelog reconstructed from the machine-readable methodology version source. Covers Pricing Pipeline `v1.0` through `v6.191` (2026-02-01 -> 2026-06-27).

---

> Older entries are archived in [pricing-pipeline-timeline-archive.md](./pricing-pipeline-timeline-archive.md); this file keeps the 10 most recent.

## v6.191 - Missing-price recovery for audited low-volume and NAV assets (June 27, 2026)

- `autoUSD` and `sYUSD` now use authoritative ERC-4626 `convertToAssets(1 share)` NAV pricing against their trusted parent assets
- ERC-4626 NAV overrides run before lower-priority RPC-backed override families so missing wrapper prices are less likely to be skipped by the shared live override budget
- `Noble USDN` now inherits fresh replay-safe tracked `M` pricing as an M0-backed rebasing Noble unit
- `USDK` and `XO` can inherit a fresh replay-safe single-source `wM` parent while still rejecting cached, stale, fallback, and untrusted parents
- `usdn-smardex` and `cadm-mento` join the scoped `coingecko-low-volume` fallback allowlist for near-peg quotes inside the relaxed low-volume freshness window

---

## v6.19 - Authoritative override budget prioritization (June 24, 2026)

- Live authoritative protocol overrides now attempt cache/local repairs before RPC-backed probes
- Local protocol-par and inherited tracked-base overrides can no longer be skipped behind slower ERC-4626 or redeem-preview RPC calls when the 10-second live override budget is exhausted
- RPC-backed override candidates that are still missing a price are attempted before already-priced wrapper candidates in the same cost tier
- Ties preserve existing registry order when priority and missing-price state are equal

---

## v6.18 - Fiat FX upside validation parity (June 23, 2026)

- Fresh or static fiat FX peg references now use the same upside tolerance ratio as USD pegs
- EUR, JPY, GBP, and other fiat FX pegs reject reference-backed upside prints at `1.19x` the FX reference instead of allowing prices up to `2x`
- Gold and silver commodity pegs keep the existing `2x` reference band, including `commodityOunces` scaling for fractional tokens
- Authoritative downside modes keep their existing lower-bound relaxation

---

## v6.17 - DEX aggregate and high-TVL outlier guards (June 19, 2026)

- Primary pricing now withholds the aggregate `dex-promoted` fallback whenever a promoted protocol DEX candidate exists for the asset, even if that protocol candidate is rejected before consensus
- The aggregate DEX fallback remains available only when no promoted protocol candidate exists and the Binance overlap guard is clear
- High-TVL directional pool challenge now selects the largest coherent same-direction protocol subset, so one incoherent outlier no longer vetoes otherwise corroborated DEX replacement evidence

---

## v6.16 - DEX pool replacement price validation (June 14, 2026)

- Pool-challenge protocol medians must now pass the same peg-aware DEX observation validation used by DEX liquidity before they can downgrade or replace a primary price
- Inverse or otherwise implausible commodity pool marks are ignored before pool-challenge divergence and replacement checks
- `pool-tvl-weighted` can still publish corroborated DEX replacements when the protocol medians are plausible for the asset's peg and denomination
- Commodity tokens such as one-ounce gold assets can no longer be published at near-zero inverse prices from malformed challenger rows

---

## v6.15 - DexScreener liquidity breaker isolation (June 7, 2026)

- Optional DexScreener liquidity and discovery pool lookups now use their own `dexscreener-liquidity` circuit breaker
- `dexscreener-prices` now protects only the exact token-address stablecoin pricing fallback
- The optional liquidity breaker remains visible in raw/admin health data but is excluded from public-impact circuit counts
- `sync-dex-liquidity` records one aggregate DexScreener fallback outcome per run, so target-level failures or budget exhaustion cannot trip a source breaker multiple times in one run

---

## v6.14 - Depeg-sized hard-corroborated DEX replacement (June 6, 2026)

- Pool challenge can replace a depeg-sized soft consensus price when a high-TVL DEX protocol median agrees with a hard primary candidate
- The single-protocol replacement exception no longer requires the published soft result itself to be inside the peg depeg threshold
- Replacement still requires $5M+ protocol-level DEX TVL, depeg-sized DEX evidence, material divergence from the published soft result, and hard market/oracle/protocol candidate agreement
- Uncorroborated single-protocol divergence, same-protocol noisy pools, and incoherent cross-protocol DEX prices still preserve the original price while downgrading confidence

---

## v6.13 - RedStone stablecoin-id attribution (June 6, 2026)

- RedStone oracle quotes are now attributed by configured canonical stablecoin id before primary consensus
- Each `REDSTONE_SYMBOL_CONFIG` entry declares the stablecoin id that may consume that feed
- Consensus looks up RedStone quotes by stablecoin id, not by bare asset symbol
- The live RedStone `USDH` feed is pinned to Native Markets USDH because its source set is Hyperliquid/HypEVM-specific, so Hubble USDH no longer receives that quote

---

## v6.12 - High-TVL directional DEX pool challenge (June 5, 2026)

- Pool challenge can replace a recovered soft consensus price when multiple high-TVL DEX protocol medians coherently show the same depeg direction
- The standard replacement path still replaces when at least two protocol medians diverge beyond the peg-aware pool threshold
- The high-TVL multi-protocol path requires at least two protocol medians with $5M+ TVL each, both crossing the peg depeg threshold in the same direction, both diverging from the soft result by at least the depeg threshold, and both agreeing with each other inside the existing pool-challenge bps band
- The single-protocol exception remains limited to hard-corroborated cases, and incoherent cross-protocol prices still only downgrade confidence

---

## v6.11 - High-TVL hard-corroborated pool challenge (June 5, 2026)

- Pool challenge can replace a recovered soft consensus price when a high-TVL DEX protocol median is depeg-sized and agrees with a hard primary candidate
- The standard replacement path still requires at least two independent diverging DEX protocols
- A single-protocol replacement is allowed only when the protocol median has at least $5M TVL, the published price is still inside the peg depeg threshold, the DEX median crosses the peg depeg threshold, and a hard market/oracle/protocol candidate agrees with the DEX mark within the normal consensus threshold
- Same-protocol noisy-pool protection remains in place for lower-TVL or uncorroborated DEX-only disagreements

---

## v6.1 - DEX pricing source utilization expansion (May 24, 2026)

- Hard Curve on-chain coverage now includes audited direct pools plus explicit opt-in one-hop and chained-hop routes that fail closed on missing dependencies or cycles
- `uniswap-v3-dex` and `uniswap-v4-dex` can enter consensus as soft DEX lanes when `dex_prices.price_sources_json` publishes corroborated protocol evidence
- At v6.1, `dex-promoted` was withheld only when a promoted protocol DEX lane was actually admitted, so rejected lone protocol candidates did not suppress the aggregate DEX voice
- Exact-address providers prioritize missing and low-depth priced assets, report request-cap skips, and Jupiter can append bounded soft evidence to agreeing low-depth Solana prices without replacing the primary price

---

## v6.09 - Weak address-provider depeg quarantine (May 24, 2026)

- Single-source fallback/search-family address quotes can no longer publish fixed-peg depeg-sized prices without corroboration
- Exact-address augmentation still fills or corroborates near-peg prices for thin assets
- A fallback/search-family source such as CoinGecko Onchain address pricing is rejected when it is at least 500 bps from a fixed peg and no stronger source corroborates the move
- Rejected weak address-provider candidates fall through to later enrichment, allowing exact DefiLlama contract fallback to repair assets such as Tangent USG when that contract quote remains near peg

---
