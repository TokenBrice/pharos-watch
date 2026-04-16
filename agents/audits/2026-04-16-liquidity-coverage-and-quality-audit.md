# Liquidity Coverage & Code Quality Audit (2026-04-16)

Scope: `/liquidity` feature + `worker/src/cron/dex-liquidity/` pipeline (~39 files, 9,494 LOC).
Methodology: live D1 probe via wrangler (`stablecoin-db` remote), static file inspection, `npx knip`, `cd worker && npx tsc --noEmit`, `npx vitest run src/cron/dex-liquidity/`.

---

## Part A: Coverage

### A.1 Current State (live D1 snapshot)

190 tracked stablecoins = 180 active + 10 pre-launch. All 180 active coins have a `dex_liquidity` row (no ghost coins missing from scoring). Coverage class breakdown:

| Coverage class | Count | Share |
| -------------- | ----- | ----- |
| `mixed`        | 91    | 51%   |
| `fallback`     | 36    | 20%   |
| `primary`      | 31    | 17%   |
| `unobserved`   | 22    | 12%   |

Observations:

- Only 17% of tracked coins reach `primary` (pure DL + direct-API). Half of the universe sits at `mixed` and a fifth at `fallback` — i.e. at least one DL or direct row plus CG-onchain/GT/DS/CG-tickers augmentation.
- 22 coins are `unobserved` — mostly RWA, pre-launch, or single-chain exotic assets (see A.2).
- Top cross-stablecoin deduped protocols (from `__global__.protocol_tvl_json`) are led by UniV3 ($1.73B), Curve ($1.55B), Raydium ($998M), UniV4 ($677M), **QuickSwap ($471M, no direct fetcher)**, PancakeSwap ($440M), Fluid ($312M), Orca ($235M), Aerodrome ($149M), UniV2 ($143M), Meteora ($99M), **Kumbaya ($46M, Solana, no direct fetcher)**, Sushiswap ($46M), **Pharaoh ($29M + $17.5M v3 + $5.5M, no fetcher)**, **Joe v2.2 ($22.7M)**, **Camelot v3 ($20M)**, **Kodiak v3 ($19.6M, Berachain)**, **BlackHole ($19M + $18.8M CLMM, Avalanche)**, Balancer ($18.8M), **BlueFin ($17.6M, Sui)**, **Cetus CLMM ($19M, Sui)**, **SparkDEX ($15.2M + $6.2M v4, Flare)**, **Ston.fi ($12.3M, TON)**, **Hyperion ($11.3M, Aptos)**, **Noble Swaps ($10.9M)**, **Manifest ($10.7M)**, **Figure Markets ($9.1M, Provenance)**.

### A.2 Per-Coin Gaps

**Unobserved (22 coins, `coverage_class='unobserved'`, zero pools):**

| Stablecoin | Root cause |
| --- | --- |
| `buidl-blackrock` | Permissioned RWA, no public DEX market. Expected. |
| `tbill-openeden`, `usyc-hashnote`, `ustb-superstate`, `ousg-ondo-finance`, `rwausdi-multipli`, `isc-international-stable-currency` | Permissioned RWA tokens. Correct `unobserved`. |
| `silk-shade-protocol` | Deployed only on Secret Network (privacy chain, no public AMM indexing). Impossible to cover without Secret-specific bridge. |
| `usdh-hermetica` | BTCfi stablecoin; Hermetica markets primarily via internal venues. |
| `btcusd-btcfi`, `usdnr-nerona`, `axcnh-anchorx`, `chfau-allunity`, `cgusd-cygnus-finance`, `usdm-moneta` (Cardano!), `usdh-hermetica` | Low-circulation or illiquid; many may never get a DEX market. |
| `usdk-kast`, `usdk-orki`, `usdq-quill` | New / pre-scale — partial launches. May resolve via discovery over time. |
| `usdf-astherus`, `usbd-bima`, `xo-exodus`, `uusd-youves` (Tezos) | Emerging / chain-restricted deployments. Tezos has no provider mapping. |

**Fallback with very weak signal (score <25, confidence <0.5):**

