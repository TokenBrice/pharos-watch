# Liquidity Data Accuracy Audit (2026-04-16)

## Summary

The /liquidity ingestion pipeline is broadly healthy. Field mapping for Curve, DefiLlama Yields, Uniswap V3 / Aerodrome subgraphs, Balancer, Raydium, Orca, Fluid (post-resolver enrichment), PancakeSwap V3 and Slipstream is correct in the common case, with peg-aware sanity gates pulling outliers out of price observations. Two real bugs stand out:

1. Meteora derives a per-pool price from raw normalized reserves and **prefers** that derived value over the API's correct `current_price`. For DLMM pools (concentrated liquidity), the reserve ratio is not the spot price, so any imbalanced Meteora pool publishes a wrong price into both the pool entry and the price-observation lane. The price-sanity gate masks this for stablecoin pairs by silently dropping anything outside [0.95, 1.05], which means we lose Meteora coverage rather than emitting bad numbers, but it is still a correctness bug in extraction.
2. Fluid's hardcoded `volume24hUsd = base_volume + target_volume` fallback is wrong (sum of two raw token-unit sides masquerading as USD). It is hidden in production because `derivePoolVolume24hUsd` overrides it via the `tokenVolumes24h` averaging path, but only as long as at least one side resolves to a USD reference price — which is true for every stablecoin-paired Fluid pool. The dead branch is a footgun for non-stablecoin pools and surfaces if the override path ever short-circuits.

The remaining findings are mostly hygiene-level: a misnamed CG "balance ratio" that is actually a price ratio and capped to a no-op range, a `mintTvl: 10000` Balancer filter that is evaded by upstream mis-reported `totalLiquidity` such as the Fantom DEI pool's $337B value (caught later by `DIRECT_API_MAX_POOL_TVL_USD = $10B`), and a Pancake/Slipstream fee classifier that labels 25bp pools as "30bp" because it only knows three buckets. A handful of doc-vs-code drift items (Balancer "14 chains" vs 16 in `BALANCER_CHAIN_MAP`) round out the report. Most direct fetchers correctly throw or return non-`ok` results on upstream failure, so circuit breakers stay accurate.

## Critical Findings

### C1: Meteora overrides correct API price with reserve ratio

- File: `worker/src/cron/dex-liquidity/fetch-meteora.ts:118-145`
- Symptom: `derivedPrice = token_y_amount / token_x_amount` is computed from already-normalized reserves and unconditionally takes precedence over `current_price` in the `price` field that downstream consumers (price observations, top pools, challenger pools) use. `token_x_amount` / `token_y_amount` are not Uniswap-V2-style spot reserves on Meteora DLMM — they are the active inventory across all bins, which on a CLMM is a function of the *active range*, not of the price.
- Real API response (`https://dlmm.datapi.meteora.ag/pools?page=1&limit=2`):
  ```json
  {
    "address": "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
    "name": "SOL-USDC",
    "token_x_amount": 22710.294731553997,
    "token_y_amount": 1798210.074553,
    "current_price": 84.99974593819722,
    "tvl": 3728005.5600712495
  }
  ```
  Reserve ratio: `1798210.07 / 22710.29 ≈ 79.18`. Actual market price: `84.99`. Error: ~6.8%. Imbalance is the norm for DLMM bins, not the exception.
- Expected: prefer `current_price` (already a clean spot quote), fall back to nothing (or to the reserve ratio only for symmetric AMMs). Meteora DLMM pools are concentrated liquidity, not constant-product.
- Impact:
  - Top-pool JSON shows wrong prices for Meteora rows.
  - DEX price observation extraction multiplies the wrong price by the other token's USD reference and emits skewed numbers.
  - The peg-aware sanity gate (`isPlausibleDexObservationPrice`) drops anything outside the per-peg band, so for stablecoin pairs the bug usually manifests as **silent loss of Meteora price observations** rather than visible mispricing — but coverage is materially understated for any imbalanced Meteora stable-stable pool. For non-stablecoin Meteora rows that sneak through (or for pegged-currency pairs with looser bands), it surfaces as visibly wrong prices.
  - The unit test `fetch-meteora.test.ts` happens to pick `token_x_amount=100, token_y_amount=9000, current_price=90` — a coincidentally balanced sample — and never asserts on `pools[0].price`, so the bug is not covered.
