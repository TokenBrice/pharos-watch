# Pricing Pipeline Audit

Date: 2026-03-19

Scope:
- Primary price consensus in `worker/src/cron/enrich-prices.ts`
- Consensus selection in `worker/src/lib/price-consensus.ts`
- Confidence assessment and validation references
- DEX price bridge and pool challenge inputs
- Reference-rate side (`sync-fx-rates`, FX, commodity spot)

## Executive Verdict

The pricing pipeline is materially stronger than the 2026-03-18 state, but it still had multiple trust-breaking edge cases before this pass:

1. consensus could fabricate high confidence from transitive disagreement,
2. fixed pegs could silently fall into NAV-style wide clustering when peg references were unavailable,
3. RedStone could be admitted without freshness or venue transparency guarantees,
4. GeckoTerminal probing could overwrite a stronger protocol redemption price,
5. absurd direct-API pools could suppress healthy DeFiLlama coverage before shared sanity gates.

Those five issues are the most important root-cause fixes and are now patched in code and covered by tests.

## How Pharos Knows a Stablecoin Price

Quarter-hourly runtime:

1. `syncStablecoins()` loads DefiLlama stablecoin rows plus fresh FX / commodity references.
2. `fetchPrimaryPrices()` gathers live voices:
   - CoinGecko simple price
   - DefiLlama stablecoins-list price
   - Pyth Hermes
   - Binance spot
   - Coinbase spot
   - RedStone
   - Curve on-chain
   - Curve oracle for `crvusd-curve`
   - promoted DEX prices from `dex_prices`
3. `computePriceConsensus()` forms pairwise agreement clusters and selects a winning cluster / fallback source.
4. Soft-only agreement is challenged against large individual pools from `dex_liquidity.top_pools_json`.
5. GeckoTerminal probe runs only for CG-only single-source assets.
6. Protocol redemption overrides are applied last for wrapper assets.
7. Remaining holes flow through enrichment:
   - DefiLlama contract passes
   - CoinMarketCap batch
   - DexScreener fallback
8. Downstream depeg detection uses the cached primary price plus DEX challenger inputs.

## API Verification Matrix

Code-reviewed and live-probed:

| Source | Endpoint / contract shape checked | Verdict | Notes |
| --- | --- | --- | --- |
| CoinGecko simple price | `/simple/price` | Healthy | Still the main aggregator voice; independent from DL coins path |
| DefiLlama stablecoins list | `stablecoins.llama.fi` | Healthy | Correct primary DL price source; do not replace with DL coins current-by-gecko |
| Pyth Hermes | latest price updates | Healthy | Confidence and staleness logic already materially improved |
| Binance | `/api/v3/ticker/price` | Healthy | Good major-USD venue input |
| Coinbase | `/products/{pair}/ticker` | Healthy | Good regulated venue input, limited symbol coverage |
| RedStone | `/prices?symbols=...` | Healthy with gating fix | Needed timestamp freshness and venue-breakdown admission rules |
| Fluid | `/v2/:chainId/dexes/stats/tickers` + resolver RPC | Healthy | Coverage good, but reserve normalization still needs follow-up review |
| Balancer | `api-v3.balancer.fi` GraphQL | Healthy with data-quality caveat | Live API can return absurd TVL outliers; shared sanity gate now blocks them from suppressing healthier sources |
| Raydium | `/pools/info/list` | Healthy after prior lowercase query fix | Important for Solana coverage |
| Orca | `/v2/solana/pools` | Healthy after prior cursor fix | Important for Solana coverage |
| GeckoTerminal probe | pool price probe path | Healthy | Correctly scoped as a narrow CG-only cross-check |
| DexScreener fallback | token-pools search | Healthy | Still fallback-grade, not a primary price source |
| Frankfurter | `api.frankfurter.* / latest` | Healthy | Daily ECB cadence is the main weakness, not transport |
| Secondary FX | `@fawazahmed0/currency-api` CDN mirror | Healthy with operator risk | Community-maintained; good fallback, weak SLA |
| gold-api.com | `/price/XAU`, `/price/XAG` | Healthy | Good live spot reference, but only spot not full timeseries |

Code-reviewed, not directly live-probed in this pass:

| Source | Verdict | Notes |
| --- | --- | --- |
| Curve on-chain price reads | Logic sound | Relies on configured chain RPCs; existing sanity bounds look correct for stable + commodity scales |
| Protocol redemption overrides | Logic sound | Authority level is appropriate for wrapper assets |

## Findings

### Fixed in this pass

1. High: transitive consensus bug in `price-consensus.ts`
   - Old behavior could merge `1.0000 / 1.0040 / 1.0080` into fake 3-source agreement.
   - Fix: maximal fully pairwise cluster search plus deterministic tie-breaking.

2. High: fixed pegs could silently downgrade into NAV mode when references were unavailable
   - Cause: `pegRef = null` implicitly selected the 500 bps NAV path.
   - Fix: explicit `mode: "fixed" | "nav"` passed from callers.

3. High: RedStone admission allowed stale or opaque entries
   - Cause: no timestamp freshness requirement and no requirement for per-venue breakdown.
   - Fix: reject entries older than 5 minutes or missing venue detail.

4. High: protocol redemption prices could be overwritten by GT probe
   - Cause: override application happened before the GT pass.
   - Fix: apply authoritative overrides after GT probing.

5. High: absurd direct-API pools could suppress good DeFiLlama coverage
   - Cause: `filterPrimaryPoolsPreferDirectApi()` trusted raw direct-API pools before shared TVL sanity filters.
   - Fix: only eligible direct-API pools can suppress overlapping DL pools.

### Confirmed weaknesses still open

1. Medium: token-pair fingerprint dedup is still too coarse
   - Same chain + protocol + token set can collapse legitimate multiple pools.
   - This needs a more explicit identity model, not a quick patch.

2. Medium: pool challengers only see visible `top_pools_json`
   - Large but not top-10 pools can be missed by confirmation logic.
   - Fix likely requires storing a broader challenger set, not just visible pools.

3. Medium: duplicate staged / fallback observations can still overweight `dex_prices`
   - Current observation records do not carry enough identity to dedupe perfectly at write time.
   - This is the next DEX-price integrity fix I would schedule.

4. Medium: symbol fallback in `resolveStablecoinId()` remains ambiguous
   - `symbolToIds.get(sym)?.[0]` can map the wrong stablecoin in collision groups.
   - Needs chain-aware or token-class-aware disambiguation, not first-hit fallback.

5. Medium: Fluid reserve balances need a normalization audit
   - Resolver values are raw reserves and can be misinterpreted as normalized token balances downstream.

## Confidence Assessment Verdict

High-confidence prices are now materially more honest than before this pass because:

- agreement must be fully pairwise,
- equal-size clusters no longer depend on source iteration order,
- fixed pegs do not silently use NAV-wide tolerance,
- RedStone can no longer contribute stale aggregate-only prints,
- protocol redemption marks remain final.

Remaining confidence-model risk is now mostly in the DEX side:
- challenger coverage breadth,
- duplicate observation weighting,
- ambiguous pool/token identity.

## Recommended Next Work

Priority order after the fixes in this pass:

1. add identity-carrying DEX observations so duplicate staged/fallback pools cannot overweight protocol aggregates,
2. redesign pool fingerprinting so legitimate same-pair pools are preserved,
3. store a wider challenger pool set than just visible top-10 rows,
4. replace symbol-first token fallback with chain-aware contract-driven disambiguation,
5. normalize Fluid reserve balances with token decimals before balance-health scoring.