| Stablecoin | Score | Confidence | Source mix | Root cause |
| --- | --- | --- | --- | --- |
| `m-m0` | 11 | 0.35 | cg_onchain 1 pool / $6K | M has contracts on ETH/OP/ARB/Base/Solana/HyperEVM but primary markets are extending; currently stuck in CG_onchain-only. |
| `wsrusd-reservoir` | 13 | 0.45 | cg_onchain 1 pool / $2K | Katana deployment (no provider mapping) + no discovery hit on ETH. |
| `yousd-yield-optimizer` | 13 | 0.42 | cg_onchain 4 pools / $9K | Yield wrapper; discovery-only. |
| `mnee-mnee` | 13 | 0.45 | cg_onchain 1 pool / $199K | Regulated USD stable on Base; single pool observed. |
| `zeusd-zoth` | 14 | 0.35 | cg_onchain 1 pool / $1.5K | Thin market. |
| `satusd-river` | 14 | 0.48 | cg_onchain 7 pools / $49K | BTCfi stable, thin pools. |
| `idrt-rupiah-token` | 16 | 0.35 | cg_onchain 3 pools / $4K | Indonesian Rupiah, 2-decimal; primary liquidity on orderbooks (Indodax, Tokocrypto), not covered. |
| `gyen-gyen` | 18 | 0.40 | cg_onchain 2 pools / $35K | JPY stable; CG tickers would add Coinbase/Crypto.com books. |
| `ftusd-flying-tulip`, `mtbill-midas`, `cusd-cap` | 20–29 | 0.35–0.45 | cg_onchain, tiny | Midas mTBILL is regulated RWA on Etherlink (no provider map). |
| `euri-banking-circle` | 22 | 0.50 | cg_onchain 15 / $1.3M | EUR stable, regulated; would benefit from CEX ticker aggregation (Bitstamp, Kraken EUR books). |
| `xaum-matrixdock` | 23 | 0.45 | cg_onchain 5 / $201K | Gold token; orderbook-heavy. |
| `usnd-nerite` | 27 | 0.50 | cg_onchain 3 / $14K | Nerite bridged/borrow stable. |
| `ggbr-goldfish-gold` | 30 | 0.35 | cg_onchain 1 / $249K | Single pool. |
| `uty-xsy` | **34** | 0.50 | **cg_onchain 4 / $11.9M** | **Significant TVL but no direct fetcher**. Avalanche-only — Trader Joe / Pharaoh would promote to `primary`. |

**Fallback with `cg_tickers` only (orderbook synthetic, low confidence):**

| Stablecoin | Score | Source mix |
| --- | --- | --- |
| `kau-kinesis` | 42 | cg_tickers 1 / $3.6K — Kinesis Exchange is the only market. Correct CG-tickers fallback. |
| `kag-kinesis` | 48 | cg_tickers 3 / $1.3M |
| `pht-pht` | 47 | cg_tickers 1 / $14.7K |
| `aeur-anchored-coins` | 43 | cg_onchain + cg_tickers |
| `gusd-gate` | 50 | cg_tickers 1 / $1.2M (Gate.io) |
| `usda-anzens` | 58 | cg_tickers 1 / $498K |
| `jupusd-jupiter` | 61 | cg_tickers 2 / $6.8M — Jupiter stablecoin; should have Raydium/Orca direct pools but isn't being matched. **Investigate**. |
| `hollar-hydrated` | 62 | cg_tickers 1 / $1.3M (HydraDX) — Polkadot chain. |
| `usdgo-osl` | 55 | cg_tickers 2 / $2.9M |
| `wusd-worldwide` | 57 | cg_tickers 4 / $324K |
| `usdn-noble` | **72** | **cg_tickers 1 / $10.9M (noble-swaps)** — Noble chain has Noble Swaps AMM ($10.9M TVL); should be promoted to direct fetcher. |
| `cgo-comtech` | 70 | cg_tickers 3 / $3M |
| `eurr-stablr` | 80 | cg_tickers 19 / $9.3M |

**GT-only with no primary anchor:**

| Stablecoin | Pools | TVL | Note |
| --- | --- | --- | --- |
| `usdh-native-markets` | 21 | $3.5M | HyperEVM only. No direct fetcher (Hyperion, HyperSwap v3). |
| `feusd-felix` | 15 | $131K | HyperEVM only. |
| `usdb-blast` | 19 | $940K | Blast chain. Thruster/Bladeswap etc. none covered directly. |
| `usdm-mega` | 13 | $25M | MegaETH — currently has provider mapping, but no direct fetcher for Prism-megaeth, Atlantis-monad, etc. |
| `pusd-plume` | 11 | $2.1M | Plume. |
| `nect-beraborrow` | 9 | $1M (cg_onchain) | Berachain; Kodiak/BEX/BlackHole — no direct fetcher. |
| `usdsc-startale` | 3 | $1.6M | Soneium / Astar ecosystem. |

### A.3 Per-Chain Gaps

60 chains have at least one tracked stablecoin deployment but **no entry** in `shared/lib/chain-provider-registry.ts` (so not even GT/DS/CG discovery runs for these coins on those chains). Ranked by tracked-stablecoin count:

| Chain | Tracked coins deployed | Material assets affected |
| --- | --- | --- |
| stellar | 8 | USDC, PYUSD, EURC, EURCV, AUDD, CETES, EURS, USDY. No provider mapping. |
| tron | 7 | USDT, USDC, TUSD, USDD, USD1, USDKG, A7A5. **Has CG+DS mapping but no GeckoTerminal** (see `CHAIN_REGISTRY.tron`), and no direct fetcher for SunSwap/JustMoney. Tron USDT circulating is huge — the largest non-covered deployment by supply. |
| aptos | 7 | USDC, USDT, USDE, FRXUSD, USD1, BUIDL, USDY. Hyperion ($11.3M), Thala, Tapp — no coverage. |
| xrpl | 6 | RLUSD, EURCV, USDC, EURP, USDQ, VEUR. No provider coverage. |
| near | 6 | USDC, USDT, DAI, GUSD, USDD, CUSD. |
| fraxtal | 6 | FRAX, FRXUSD, DUSD, USDE, VEUR, CRVUSD. Fraxswap not captured directly. |
| ink | 6 | Already in registry. |
| osmosis | 3 | USDC, USDY, EURE. Osmosis DEX is the largest non-EVM DEX not covered. |
| noble | 3 | USDC, USDN, USDY. Noble-swaps has **$10.9M** in __global__. |
| ton | 3 | FDUSD, USDT | Ston.fi ($12.3M deduped). Not covered. |
| tezos | 3 | USDT, EURL, UUSD | No provider mapping at all. |
| klaytn | 4 | USDT, DAI, IDRX, USDA |
| cardano | 2 | USDC, USDM. No DEX coverage (Minswap, Sundaeswap). |
| starknet | 1 | USDC — Ekubo $3.1M. Not covered. |
| xdc | 2 | USDC, USDF | |
| katana | 4 | AUSD, DUSD, WSRUSD. New chain. |
| apechain | 2 | PGOLD, PUSD (Pleasing) |
| etherlink | 3 | MTBILL, IDRX, USDT | |
| kava | 4 | DAI, USDT, MIM, USDE | |
| Others (<=2 coins) | flare, sophon, provenance, sui (partial), polygon-zkevm, mode, swellchain, pulsechain, polkadot/hydration (HOLLAR), harmony, zircuit, morph-l2, mezo, bsquared, bob, bitlayer, bitcoin-rootstock, … | |

Chains already in the registry (so GT/DS/CG discovery runs) but **no direct fetcher** despite material liquidity: `sonic`, `mantle`, `scroll`, `linea`, `blast`, `zksync`, `monad`, `hyperevm`, `plume`, `megaeth`, `worldchain`, `unichain`, `soneium`, `taiko`, `mode`, `manta`, `sei`, `berachain`, `bob`, `sui`.

### A.4 Recommended New Sources (Ranked)

Ranked by (expected coverage uplift × affected tracked coins) vs. (fetcher implementation effort). Each entry includes the public API endpoint — implementation is meant to drop into `worker/src/cron/dex-liquidity/fetch-<name>.ts` alongside the eight existing direct fetchers and get registered in `buildDexDirectApiFetchers()` in `orchestrator-phases.ts:144`.

1. **Osmosis + Noble Swaps (Cosmos SDK)** — low effort, $10.9M+ immediate coverage uplift, unblocks `usdy-ondo-finance`, `usdn-noble`, `eure-monerium`, and improves `usdt-tether`/`usdc-circle` chain diversity.
   - Noble: `GET https://swap-api.noble.xyz/v1/simulate/stableswap/pools` (or the indexer used by the Noble dashboard). Alternative: query Cosmos REST `https://noble-api.polkachu.com/noble/dollar/v2/state`.
   - Osmosis: `GET https://sqs.osmosis.zone/pools` returns all pools with TVL + volume + token balances. Osmosis also has a well-documented CLMM indexer.
   - Why first: highest TVL-per-coin uplift in a protocol that already contributes $10.9M via CG-tickers fallback. Brings `usdn-noble` from `fallback` to `primary`.

2. **Trader Joe (v2 / v2.1 / v2.2) + Pharaoh on Avalanche** — low effort, $47M+ combined, unblocks `uty-xsy` (currently stuck at score 34, fallback), improves `usdt-tether`, `usdc-circle`, `avusd-avant`, `usde-ethena` on Avalanche.
   - Trader Joe Liquidity Book: `GET https://barn.traderjoexyz.com/v1/pools/avalanche` (or the official LBPair subgraph on Graph Gateway).
   - Pharaoh: `GET https://api.pharaoh.exchange/v1/pools` (Pharaoh v3 is a SolidlyCL fork; pool list endpoint returns TVL, volume, feeTier).
   - Unblocks: `uty-xsy` (Avalanche-only, $11.9M TVL stuck in CG-onchain).