- Fix direction: invert the precedence — use `current_price` first, fall back to the reserve ratio only if `current_price` is missing AND the pool type is constant-product. For DLMM specifically, never trust reserve ratio as a price.

### C2: PancakeSwap classifier mislabels 25bp pools as 30bp

- File: `worker/src/cron/dex-liquidity/direct-source-helpers.ts:9-18` and `worker/src/cron/dex-liquidity/fetch-pancakeswap.ts:192-202`
- Symptom: PancakeSwap V3 fee tiers are 100, 500, 2500, 10000. The code computes `feeBps = feeTier / 100` so the candidate buckets are 1, 5, 25, 100. `classifyClPoolType` only knows `<=1` → 1bp, `<=5` → 5bp, else → 30bp. So both the 0.25% and 1% tiers collapse to the `pancakeswap-v3-30bp` bucket and inherit the 0.4x quality multiplier, even though the 0.25% tier is structurally tighter.
- Real API: PancakeSwap subgraph `feeTier` enum is a stringified integer matching the on-chain pool fee in 1e6 units (100 / 500 / 2500 / 10000).
- Expected: A dedicated `25bp` bucket (or at least mapping `<= 25` to a tighter retention multiplier than 30bp). Same issue applies to Aerodrome Slipstream and Velodrome Slipstream because they share `classifyClPoolType` — those protocols actually use 1, 4, 30, 100 bp tiers, so the existing 1bp / 5bp / 30bp buckets are roughly correct for Slipstream but the 100bp tier is also collapsed into "30bp".
- Impact: 25bp PancakeSwap pools get the same quality penalty as 100bp pools. Quality-adjusted TVL and effective TVL for the affected pool set are systematically understated. Methodology drift versus the intent in `docs/dex-liquidity.md`'s quality multiplier table.
- Fix direction: extend `classifyClPoolType` with explicit `25bp` (and ideally `100bp`) buckets and corresponding entries in `QUALITY_MULTIPLIERS`. Alternatively, add a `<=25 → 30bp-ish` bucket but keep it distinct from the >25 tail.

## Major Findings

### M1: Fluid hardcoded one-sided volume fallback is wrong

- File: `worker/src/cron/dex-liquidity/fetch-fluid.ts:183-189`
- Symptom: Fluid's per-ticker `base_volume` and `target_volume` are token amounts in base / target units. The code does:
  ```ts
  volume24hUsd:
    (Number.isFinite(baseVol) ? baseVol : 0) +
    (Number.isFinite(targetVol) ? targetVol : 0),
  ```
  This adds two raw token-unit sides and stores the result in a USD-typed field. For the live USDC/USDT pool example that becomes `84,111,582 + 84,082,503 ≈ 168M`, double-counting the actual ~$84M one-sided volume; for a wstETH/WETH pool it becomes a meaningless `wstETH count + WETH count ≈ 4496` interpreted as USD.
- Real API (`https://api.fluid.instadapp.io/v2/1/dexes/stats/tickers`):
  ```json
  {
    "base_currency": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "target_currency": "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "base_volume": "84111582.628527419587158264",
    "target_volume": "84082503.18918608751577339781"
  }
  ```
