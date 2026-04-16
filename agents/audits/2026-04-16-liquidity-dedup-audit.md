# DEX Liquidity Pool Deduplication Audit

Date: 2026-04-16
Scope: `/liquidity` feature — pool dedup across DeFiLlama, direct-protocol APIs, UniV3/Aerodrome subgraphs, staged discovery (CG Onchain, GT, DexScreener, CG Tickers), and the `__global__` cross-stablecoin aggregate row.

Entry points audited:
- `worker/src/cron/dex-liquidity/pool-identity.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts` (`filterPrimaryPoolsPreferDirectApi`)
- `worker/src/cron/dex-liquidity/orchestrator-phases.ts` (`integrateDirectApiLiquidityPhase`, `runFallbackCrawlerPhase`)
- `worker/src/cron/dex-liquidity/staging-merge.ts`
- `worker/src/cron/dex-liquidity/process-pools.ts`
- `worker/src/cron/dex-liquidity/pool-contribution.ts`
- `worker/src/cron/dex-liquidity/scoring.ts` + `scoring-helpers.ts`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-liquidity/challenger-persistence.ts`
- `worker/src/cron/dex-liquidity/direct-source-helpers.ts`
- `worker/src/cron/dex-liquidity/pool-helpers.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts` (staged orderbook poolId)

## Headline Findings (severity-ranked)

### HIGH-1 — `__global__` poolId is constructed differently by DL path vs secondary/direct path; same physical pool can double-count in global aggregates

**Files**:
- `worker/src/cron/dex-liquidity/process-pools.ts:235` → `poolId: \`${pool.chain.toLowerCase()}:${pool.pool.toLowerCase()}\``
- `worker/src/cron/dex-liquidity/pool-contribution.ts:75` → `poolId: \`${pool.chain.toLowerCase()}:${pool.address.toLowerCase()}\``

**Trigger**: For DL yields pools, `pool.pool` is the DL **UUID** (e.g. `6b6de6c7-...`) for many protocols (Balancer, Curve, most non-UniV3 rows). The direct-API / GT / DS / CG paths instead store the real on-chain address. `scoring-helpers.ts:252` dedupes `__global__` by the string `pool.poolId`, so if a Balancer USDT/USDC pool is represented as `ethereum:6b6de6c7-...` in one stablecoin's metric set and `ethereum:0xabc...` in another's, both survive the global dedup set (`globalSeenPools`) and their TVL is added twice to `globalAgg.totalTvl`, `globalAgg.totalVol24h`, `globalAgg.totalVol7d`, `globalProtocolTvl[...]`, and `globalChainTvl[...]`.

This only manifests when the primary-phase identity dedup (see `filterPrimaryPoolsPreferDirectApi`) fails to collapse the DL row against the direct-API row. That happens in the scenarios below (HIGH-2, MED-1).

**Fix direction**: Make `poolId` identity-driven rather than string-typed. Prefer:
1. In `process-pools.ts`, when DL's `pool.pool` is not a trustworthy address (no `0x[40]`, no native-id pattern), derive `poolId` from `PoolIdentity.derivedMatchKey` (or from a canonical hash of `chain|protocol|sortedTokens|shape`), so that a DL row and a direct-API row for the same physical pool stamp the same `poolId` downstream.
2. Additionally, compute a `poolFingerprint` inside `accumulateGlobalAggregate` that falls back to `PoolIdentity` when `pool.pool` looks UUID-shaped, and dedupe global aggregates on the fingerprint rather than raw `poolId`.

### HIGH-2 — Balancer DL row with unset `stablecoin` flag escapes every dedup layer against direct-API Balancer stable pool

**Files**:
- `worker/src/cron/dex-liquidity/pool-identity.ts:51–88` (`resolvePoolShapeFamily`)
- `worker/src/cron/dex-liquidity/pool-helpers.ts:25–40` (`classifyPoolType`)
- `worker/src/cron/dex-liquidity/orchestrator.ts:57–66` (`filterPrimaryPoolsPreferDirectApi` builds primary identity)

**Trigger**: Balancer DL rows set `pool.stablecoin` inconsistently (many V3 stable pools omit the flag). The DL side then computes:
- `classifyPoolType("balancer-v2") = "balancer-weighted"` (because project string lacks the literal substring "stable" — line 33 requires both)
- `resolvePoolShapeFamily` takes the `"weighted"` branch; the Balancer-stable fallback at line 63 only fires when `isStable === true`. With DL's `stablecoin` undefined/false, the shape stays `"weighted"`.