3. **Sui DEXes (Cetus + BlueFin + Turbos)** — medium effort (non-EVM), $39M+ combined.
   - Cetus CLMM: `GET https://api-sui.cetus.zone/v2/sui/stats_pools?is_vaults=false&display_all_pools=false&has_mining=false`.
   - BlueFin Spot: `GET https://swap.api.sui-prod.bluefin.io/api/v1/pools/info`.
   - Turbos: `GET https://api.turbos.finance/pools/v2`.
   - Unblocks: `usdc-circle`, `usdt-tether`, `usdy-ondo-finance` on Sui. Sui already has registry mapping but discovery-only.

4. **Aptos DEXes (Hyperion + Thala + Tapp)** — medium effort, $15M+ combined, unblocks 7 tracked coins including `usdt-tether`, `usdc-circle`, `usde-ethena`, `frxusd-frax`, `usdy-ondo-finance`, `usd1-world-liberty-financial`, `buidl-blackrock`.
   - Hyperion (AMM + CLMM): `GET https://api.hyperion.xyz/pools` (check — may be subgraph-based via indexer).
   - Thalaswap v1/v2: `GET https://api.thalalabs.xyz/v1/pool` (THL foundation API).
   - Tapp Exchange: Aptos node REST (`view`) calls per pool or indexer dashboard endpoint.
   - **Registry gap:** Aptos is not yet in `CHAIN_REGISTRY`. Must add first.

5. **Hyperion / HyperSwap v3 on HyperEVM** — low effort, unblocks `usdh-native-markets` (21 pools, $3.5M, currently `fallback`), `feusd-felix`, improves `usde-ethena` HyperEVM coverage, `usdt-tether`, `ramses-v3-hyperevm` aggregation.
   - Hyperion: HyperSwap v3 subgraph-compatible endpoint at Goldsky (`https://api.goldsky.com/api/public/project_cm.../subgraphs/hyperswap-v3/...`). Alternatively query the Graph Gateway with the subgraph ID.
   - HyperEVM has registry entries — direct fetch would promote from `fallback` to `primary`.

6. **Berachain native DEXes (Kodiak + BEX + BlackHole)** — low effort, $41M+, unblocks `nect-beraborrow` (currently $1M cg_onchain only), `honey-berachain`, `ausd-agora` on Berachain.
   - Kodiak v3: subgraph on Berachain Graph gateway (`kodiak-finance/kodiak-v3`).
   - BEX: `GET https://api.berachain.com/` GraphQL (pools query — same shape as Balancer v3 GraphQL since BEX is Balancer-forked). Could share the `fetchBalancerPools()` machinery by parameterising the endpoint.
   - BlackHole v2/v3: check for public indexer / API.

7. **QuickSwap v3 (Polygon)** — medium, **$471M deduped TVL** from `__global__` (!!! largest uncovered protocol by TVL). Affects `usdc-circle`, `usdt-tether`, `dai-makerdao`, `maticx-...`, `agEUR`, etc. QuickSwap v3 is Algebra Finance forked, has a public Graph subgraph.
   - Subgraph: `https://api.studio.thegraph.com/query/44554/quickswap-v3/v0.0.7` (or similar — verify via Goldsky/QS docs).
   - Big-bang integration — but QS currently flows through DL yields as generic `quickswap`, so the direct-fetcher upgrade mostly improves balance-ratio + feeTier measurement, not pure coverage count.

8. **PancakeSwap v3 extensions (Arbitrum, zkSync, Polygon zkEVM, Linea, opBNB)** — very low effort, the existing `fetch-pancakeswap.ts` already handles the subgraph pattern for BSC/ETH/Base. Extending to additional PancakeSwap v3 chains just adds subgraph IDs to the chain list and updates `supportedChains` in `buildDexDirectApiFetchers`.

9. **TON: Ston.fi** — medium (non-EVM, TON-specific addressing), $12.3M deduped TVL. Unblocks `usdt-tether` and `fdusd-first-digital` on TON.
   - `GET https://api.ston.fi/v1/pools` returns pool list with reserves/TVL.
   - Requires TON address format handling (base64 / bounceable). Need to add TON to `CHAIN_REGISTRY`.

10. **Stellar Soroswap / Aqua** — medium, unblocks 8 tracked coins (USDC, PYUSD, EURC, EURCV, AUDD, CETES, EURS, USDY).
    - Stellar Horizon DEX orderbook API: `GET https://horizon.stellar.org/order_book?selling_asset_type=credit_alphanum4&selling_asset_code=USDC&selling_asset_issuer=...`.
    - Soroswap contracts on Soroban: on-chain reads via `soroban-rpc`. Higher effort.
    - Stellar currently has no provider mapping at all.

11. **Thena / Thena Fusion (BSC)** — low effort via subgraph. Covers Thena v3 CLMM alongside existing PancakeSwap fetcher.