- Expected: the correct one-sided USD volume for this pool is `~84M`, not `~168M`.
- Impact: This bug is masked in production because `derivePoolVolume24hUsd` (`worker/src/lib/dex-api-token-pricing.ts:99-144`) sees the populated `tokenVolumes24h` array, looks up each side's USD reference price, and averages the resulting USD candidates. For any stablecoin-paired Fluid pool that path returns the correct one-sided volume. The hardcoded sum is only the fallback when **neither** side resolves to a USD reference, which happens only for pools that aren't stablecoin pairs and therefore don't get scored. Still, the field value persists into raw structures (`top_pools_json`, debugging telemetry), and any future code path that reads `pool.volume24hUsd` directly (without going through `derivePoolVolume24hUsd`) inherits the bug.
- Fix direction: do not write `baseVol + targetVol` to `volume24hUsd`. Either set it to `0` and rely on the `tokenVolumes24h` derivation, or compute a properly USD-denominated value from the resolver if available.

### M2: CoinGecko "balance ratio" is actually a token-price ratio and never returns a useful value

- File: `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts:21-33`
- Symptom: `inferCgBalanceRatio` returns `min(basePrice, quotePrice) / max(basePrice, quotePrice)` and only emits the value when it is `> 0.5`. This is a ratio of two token USD prices, not pool inventory balance. For USDC/USDT it returns ~0.9997. For USDC/WETH it returns ~0.0004 → rejected. So in practice the function only emits values for stable-stable pairs, where the result is always ~1.0 — i.e., it is doing nothing except marking stable-stable CG-discovered pools as "balanced".
- Expected: a real balance ratio compares pool inventory in USD, not the prices themselves. CG onchain doesn't expose raw reserves so the function can't derive a true ratio without changing the source. The honest fix is to either remove the field or explicitly mark it as a "stable-pair confidence" signal so downstream `balanceMeasured` accounting doesn't credit CG rows with measured inventory they don't have.
- Impact: CG pools that pass the filter look "balance-measured" in `coverage_confidence`/`balance_measured_tvl_usd` aggregates, inflating measurement coverage. The frontend's measured/partially-measured/unobserved labelling is biased upward for CG-only assets.
- Fix direction: drop `inferCgBalanceRatio` from the CG path or rename/repurpose it as a binary stable-pair flag, and stop counting CG rows as `balanceMeasured: true` in `convertToGtNewPools` / `addSecondaryPoolContribution` unless real reserves are available.

### M3: Balancer accepts upstream-corrupt `totalLiquidity` until the global $10B cap

- File: `worker/src/cron/dex-liquidity/fetch-balancer.ts:181-226`
- Symptom: The GraphQL query asks for `where: { minTvl: 10000 }` but Balancer V3 still returns historical Fantom pools with absurd `totalLiquidity` values (the multiUSDC/DEI pool reports `totalLiquidity = "337677697052.70"`, i.e. $337B). The fetcher only checks `tvlUsd > 0`, so any pool the API reports gets through the fetcher; only the centralized `DIRECT_API_MAX_POOL_TVL_USD = 10_000_000_000` cap in `dex-api-pool-shaping.ts:24` filters it later.
- Real API:
  ```json
  {
    "id": "0x4e415957aa4fd703ad701e43ee5335d1d7891d8300020000000000000000053b",
    "type": "STABLE",
    "chain": "FANTOM",
    "dynamicData": { "totalLiquidity": "337677697052.70", "volume24h": "0.00" },
    "poolTokens": [
      { "symbol": "multiUSDC", "balance": "0.000001", "balanceUSD": "0.00000005684014991798558" },
      { "symbol": "DEI", "balance": "1000002064258.7402", "balanceUSD": "337677697052.6986" }
    ]
  }
  ```
- Expected: such pools should be filtered as upstream data errors before they hit pool identity dedupe. The current $10B max catches the worst case but a saner per-source cap (say $2B) plus a sanity check on per-token balanceUSD would catch the long tail.
- Impact: deduper and protocol-cap math see junk pools as candidates and waste cycles; per-token derived prices `balanceUSD / balance` for these rows produce nonsense values (`337677697052 / 1000002064258 ≈ 0.34`) that *would* pass the peg-aware sanity gate's loose lower bound for some currency pegs. The price-sanity gate plus protocol-level TVL caps usually contain the damage, but it is fragile.
- Fix direction: harden `fetch-balancer.ts` with a per-pool sanity gate (e.g. drop pools where `totalLiquidity` is more than 100x the expected in-protocol max, or where any single `balanceUSD` exceeds a chain-aware cap), and skip pools whose `chain` resolves to `fantom` until Balancer cleans up the old Fantom shards (or block the chain explicitly).