The direct-API side computes:
- `poolType = "balancer-stable"` (derived from the direct API's `poolTokens` analysis)
- `buildDirectApiPoolIdentity` sets `isStable: poolType.includes("stable") = true` and `resolvePoolShapeFamily` returns `"stable"`.

Consequence:
- `exactPoolKey` differs (DL Balancer `pool.pool` is the 32-byte vault id or opaque UUID → not trustworthy → `null`; direct API has `chain:0x20-byte-address`).
- `derivedMatchKey` differs (shape `weighted` vs `stable`, stability bucket `volatile`/`na` vs `stable`).
- `optionalWildcardKey` **also differs** because `poolShapeFamily` is part of the wildcard key at `pool-identity.ts:135–138` (`[chain, protocol, tokens, poolShapeFamily].join("|")`).

Result: every dedup reason (`exact`, `derived_unique`, `derived_optional_wildcard`) misses. Both rows survive `filterPrimaryPoolsPreferDirectApi`, both are processed into metrics, and the DL Balancer row is weight-multiplied at 0.4x while the direct row (correctly classed stable) contributes at 0.85x — doubling per-stablecoin TVL for that pool and, per HIGH-1, double-counting globally as well.

**Fix direction**: Make DL-side identity construction more charitable when the project string contains `"balancer"` but the pool shape cannot be classified confidently. Options:
1. In `resolvePoolShapeFamily`, when `normalizeProtocol(protocol) === "balancer"` and `isStable` is null/false but the DL pool's `poolMeta.symbol` is all stablecoin symbols, force shape to `"stable"`.
2. Simpler: for the `balancer` wildcard path, ignore `poolShapeFamily` so a direct Balancer stable pool always matches its DL counterpart by `chain|protocol|tokens` when neither side has a trustworthy exact id.
3. At the source, upgrade `classifyPoolType` to recognise `"balancer-v2"` + all-stablecoin symbols as `"balancer-stable"` before identity is built.

### HIGH-3 — CoinGecko tickers synthetic orderbook rows have TWO incompatible `poolId` conventions (staging vs fallback)

**Files**:
- `worker/src/cron/dex-discovery/crawl-sources.ts:444` — staged poolId: `` `orderbook:${summary.exchangeId}:${stablecoinId}`.toLowerCase() ``
- `worker/src/cron/dex-liquidity/staging-merge.ts:330` — address extraction: `const address = stagedPool.poolId.split(":")[1] ?? stagedPool.poolId;`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts:319–343` — fallback poolId (via `addSecondaryPoolContribution`): chain `"orderbook"`, address `` `orderbook-${exchangeId}` ``
- `worker/src/cron/dex-liquidity/pool-contribution.ts:75` — final stamped poolId

**Trigger — scenario A (staging path collapses correctly for `__global__` but loses TVL magnitude info)**:
Staged poolId `orderbook:kinesis:usdc-circle`. Split on `":"` yields `"kinesis"` as address. The final `PoolEntry.poolId` = `orderbook:kinesis`. For the USDT staged row the final `poolId` is also `orderbook:kinesis`. Global dedup collapses them — but the *first-wins* semantics of `accumulateGlobalAggregate` drops the TVL/volume of the losing row and picks whichever stablecoin's row happened to iterate first. A per-stablecoin synthetic depth of $10M USDC and $5M USDT contributes only one number (whichever arrives first) to `globalAgg.totalTvl`. Order is Map-insertion order — deterministic but arbitrary.

**Trigger — scenario B (staging + fallback double-count)**:
`fetchCgTickersFallback` only runs when `getFallbackTargets` still flags the coin as weak-coverage after staging. For a coin that received a single synthetic orderbook row from staging (insufficient to hit `WEAK_COVERAGE_MIN_POOL_COUNT=3`), the fallback will requery CoinGecko tickers. The fallback's `GtNewPool` object uses `address: \`orderbook-${summary.exchangeId}\`` and `chain: "orderbook"`. Final `poolId` = `orderbook:orderbook-kinesis`.

This does not equal the staged row's final `poolId` of `orderbook:kinesis`, so:
- Per-stablecoin metrics get **two** synthetic Kinesis rows (double-counted TVL, volume, pool count, and `effectiveTvl`).
- Global dedup sees two distinct keys → global TVL is double-counted as well.

**Trigger — scenario C (fallback bypasses `knownPoolIndex` entirely)**:
`fetchCgTickersFallback` (lines 266–367) does **not** take `knownPoolIndex` as a parameter and does not call `getIdentityDedupReason`. Even if the staged and fallback conventions were aligned, the fallback path would still skip identity dedup.

**Fix direction**:
1. Make discovery and fallback agree on one poolId convention. Recommended: drop the stablecoin suffix from the staged poolId (use `orderbook:${exchangeId}`) and use the same key in fallback so that the exactPoolKey path (`"orderbook:*"` is already trustworthy per `pool-identity.ts:45`) actually registers.
2. Pass `knownPoolIndex` into `fetchCgTickersFallback` and run the same `buildPoolIdentity` / `getIdentityDedupReason` sequence used by the DexScreener fallback (`fetch-fallbacks.ts:230–247`). Register the retained CG-ticker identities into `knownPoolIndex` so a later iteration cannot re-add them.
3. In `staging-merge.ts:330`, stop using `split(":")[1]` for orderbook rows; use the full suffix after the first colon so that the final downstream poolId is `orderbook:${exchangeId}`. (Currently the "split on 1 colon" also mangles any pool id that contains a colon, e.g. Solana base58 ids are safe but orderbook composite ids are not.)

### HIGH-4 — `normalizeProtocol` only matches the concatenated form `"pancakeswap"`, missing `"pancake-swap"`, `"pancake_swap"`, `"pcs"`, `"uni-v3"`, `"univ3"`, etc.

**File**: `worker/src/cron/dex-liquidity/pool-helpers.ts:173–193`

**Trigger**: The dedup identity's `derivedMatchKey` uses `normalizeProtocol(input.protocol)`. When a DexScreener staged row reports `dexId: "pancake-swap-v3"` (common for DS), `normalizeProtocol` returns the raw `"pancake-swap-v3"` instead of `"pancakeswap"`, because line 184 only checks `p.includes("pancakeswap")` and `p` is `"pancake-swap-v3"` after the single `_→-` replace at line 174. The DL Balancer/PancakeSwap/etc. project strings normalize to the short form `"pancakeswap"`; the staged/DS-side strings don't. Their derived and wildcard keys no longer share a `protocol` component, so **no derived dedup can succeed** — the direct-API / DL PancakeSwap row and the DS/GT PancakeSwap row both land in metrics.

The same failure mode exists for any vendor slug with a dash or underscore the normalizer does not anticipate (e.g. `uni-v3`, `uni_v3`, `univ3`, `trader_joe`, `sushiswap_v3` would all pass, but `"pcs-v3"` and `"pancake-swap-v3"` do not).

**Fix direction**: Strip dashes/underscores before the substring checks, e.g.

```ts
const p = project.toLowerCase().replace(/[-_]/g, "");
if (p.includes("pancakeswap")) return "pancakeswap";
if (p.includes("uniswapv3")) return "uniswap-v3";
...
```

or, more robustly, match against an explicit alias table so that new slug variants are a one-line addition rather than a silent dedup miss.

### MED-1 — Identity asymmetry: DL path passes no `feeTierBps` or explicit `isStable` for non-UniV3 pools, while the direct-API path always does; optional wildcard is the only safety net

**Files**:
- `worker/src/cron/dex-liquidity/orchestrator.ts:57–66` (primary identity build in `filterPrimaryPoolsPreferDirectApi`)
- `worker/src/cron/dex-liquidity/fetch-primary.ts:369–441` (`buildKnownPoolAddresses`)
- `worker/src/cron/dex-liquidity/direct-source-helpers.ts:25–35` (`buildDirectApiPoolIdentity`)

**Trigger**: `filterPrimaryPoolsPreferDirectApi` passes `isStable: pool.stablecoin` but deliberately omits `feeTierBps` — DL yields does not expose fee tiers for most protocols. On the direct-API side, `buildDirectApiPoolIdentity` always passes `feeTierBps` (derived from `pool.feeRate`). The derived-key fee bucket therefore differs between the two sides for virtually every Balancer / Raydium / Orca / Meteora pool. `derived_unique` dedup never succeeds for these protocols; all non-exact dedup must go through `derived_optional_wildcard`, which only fires when:
- the DL side's `hasMissingOptionalIdentityFields` is true (OK — fee bucket is `na`),
- AND both the known-bucket count and the incoming-bucket count are 1,
- AND the wildcard token+shape bucket agrees exactly.

The failure modes of HIGH-2 (shape disagreement) and MED-2 (ambiguous bucket count) therefore each collapse the entire Balancer / Raydium / Orca / Meteora dedup to a single-path wildcard rail.

**Fix direction**: Either:
1. In `filterPrimaryPoolsPreferDirectApi`, also strip `feeTierBps` and `isStable` when building the direct-API identity so both sides are consistently identity-poor (then they match by shape+tokens). This widens the wildcard rail to the whole primary phase.
2. Or treat `fee bucket = "na"` as a wildcard on either side when computing the derived_unique match, not only when the incoming side has missing optional fields.

### MED-2 — Wildcard dedup is blocked whenever there are 2+ parallel same-pair pools on the same protocol, even when one side is clearly the direct-API row

**Files**: `worker/src/cron/dex-liquidity/pool-identity.ts:214–237` (`getIdentityDedupReason`)

**Trigger**: The check `incomingCounts.derived === 1` and `incomingCounts.wildcard === 1` stops same-pair parallel pools from collapsing. This is intentionally conservative per the docs, but combined with HIGH-2 / MED-1 it means an incident where DL has two Balancer-stable USDC/USDT pools (V2 + V3) and direct API also has two, dedup drops to "exact only" — and since DL Balancer has no trustworthy exact id, neither side collapses.

**Fix direction**: When the incoming bucket count is >1 but the *direct-API* known bucket has the same count and there's a one-to-one match by sorted exact keys, allow each incoming row to pair against its exact-key counterpart rather than abandoning the dedup. This needs a richer index (`KnownPoolIdentityIndex.exactKeysByDerivedKey`).

### MED-3 — Curve metapool `usdTotalExcludingBasePool` is only applied to `effectiveTvl`; `totalTvlUsd`, `protocolTvl["curve"]`, `chainTvl`, and `__global__.totalTvl` double-count base-pool liquidity

**Files**:
- `worker/src/cron/dex-liquidity/process-pools.ts:199` (`m.totalTvlUsd += pool.tvlUsd`)
- `worker/src/cron/dex-liquidity/process-pools.ts:227–228` (`protocolTvl`/`chainTvl` use `pool.tvlUsd`)
- `worker/src/cron/dex-liquidity/scoring-helpers.ts:50–63` (rebuilt metrics sum `pool.tvlUsd`, not an adjusted field)

**Trigger**: Curve metapools carry both their pool tokens and a basepool LP (e.g. USDT+3CRV). DL yields reports `pool.tvlUsd` as the full metapool value (including 3CRV's underlying TVL). The Curve API's `usdTotalExcludingBasePool` is used only when computing `effectivePoolTvl = curveAddressMatch ? curveData.metapoolAdjustedTvl : pool.tvlUsd`, which flows into `effectiveTvl` / `qualityAdjustedTvl` only. Per-stablecoin `totalTvlUsd`, `protocolTvl`, `chainTvl`, and the `__global__` row all continue to sum the un-adjusted value, so the 3pool TVL is counted once inside the 3pool row and once inside every metapool that uses it.

Docs (`docs/dex-liquidity.md` §Pool Quality Adjustments) say "MetaPool TVL dedup: Uses `usdTotalExcludingBasePool` to prevent double-counting base pool liquidity across ~322 Curve metapools", which reads as a broader guarantee than the code currently delivers.

**Fix direction**: When pushing to `m.topPools`, set `pool.tvlUsd` (and `pool.volumeUsd1d`) to the metapool-adjusted values for address-matched Curve metapools, rather than only adjusting `effectiveTvl`. Retain the raw DL TVL in `pool.extra` for debugging.

### MED-4 — `accumulateGlobalAggregate` keys dedup on `pool.poolId` string — so the first write wins even when the "losing" row has a larger TVL

**Files**: `worker/src/cron/dex-liquidity/scoring-helpers.ts:239–268`

**Trigger**: `globalSeenPools.add(pool.poolId)` only skips duplicates. If the same physical pool appears in stablecoin A's metric set with `tvlUsd = $5M` (direct API measurement) and in stablecoin B's metric set with `tvlUsd = $4.5M` (e.g. a filtered/capped row), the one that iterates first is taken; the other is silently dropped. Iteration order is `for (const [id, m] of metrics)`, which is Map-insertion order (deterministic but dependent on primary-phase processing order). This can cause small cross-run drifts in `__global__.totalTvl` even when inputs are stable.

**Fix direction**: When duplicates collide, prefer the row with the higher TVL (or the row whose `source` family is higher-trust). Minor but cheap to fix.

### MED-5 — `buildKnownPoolAddresses` registers Curve/UniV3/Aerodrome exact keys with empty `tokenAddresses`, so those entries contribute no derived or wildcard coverage

**Files**: `worker/src/cron/dex-liquidity/fetch-primary.ts:397–434`

**Trigger**: Curve pools are registered via `buildPoolIdentity({..., tokenAddresses: []})`. The identity builder requires `>= 2` tokens for either the derived or wildcard key (line 124, 136), so these entries only register `exactPoolKey`. If a staged GT/CG row arrives for the same physical Curve pool but only carries a UUID as pool id (e.g. from a GT crawl that returned DL's yields UUID verbatim), neither `exactPoolKey` nor `derivedMatchKey` matches — the staged row slips through as a duplicate.

**Fix direction**: Pull token addresses from the Curve API response and pass them to `buildPoolIdentity` when registering Curve/UniV3/Aerodrome known identities. That way the dedup fallback paths are not surrendered for pools that have trustworthy pool addresses but where a staged row arrives with a different-looking id.

### MED-6 — Solana base58 addresses are lower-cased for identity and `poolId` stamping, losing case information

**Files**:
- `worker/src/cron/dex-liquidity/pool-identity.ts:112` (`exactPoolKey = \`${chain}:${exactPoolId.toLowerCase()}\``)
- `worker/src/cron/dex-liquidity/process-pools.ts:235`, `pool-contribution.ts:75` (stamped `poolId`)

**Trigger**: Base58 is case-sensitive. Two distinct Solana pool addresses could collapse to the same lowercase string (`"4Gh..."` and `"4gh..."`). Both sides lowercase consistently so same-pool cross-source dedup still works, but a naturally occurring collision would misdedupe two different physical pools.

**Fix direction**: Treat base58 ids as case-sensitive — skip the `.toLowerCase()` branch in `pool-identity.ts:112` when `isBase58PoolId(trimmed)` (a new helper) is true. Adjust `pool-contribution.ts` and `process-pools.ts` similarly so that Solana `poolId` preserves original case, and normalize EVM addresses separately.

### LOW-1 — `selectDexPriceChallengerRowsFromPools` has no intra-stablecoin dedup; same poolId is not collapsed before insert

**File**: `worker/src/cron/dex-liquidity/challenger-persistence.ts:240–279`

**Trigger**: The function filters and sorts qualifying pools but does not de-duplicate by `poolId`. The `ON CONFLICT(stablecoin_id, snapshot_at, pool_id)` clause ensures at most one row lands in the DB per key — but "last write wins", so if the same stablecoin's retained pool list contains two rows with the same `poolId` (e.g. because HIGH-1 leaked a Balancer row via two sources), the second row's TVL silently overwrites the first, and any diagnostic count of "published challenger rows" in `sourceCoverageCompleteByStablecoin` logic is off-by-n.

**Fix direction**: Dedupe `qualifying` by `poolId` before emitting statements (prefer the higher `tvlUsd`).

### LOW-2 — CG tickers staged rows and CG tickers fallback rows cannot share a derived key, because they expose no token addresses

**File**: `worker/src/cron/dex-liquidity/staging-merge.ts:247`

**Trigger**: `buildPoolIdentity({..., tokenAddresses: [stagedPool.baseToken ?? "", stagedPool.quoteToken ?? ""]})`. For staged CG tickers rows, `baseToken` and `quoteToken` are null (see discovery's `crawl-sources.ts:463–464`). The filter at `pool-identity.ts:117–118` drops empty strings, leaving `normalizedTokens = []`, so `derivedMatchKey = null` and `optionalWildcardKey = null`. Combined with the staged `poolId` suffix problem (HIGH-3), CG-tickers staged rows are effectively invisible to dedup.

**Fix direction**: For staged CG-tickers rows, synthesize a stable token-shape key from `(stablecoin_id, quote_symbol)` and use it in the derived key so that subsequent discovery crawls cannot add a second synthetic row for the same exchange+coin.

### LOW-3 — `classifyPoolType` hits `"aerodrome"` before `"aerodrome-slipstream"` / `"velodrome-slipstream"` because the latter branches are below the generic `"aerodrome"` branch

**File**: `worker/src/cron/dex-liquidity/pool-helpers.ts:25–40`

**Trigger**: Line 30 returns `"aerodrome-volatile"` for any project containing `"aerodrome"`. Line 32 (`velodrome-slipstream`) and line 31 (`aerodrome-slipstream`) will never be reached for an `aerodrome-slipstream` project. In practice DL uses `"aerodrome-slipstream"` which matches line 30 FIRST (it contains `"aerodrome"`), returning `"aerodrome-volatile"` instead of `"aerodrome-slipstream-5bp"`. This mis-classifies the pool, which then changes `poolShapeFamily` (generic vs concentrated), which breaks derived/wildcard dedup against the direct Slipstream pool.

**Fix direction**: Reorder the branches so that the most specific match (`velodrome-slipstream`, `aerodrome-slipstream`) is tested before the broader `aerodrome` / `velodrome` match.

### LOW-4 — `mergeSecondaryPools` pushes every pool into `m.topPools` without any local dedup

**File**: `worker/src/cron/dex-liquidity/fetch-crawlers.ts:30–51`

**Trigger**: Relies entirely on the caller to have deduped. Four callers feed it (`integrateDirectApiLiquidityPhase`, `mergeStagedPools` × 2, `runFallbackCrawlerPhase` × 2), and one of them (`fetchCgTickersFallback`) skips dedup. There's no cheap defensive guard inside `addSecondaryPoolContribution` to collapse an obvious duplicate already present in `m.topPools`.

**Fix direction**: As a defensive net, make `addSecondaryPoolContribution` a no-op when `m.topPools` already contains an entry with the same `poolId` (or the same identity). This protects against any future caller that forgets to dedup.

## Traced Scenarios

### Scenario A — USDT/USDC Raydium CLMM pool on Solana (happy path)

1. DL yields returns a Raydium CLMM row. `pool.pool = "<solana-address-or-uuid>"`, `pool.project = "raydium-clmm"`, `pool.chain = "Solana"`, `pool.stablecoin = true`.
2. Direct Raydium fetch returns the same pool with `poolAddress = "<base58 address>"`, `source = "raydium"`, `poolType = "raydium-clmm"`, `feeRate = 0.0001` (→ `feeTierBps = 1`).
3. `filterPrimaryPoolsPreferDirectApi` builds:
   - Direct identity: `exactPoolKey = "solana:<lowercased-base58>"`, `derivedMatchKey = "solana|raydium|<sortedTokens>|concentrated|1|volatile"` (direct side sets `isStable = "raydium-clmm".includes("stable") = false`).
   - DL identity: `exactPoolKey = null` if DL pool id is a UUID, else `"solana:<same-lowercased-base58>"`. `derivedMatchKey = "solana|raydium|<sortedTokens>|concentrated|na|stable"` (DL has `pool.stablecoin = true`).
4. Exact key: matches only if DL row also has the base58 address. If so → `"exact"` dedup, DL skipped. ✓
5. Exact key miss path: `derivedMatchKey` differs (`na|stable` vs `1|volatile`). Optional wildcard key (shape=`concentrated`, ignore fee+stable) matches. DL row has `hasMissingOptionalIdentityFields = true` iff `feeTier === "na"` (always true) OR `isStable == null` (false since DL set it). Wildcard dedup succeeds. ✓
6. DL row suppressed, direct API row goes through `integrateDirectApiLiquidityPhase` → `convertToGtNewPools` → `mergeGtPools` → `addSecondaryPoolContribution`. poolId = `"solana:<lowercased-base58>"`.
7. `__global__` aggregate: `accumulateGlobalAggregate` iterates USDT's retainedPools (contains `"solana:<addr>"`) then USDC's retainedPools (contains same). Second is skipped by `globalSeenPools`. ✓

Verdict: **counted once in `__global__`** provided the direct API returned the pool and the wildcard dedup fired. ✓

### Scenario B — USDT/USDC Balancer V3 stable pool on Ethereum (buggy path)

1. DL yields returns `project = "balancer-v3"`, `pool.pool = "<32-byte vault id>"`, `pool.stablecoin = null` (V3 omits the flag for this row), `pool.underlyingTokens = [USDC, USDT]`.
2. Direct Balancer API returns `source = "balancer"`, `poolAddress = "0x<20-byte-address>"`, `poolType = "balancer-stable"`, `feeRate = 0.0001` (1 bps).
3. `filterPrimaryPoolsPreferDirectApi`:
   - Direct identity: `exactPoolKey = "ethereum:0x<20b>"`, `derivedMatchKey = "ethereum|balancer|<USDC:USDT>|stable|1|stable"`, `optionalWildcardKey = "ethereum|balancer|<USDC:USDT>|stable"`.
   - DL identity: `classifyPoolType("balancer-v3") = "balancer-weighted"` (project doesn't include "stable"). `resolvePoolShapeFamily("balancer-weighted", "balancer-v3", isStable=null)` → the fallback at line 63 requires `isStable === true`, which is false → stays `"weighted"`. `exactPoolKey = null` (64-hex vault id is not trustworthy for Balancer). `derivedMatchKey = "ethereum|balancer|<USDC:USDT>|weighted|na|na"`. `optionalWildcardKey = "ethereum|balancer|<USDC:USDT>|weighted"`.
4. Exact match: DL key is null → no match.
5. Derived_unique: keys differ on `stable` vs `weighted` → no match.
6. Derived_optional_wildcard: wildcard keys differ on `stable` vs `weighted` → no match.
7. DL row **survives** into `preferredPrimaryPools`. Direct API row also survives into `integrateDirectApiLiquidityPhase`.
8. `processPoolMetrics` pushes DL row with `poolId = "ethereum:<vault-id>"` into USDT's and USDC's metric sets, tvlUsd counted at 0.4x multiplier (weighted).
9. `integrateDirectApiLiquidityPhase` pushes direct row with `poolId = "ethereum:0x<20b>"` into USDT's and USDC's metric sets, tvlUsd counted at 0.85x multiplier (stable).
10. Per-stablecoin metrics: each coin's `totalTvlUsd` double-counts the pool. `poolCount` is 2 instead of 1. `effectiveTvl` double-counts at different multipliers. `qualityAdjustedTvl` is inflated.
11. `accumulateGlobalAggregate`: `"ethereum:<vault-id>"` and `"ethereum:0x<20b>"` are distinct keys → `globalAgg.totalTvl` is the SUM of both. `globalAgg.protocolTvl["balancer"]` is double the real value.

Verdict: **counted twice per stablecoin AND twice globally**. ✗

### Scenario C — CG tickers Kinesis synthetic pool for KAU (leaky path)

1. Discovery cron writes staged row: `pool_id = "orderbook:kinesis:kau-kinesis"`, `chain = "orderbook"`, `base_token = null`, `quote_token = null`.
2. Staging merge reads the row. `buildPoolIdentity` receives `poolAddressOrId = "kinesis"` (via `split(":")[1]`) — NOT trustworthy, `exactPoolKey = null`. `tokenAddresses = ["", ""]` → zero valid tokens → `derivedMatchKey = null`, `optionalWildcardKey = null`. `registerKnownPoolIdentity` is a no-op for this row.
3. `addSecondaryPoolContribution` stamps final `poolId = "orderbook:kinesis"`. Per-coin metrics receive the staged synthetic row; `m.poolCount = 1`.
4. KAU still has `poolCount < WEAK_COVERAGE_MIN_POOL_COUNT=3`, so `getFallbackTargets` flags it for CG tickers fallback.
5. `fetchCgTickersFallback` does not pass `knownPoolIndex`. It creates a new `GtNewPool` with `address = "orderbook-kinesis"` → final `poolId = "orderbook:orderbook-kinesis"`.
6. `mergeGtPools` pushes it into KAU's metrics without any dedup. `m.poolCount = 2`, `m.totalTvlUsd` includes the same Kinesis synthetic TVL twice, and `accumulateGlobalAggregate` sees two distinct keys so global count is `2` and global TVL doubles.

Verdict: **double-counted per coin AND globally** when both staged and fallback CG tickers paths deliver the same exchange. ✗

### Scenario D — PancakeSwap V3 USDC/USDT stable pool on BSC via DexScreener staged row

1. DL yields row: `project = "pancakeswap-v3-bsc"`, `pool.pool = "<uuid>"`, `stablecoin = true`.
2. Direct PancakeSwap subgraph fetch: `source = "pancakeswap"`, `poolAddress = "0x<addr>"`, `poolType = "pancakeswap-v3-5bp"`, `feeRate = 0.0005` (→ feeTierBps=5).
3. `filterPrimaryPoolsPreferDirectApi`:
   - Direct identity: `normalizeProtocol("pancakeswap") = "pancakeswap"`. `derivedMatchKey = "bsc|pancakeswap|<tokens>|concentrated|5|stable"`. `optionalWildcardKey = "bsc|pancakeswap|<tokens>|concentrated"`.
   - DL identity: `classifyPoolType("pancakeswap-v3-bsc") = "pancakeswap-v3-5bp"`. `normalizeProtocol` sees `"pancakeswap-v3-bsc"`, the substring check for `"pancakeswap"` succeeds → returns `"pancakeswap"`. `derivedMatchKey = "bsc|pancakeswap|<tokens>|concentrated|na|stable"`. Wildcard matches direct. → dedup succeeds, DL suppressed. ✓
4. Staged DexScreener row arrives with `dex_id = "pancake-swap-v3"` (DS uses dashed form). Staging merge calls `buildPoolIdentity({protocol: profile.dexId = "pancake-swap-v3", ...})`. `normalizeProtocol("pancake-swap-v3")`: `p.includes("pancakeswap")` is FALSE (`pancake-swap-v3` doesn't contain the concatenated `pancakeswap`), so `normalizeProtocol` returns `"pancake-swap-v3"`. The staged identity's `derivedMatchKey = "bsc|pancake-swap-v3|<tokens>|concentrated|5|stable"` — a different string than the direct API's `derivedMatchKey` which uses `"pancakeswap"`.
5. No derived dedup match. Exact key on staged row does match (address format is `0x<20b>`) — the staged row exactly equals the direct API row's `exactPoolKey`, so `"exact"` dedup fires and the staged row is dropped. ✓ (only because `exactPoolKey` saved the day).
6. But if the staged row came from CG Onchain with a different address-mapping quirk (rare) or from DS with a truncated pair address, exact would fail and **no derived dedup would fire at all**.

Verdict: **dedup relies entirely on exact-address match for PancakeSwap via DS** because `normalizeProtocol` does not normalize hyphenated PancakeSwap variants.

## Checklist

| Dedup path | File | Status |
| --- | --- | --- |
| Primary DL ↔ direct API (exact) | `orchestrator.ts:89` | Clean **when** DL exposes a trustworthy pool id (most UniV3 rows) |
| Primary DL ↔ direct API (derived_unique) | `orchestrator.ts:93` | Broken for Balancer + when fee bucket or shape disagree (HIGH-2, MED-1) |
| Primary DL ↔ direct API (optional wildcard) | `orchestrator.ts:97` | Clean only when DL side has `hasMissingOptionalIdentityFields=true` **and** wildcard bucket is unique on both sides |
| Direct API ↔ itself (self-dedup) | `orchestrator-phases.ts:437–467` | Clean |
| Direct API exact-id reservation for staged/fallback | `orchestrator-phases.ts:472–477` | Clean |
| Staged discovery ↔ primary + direct API | `staging-merge.ts:309–326` | Clean for rows with ≥2 token addresses; broken for CG-tickers staged rows which carry no token addresses (LOW-2); broken for PancakeSwap staged rows with hyphenated dex_id (HIGH-4) |
| Staged discovery authoritative-protocol gate | `staging-merge.ts:275–282` | Clean — requires explicit exact key confirmation |
| DexScreener fallback ↔ knownPoolIndex | `fetch-fallbacks.ts:230–247` | Clean — uses identity dedup, registers retained rows |
| CG tickers fallback ↔ knownPoolIndex | `fetch-fallbacks.ts:266–367` | **Missing** — no dedup against `knownPoolIndex` at all (HIGH-3) |
| CG tickers staging ↔ CG tickers fallback | — | **Broken** — incompatible `poolId` conventions (HIGH-3) |
| `__global__` TVL/volume dedup | `scoring-helpers.ts:239–268` | Correct in intent; broken in practice when `poolId` is UUID-flavoured on one side and address-flavoured on the other (HIGH-1) |
| `__global__` tie-breaker when two pools share a poolId | `scoring-helpers.ts:253` | First-wins, iteration-order dependent (MED-4) |
| Curve metapool base-pool dedup | `process-pools.ts:199` | Partial — only `effectiveTvl` is adjusted; raw tvl, protocolTvl, chainTvl, `__global__` still double-count (MED-3) |
| Curve / UniV3 / Aerodrome known-pool index (beyond exact) | `fetch-primary.ts:397–434` | Exact only; derived/wildcard coverage forfeited (MED-5) |
| Top-pools JSON dedup | `scoring-helpers.ts:110–113` | No explicit dedup — inherits bugs from `m.topPools` duplicates |
| Challenger pool dedup per stablecoin | `challenger-persistence.ts:240–279` | No intra-coin dedup; DB conflict clause masks it (LOW-1) |
| `dex_prices` duplicate-observation collapse | `scoring-helpers.ts:347–383` | Clean — collapses by `poolKey` (exact) or `derivedMatchKey` (unique) |
| EVM address case normalization | `pool-identity.ts:112` | Clean (case-insensitive) |
| Solana base58 case normalization | `pool-identity.ts:112` | Fragile — lowercased on both sides, loses case but symmetric (MED-6) |
| Balancer direct-API key-off address (not vault id) | `fetch-balancer.ts:104–114` | Clean |
| PancakeSwap + variants protocol normalization | `pool-helpers.ts:173–193` | **Broken** for hyphenated variants (HIGH-4) |
| Aerodrome Slipstream classification order | `pool-helpers.ts:25–40` | **Broken** — generic `aerodrome` branch wins before `aerodrome-slipstream` (LOW-3) |
| `mergeSecondaryPools` internal dedup | `fetch-crawlers.ts:30–51` | No defense — caller is expected to dedup (LOW-4) |

## Recommended remediation order

1. **HIGH-1** (global poolId canonicalization) — blast radius covers every downstream aggregate. Fixing this alone neutralizes most of HIGH-2/HIGH-3/LOW-1 severity in the global row.
2. **HIGH-4** (`normalizeProtocol` hyphen handling) — two-line fix, unlocks derived dedup for PancakeSwap / pcs-v3 / uniswap-v3 variants.
3. **HIGH-3** (CG tickers poolId convention + knownPoolIndex threading) — ≤10 LOC fix.
4. **HIGH-2** (Balancer shape identity) — small fallback in `resolvePoolShapeFamily` or `classifyPoolType`.
5. **MED-1** / **MED-2** — widen the wildcard rail or attempt exact-key pairing across parallel pools.
6. **MED-3** — thread `metapoolAdjustedTvl` into raw `tvlUsd`.
7. **MED-4** — prefer higher-TVL row on poolId collision.
8. **MED-5** — pass token addresses when registering known Curve/UniV3/Aerodrome identities.
9. **LOW-1**, **LOW-2**, **LOW-3**, **LOW-4** — defensive cleanups.

No tests currently cover `accumulateGlobalAggregate` dedup or the staged-vs-fallback CG tickers interaction. Any fix should add unit coverage for the two traced scenarios B and C above.