12. **Camelot v3 (Arbitrum)** — low, $20M TVL. Algebra Finance fork. Subgraph on Arbitrum Graph gateway. Affects all Arbitrum stablecoins.

13. **Fraxswap on Ethereum/Arbitrum/BSC/Polygon/Avalanche/Optimism/Fraxtal** — low effort. Unblocks `frax-frax`, `frxusd-frax`, `crvusd-curve` on Fraxtal specifically.

14. **Sonic/Fantom native (Shadow, Equalizer, Spooky v3)** — medium. Sonic is in registry but direct coverage would help `usds-sky`, `eusd-elixir` migration.

15. **CEX orderbook expansion beyond the current diagnostic canary** — the Binance/Coinbase/Kraken canary (`worker/src/lib/cex-orderbooks.ts`) only reports for USDC/USDT in metadata and does not feed scoring. Promoting this to a real ingest source would unblock **all** the `cg_tickers` fallback cases (KAG, KAU, AEUR, JUPUSD, PHT, USDN, USDA, HOLLAR, CGO, GUSD-Gate, WUSD, USDGO, EURR) with measured depth rather than synthetic volume × 3.
    - Bitstamp, OKX, Kraken, Gate, Bitget, HTX, MEXC — all expose `/api/v3/depth`-style endpoints.

16. **XRPL AMM pools (RLUSD)** — `rippled` `book_offers` / `amm_info` RPC. Unblocks RLUSD, EURCV, USDC on XRPL.

17. **Solana: Meteora DAMM / DBC / DLMM v2** — already covered in Meteora fetcher, but DAMM (dynamic AMM) and DBC (DLMM v2) have separate endpoints. Worth a pass.

Not recommended (effort >> value):
- **Secret Network (for `silk-shade-protocol`)** — privacy-preserving chain, no public indexer. Document as a permanently unobservable asset.
- **Cardano (USDM)** — Minswap API exists but Cardano addressing + Plutus pool model is non-trivial. Single tracked coin.
- **Algorand (USDC, USDQ)** — Tinyman API exists, but USDC/USDT already have strong non-Algorand coverage.
- **ICP (USDC)** — single-chain, single-coin.

---

## Part B: Code Quality

### B.1 Structural Issues (Critical)

**B.1.1 Orchestrator coupling leak via `DexLiquidityPoolState extends DexLiquidityFallbackPhase`.**
`worker/src/cron/dex-liquidity/orchestrator.ts:171-180` defines `DexLiquidityPoolState` by inheritance from `DexLiquidityFallbackPhase`, then spreads the fallback result with `...fallback` at line 361. This works, but the pool-state interface becomes partially defined by the return shape of a phase module it shouldn't know about. Consequence: adding a field to `FallbackCrawlerPhaseResult` silently changes `DexLiquidityPoolState`. A named composition field (`fallbackStats: DexLiquidityFallbackPhase`) is strictly more readable and survives grep/rename.

**B.1.2 Phase outputs declared via `Awaited<ReturnType<typeof ...>>`.**
`orchestrator.ts:145-152`. Six type aliases are all derived via `Awaited<ReturnType<typeof foo>>`. This guarantees type drift when phase signatures change — but it also means the orchestrator cannot be read without opening every imported module. Promoting each phase's output to an exported interface in `orchestrator-phases.ts` / `orchestrator-metadata.ts` (several already exist — `SubgraphEnrichmentPhaseResult`, `DirectApiFetchPhaseResult`, `FallbackCrawlerPhaseResult`) and using those directly would make `orchestrator.ts` self-describing.

**B.1.3 `filterPrimaryPoolsPreferDirectApi` lives in `orchestrator.ts` but is pure pool-identity logic.**
`orchestrator.ts:42-111` — 70 LOC of identity-dedup math mixed into the top-level composition file. This belongs in `pool-identity.ts` or a new `primary-pool-filter.ts`. Nothing in it depends on run context; it reads only pools + direct API pools + `buildPoolIdentity`. Moving it would shrink `orchestrator.ts` to ~440 LOC and make it a pure coordination layer.

**B.1.4 Scoring state rebuild happens twice on every coin.**
`scoring.ts:139-155`: `filterRetainedPools` → `applyProtocolCaps` → `rebuildMetricsFromPools` → `applyRebuiltMetrics` → `accumulateGlobalAggregate`. The rebuild is explicit in the doc but the function-chain across three files makes it hard to see that the ordering is load-bearing. A `recomputeMetricsAfterRetentionFilters(metric, protocolTvlCaps, globalAccumulators)` wrapper in `scoring-helpers.ts` would collapse the five-function dance and make the invariant ("rebuild aggregates only from the post-filter retained surface") obvious.