### M4: Balancer derived per-token price relies on first-token iteration order

- File: `worker/src/cron/dex-liquidity/fetch-balancer.ts:192-220`
- Symptom: `pool.price` is computed by walking `poolTokens` in order and taking the first token with `balance > 0` and `balanceUSD > 0` — `price = balUsd / bal`. This is a per-token USD price for whichever token happens to come first in the GraphQL response. The pool-level `price` is then opaque about which token it represents. Downstream `deriveTokenUsdPrice` would use this `pool.price` as `token0_per_token1` (treating it as a price ratio between the two tokens), but here it is a USD price for an unspecified token — the semantic is wrong.
- Mitigation already in place: each token is also assigned its own `priceUsd: balUsd / bal` in the `tokens.map(...)` block, so `deriveTokenUsdPrice` actually uses the per-token value and never reaches the `pool.price` fallback for Balancer rows. **Balancer prices are correct in practice**, but the misleading `pool.price` field is a footgun for any future code that reads it without going through `deriveTokenUsdPrice`.
- Fix direction: drop `pool.price` for Balancer (set it to `null`) since per-token `priceUsd` is authoritative, or document the field's semantic clearly in `dex-api-types.ts`.

### M5: Slipstream reserve-ratio price is unreliable for concentrated liquidity

- File: `worker/src/cron/dex-liquidity/fetch-slipstream.ts:174-204`
- Symptom: Slipstream pools (Aerodrome / Velodrome v3-style CL) read `reserve0` and `reserve1` from the Sugar `all()` view and set:
  ```ts
  price: reserve0 > 0 ? reserve1 / reserve0 : null,
  tvlUsd: reserve0 * token0PriceUsd + reserve1 * token1PriceUsd,
  ```
  Reserves on a CL pool reflect total inventory across active and out-of-range positions, not the spot price. The reserve ratio is only the spot price for symmetric AMMs. Although decimal normalization is correctly applied via `bigintToDecimal`, the resulting price is structurally wrong for any CL pool whose liquidity is asymmetrically distributed around the active tick.
- Expected: derive Slipstream price from `sqrt_ratio` (which the Sugar view returns and the code currently ignores). `priceX96 = (sqrtPriceX96 / 2^96) ^ 2 * (10^token0Decimals / 10^token1Decimals)`.
- Impact:
  - The pool-level `price` field is wrong for any concentrated Slipstream pool. The peg-aware sanity gate filters it out for stablecoin pairs, so price observations are not corrupted, just lost.
  - `tvlUsd` is *also* derived from reserves, but the code uses the tracked stablecoin's pinned USD price for one side and infers the other side's price from the reserve ratio (lines 167-176). That means tvlUsd is **internally consistent** (both sides come out priced as if the reserve ratio were the spot), but the absolute number can be off when the actual on-chain price diverges from the reserve ratio. For tightly pegged pools this is small. For volatile ones it can be material.
- Fix direction: parse the existing `sqrt_ratio` from the Sugar struct and derive the spot price from it. Then use `priceUsd = sqrt_price * (token1_per_token0)` and recompute TVL from one tracked side plus the spot ratio, not from the raw reserves.

### M6: Aerodrome / Velodrome Slipstream `pool_fee` semantics are not verified against the live contract

