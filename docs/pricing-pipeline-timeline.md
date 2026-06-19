# Pricing Pipeline Methodology - Version Timeline

Internal changelog reconstructed from the machine-readable methodology version source. Covers Pricing Pipeline `v1.0` through `v6.17` (2026-02-01 -> 2026-06-19).

---

> Older entries are archived in [pricing-pipeline-timeline-archive.md](./pricing-pipeline-timeline-archive.md); this file keeps the 10 most recent.

## v6.17 - Rejected DEX aggregate corroboration guard (June 19, 2026)

- The aggregate `dex-promoted` lane is withheld whenever a promoted protocol DEX candidate exists but fails admission
- A lone protocol DEX candidate that lacks hard market/oracle/protocol corroboration no longer re-enters consensus through the overlapping aggregate lane
- The aggregate `dex-promoted` fallback still enters when no promoted protocol DEX candidate exists and the Binance overlap guard is clear

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
- `dex-promoted` was withheld only when a promoted protocol DEX lane was actually admitted, so rejected lone protocol candidates no longer suppressed the aggregate DEX voice
- Exact-address providers prioritize missing and low-depth priced assets, report request-cap skips, and Jupiter can append bounded soft evidence to agreeing low-depth Solana prices without replacing the primary price

---

## v6.09 - Weak address-provider depeg quarantine (May 24, 2026)

- Single-source fallback/search-family address quotes can no longer publish fixed-peg depeg-sized prices without corroboration
- Exact-address augmentation still fills or corroborates near-peg prices for thin assets
- A fallback/search-family source such as CoinGecko Onchain address pricing is rejected when it is at least 500 bps from a fixed peg and no stronger source corroborates the move
- Rejected weak address-provider candidates fall through to later enrichment, allowing exact DefiLlama contract fallback to repair assets such as Tangent USG when that contract quote remains near peg

---

## v6.08 - Scoped live-parent wrapper price repair (May 24, 2026)

- `sbold-k3-capital` and `ybold-yearn` can publish ERC-4626 NAV prices from `convertToAssets(1 share)` multiplied by fresh high-confidence BOLD live pricing
- `usdk-kast` and `xo-exodus` can inherit fresh high-confidence `wm-m0` pricing as Solana M0 extension units
- The relaxation is scoped to these audited wrappers and does not change historical replay rules or cached-parent eligibility

---

## v6.07 - Curated production price-gap closure (May 24, 2026)

- `mnee-mnee` and `veur-vnx` now use the allowlisted CoinGecko low-volume fallback when DefiLlama supplies circulation but no usable price
- `cadd-cad-digital`, `jpym-mento`, `zarm-mento`, and `xofm-mento` can publish scoped `protocol-redeem` FX-par prices when the relevant CAD/JPY/ZAR/XOF reference is fresh or static
- CADD and the Mento JPY/ZAR/XOF stables can repair DefiLlama zero-supply rows from verified deployments and current FX references when DL chart history is absent or below the tracked repair floor

---