### B.2 Maintainability Issues (Major)

**B.2.1 Direct fetchers duplicate the pagination+error-collection pattern.**
Compare `fetch-raydium.ts:49-120` (pagination, errors[], successfulPages counter, `readDexApiJson`, parse loop) vs `fetch-meteora.ts:58-160` (identical shape) vs `fetch-balancer.ts`, `fetch-orca.ts`. Each fetcher reimplements the same "loop over pages, break on first error, collect errors array, record successfulPages, call makeDexApiFetchResult" scaffolding. The extracted helpers `direct-api-json.ts` (23 LOC) and `direct-source-helpers.ts` (35 LOC) only handle JSON parsing and identity building — they do not own the fetch loop. A `runPaginatedDirectApiFetch<TResponse, TPool>({ url, pageSize, parse, mapPool, fetchTimeoutMs })` helper would eliminate ~200 LOC of duplication across eight fetchers and — more importantly — unify how partial-page failures are surfaced to the circuit breaker. Today each fetcher makes slightly different decisions about when to set `ok: false` vs `degraded: true`, which has caused audit drift before (see MEMORY.md fetcher-failure propagation rule).

**B.2.2 `fetch-primary.ts` is 527 LOC and does too much.**
It owns: DL yields fetch, DL protocols fetch, Curve API fan-out, UniV3 orchestration delegation, Aerodrome orchestration delegation, curve lookup building, known-pool-address building, and part of the price observation extraction. Split candidates:
- `fetch-dl-yields.ts` — DL Yields + Protocols.
- `fetch-curve.ts` — Curve API fan-out + Curve lookup building.
- Leave `fetch-primary.ts` as a thin orchestrator for those two.
`fetchUniV3Data` and `fetchAerodromeData` are already re-exports from `subgraph-source-families.ts`, so those lines are just re-export noise.

**B.2.3 `challenger-persistence.ts` (677 LOC) is the largest file.**
It has its own graveyard of unused types: `DexPriceChallengerPoolRow`, `DexPriceChallengerSnapshotRow`, `DexPriceChallengerPublicationInput`, `DexPriceChallengerPublicationPlan`, `DexPriceChallengerLoadDiagnostics`, `DexPriceChallengerLoadResult`, `DexPriceChallengerTableState`, `DexPriceChallengerSqlStatement` (all flagged by knip — see B.3.1). It also defines an unused `detectDexPriceChallengerTableState` function. Worth a one-time cleanup pass + consider splitting into `challenger-load.ts` + `challenger-publish.ts`.

**B.2.4 `orchestrator-phases.ts` (619 LOC) mixes fetch coordination with integration logic.**
It exports:
- Fetcher catalog builder (`buildDexDirectApiFetchers`)
- Context loaders (`loadTrackedStablecoinPriceMap`, `loadTrackedStablecoinMcapMap`)
- Subgraph enrichment runner (`fetchSubgraphEnrichmentPhase`)
- Direct API runner (`runDirectApiFetchPhase`)
- Authoritative confirmation index (`buildAuthoritativeStagedPoolConfirmationIndex`)
- Direct-API integration into metrics (`integrateDirectApiLiquidityPhase`)
- Fallback crawler runner (`runFallbackCrawlerPhase`)
- Price observation merge helper (`mergeDexPriceObservationMap`)
The last three are conceptually pool-state mutation; the first five are source loading. A split into `phases/source-loading.ts` + `phases/metric-integration.ts` would map exactly onto the `loadDexLiquiditySourceState` vs `buildDexLiquidityPoolState` boundary in `orchestrator.ts`.

**B.2.5 `score-weights.ts` is an 11-LOC re-export shim.**
`worker/src/cron/dex-liquidity/score-weights.ts` only re-maps `LIQUIDITY_SCORE_WEIGHTS[0..4].weight` to named keys. The array in `@shared/lib/liquidity-score-weights.ts` is the source of truth. The shim exists for ergonomics but also hides the fact that the index order is load-bearing. A named export from the shared file (`LIQUIDITY_COMPONENT_WEIGHTS` in `@shared/lib/liquidity-score-weights.ts`) would eliminate this file.

### B.3 Polish (Minor)