- File: `worker/src/cron/dex-liquidity/fetch-slipstream.ts:179-184`
- Symptom: `feeBps = Number(pool.pool_fee)` and the value is fed into `classifyClPoolType` directly, assuming it is already in basis points. The Sugar view's `pool_fee` field is documented as the dynamic fee in 1e6 units (`100` = 0.01% = 1bp) on Velodrome, but this varies between Aerodrome and Velodrome Sugar revisions. The unit tests use `pool_fee: 1n` and `pool_fee: 100n` as 1bp / 100bp respectively, but those are hand-crafted, not real-API fixtures.
- Expected: confirm against the live Sugar deployment. If the contract returns the value in 1e6 units (likely), the conversion should be `feeBps = Number(pool.pool_fee) / 100`.
- Impact: if the assumption is wrong, every Slipstream pool gets misclassified into the 30bp bucket and inherits 0.4x quality. Worth a one-time live check against `0x27fc745390d1f4BaF8D184FBd97748340f786634` (Base) and `0xA64db2D254f07977609def75c3A7db3eDc72EE1D` (Optimism) before more Slipstream coverage rolls out. (Live `eth_call` against the public Tenderly RPC reverted in this audit so the assumption could not be verified end-to-end here.)
- Fix direction: add a one-shot real-fixture test that decodes the real Sugar `all()` response and asserts the resulting `poolType` and `feeRate` match expectations.

### M7: Pancake fee classifier loses 100bp tier silently

- File: `worker/src/cron/dex-liquidity/direct-source-helpers.ts:9-18`
- Symptom: PancakeSwap V3 has 1, 5, 25, 100 bp tiers. The classifier maps `<= 1 → 1bp`, `<= 5 → 5bp`, else `30bp`. So both 25bp and 100bp pools land in the same bucket. PancakeSwap volatile pools (typically 100bp) should not share a quality multiplier with stable 25bp pools.
- Impact: same as C2 — quality multipliers are flattened; 100bp memecoin pools get the same `0.4x` retention as 25bp Curve-killer stable pools.
- Fix direction: add explicit `25bp` and `100bp` buckets in `classifyClPoolType` and the `QUALITY_MULTIPLIERS` map.

## Minor Findings

### m1: Balancer chain map drifts from docs (16 vs 14 chains)

- File: `worker/src/cron/dex-liquidity/fetch-balancer.ts:8-25` and `worker/src/cron/dex-liquidity/orchestrator-phases.ts:155-176`
- `BALANCER_CHAIN_MAP` includes FRAXTAL, MODE, and XLAYER beyond the 14 chains documented in `docs/dex-liquidity.md`, and the `supportedChains` list passed to the orchestrator references `fraxtal`, `mode`, `polygon-zkevm`, `xlayer`. Doc says 14, code maps 16.
- Fix direction: update `docs/dex-liquidity.md` to include the additional Balancer chains (or remove unsupported ones from the code if the doc list was intentional).

### m2: Fluid `parseFloat` precision risk on large reserves

- File: `worker/src/cron/dex-liquidity/fetch-fluid.ts:166-189`
- `parseFloat(t.liquidity_in_usd)` is fine for amounts under ~9e15, but `parseFloat` on extremely long decimal strings drops precision past 15 significant digits. For Fluid this is fine for USD totals, but `base_volume`/`target_volume` can be high-precision token amounts (`"84111582.628527419587158264"`) that lose the trailing digits. Not a bug but worth noting if later compared bit-for-bit.

### m3: Orca `tokenBalanceA/B` precision via `parseFloat`

- File: `worker/src/cron/dex-liquidity/fetch-orca.ts:99-103`
- The Orca API returns `tokenBalanceA` as a stringified raw integer ("207098154630167"). `parseFloat` then `/ 10**decimals` is fine for SOL-scale values, but token balances stored as raw 64-bit integers can exceed `Number.MAX_SAFE_INTEGER = 2^53`. Trailing digits are quietly truncated. For a 6-decimal stablecoin balance over $9 billion this would start losing precision in the cents. Acceptable for current scale; a future scale check should switch to BigInt.

### m4: Meteora `derivedPrice` computed from amounts already lost to decimal normalization