**B.3.1 Dead code flagged by `npx knip --workspace worker`:**
- `challenger-persistence.ts`: unused export `detectDexPriceChallengerTableState` and 8 unused type exports.
- `fetch-crawlers.ts`: unused exports `fetchCgPools`, `fetchGtPools` — crawl logic was moved to the discovery cron, these are leftovers.
- `geckoterminal-shared.ts`: unused `getGtPoolKind`.
- `pool-identity.ts`: unused `buildKnownPoolIdentityIndex` (alongside the still-used `createKnownPoolIdentityIndex`). Name collision suggests incomplete refactor.
- `token-resolution.ts`: unused `resolveStablecoinToken`, `buildChainAddressKey`, `makeChainAddressKey`, and type exports `TokenResolutionResult`, `TokenResolutionOptions`.
- Several phase result types exported but only consumed via `Awaited<ReturnType<typeof ...>>` in `orchestrator.ts` (so they read as "unused" to knip even though they're technically live).

**B.3.2 Scoring logic is fragmented across five files but each file is reasonable.**
`scoring.ts` + `scoring-helpers.ts` + `score-weights.ts` + `pool-contribution.ts` (105 LOC) + `process-pools.ts` (283 LOC). The distinction between `scoring.ts` (cron-entrypoint-facing) and `scoring-helpers.ts` (reusable math) is defensible. However, the split `scoring-helpers.ts` ↔ `pool-contribution.ts` is less clear — both operate on pool mutation and metric accumulation. Consider merging `pool-contribution.ts` into `scoring-helpers.ts`.

**B.3.3 Magic numbers in coverage classifier.**
`scoring-helpers.ts:307-319` — the confidence formula uses raw numeric weights (0.35 base, +0.2 protocol breadth, +0.15 source family breadth, +0.10 measured balance, +0.05 measured organic, +0.10 measured price, −0.25 synthetic, −0.15 decayed, +0.15 for pure primary, +0.05 for mixed, −0.05 for fallback). These are load-bearing heuristics and deserve to be constants at the top of the file (or in `score-weights.ts`) with a one-line doc. Current form makes it hard to A/B-test tuning.

**B.3.4 Comment drift / stale TODO hints.**
- `scoring.ts:215-217`: "M3: Global protocol-level TVL cap: when reducing excess, chain TVLs are distributed proportionally rather than attributed to the chain with the most excess." The M3 marker refers to an old milestone naming convention — useful historically, confusing today.
- `scoring.ts:346-362`: "H2" and "H1" comment tags for "heuristic 1/2" — same issue.
- `fetch-raydium.ts` typing: `RaydiumResponse.data.data: unknown` — the inner `unknown` is correct but the comment could explain why Raydium double-nests data.

**B.3.5 Type cast to `Record<string, number | unknown>` in `applyProtocolCaps`.**
`scoring-helpers.ts:200` — `const extra = pool.extra as Record<string, number | unknown>;`. This is the one "escape hatch" cast in the entire directory (no `any`, no `@ts-ignore`). It's because the scaling loop mutates arbitrary extra fields. A narrower helper (`scaleTvlFields(pool.extra, scale)`) with a known-fields whitelist would avoid the cast.

**B.3.6 Console logging density is uneven.**
`fetch-primary.ts:19`, `orchestrator-phases.ts:14`, `fetch-fallbacks.ts:12` — hot spots with 12-19 console.* calls each. `scoring.ts` has only 4 across 449 LOC. Most logging is unstructured template strings. No structured logging library is used, which is consistent with the rest of the worker codebase — not an issue, just a note if structured telemetry is ever wanted downstream.

### B.4 Testing Gaps

Vitest run: `11 test files, 61 tests passed (811ms)`.

**Files with tests:** `fetch-crawlers`, `fetch-fallbacks`, `fetch-meteora`, `fetch-pancakeswap`, `fetch-primary`, `fetch-slipstream`, `geckoterminal-shared`, `orchestrator-metadata`, `orchestrator-phases`, `pool-identity`, `staging-merge`.

**Files with NO direct tests (28 of 39 source files, ~72%):**
- **Scoring (critical gap):** `scoring.ts` (the heart of the feature), `scoring-helpers.ts` (all rebuild/classify/collapse logic), `score-weights.ts`, `pool-contribution.ts`, `process-pools.ts`, `pool-helpers.ts` (`computeLiquidityScore`, `computeDurabilityScore`).
- **Direct API fetchers:** `fetch-balancer.ts`, `fetch-fluid.ts`, `fetch-orca.ts`, `fetch-raydium.ts` — only Meteora, PancakeSwap, and Slipstream are covered. Per MEMORY.md, "real API fixtures, not hand-crafted mocks" is a learned rule; the existing Meteora test does use a real fixture shape which is the right pattern.
- **Persistence / price computation:** `persistence.ts`, `challenger-persistence.ts`, `computeDexPrices` / `computeDepthStability` inside `scoring.ts`.
- **Shared helpers:** `coingecko-onchain-shared.ts`, `coingecko-tickers-shared.ts`, `crawl-helpers.ts`, `token-batch-runner.ts`, `token-price-observations.ts`, `token-resolution.ts`, `subgraph-family-runner.ts`, `subgraph-source-families.ts`, `subgraph-helpers.ts`, `price-sanity.ts`, `direct-api-json.ts`, `direct-source-helpers.ts`.
- **Top-level orchestrator** (`orchestrator.ts`) — no direct test; only phase-level integration tests cover parts of it.

Critical recommendation: add unit tests for `computeStablecoinScores`, `classifyCoverage`, `computeLiquidityScore`, `computeDurabilityScore`, and `collapseDuplicateObservations`. These are the pure-math surfaces with zero external dependencies — tests should be cheap and high-leverage.

### B.5 Type System Gaps

- `cd worker && npx tsc --noEmit` is **clean** — no errors, no warnings.
- Zero instances of `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `as any`, or `: any` in the entire `dex-liquidity` directory (grep confirmed). This is excellent discipline.
- One type escape in `scoring-helpers.ts:200` (`as Record<string, number | unknown>`) — noted in B.3.5.
- `ScoreResult` vs `FullScoreResult` in `types.ts:238-333` — `FullScoreResult = ScoreResult & { ... }`. The base `ScoreResult` (only `tvl`, `vol24h`, `score`) is not meaningfully used on its own; `FullScoreResult` is what flows through the pipeline. Either inline `ScoreResult`'s fields into `FullScoreResult` and delete the base type, or document where the split matters.
- `PoolEntry.extra` (types.ts:96-119) mixes well-typed fields with an implicit assumption that the mutation code (`scoring-helpers.ts:200-206`) will only touch numeric ones. The `measurement` sub-record is properly typed via `PoolMeasurementFlags`. Reasonable shape; main improvement would be to discriminate `source` (`"dl" | "direct_api" | "cg_onchain" | ...`) by `sourceMix` key validity.
- Several exported phase types are only consumed internally (knip flags them) — see B.3.1.

### B.6 Orchestration-level Error Handling

Reviewed all `try/catch` blocks (41 total across 22 files). No silently-swallowed errors. Two acceptable patterns:

- **`/* non-blocking */`** empty catch bodies (scoring.ts:120, challenger-persistence.ts:157). Both have explicit justification comments explaining the pre-migration fallback behavior.
- **`rethrowIfAborted(err, params.signal)` + `console.warn(...)`** in phase runners (`orchestrator-phases.ts:263, 282, 561, 582, 594`). Correct pattern — abort signals propagate, non-abort exceptions degrade the phase but don't kill the run.
- The three hard-throw guardrails in `scoring-state.ts` (`scoreDexLiquidityPoolState` at `orchestrator.ts:402-418`) — coverage guard, value guard, major coverage guard — all throw with full numeric context. Correct.

No error handling defects found at the orchestration layer.

---

## Priorities (Top 5 by ROI)

1. **Coverage: ship a Noble Swaps + Osmosis direct fetcher (A.4 #1).** Lowest effort, highest headline uplift — promotes `usdn-noble` from `fallback` → `primary`, adds confidence to `usdy-ondo-finance` and `eure-monerium`. $10M+ of deduped TVL currently routed through `cg_tickers` synthetic rows. Estimated: 1 day.
2. **Coverage: ship Trader Joe + Pharaoh direct fetchers on Avalanche (A.4 #2).** Unblocks `uty-xsy` ($11.9M TVL stuck at score 34) and improves Avalanche primary coverage for USDC/USDT/USDE/AVUSD. Estimated: 1–1.5 days.
3. **Quality: extract the direct-fetcher pagination scaffold (B.2.1).** Removes ~200 LOC of duplication across eight fetchers and unifies circuit-breaker-relevant error signaling. Prevents future drift where one fetcher reports `degraded` and another reports `ok: false` for the same failure mode. Estimated: 0.5 days.
4. **Quality: add unit tests for `computeStablecoinScores`, `classifyCoverage`, `computeLiquidityScore`, and `collapseDuplicateObservations` (B.4).** These are pure functions with zero external dependencies. Moving from 0% to ~70% coverage on the scoring core is cheap and high-leverage — and would give future weight-tuning work a safety net. Estimated: 0.5–1 day.
5. **Quality: clean up dead exports flagged by knip (B.3.1) and split `fetch-primary.ts` (B.2.2) + `orchestrator-phases.ts` (B.2.4).** Pure hygiene: eliminates three >500-LOC files, removes 15+ unused type exports, and moves `filterPrimaryPoolsPreferDirectApi` out of `orchestrator.ts`. Estimated: 0.5 days.

Followup candidates (not in top 5 but worth flagging): Sui DEXes (A.4 #3), Aptos DEXes + registry entry (A.4 #4), HyperEVM Hyperion/HyperSwap v3 (A.4 #5), CEX orderbook ingest promotion (A.4 #15), and the `score-weights.ts` re-export shim cleanup (B.2.5).