- File: `worker/src/cron/dex-liquidity/fetch-meteora.ts:118-122`
- Independent of the C1 precedence bug: `token_x_amount` and `token_y_amount` are returned from the API as already-normalized floats. The code uses them directly. That part is correct (no double-normalization), so calling out only to confirm decimals are NOT mishandled. The C1 finding above is a separate semantic bug.

### m5: Curve API `usdPrice` for individual coins is trusted without sanity bound checks beyond price-sanity

- File: `worker/src/cron/dex-liquidity/fetch-primary.ts:298-318`
- Curve's per-coin `usdPrice` is treated as the canonical price observation when it passes `isPlausibleDexObservationPrice`. For exotic Curve metapools that mis-report `usdPrice`, the only filter is the peg-aware sanity gate. This is a known intentional trust line, but worth flagging that Curve API outages or anomalies would propagate directly.

### m6: PancakeSwap `subgraphId` set is hardcoded to 3 chains, doc says "BSC, Ethereum, Base"

- File: `worker/src/cron/dex-liquidity/fetch-pancakeswap.ts:13-18`
- Matches the doc, but the file comment says "Keep Pancake coverage on the subgraphs that stay within the worker cron budget reliably" — implying additional chains were intentionally dropped. If new chains (zkEVM, Linea) are added in `wrangler.toml` or staging discovery, scoring will not pick them up.

### m7: Slipstream price observation never published when the Sugar contract is the source

- File: `worker/src/cron/dex-liquidity/fetch-slipstream.ts:201`
- Slipstream pools always set `volume24hUsd: 0` (Sugar view doesn't expose volume), and the orchestrator's `isPreferredDirectApiPool` requires `volume24hUsd > 0` for direct-API rows to displace overlapping DefiLlama UUID rows (`worker/src/lib/dex-api-pool-shaping.ts:44-49`). So Slipstream rows always cede precedence to DL coverage when both exist. This is intentional per `docs/dex-liquidity.md` but worth noting because it means Slipstream is purely additive coverage, not authoritative.

### m8: Orca cursor pagination fallback may infinite-loop on flat-cursor responses

- File: `worker/src/cron/dex-liquidity/fetch-orca.ts:130-138`
- The cursor-loop guard uses `seenCursors.has(nextCursor)` to detect loops, but only AFTER first appending. If Orca repeatedly returns the same cursor on different requests due to a backend bug, the function will exit on the second occurrence. Fine. The minor risk is when `nextCursor === undefined` while `meta.next === null`: the code falls through correctly. No bug, just hardened well; flagging because it's the only paginator with this guard.

### m9: GeckoTerminal `parseGtPool` reads `volume_usd.h24` without verifying numeric type

- File: `worker/src/cron/dex-liquidity/geckoterminal-shared.ts:52-70`
- `parseFloat(attrs.volume_usd?.h24 ?? "0")` is correct — GT API does return strings — but if GT ever switches to numbers the optional chaining still works. Just noting that no defensive numeric type check exists. Lowest severity.

### m10: PancakeSwap subgraph `feeRate` stores integer-ratio as fraction with 1bp = 0.0001

- File: `worker/src/cron/dex-liquidity/fetch-pancakeswap.ts:218`
- `feeRate: feeTier / 1_000_000` produces 0.0001 for 1bp, 0.0005 for 5bp, 0.0025 for 25bp, 0.01 for 100bp. That matches `feeRate * 10_000 → bps` in `direct-source-helpers.deriveDirectApiFeeTierBps`. Correct, just confirming.

### m11: Subgraph `runTokenBatchPriceFetch` returns 0 candidates on HTTP errors silently

- File: `worker/src/cron/dex-liquidity/fetch-primary.ts:483-499` (`fetchGtTokenBatch`)
- `if (!res?.ok) return [];` swallows HTTP errors and feeds an empty result back to the runner. The runner's metric would record 0 observations for that chain without surfacing the failure. Token-batch crawls already run inside a try/catch in the orchestrator so a `throw` would be safer than a silent `[]`. Same pattern in `fetchCgTokenBatchPrices`. Per the user's explicit memory rule "fetchers must propagate failures to circuit breakers", this is a recurring anti-pattern.

### m12: Direct CEX orderbook telemetry caught in a try/catch with no circuit breaker

- File: `worker/src/cron/dex-liquidity/orchestrator-phases.ts:592-598`
- `fetchMajorStablecoinOrderbookDepthSummary` failures are pushed into `failedSources` but no `recordOutcome` for a circuit. Since this lane is non-scoring telemetry only, the cost of an outage is just metadata noise, but consistency would dictate giving it a circuit so repeated upstream failures back off cleanly.

## Sources Verified Clean

- **Curve API** — `fetch-primary.ts:193-328`: Verified against `https://api.curve.finance/api/getPools/ethereum/main`. `coins[].poolBalance / 10^decimals * usdPrice` matches the `usdTotal` field within rounding. `usdTotalExcludingBasePool` correctly used for metapool dedupe. `isBroken` filter respected. Per-coin `usdPrice` extraction for price observations correctly uses the peg-aware sanity gate.
- **DefiLlama Yields** — `process-pools.ts`: `tvlUsd`, `volumeUsd1d`, `volumeUsd7d` all consumed as USD without re-multiplication. `apyBase / apy` organic fraction is guarded against NaN. `exposure === "single"` lending pools correctly skipped.
- **Uniswap V3 subgraph** — `subgraph-source-families.ts:101-180`: `token0Price` / `token1Price` direction is correct (V3 subgraph convention `tokenXPrice = X per Y`). Fee tier parsing maps cleanly to bp buckets. Reference token detection requires one side to be a USD-symbol whitelist entry.
- **Aerodrome subgraph** — `subgraph-source-families.ts:182-266`: `reserveUSD / (reserve0 * token1Price + reserve1)` derivation algebraically reduces to one-sided priceUsd; balance ratio gate `>= 0.3` enforced before publishing.
- **Balancer per-token prices** — `fetch-balancer.ts:207-220`: Each `poolTokens[i]` gets its own `priceUsd: balUsd/bal`, used by `deriveTokenUsdPrice` ahead of the misleading pool-level `price`. Good in practice (see M4 for the latent footgun).
- **Raydium price field** — `fetch-raydium.ts:122`: `pool.price` direction (`mintB per mintA` = `quote per base`) verified against the live API for `XMR/USDC`. `deriveTokenUsdPrice` handles inversion correctly via `pool.price * otherUsdRef` for tokenIndex 0 and `(1/pool.price) * otherUsdRef` for tokenIndex 1.
- **Orca `price` field** — `fetch-orca.ts:96-117`: Verified against `https://api.orca.so/v2/solana/pools` SOL/USDC sample. Matches `current_price` from sqrtPrice math. `feeRate / 1_000_000` conversion correct.
- **Fluid token-volume one-sided derivation** — `dex-api-token-pricing.ts:99-144` averaging path correctly converts each side to USD via the tracked stablecoin reference. Stablecoin-paired Fluid pools yield correct one-sided USD volume.
- **Fluid resolver enrichment** — `fetch-fluid.ts:74-139`: Decoded ABI words, decimals-aware `bigintToDecimalNumber`, `feeRate = fee / 1_000_000` (Fluid uses 1% = 10_000 internally). Correct.
- **Curve metapool dedupe** — `process-pools.ts:88-122`: Symbol-fallback Curve match correctly does **not** carry over `metapoolAdjustedTvl`; only address-matched curve enrichment uses `usdTotalExcludingBasePool`.
- **Peg-aware price sanity** — `price-sanity.ts` + `price-validation.ts`: USD pegs use hardcoded `[0.01, 1.19]` upper guard plus reference band of `[0.01 * ref, 2 * ref]`. Fiat FX pegs map peg currency → live FX reference scaled by `commodityOunces` for gold/silver. NAV tokens accept any positive price. Variable / unknown pegs accept any positive price.
- **Direct-API max TVL backstop** — `dex-api-pool-shaping.ts:24,37-42`: `DIRECT_API_MAX_POOL_TVL_USD = $10B` catches the worst Balancer outliers. `isEligibleDirectApiPool` enforces both min and max bounds.
- **Circuit breaker propagation** — `orchestrator-phases.ts:298-358`: All eight direct fetchers run inside `recordOutcomeSafe(..., result.ok)` so genuine `ok=false` returns and `throw`s both record breaker failures. Fluid, Balancer, Raydium, Orca, Meteora, PancakeSwap, Slipstream all return `makeDexApiFetchResult(..., { ok: successfulX > 0, degraded: errors.length > 0 })`, so a total upstream outage cleanly flips `ok=false` instead of returning a stealth empty array.
- **PancakeSwap pool body parser** — `fetch-pancakeswap.ts:95-121`: HTML/plaintext upstream regressions are now flagged as `invalid-json: ...; body=...` errors instead of opaque parse crashes. Matches the doc claim.
- **CoinGecko tickers fallback** — `coingecko-tickers-shared.ts`: `is_stale` / `is_anomaly` filter respected, `converted_volume.usd >= 1000`, USD-quote-only filter via `USD_QUOTE_COIN_IDS`, depth-capped synthetic TVL (`min(volume * factor, depthDownUsd)`).
- **Cross-source identity dedupe** — `pool-identity.ts` (read tangentially via `orchestrator.ts:42-111` and `orchestrator-phases.ts:405-526`): exact pool key first, derived match second, optional wildcard only when both sides are unique. Direct API exact pool ids reserved even when filtered out, so staged discovery cannot re-add them with incompatible TVL.
- **Direct fetcher error → circuit breaker propagation**: All eight direct fetchers return non-ok results on full failure (verified in source). No fetcher silently returns `[]` from a top-level catch in a way that would falsely bump circuit-breaker success.

## Open Questions

- **Slipstream `pool_fee` units** (M6): Could not verify against the live Aerodrome Sugar contract during this audit. Needs a one-shot live `eth_call` against the deployed Sugar at `0x27fc745390d1f4BaF8D184FBd97748340f786634` and decoding of the actual struct to confirm whether `pool_fee` is in basis points or in 1e6 units. If it is 1e6 units, all currently retained Slipstream pools are misclassified.
- **Meteora downstream blast radius** (C1): How many Meteora-derived rows actually make it into `dex_prices` after the sanity gate? If the answer is "almost none, the gate eats them" then C1 is a coverage gap rather than a bad-data emission. A run-time count of Meteora `priceObservations` accepted vs filtered would quantify this. The current diagnostics expose `priceObservationCoins` per source family, so a quick read of recent metadata would resolve this.
- **PancakeSwap 25bp pools** (C2 / M7): how many DL+direct retained pools sit in the misclassified bucket today? A backfill query against `top_pools_json` for `pancakeswap-v3-30bp` rows joined against the actual fee tier from the subgraph should give a count.
- **Balancer Fantom pollution** (M3): would blocking Fantom outright (or all post-multichain-bridge-exploit pools) materially reduce noise without losing tracked stablecoin coverage? Multichain shut down in 2023 so any Fantom Balancer pool referencing `multiUSDC` / `multiUSDT` is structurally unrecoverable.
- **Slipstream sqrt price extraction** (M5): is the Sugar struct's `sqrt_ratio` field reliable enough to derive spot price for both Aerodrome and Velodrome variants? The ABI exposes it but it's currently ignored.
- **CG balance ratio drop** (M2): if the pseudo-balance-ratio is removed, will any rows lose `coverage_class = mixed` and drop to `fallback`? Worth a one-run shadow comparison before deleting.
