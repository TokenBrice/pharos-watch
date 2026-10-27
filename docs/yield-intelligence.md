# Yield Intelligence

Risk-adjusted yield tracking and ranking for yield-bearing stablecoins and curated lending opportunities. Computes APY from deterministic on-chain reads, curated DeFiLlama pools, protocol-native yield APIs, price history, and benchmark-derived fallbacks; scores each coin via the Pharos Yield Score (PYS); and serves a dedicated `/yield` page plus a stablecoin-detail yield section. That detail section now renders for any asset with a live published ranking row, even when the coin itself is not statically marked `yieldBearing` (for example USDC/USDT lending opportunities or XAUT's curated Yo Protocol venue).

> **Agent navigation** — Grep the heading you need: Methodology Versioning · Tracked Coins · Source-Aware APY Resolution · Pharos Yield Score (PYS) · Benchmark Registry · Warning Signals · Engineering Contract.

---

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-yield-methodology -->`v8.52`<!-- GENERATED-END: methodology-version-yield-methodology -->
- **Public changelog page:** `/methodology/yield-changelog/`
- **Canonical source:** `shared/lib/methodology-versions/registry.ts`

Yield versions are bumped when APY source resolution, source arbitration, history semantics, PYS scoring logic, or score-affecting publication rules change.

**Open release gates:** v8.52 (USDGO reclassified as non-yield-bearing; its EFFR proxy is removed) activation is provisionally **2026-10-26 00:00 UTC (`1792972800`)**, to be re-dated at release. v8.51 (two-hour core publication; interval-derived stale/aging/API bounds double) is active from **2026-10-23 00:00 UTC (`1792713600`)**, shipped with the cadence release. v8.49 activation is provisionally **2026-10-16 00:00 UTC (`1792108800`)**, to be re-dated at release; fresh admitted observations and a valid comparison anchor are required. For v8.48, fixed-clock input/output comparison and owner review of changed outcomes remain release gates, separate from fresh producer observations and production resource evidence. Replay cannot reconstruct pruned mint evidence or unknown legacy Midas observation clocks. These are obligations, not claims of completed replay, deployment or production health.

Version deltas live in the [structured public changelog](https://pharos.watch/methodology/yield-changelog/), not a second release diary here. The [PYS contract](#pharos-yield-score-pys) owns score qualification, the [benchmark registry](#benchmark-registry) owns independent benchmark clocks, and [Persistence And Publication](#persistence-and-publication) owns migration-first ordering and final admission.
---

## Tracked Coins

Every stablecoin with `flags.yieldBearing: true` in `shared/lib/stablecoins/registry.ts` is inventoried by the yield manifest. Live cron resolution operates on the active subset (`status !== "pre-launch"`), while pre-launch or intentionally uncovered assets remain visible to operators through explicit manifest entries instead of silently disappearing from coverage accounting. Pre-launch status is declared in the asset's per-coin file under `shared/data/stablecoins/coins/*.json`, loaded through `shared/data/stablecoins/coins.generated.json`, and skipped by explicit lending override publication until the per-coin entry moves into the active lifecycle. The sync also supports deterministic custom sources for select non-yield-bearing coins, exact-pool curated overrides for select non-stablecoin assets, plus automatic lending pool discovery for tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), including coins already flagged `yieldBearing`. `yieldConfig` is used when present to provide canonical source/type labels; auto-discovered lending rows synthesize protocol-derived labels when the source is `defillama-auto`. Tracked savings wrappers own their own runtime pool/on-chain readers and history. When a tracked wrapper has a live native/wrapper yield source, the publisher may also expose that source on the active parent stablecoin with a `linked-variant:<variantId>:<sourceKey>` key for comparison and coverage context; this does not mark the parent `yieldBearing` purely because the wrapper exists, and external opportunity rows (`lending-opportunity`, `fixed-yield`, or `structured-tranche`) are not projected from variants to parents.

Open USD (`ousd-open-standard`) is not a holder-yield asset: the [issuer reserve page](https://reserves.bridge.xyz/ousd) describes earnings shared with participating platforms, not an on-chain holder return. No intentional holder-yield gap is needed. Origin Dollar's `OUSD` native pool belongs to `ousd-origin-protocol`; exact address or unambiguous chain-scoped symbol evidence cannot transfer that source to Open USD. Revisit if a public holder-return instrument or identity-bound lending market appears.

BRSRV (`brsrv-blackrock`) retains an `issuer-distributed-yield` gap, not a finding of no public yield evidence. [BlackRock's fund page](https://www.blackrock.com/cash/en-us/products/351891/blackrock-daily-reinvestment-stablecoin-reserve-vehicle) publishes dated RSVXX seven-day SEC yield and daily distribution factors; the [prospectus](https://www.blackrock.com/cash/literature/prospectus/pro-brsrv.pdf) provides daily share reinvestment unless cash dividends are elected. No reviewed distribution-return reader consumes those observations, and stable $1 NAV growth cannot measure holder income.

| Field         | Type        | Description                                                                                   |
| ------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `yieldSource` | `string`    | Human-readable source name (e.g. "Ethena staking"). Optional for auto-discovered lending rows |
| `yieldType`   | `YieldType` | Mechanism classification (see below). Optional for auto-discovered lending rows               |

### Yield Types

| Type                  | Label              | Description                                                              |
| --------------------- | ------------------ | ------------------------------------------------------------------------ |
| `lending-vault`       | Native             | Deposited into lending protocols or vault strategies                     |
| `rebase`              | Rebase             | Token supply rebases to distribute yield                                 |
| `fee-sharing`         | Fee Share          | Protocol fees passed to holders                                          |
| `lp-receipt`          | LP Receipt         | LP position wrapped as stablecoin                                        |
| `nav-appreciation`    | NAV                | Token price appreciates as backing grows                                 |
| `governance-set`      | Gov. Set           | Yield rate set by governance vote                                        |
| `lending-opportunity` | Lending Opp.       | Auto-discovered best lending market from the curated allowlist           |
| `fixed-yield`         | Fixed Yield        | Fixed-maturity principal-token opportunity over an underlying stablecoin |
| `structured-tranche`  | Structured Tranche | Senior/junior tranche opportunity over an underlying yield market        |

Labels and styles are centralized in `shared/lib/classification.ts` (`YIELD_TYPE_LABELS`, `YIELD_TYPE_STYLES`), both typed as `Record<YieldType, ...>` so adding a new variant without updating the maps is a compile error.

---

## Source-Aware APY Resolution

The sync cron resolves APY for each coin using a priority-ordered strategy. Deterministic and curated rows can coexist; the cron then applies confidence-weighted arbitration to choose the primary row while retaining alternatives.

### Tier 1: On-Chain Reads

Reads protocol state directly via `eth_call` RPC. The main path reads vault exchange rates and computes APY from the 7-day rate delta; special-case estimators can also derive APR from raw protocol state.

Tier 1 rate sources inherit measured venue TVL from their pinned DeFiLlama pool through a zero-fetch join. Audited ERC-4626 `totalAssets` reads cover verified residual vaults. Only measured venue TVL is written to `sourceTvlUsd` — never coin supply — and unavailable measurements remain null and fail closed for external-opportunity eligibility.

Exact contracts, chains, selectors and optional TVL reads are owned by [`ON_CHAIN_RATE_CONFIGS`](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/yield-config/yield-config-rate-sources.ts) and the [`OnChainRateConfig` schema](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/yield-config/yield-config-registry.ts). ERC-4626 entries
use `convertToAssets(uint256)` with one whole share in the vault's share decimals, then decode the result in underlying-asset
decimals. Axis sUSDx and Unitas XGLD instead read `exchangeRate()`; both deployments accept the generic reader's trailing zero word.
XGLD's rate is denominated in XAUt per token, so its growth measures the administered gold-unit return rather than changes in gold's USD price. It is an issuer-published NAV figure, not independently reconciled strategy profit: the privileged rate updater can increase it by up to 5 bps per update with no minimum update interval. The existing seven-day anchor, bootstrap rules and generic 300% APY sanity bound still apply; they do not independently verify realized income.
Protocol-specific assets use the dedicated paths described below. Optional
`totalAssets` reads are USD venue TVL only for USD-denominated underlyings; EURCV and gold-denominated assets are not reported as USD TVL.

`scrvusd-curve` is permanently excluded from the generic Tier 1 reader: its trailing 7-day `convertToAssets(1e18)` delta understates Curve's current profit-unlock APY. The dedicated scrvUSD current-rate estimator and independent DeFiLlama alternative remain active. `ustb-superstate` is also permanently excluded because USTB does not implement ERC-4626; its issuer-fund DeFiLlama pin remains available. A future dedicated Superstate NAV reader requires separate identity, freshness, units, and historical-anchor evidence.

The empty generic-quarantine reprobe lane has been retired. Monthly coverage audits continue for real source gaps and lifecycle reviews; cached historical restoration items remain readable and do not authorize re-enabling an incompatible reader.

**APY formula:**

```
lookbackDays = (publication_time - anchor_time) / 86_400
apy = ((rate_now / rate_anchor) ^ (365.25 / lookbackDays) - 1) * 100
```

The anchor is the newest published positive exchange rate at least seven days old; annualization uses its actual elapsed interval, not a fixed seven days.

The generic exchange-rate reader rejects computed APY above `DETERMINISTIC_APY_SANITY_MAX = 300`. Rejected observations are not published as `onchain` rows and the suspicious current exchange rate is not written as a new anchor; the resolver continues through lower tiers so curated DeFiLlama, protocol-API, or rate-derived coverage can win. The post-V9 sync records the rejected Tier 1 count at `sourceCoverage.onChainEnvelopeRejectionCount` and bounded examples at `sourceCoverage.onChainEnvelopeRejections` with a truncation flag. Those examples are diagnostic sync metadata only; fallback resolution is unchanged. Negative APY remains allowed because it is bounded by the ratio formula and can be useful stress evidence.

Invalid inputs or overflowed annualization return an explicit unavailable result with a named rejection reason; they do not become a 0% observation or a new history anchor. A genuine unchanged exchange rate still measures 0%.

Even when Tier 1 succeeds, the cron still falls through to Tier 2 to collect additional wrapper/native DeFiLlama rows. Without an admissible prior rate, the generic reader and the Ondo/Midas NAV readers resolve an **anchor-only** observation, not measured zero yield. The next admitted publication persists its existing seed shape (`apy: 0`, `apy_base: null`, positive `exchange_rate`) in `yield_history` with `is_best: 0`, under the same atomic generation fence. Seeds do not enter current yield rows, arbitration, rankings or alternatives, measured-coverage counts, or current rolling-statistics samples. Historical seed filtering is unchanged. A later admissible observation uses the durable anchor to compute return; genuine flat-rate zero and negative returns remain measured yield. Existing empty/absolute-coverage guards still hold the generation when independent measured coverage is insufficient; seeds do not bypass them.

#### Special-case Tier 1 estimator: Curve scrvUSD

scrvUSD uses a protocol-specific on-chain current-rate reader instead of the generic 7-day exchange-rate reader. The vault is a Yearn V3 vault that distributes newly reported crvUSD rewards through a profit-unlock stream, so the current APY shown by Curve and DeFiLlama is the daily-compounded value of the active unlock rate rather than the trailing 7-day `pricePerShare` delta.

**Reads:**

- `scrvUSD.totalAssets()`
- `scrvUSD.totalSupply()`
- `scrvUSD.profitUnlockingRate()`
- `scrvUSD.fullProfitUnlockDate()`

**Formula:**

```
sharesPerSecond = profitUnlockingRate / 1e12 / 1e18
apr             = sharesPerSecond * 31_536_000 / totalSupply
apy             = ((1 + apr / 365) ^ 365 - 1) * 100
```

When `fullProfitUnlockDate` is no longer in the future, the current unlock rate is treated as 0. The row publishes under source key `onchain:scrvusd-curve:scrvusd-current-rate`, leaving the old parent-owned `crvUSD` history unmixed. The curated DeFiLlama pool `5fd328af-4203-471b-bd16-1705c726d926` remains an alternative/fallback source.

#### Special-case Tier 1 estimator: LUSD / B.Protocol Stability Pool

LUSD also has a deterministic on-chain estimator for the Liquity v1 Stability Pool via B.Protocol. This row is intentionally conservative and is labeled `B.Protocol Stability Pool (LQTY only)`.

**Reads:**

- `stabilityPool.getTotalLUSDDeposits()` on Ethereum
- `communityIssuance.totalLQTYIssued()` on Ethereum
- CoinGecko `liquity` USD price

**Formula:**

```
remainingLqtyRewards = max(0, 32_000_000 - totalLQTYIssued)
dailyIssuanceFactor  = 1 - 0.5^(1 / 365)
apr                  = remainingLqtyRewards * dailyIssuanceFactor * lqtyPriceUsd / totalLUSDDeposits * 365 * 100
```

**Caveat:** This source captures only the projected LQTY incentive stream. It deliberately excludes ETH liquidation gains, so it is a lower-bound estimate of the full Stability Pool return.

#### Special-case Tier 1 estimator: Liquity V2 Stability Pools

Base Dollar and Liquity V2 itself share one deterministic branch reader (`fetchLiquityV2StabilityPoolSource`), parameterized by chain, CollateralRegistry, and branch table:

| Coin            | Chain    | Branches                                | Source key            | Label                                          |
| --------------- | -------- | --------------------------------------- | --------------------- | ---------------------------------------------- |
| `bold-liquity`  | Ethereum | wstETH, WETH, rETH                      | `onchain:bold-liquity`  | `Liquity V2 Stability Pools (interest-only)`   |
| `bd-basedollar` | Base     | WETH, wstETH, rETH, cbBTC, cbETH        | `onchain:bd-basedollar` | `Base Dollar Stability Pools (interest-only)`  |

Both rows publish `yieldType: lending-vault`, and `sourceTvlUsd` is the total deposit token held across that deployment's Stability Pools. Neither BOLD nor BD is yield-bearing itself — the Stability Pool is the deposit venue, as with LUSD — so both are standalone source-registry entries rather than yield-bearing manifest assets.

This row is what keeps BOLD off its own wrapper's numbers. `bold-liquity` has no curated DeFiLlama pool and no variant-map entry: the tracked Yearn `yBOLD` wrapper owns the Yearn venue, and its linked-variant projection reaches BOLD only as a lower-evidence `lending-opportunity` alternative.

**Reads:**

- One batched `eth_call` read per refresh: the CollateralRegistry branch count plus each branch's Stability Pool deposits, `aggWeightedDebtSum`, and shutdown state

**Formula:**

```
aggregateBorrowerInterest = Σ activeBranch(aggWeightedDebtSum)
apr = 0.75 * aggregateBorrowerInterest / totalStabilityPoolDeposits * 100
```

Shutdown branches contribute zero interest but keep their deposits in the denominator, so the published number is the deposit-weighted aggregate across every branch rather than any single branch's rate. The reader fails closed if any read fails or if the CollateralRegistry reports a branch count different from the configured branch table (e.g. after a governor registers Base Dollar's announced AERO/LP branch), so a row is published only with complete branch coverage.

**Caveat:** This is a deliberately conservative interest-only undercount. It excludes upfront borrowing fees and liquidation collateral gains, so it does not represent the full Stability Pool return.

### Tier 2: DeFiLlama Yields API (Multi-Source)

Collects **all** matching DL pools per coin via `matchAllDlPools` (three layers). Each unique pool found becomes a separate row in `yield_data`. The `is_best = 1` row per coin is the winner of the confidence-weighted arbitration described above — evidence class and confidence tier rank ahead of raw APY — and every other row is `is_best = 0`.

Before matching, the worker now preserves any single-exposure pool that is either:

- a normal DeFiLlama stablecoin pool (`stablecoin === true`), or
- explicitly relevant via `YIELD_POOL_MAP`, or
- explicitly relevant via a configured wrapper symbol in `YIELD_VARIANT_MAP`, or
- explicitly relevant via `EXPLICIT_YIELD_SOURCE_POOL_MAP`

This keeps configured wrapper pools like `fxSAVE` eligible even when DeFiLlama marks them `stablecoin: false`, and it also preserves exact curated non-stablecoin venues such as XAUT's isolated Yo Protocol market.

**Layer 1 — Static map:** `YIELD_POOL_MAP` maps Pharos ID to a DL pool UUID. Filters for `exposure === "single"` and identifies the native/primary yield source. A missing pinned UUID fails closed for that native mapping; it cannot borrow a generic venue's APY under the native label. Dead-pin diagnostics retain `missing-pool`. Independent configured source tiers may still resolve.

**Layer 2 — Variant map:** `YIELD_VARIANT_MAP` maps to a wrapper/savings pool symbol and can also pin the wrapper chain, address, and preferred DeFiLlama project. Every generic candidate must have the wrapper's exact normalized symbol; an address proves the deposit asset, not receipt ownership. Pendle/Spectra PT and LP markets (`pendle-v2`, `spectra-v2`) are excluded from this layer and remain external opportunities. Resolution prefers configured address identity, and only falls back to symbol when address evidence is absent and the chain-scoped match is unambiguous. Supplied contradictory or multi-asset address evidence fails closed rather than reverting to the ticker. Filters require `exposure === "single"` (stablecoin flag intentionally relaxed, since savings wrappers like fxSAVE are not flagged `stablecoin = true` in DeFiLlama). Differently shaped holder sources require an exact curated pin.

Same-chain, same-symbol receipt ambiguity requires a curated UUID rather than maximum TVL. The [native pool registry](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/yield-config/yield-config-pools.ts) owns exact identities: a receipt, issuer fund, collateral market and bridged venue are not interchangeable. Supplied underlying-address evidence that contradicts the tracked contract also blocks Layer 3 ticker fallback.

**Layer 3 — Base-symbol fallback:** Used only when both static maps miss and the coin has no Tier-1 on-chain rate config (a configured on-chain rate already measures the coin's intrinsic yield, so a symbol guess could only add a third-party venue; the skip holds even when that run's read fails). Address-corroborated candidates must also have the tracked instrument's exact normalized symbol and no same-chain same-symbol ambiguity. An underlying-address match alone establishes a deposit asset, never receipt ownership: differently named tranches stay in the supplemental opportunity lane, so Royco's senior tranche cannot become apyUSD native holder yield. When corroborating address evidence is unavailable, only an unambiguous exact-symbol candidate is eligible; supplied contradictory addresses fail closed. Symbols shorter than 4 characters are excluded from fallback matching. Filters require `exposure === "single"` and `stablecoin === true`, and exclude yield-tokenization markets (`pendle-v2`, `spectra-v2`): their PT implied APY and market TVL are not the wrapper's native return. Pendle markets publish separately as `fixed-yield` protocol-API rows. Ambiguous fallback candidates are dropped instead of guessed.

**Exact weighted pool groups:** `YIELD_WEIGHTED_POOL_GROUPS` can collapse multiple exact DeFiLlama pool UUIDs into one TVL-weighted APY row when Pharos tracks one protocol asset but the yield wrapper is deployed as chain-isolated, non-fungible vaults. This is currently used for `sdusd-dtrinity`, where Ethereum and Fraxtal sdUSD dStake pools publish under one synthetic DeFiLlama source key.

Total, base, and reward APY use the same complete admitted TVL universe. Before aggregation, a missing pool reward is proven zero only when its finite base APY is at least its total APY (the shared A9 rule). If any constituent component is still unresolved, that aggregate component is null; total APY and full measured TVL remain available. A small incentivized pool's reward APY is never reweighted onto the whole group.

Finite signed holder returns are admitted for every identity-valid weighted member. Losing constituents retain their measured TVL in the denominator; a mixed positive/negative portfolio is not reduced to its profitable members.

Ethereum Frankencoin Savings is an exact external `lending-opportunity` for ZCHF without `flags.yieldBearing`; plain ZCHF holdings do not earn it. A non-rejected curated explicit pool takes precedence over auto-discovered same-asset/same-type candidates, including an incumbent; Gnosis remains an alternative. K3 sBOLD's gross Stability Pool pin and HedgeCore sUSD's gross Venus pin are permanently excluded because gross venue rates do not establish net holder returns. sUSD retains its intentional gap: unsupported contract reads and a documented 93% pass-through do not prove compounding, reward timing or fees.

**Exact-pool overrides:** `EXPLICIT_YIELD_SOURCE_POOL_MAP` publishes a named venue only when UUID, project, chain and symbol match and APY/TVL gates pass. This separate lane can admit commodity opportunities such as XAUT's Yo Protocol venue without treating mixed-RWA baskets as single-asset commodity yield.

**Variant ownership:** The [variant registry](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/yield-config/yield-config-variants.ts) owns wrapper identities, labels and types. `YIELD_VARIANT_MAP` applies only when the yield-bearing wrapper is not tracked separately; tracked wrappers own their native sources and history. AZND is frozen with no runtime loAZND variant. Falcon sUSDf and Gnosis sDAI own their sources separately from USDf and Ethereum sDAI. Saturn sUSDat owns its ERC-4626 source, not the USDat parent; its NAV includes credit valuation and income rather than a guaranteed cash savings rate.

APY, base/reward split, pool TVL, and pool UUID are all taken directly from the DL response.

### Tier 2.5: Protocol-Native Yield APIs

For coins whose native savings path is published by the protocol itself but is not exposed as a usable DeFiLlama pool, the sync can ingest a curated protocol-owned earn endpoint directly.

Protocol-specific lending-market readers that query protocol state directly also live in this tier. Even when the transport is an on-chain call, these rows are treated as curated protocol-native venues rather than Tier 1 deterministic native-wrapper sources, so arbitration still prefers a stronger native wrapper or savings source when one exists.

This tier can carry wrapper-over-wrapper native sources when the upstream venue measures the managed wrapper's own return. Yearn `yBOLD` and K3 `sBOLD` retain their first-party holder paths, including sBOLD's K3-specific Yearn/Kong supplemental source. Base BOLD publishes its own deterministic Liquity V2 Stability Pool aggregate, with wrapper projections retained only as external opportunities. The excluded raw sBOLD pool pin does not remove the dedicated source or eligible price-derived fallback; any new mapping still requires independent holder-ownership proof.

Royco Dawn markets also live in this tier. The supplemental source lane reads the Dawn market explorer API and emits separate `structured-tranche` rows for the senior and junior vaults in each verified market above the local Royco TVL floor. Rows use the stable source keys `royco-dawn:<chainId>:<marketId>:senior` and `royco-dawn:<chainId>:<marketId>:junior`; the tranche share tokens are not added to the stablecoin registry. Identity resolution maps the Royco deposit token back to a tracked underlying stablecoin by chain/address first, with configured wrapper-variant addresses such as Neutrl `sNUSD` attached to their tracked parent when the wrapper is not a first-class stablecoin row.

Pendle supplemental PT markets also live in this tier. The Pendle REST reader emits active stable-category principal-token markets as `fixed-yield` protocol-API rows using implied APY, the PT market address as `sourcePool`, and source keys shaped as `protocol-api:pendle:<chain>:<marketAddress>`. Identity resolution keeps the PT market's underlying asset symbol/address for stablecoin matching. These rows are external opportunity alternatives: they can attach to the matched underlying stablecoin for comparison, but they do not replace native holder-yield rows or project through variant inheritance.

Supplied token addresses are authoritative in protocol-native identity resolution: an unresolved address never falls back to a unique ticker. In particular, Axis USDx Pendle markets cannot attach to Hex Trust USDX.

Source links resolve instrument keys before protocol labels or issuer fallbacks. Valid DeFiLlama UUIDs link to the individual pool unless a configured pool-specific or pinned native deep link exists; validated linked variants use child ownership. Weighted aggregates link to the owning application, never a fabricated pool. Pendle keys resolve to the market's PT swap page with chain context. Ethereum Frankencoin Savings links to `https://app.frankencoin.com/savings?chain=ethereum`; Gnosis links to its own DeFiLlama pool. Non-pool sources retain protocol/issuer fallbacks.

External opportunities follow the single [final measured-size admission rule](#persistence-and-publication), regardless of reader family; native holder-yield rows are outside that external-opportunity gate. Lending suggestions also exclude venues identified as Resolv / `USR`, `stUSR` or `wstUSR` linked.
All supplemental candidates pass the shared `PYS_APY_SANITY_MAX = 300` envelope before cache publication and again when the cache is read. Over-envelope rows are rejected and counted separately from malformed rows.

The [tracked optional-source registry](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/cron/yield-sync/sources-optional.ts) owns adapter membership. Eligible families include protocol savings APIs, issuer NAV oracles and protocol-specific on-chain estimators; scrvUSD's profit-unlock rate and Midas's observation-clock NAV are examples. Source-specific estimator semantics follow below rather than duplicating an endpoint roster.

The dormant BIMA sUSBD matcher and consumed USBD-to-sUSBD variant have been retired. Base USBD remains non-yield-bearing. The former matcher used unboosted APR only; boosted-only rates were never valid holder evidence. Historical `protocol-api:bima-susbd` classification, venue identity, and source links remain readable.

The Royco Dawn adapter maps APY ratios to percent APY, measured tranche-vault TVL to `sourceTvlUsd`, and market coverage/utilization/status/drawdown plus share-token addresses into nested `sourceRisk` fields. Royco rows carry `venueRiskTier: "unknown"` until a reviewed venue-risk audit assigns a sourced tier. They also carry investability flags for withdrawal constraints, verified listing status, and whether the row is senior protected or junior first-loss. KYC/access booleans are nullable; the current Dawn market payload does not expose explicit KYC or jurisdiction restriction fields, so those penalties apply only if future source evidence populates them. The universal measured-TVL gate augments Royco's bespoke market/vault floors.

The dormant Etherfuse CETES issuance reader has been retired without changing the CETES coin, catalog quarantine, or retained yield history. Banxico remains the independent MXN CETES benchmark authority. Re-admission would require a newly reviewed source and catalog eligibility evidence; missed observations are not synthesized.

The Yearn yBOLD adapter reads Yearn's first-party ydaemon vault endpoint twice: the yBOLD vault (`0x9f43…a3d8`) supplies `sourceTvlUsd`, and the Staked yBOLD vault (`0x2334…91cd`) supplies the net APR. yBOLD's own price-per-share is flat because Yearn routes the Liquity V2 Stability Pool return to holders who stake into `ysyBOLD`, so the staked net APR is the advertised yBOLD yield. The adapter fails closed unless the staked vault's underlying asset is still the tracked yBOLD vault, and rejects APR outside `(0, 100]%` or TVL below the 100k publication floor. It publishes `protocol-api:yearn:ybold` as a `lending-vault` row; the curated DeFiLlama pool `4c29f645-…` stays pinned as a lower-evidence corroborating alternative.

Midas mMEV reads the issuer-listed Ethereum NAV oracle's `decimals()` and Chainlink-style `latestRoundData()`. Positive answers, supported decimals, and `updatedAt` within three days/five-minute future skew are required. The first observation seeds `exchange_rate` with `currentApy=0`; later APY uses the two oracle observation clocks, not publication delay. Raw/daily history retains nullable `source_observed_at`; legacy unknown clocks cannot anchor. Registry anchors are 7–45 observation-days old.

The Re Protocol adapter reads the official daily price feed's `reUSD` series and publishes its latest APY and NAV as `protocol-api:re-protocol-reusd`. Observations must have a positive NAV, an APY within the accepted envelope, and a UTC date no older than three days. The source belongs directly to `reusd-re-protocol`; the separate junior `reUSDe` Insurance Alpha product is not treated as a yield variant of reUSD. Historical rows written under the misattributed `protocol-api:re-protocol-reusde` key are suppressed and purged through the yield-history ownership-handoff safeguards.

Zephyr publishes its one-day effective APY only for `zys-zephyr-protocol`, not base ZSD. Cron and backfill share the upstream hourly observation bucket as history identity; retries cannot add samples. Publication generation fencing remains independent. Hashnote excludes non-finite/nonpositive timestamps and reports beyond five-minute future skew before choosing either NAV endpoint.

Historical vaults.fyi rows retain curated-observation classification, venue/chain attribution, and existing source links; the retired collector confers no first-party evidence status.

Supplemental discovery isolates ordinary per-target failures while preserving bounded family publication. Morpho splits tracked symbol filters into batches of at most 100 (the public GraphQL limit), paginates each batch independently, and keeps the existing overall request deadline. Aave refreshes the verified Ethereum USDC, Arbitrum USDT, and Base USDC reserves plus three rotating tracked-contract targets, in two batches of at most three inside the 28-second family deadline. Successful generations replace the family snapshot rather than accumulating old windows or refreshing their timestamps. Successful targets publish when a strict majority resolves; budget exhaustion, systemic zero-resolution, or at least 50% misses retains the previous family snapshot. Long-tail probes do not imply a listed reserve or continuous coverage.

Royco Dawn uses the official `/api/v1/ecosystem/explore` directory with one-based pagination, admits only verified `marketv2` entries, and fetches `/api/v1/market/info/{chainId}/{marketId}` for each market's USD TVL and full tranche-risk evidence in batches of at most three. The directory's native-NAV amounts and Day markets are not admitted through the Dawn adapter. Missing, future, or stale APY evidence skips only the affected tranche; a failed detail read or exhausted family budget is reported explicitly without discarding healthy candidates already collected.

### Opportunity-Level Safety Resolution

One engine resolves every row's published `safetyScore`, `safetyGrade`, `provenance.safetyProvenance`, and `safetyReason` from the underlying stablecoin's Report Card plus opportunity-level risk: `resolveYieldRowSafety(...)` in `shared/lib/yield-opportunity-risk.ts`. The hourly write path (`worker/src/cron/yield-sync/evaluation.ts`) and the API live-safety hydration read path (`worker/src/api/yield-rankings-cache.ts`) both call it, so the read path re-bins the published judgment rather than re-deriving it (ADR-19). The two paths differ in exactly one input — the provenance label a rated resolution carries (`cached-publish` on write, `live-report-card` on hydration).

The ladder's guards:

- **NR-substitution guard.** Generic and Royco opportunity scores replace only an observed, rated Report Card. Missing (`default-safety`) or `NR` cards retain their unrating and reason; diagnostic opportunity/tranche scores remain available but cannot move the grade.
- **Reviewed-venue fallback.** Venue risk resolves once, in `resolveVenueRisk(...)`: the row's explicit `venueRiskWeighted` wins, and the reviewed registry keyed by `venueProtocol` (or the DeFiLlama project slug on auto-discovered rows) is the fallback. Unreviewed venues stay `unknown` and produce a `venue-review` evidence gap, never a guessed penalty.
- **Entry gate.** Every `lending-opportunity`, `fixed-yield`, and `structured-tranche` row is assessed, whether or not it already carries a published opportunity contract; holder yield types carry no opportunity contract at all. A row that publishes no source risk gains only its unrated opportunity contract, never fabricated market evidence.
- **Evidence predicates.** `safetyObserved`, `hasVenueRisk`, and `opportunityEvidenceComplete` come from the ladder's own resolution on both paths; `hasHistory` is the published `observationCount30d` (more than one distinct observation day) on both.
- **Degraded snapshot.** When the exact published safety snapshot cannot be read, every safety-derived field (`underlyingSafetyScore`, `trancheSafetyScore`, `trancheSafetyPenalty`, `opportunityRisk`) is stripped and the row publishes `safety-snapshot-unavailable`.

Both penalty engines — the generic external-opportunity engine and the Royco Dawn tranche engine — draw their access, withdrawal, utilization, TVL, and venue terms from one kit (`shared/lib/yield-penalty-terms.ts`) with per-engine magnitude profiles. Venue risk has a single derivation for both: the weighted `1..5` score is canonical and the coarse tier is derived from it, so an engine can never price a venue from a stored tier that disagrees with the weighted score. The generic engine prices the weighted score continuously above the blue-chip threshold; the tranche engine bins it. Royco-only terms (first-loss, coverage, market status, drawdown) stay bespoke.

### Opportunity-Level Tranche Safety

Royco Dawn rows use a row-level tranche Safety Score for PYS instead of blindly reusing the underlying stablecoin's Report Card Safety Score. The raw underlying score remains the ceiling for senior rows unless a future methodology explicitly allows first-loss protection to create an uplift. The current implementation does not uplift senior rows; it only subtracts tranche-specific penalties. Junior rows start with a large first-loss penalty, then add utilization, coverage, market-status, drawdown, TVL, withdrawal, access, and venue-posture penalties. At high utilization, junior rows should usually score materially below the underlying stablecoin.

Before the bespoke model can publish a tranche judgment, the common opportunity evidence gate requires reviewed venue risk, measured market size, and an observed market status. Missing status is not `normal`. Any missing critical fact leaves the observed APY available but publishes null opportunity/tranche scores, `scoreQualification: "NR"`, and null PYS with `opportunity-evidence-missing`; `missingCriticalEvidence` names the missing facts. The ladder does not fall back to generic tranche scoring. Complete evidence retains the bespoke penalty magnitudes.

Published Royco source-risk metadata includes `trancheSide`, `underlyingSafetyScore`, `trancheSafetyScore`, `trancheSafetyPenalty`, `marketCoverageRatio`, `marketMinCoverageRatio`, `marketUtilizationRatio`, `marketUtilizationLimitRatio`, `marketDrawdownRatio`, `marketStatus`, `marketTvlUsd`, `trancheTvlUsd`, `withdrawalDelaySeconds`, `kycRequired`, and `accessRestricted` when available. API hydration recomputes those scores from the live underlying Report Card snapshot before ranking, so a stale cached Royco score is not allowed to overwrite current stablecoin safety data.

### Tier 3: Price-Derived APY

For `navToken` coins or explicit `PRICE_DERIVED_FALLBACK_IDS` only when the catalog explicitly identifies `nav-appreciation` or `lending-vault`, the return reference is USD, and no intentional holder-return gap applies. Eligibility follows the catalog's referenced asset when present, not whether a comparison benchmark exists. FPI and ISC retain explicitly reviewed USD-based variable-NAV policies; an unreviewed `VAR` asset is not implicitly USD-return eligible. Derives APY from USD price appreciation in `supply_history` using the oldest available anchor between 7 and 45 days. Manifest price-derived strategies describe this eligible estimate, not every NAV flag or historical fallback ID.

```
apy = ((price_now / price_anchor) ^ (365.25 / lookbackDays) - 1) * 100
```

Zero new API calls — reuses cached price data. Falls through if no price history exists or if the coin has fewer than 7 days of priced history.

The same 300% deterministic APY sanity envelope applies to price-derived rows. A transient price spike, token migration, or one-off NAV correction above that envelope returns no price-derived source instead of publishing a headline APY or displacing a sane curated source.

**Tier 3 as additional source:** For eligible coins, Tier 3 also runs when Tier 2 found sources but they all report 0% APY. The price-derived source is added alongside the DL source, and `is_best` is decided by confidence-weighted arbitration — never by raw APY alone or by promoting a rejected candidate as a least-bad fallback.

**Known limitation:** USD price drift cannot measure EUR-native or gold-native return, distributed rewards, or rebasing yield. xGLD's XAUt-reference return therefore has no USD-price-derived fallback when its deterministic reader fails; gold's USD movement alone is not holder yield. A fallback would require separately reviewed same-clock XAUt-normalized history. bC3M, stkGHO, and USDB likewise have no price-derived holder-return coverage; intentional gaps stay unavailable until a reviewed return source exists. Dividend-distributing products use an explicit native pool or a reviewed rate-derived proxy instead; VBILL is pinned to its native fund pool.

### Tier 4: Rate-Derived APY

Dividend-distributing tokens, rebase proxies and T-bill-backed funds can use explicitly reviewed benchmark-derived estimates. [`RATE_DERIVED_CONFIGS`](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/yield-config/yield-config-rate-sources.ts) owns product membership, spreads and benchmark overrides.

```
apy = max(0, benchmarkRate - spreadBps / 100)
```

Uses the structured benchmark cache refreshed daily by `fetch-tbill-rate`. USD defaults to the 3-month Treasury yield (`DGS3MO`), but the resolver can switch to a peg-native or product-specific benchmark when one exists. EUR rows use the ECB's official 3-month compounded €STR series. CHF rows use delayed public `SAR3MC` (3-month compounded SARON) from SIX. RUB rows use the Central Bank of Russia key rate from the DailyInfo `KeyRateXML` SOAP feed. TRY rows use CBRT EVDS BIST TLREF (`TP.BISTTLREF.ORAN`). `USD_EFFR` is sourced first from the New York Fed EFFR endpoint and then FRED DFF; a config can select it as the product benchmark through `benchmarkCurrency`, though no tracked product does so today. Rate-derived configs can also set `benchmarkOverrideKey`: APY is still computed from the configured product benchmark, but PYS/excess-yield benchmark selection and provenance use the override. USD tokenized T-bill/MMF-style proxies use this to compare against `USD_EFFR`; EUR and GBP treasury proxies carry explicit same-currency override keys; A7A5 uses `RUB` for both APY derivation and PYS/excess-yield provenance. If a benchmark fetch fails, the cron retains the last known market benchmark when available and marks provenance as degraded instead of immediately snapping back to the hardcoded default. Because the public SIX compound-rate file is delayed, CHF benchmark `recordDate` can trail the fetch date by one business day even on a healthy run.

Product-input freshness is independent of the comparison hurdle: fresh EFFR cannot refresh a stale USD T-bill input. Structured cache entries preserve absent/invalid fetch and last-market clocks as null; only legacy scalars infer cache time. Missing clocks cannot score. Retained evidence stays degraded; hardcoded fallback without a market rate cannot produce product APY. Invalid registry readability names `yield-benchmarks:registry-invalid`.

The configured dependency resolver is shared by source resolution, evaluation, and both live-safety and preserved-safety API reads. A config whose product and hurdle are both `USD_EFFR` depends on EFFR alone, so a USD T-bill outage would not stale its source or withhold its score. Non-USD products independently require the USD normalization reference: a stale USD reference with a healthy EUR product yields `benchmark-stale`, not `source-stale`. A stale product yields `source-stale`; an independently stale comparison hurdle yields `benchmark-stale`. Retained product or normalization evidence carries `reference-benchmark-degraded`; healthy arithmetic is unchanged.

These are modeled proxies, not observed holder returns. For example, BUIDL applies its configured 20 bps spread. Product-specific and peg-native benchmark choices remain explicit; a stable NAV alone never authorizes a proxy.

Note: thBILL remains in Tier 1 `ON_CHAIN_RATE_CONFIGS`. USTB is permanently excluded from the generic reader because it is not ERC-4626; its DeFiLlama source remains available pending a separately reviewed Superstate NAV reader.
VBILL is not rate-derived: its verified BSC DeFiLlama native fund pool reports distributed holder yield. Its NAV metadata is not permission to annualize USD price drift as that return.

Rate-derived runs after Tier 3 in the resolution loop and participates in the `is_best` selection like any other source, under the same confidence-weighted arbitration (deterministic rows rank ahead of fallback-derived rows; a rejected candidate is skipped, so the coin can publish no `is_best` row for that generation rather than a least-bad one).

### Automatic Lending Pool Discovery (Wave 2)

For tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), the sync cron can append the best lending pool from a curated protocol allowlist. This runs after the base four-tier resolution, so yield-bearing coins can also receive an additional `defillama-auto` source row when a distinct lending market passes filters. LUSD uses this to retain Aave as an alternative source alongside the deterministic B.Protocol estimate.
The non-gold/silver condition limits this generic discovery lane only; it does not create a supply-gate bypass for GOLD/SILVER candidates admitted through explicit or other paths.

The exported [`LENDING_PROTOCOL_ALLOWLIST` and `LENDING_PROTOCOL_LABELS`](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/yield-config/yield-config-lending-protocols.ts) own current membership and names. The curated set spans money markets such as Aave/Compound and reviewed lending-vault venues; membership is not a safety endorsement and does not bypass runtime quality gates.

**Discovery logic:** Require single exposure, DeFiLlama's stablecoin flag, allowlisted project and no reserved-pool conflict. Prefer underlying-address identity; symbol-only matches must remain unambiguous after chain scoping. APY must be at least `0.1%`; discovery applies the candidate chain's absolute floor and, for deposit venues, the supply-relative floor. Every surviving external opportunity still passes [final admission](#persistence-and-publication).
**Source-management audit inputs:** the DEX-liquidity job caches a compact DeFiLlama `/protocols` slug/category snapshot under `defillama-protocols`. The monthly coverage audit uses it for protocol recommendations: `high-confidence` requires the TVL/pool-count shape and a category of Lending, CDP, RWA Lending, or Uncollateralized Lending; missing/non-lending categories stay `review-needed`. Current allowlist membership is owned by `worker/src/lib/yield-config/yield-config-lending-protocols.ts`; runtime safety, APY, TVL, and source-shape gates still decide publication. The retired generic-quarantine lane emits no new reprobes or restoration candidates. Lifecycle reviews continue through `YIELD_ADAPTER_LIFECYCLE`.

**Queue-guided allowlist rounds:** Future lending allowlist expansions start from the monthly coverage audit's `operatorQueue.recommendationCandidates` entries with kind `lending-allowlist`. Those candidates are derived from unmatched high-TVL single-exposure stablecoin pools outside the current allowlist, must pass the protocol-category gate for `high-confidence` status, and include DeFiLlama source links, pool examples, promotion metadata, and a suggested `LENDING_PROTOCOLS` snippet anchored near `YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR`. Operators can still review or reject candidates, but broad manual protocol hunting is no longer the default expansion path.

Discovery evaluates the candidate venue's chain, not the stablecoin's first deployment. Final measured-size and supply requirements are defined once under [Persistence And Publication](#persistence-and-publication); discovery cannot grant a publication bypass. If the bulk supply cache is unreadable, malformed or missing, discovery degrades without admitting new opportunities. An absolute-only discovery fallback for an individual missing coin in an otherwise valid map still cannot bypass final admission.

**Explicit venue exclusion:** Even when a pool clears the generic quality gates above, published lending-opportunity suggestions exclude venues whose DeFiLlama `poolMeta` or supplemental source label identifies them as Resolv / `USR`, `stUSR`, or `wstUSR` linked.

**Yield type:** `lending-opportunity` — distinguishes these from native yield coins on the frontend. The direct Aave v3 on-chain supply-rate path uses the same classification so rankings/cache schema validation stays aligned across deterministic and auto-discovered lending rows.

**Data source:** `defillama-auto` — distinguishes from static-mapped `defillama` pools.

**Eligibility evaluated dynamically:** If a coin's safety score drops below 50, it stops receiving auto-discovered yield data. If it rises back to 50 or above, it starts automatically.

**Explicit deterministic edge cases:** `AUTO_LENDING_POOL_MAP` can also pin a small number of exact-symbol, single-asset lending markets for coins that would otherwise be blocked by ambiguous matching or by the generic safety gate. These rows still pass the same pool-shape and source-quality checks; the bypass is coin-specific and documented rather than global.

The [pool/override registry](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/yield-config/yield-config-pools.ts) owns current exact pins. Missing or invalid pins are removed or reviewed, not rescued by bypassing pool-shape, APY or measured-size gates.

**Same-symbol collision blocks:** `AUTO_LENDING_COLLISION_BLOCKLIST` in the [lending registry](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/yield-config/yield-config-lending-protocols.ts) blocks valid pools belonging to a different asset. Pool-specific multi-asset-vault guards use pool-id prefix matching and cannot leak to other pools in the protocol. Blocks apply before exact overrides and dynamic matching.

**Exact curated venues outside auto-discovery:** `EXPLICIT_YIELD_SOURCE_POOL_MAP` is a separate lane for named venues outside generic discovery, including the commodity pins for `xaut-tether` and `paxg-paxos` and Ethereum Frankencoin Savings for `zchf-frankencoin`. Unlike `AUTO_LENDING_POOL_MAP`, these rows publish only the exact named pool after matching expected venue metadata. K3 sBOLD's raw Stability Pool mapping is permanently excluded, not a supported wrapper-return source.

The monthly coverage audit checks exact overrides and native/variant/weighted pins against current publication gates. Missing pins produce `stale-auto-lending-override`, `missing-pool` and either `coverage-outage` or `dead-config`; unsupported families remain review candidates. Historical restoration fields stay readable, but new audits do not produce restoration work. Operator handling and queue denominators belong to [Coverage Audit Queue](https://github.com/TokenBrice/pharos-watch/blob/main/docs/yield-intelligence-operations.md#coverage-audit-queue).

---

## Pharos Yield Score (PYS)

Risk-adjusted ranking (0–100) that balances yield magnitude against source risk, stablecoin safety, and consistency. PYS answers one question — *is this APY paying enough for the risk taken?* — so it is yield per unit of risk, not a recommendation and not a safety verdict. A D-grade coin can still rank above an A+ coin when it pays a lot for a lot of risk. Every surface that names PYS carries that framing, and each row also shows the joint safety × yield **zone** described under Presentation Boundaries.

Fresh rows publish `calculationMode`, `evidenceClass`, seven-field `evidenceCompleteness`, and `scoreQualification`: complete observed evidence is `rated`, incomplete noncritical evidence is `partial`, modeled/fallback evidence is `estimated`, and unusable critical evidence is `NR`. Benchmark/reference freshness qualifies scoring independently of that completeness denominator. `scoreQualified` means `scoreQualification !== "NR"`, not that a numeric PYS exists; consult `pharosYieldScore` and `pysNullReason`.

The conservative `40 / NR` fallback can retain estimated PYS with `safety-unrated`; an unavailable common safety snapshot withholds it. Critical opportunity evidence missing means NR (`opportunity-evidence-missing`) without removing an otherwise eligible row. Source roles are assigned before final admission: receipt ownership remains distinct from deposit exposure, and projecting wrapper returns to a parent creates an opportunity rather than passive parent yield. Opportunity-level `sourceRisk.opportunityRisk` and `provenance.safetyProvenance: "opportunity-safety"` do not change the underlying Report Card and must be labeled as opportunity-derived, not Safety Score V9.
Hero and scatter labels retain that opportunity provenance and the same row-level safety value used by PYS; they never replace it with the underlying holder score. The chart's mixed safety axis is labeled row / opportunity safety.

Since v8.43, non-USD rows with a healthy USD reference score effective yield on a USD footing: `apy30d + 0.25 · spread + (usdBenchmarkRate − benchmarkRate)`, or `usdBenchmarkRate + 1.25 · spread`, before flooring at zero. This replaces local policy-rate compensation with the USD reference; it assumes a frictionless hedge and ignores FX basis and hedging cost. USD-currency rows, including `USD_EFFR`, take no rebase and retain `apy30d + 0.25 · spread`.

**Formula (`computePYS()` in `shared/lib/yield-scoring.ts`):**

```
benchmarkSpread     = apy30d - benchmarkRate
hurdleRebase        = usdBenchmarkRate - benchmarkRate          (0 for USD-currency rows or either missing rate)
effectiveYield      = max(0, apy30d + benchmarkSpread * 0.25 + hurdleRebase)
sourceRiskPenalty   = clamp(sourceRisk.sourceRiskPenalty ?? 1, 1, 2.5)
rowUtility          = effectiveYield / sourceRiskPenalty
riskPenalty         = max(0.5, (101 - safetyScore) / 20)
yieldEfficiency     = rowUtility / (riskPenalty ^ 1.75)
sustainabilityMult  = max(0.3, 1.0 - apyVarianceScore)           (unavailable when variance is unmeasured)
PYS                 = clamp(round(yieldEfficiency * sustainabilityMult * scalingFactor), 0, 100)
```

Coordinator evaluation computes ordering components before selection, then recomputes components for the final published penalty shape; the final score and null explanation share that result. A nominal `apy30d` above `PYS_APY_SANITY_MAX` (300), a non-finite APY or effective yield, or missing/non-finite variance withholds PYS with `missing-inputs`, rather than manufacturing 0 or best-case consistency. `apyVarianceScore` is derived from the published two-decimal `yieldStability`, so served and published scores agree. A measured zero variance retains full consistency credit.

**Components:**

| Component                      | Range                    | Meaning                                                                                                                                                             |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benchmarkRate`                | depends on row           | Row-level benchmark selected from the benchmark registry                                                                                                            |
| `benchmarkSpread`              | unbounded                | `apy30d - benchmarkRate`; positive means the row clears its local benchmark                                                                                         |
| `usdBenchmarkRate`             | registry `USD` rate      | Healthy USD reference (`riskFreeRate` on the payload). Missing/degraded evidence disables rebase and qualifies affected rows; a stale required reference withholds PYS |
| `hurdleRebase`                 | unbounded                | `usdBenchmarkRate - benchmarkRate`; exactly 0 for USD-currency rows (both the `USD` T-bill and `USD_EFFR` benchmarks), negative for high-rate pegs (TRY, RUB), positive for CHF/EUR hurdles below the USD rate |
| `effectiveYield`               | `>= 0`                   | Raw APY plus 25% of local benchmark spread plus rebase, floored at zero. Equal local excess gives equal effective yield for non-USD rows with the same healthy USD reference |
| `sourceRisk.sourceRiskPenalty` | `1–2.5` after resolution | Nested source-risk multiplier derived from measured source evidence. Missing/invalid values are neutral (`1`); values below 1 clamp to 1 and above 2.5 clamp to 2.5 |
| `rowUtility`                   | `>= 0`                   | `effectiveYield / sourceRiskPenalty`, used before the safety curve                                                                                                  |
| `safetyScore`                  | 0–100                    | Report card overall score. `PYS_DEFAULT_SAFETY_SCORE` (40) for unrated coins                                                                                        |
| `riskPenalty`                  | 0.5–5.05                 | Raw safety penalty before the power curve is applied                                                                                                                |
| `riskPenalty^1.75`             | ~0.30–17.01              | Effective divisor used by PYS after the steeper safety curve is applied                                                                                             |
| `apyVarianceScore`             | 0–1 or null              | `1 - yieldStability`, using the published two-decimal stability derived from trailing coefficient of variation. Null for fewer than two samples, near-zero mean, or non-finite CV; unavailable variance withholds PYS |
| `scalingFactor`                | 8                        | Global constant (`PYS_SCALING_FACTOR` in `constants.ts`) tuned after the steeper safety curve                                                                       |

Published PYS is null whenever `pysNullReason` exists. Normal evaluation uses the precedence below; safety-degraded API reads preserve an existing non-safety null reason rather than replacing it with `safety-unrated`. An otherwise eligible NR source can remain published and selected. Numeric 0 is reserved for a valid score that rounds to zero, with a null reason.

| Precedence | `pysNullReason` | Condition |
| --- | --- | --- |
| 1 | `safety-unrated` | Common safety snapshot unavailable |
| 2 | `source-stale` | Source or comparison-anchor evidence expired |
| 3 | `source-freshness-unknown` | Source freshness cannot be established |
| 4 | `benchmark-stale` | Row benchmark or required USD reference expired |
| 5 | `opportunity-evidence-missing` | Critical venue review, market-size, or tranche-status evidence is incomplete |
| 6 | `missing-inputs` | Non-finite APY/effective yield or 30-day APY above 300% |
| 7 | `apy-non-positive` | 30-day APY is non-positive |
| 8 | `scaling-invalid` | Scaling is non-finite or non-positive |
| 9 | `effective-yield-non-positive` | Benchmark-adjusted effective yield is non-positive |
| 10 | `missing-inputs` | Trailing variance is unavailable |

The shared scorer exposes the intermediate values (`benchmarkSpread`, `benchmarkAdjustment`, `hurdleRebase`, `effectiveYield`, `sourceRiskPenalty`, `rowUtility`, `riskPenalty`, `adjustedRiskPenalty`, `yieldEfficiency`, `sustainabilityMult`). Frontend breakdown components should pass the nested `sourceRisk.sourceRiskPenalty` and the payload `riskFreeRate` when they surface v8 source-risk details or per-factor attribution; the final PYS value is always served by the API.

### Source-Risk, Rank Attribution, and Neutral Policy

Yield v8 exposes optional `sourceRisk` and `rankChangeAttribution` shapes in shared API schemas. PYS and source arbitration consume the nested source-risk penalty; source-board, source-sheet, detail-page, and DEWS consumers can read populated evidence. Publication attribution compares the previous generation under the served comparator, so tie-group reorders alone are not movement. Cross-methodology comparisons omit attribution rather than assigning a `methodology` driver; live hydration also suppresses attribution when the payload methodology differs from the deployed version. Missing evidence remains neutral:

- `sourceRisk` may be omitted, `null`, or partially populated on ranking, history, and alt-source rows.
- Public API source-risk fields are nested under `sourceRisk.*` (`sourceRisk.sourceRiskPenalty`, `sourceRisk.rewardShare`, and so on). Do not document or consume flattened public fields such as top-level `sourceRiskPenalty`; calibration scripts that ingest saved payloads must normalize from the nested API contract before analysis.
- `sourceRisk.sourceRiskPenalty` is the active v8 source-risk multiplier. It is derived from reliable `rewardShare`, `sourceDepthRatio`, `sourceAgeSeconds`, `sourceSwitchCount30d`, `observationCount30d`, sourced venue inputs (the `venueRiskWeighted` 1–5 score and its derived `venueRiskTier`), and reviewer-set `dependencyConcentration` where available. Missing, `null`, or invalid evidence is equivalent to a neutral multiplier of `1`; values below 1 clamp to 1 and values above `PYS_MAX_SOURCE_RISK_PENALTY` (`2.5`) clamp to 2.5.
- Frontend materiality has one authority in `src/lib/yield-source-risk.ts`: a finite penalty above `1.05`, or, only when the penalty is unavailable, a finite source-risk score of at least `10`. Row emphasis, compact summaries and warning indicators share that rule and formatted summary. Those summaries render an unavailable observed penalty as `n/a`, never `0x` or a fabricated neutral `1x`; the scorer's explicit neutral multiplier remains separate.
- `sourceRisk.observationCount30d` counts distinct UTC observation days, including the current publication day; limited-history treatment lasts until seven distinct days are represented.
- Frontend source-risk driver labels use the same scoring thresholds: `reward-heavy` when `rewardShare > 0.5`, `thin source depth` when `sourceDepthRatio < 0.001`, `limited history` when `0 < observationCount30d < 7`, and `source changed` when the selected source changed versus the prior published snapshot or `sourceSwitchCount30d > 0`. The `stale source` driver is the exception: it fires on the row's source-family-aware freshness classification (`sourceFreshness === "stale"`), not on the flat `sourceAgeSeconds > 6h` rule that the PYS source-risk penalty uses.
- The `/yield` depth lens is explanatory context, not guaranteed executable capacity. Rows are classified only when both `sourceRisk.sourceDepthRatio` and measured `sourceTvlUsd` are present: `deep` is `>= 1%` of tracked stablecoin supply, `moderate` is `0.1%` to `< 1%`, and `thin` is `< 0.1%`. External-opportunity rows without measured venue TVL are ineligible; native rows without measured venue TVL render `Native · depth n/a` and a muted `Native` marker in the TVL cell (the venue is the asset itself), not `Unknown depth` or a dash. No AUM or coin-supply figure substitutes for venue TVL in display, depth gating, or penalties.
- The depth band thresholds have one home: `YIELD_SOURCE_DEPTH_BANDS` in `shared/lib/selector/yield-source.ts`. The `/yield` depth lens classifies rows from it, and the Picker's rail-depth comparator ranks candidate rails on the same three bands (`deep` highest, `thin` lowest) rather than on the raw supply fraction. A rail with no depth evidence at all ranks below every measured band — an unsized venue is not a shallow one.
- DeFiLlama rows use the shared DeFiLlama input metadata timestamp/age when an individual resolved row does not carry `sourceObservedAt`, so provenance and PYS source-age penalties are based on the same freshness evidence.
- `sourceRisk.venueRiskTier: "unknown"`, `null`, or omitted means the venue tier has not been sourced. Unknown tier is neutral, not a hidden high-risk default. The PYS source-risk penalty and DEWS venue branches stay neutral on unknown; external opportunities, including Royco Dawn tranches, withhold their opportunity judgment and PYS until venue review is available.
- The Picker consumes the same contract without re-defaulting it: `RecommendedSource.sourceRiskTier` is `"low" | "mid" | "high" | null`, an unsourced tier publishes `null` and renders "tier not sourced", and the rail comparator scores an unknown tier at the neutral 55. An unresolved `venueChain` likewise degrades only that rail — chain-less rails are filtered before ranking, so a coin keeps its yield coverage whenever any rail resolves (`shared/lib/selector/yield-source.ts`, `selector-v2.5`).
- The same rule governs supply: the Picker's universal exclusions distinguish `supply-unavailable` (no usable current-supply reading this run — the coin is missing from `/api/stablecoins`, or carries no finite circulating bucket) from `below-supply-floor` (an observed supply under `$5M`). An unread supply is never summed, ranked, or published as `$0` (`shared/lib/selector/exclusions.ts`, `selector-v2.6`).
- `shared/lib/yield-source-risk-registry.ts` owns the typed runtime `YIELD_RISK_CONFIG` registry of reviewed venues, including each venue's concise reviewer rationale; `shared/data/yield-source-risk-evidence.json` owns the full citation arrays under the exact same venue keys, with structural coverage enforcing the 1:1 relationship. `worker/src/cron/yield-sync/evaluation.ts` consumes the venue registry without re-exporting its test-only inventory symbols. Each runtime entry carries five Yearn-style sub-scores — `audits` (20%), `centralization` (30%), `fundsManagement` (30%), `liquidity` (15%), `operational` (5%), each `1..5` with higher = riskier — weighted into a `1..5` venue-risk score. The coarse `venueRiskTier` is DERIVED from that weighted score (`< 2.5` → `low`, `< 3.5` → `medium`, otherwise `high`) and is never stored independently.
- The monthly yield coverage audit applies a quarterly review cadence to both reviewed venue scores and dependency-concentration entries. Evidence older than 90 days is queued for re-verification; staleness does not change a venue tier or source-risk penalty.
- The venue penalty moved from flat buckets to a continuous, calibration-preserving curve `max(0, venueRiskWeighted - 2.0) * 0.15`: weighted `≤ 2.0` → `0` (the legacy `low` no-op is preserved exactly for the blue-chip set), `3.0` → `+0.15` (the legacy `medium`), `4.0` → `+0.30`, `5.0` → `+0.45`. The curve applies only when a venue carries category scores; unscored venues stay neutral, and the legacy tier branch (`high` +0.35 / `medium` +0.15) remains the fallback. The penalty knee (`2.0`) sits intentionally below the low/medium tier cutoff (`2.5`): the tier is a coarse display/DEWS bucket while the penalty is continuous, so a `low`-tier venue scoring `2.0`–`2.5` (e.g. Gearbox, Exactly, Liqwid) is low-but-not-pristine and carries a small proportional penalty (≤ +0.075), while only true blue-chips (≤ `2.0`) are an exact no-op.
- `sourceRisk.dependencyConcentration` is a reviewer-set, stablecoin-id-keyed cross-venue signal. It adds `+0.10` (`medium`) or `+0.20` (`high`) to the source-risk penalty; `low` is informational with zero penalty. The registry is authoritative; unseeded coins stay neutral. The offline venue calibration names concentration as a cause only when the canonical penalty changes with it, excluding zero and fully capped contributions.
- The `yvusdc-yearn` calibration anchor is Yearn's [May 2026 yvUSDC-1 risk report](https://github.com/yearn/risk-score/blob/master/reports/report/yearn-yvusdc.md). Re-review the dependency entry if Yearn materially revises the report, the vault diversifies away from Sky, or the Spark venue scores leave the derived `low` tier. The report is review evidence, not a runtime feed.
- DEWS Yield Anomaly reads the derived `venueRiskTier` directly, so its `structured-medium-risk-venue` (+10) and `structured-high-risk-venue` (+25) branches fire across the reviewed registry as of DEWS v6.09; no DEWS threshold changed.
- `sourceRisk.sourceRiskScore` is the 0–100 display normalization of the resolved source-risk penalty. As of v8.13, when no upstream score is provided, the publisher fills it via `computeSourceRiskScoreFromPenalty` (`penalty = 1.0` → `0`; `penalty = PYS_MAX_SOURCE_RISK_PENALTY` (`2.5`) → `100`). The score is informational and does not change PYS — PYS continues to consume the `sourceRiskPenalty` directly. Rollback compatibility: legacy v7.48 payloads still resolve to a neutral penalty when source-risk is absent, and an explicit upstream `sourceRiskScore` value still wins over derivation.
- `sourceRisk.sourceDepthRatio`, `sourceRisk.rewardShare`, `sourceRisk.sourceAgeSeconds`, `sourceRisk.observationCount30d`, `sourceRisk.sourceSwitchCount30d`, `sourceRisk.deploymentPlace`, `sourceRisk.venueProtocol`, `sourceRisk.venueChain`, and `sourceRisk.investabilityFlags` are populated only when supported by existing rows, provenance, publication-generation evidence, or sourced yield-risk config. Missing precision stays missing instead of being guessed from labels.
- `sourceRisk.venueProtocol` resolves through one resolver: explicit value → DeFiLlama `project` → source-key route → tracked wrapper child-id fallback. Unknown venues and derivation-method tokens (`price-derived`/`rate-derived`) publish null. `YIELD_VARIANT_CHILD_VENUE_PROTOCOLS` and reviewed aliases in `shared/lib/yield-source-risk-registry.ts` own child-to-venue mappings; child identity never overrides a known structured venue.
- Reviewed vault children resolve to the actual lending venue, not curator brand names. `YIELD_VARIANT_CHILD_VENUE_PROTOCOLS`, reviewed aliases and `shared/data/coverage-dispositions/dependency-target-dispositions.ts` own identity/evidence; unreviewed venues remain unknown.
- `sourceRisk.rewardShare` resolves once per publication from the same payload the penalty uses: the raw `apyReward / currentApy` ratio may exceed 1 and is null when unavailable or non-finite. A base-only row (`apyReward` null with `apyBase` at `currentApy`) proves `rewardShare: 0`. The reward-heavy penalty caps internally at +0.5; persisted and public evidence is not display-capped.
- `sourceRisk.sourceSwitchCount30d` uses durable published winner history when supplied by the coordinator, including transitions where the prior winner is absent from the current candidate set; runs shorter than two publications collapse out. Only the no-history fallback requires a live, non-rejected prior candidate and records `previous-source-transiently-missing` instead of a switch when it is absent.
- The churn term (`min(0.3, count × 0.1)`) is published on the best row only: alternate rows publish no switch count and their stored penalty excludes the term, so an alternate's `riskAdjustedUtility` can exceed the selected row's. Arbitration itself charges every candidate whose selection would be a real switch a flat 0.1 margin on the pre-run count (so the +1 ratchet cannot be won by the churn it creates), with a deterministic source-key tie-break; the chosen row still publishes its true 30-day count.
- Source-risk coverage ratios are measured over per-field eligible rows: depth and tier exclude rows whose venue is the asset itself — the derivation methods `price-derived`/`rate-derived`, and the issuer rails `native-wrapper`/`issuer-savings` (a staked or savings wrapper the issuer operates, or the issuer's own savings module). An issuer rail has no independent third-party venue to review, and the coin's Safety Score already prices that risk, so counting it would double-count it; this is a coverage-measurement denominator only, and an unknown tier stays PYS-neutral. Rows whose venue is a genuine third party (`strategy-vault`, `lending-market`) stay in the denominator and are queued as `venue-risk-config-missing` rather than backfilled with guessed tiers. `rewardShare` counts only lanes that can publish a split. The `venueProtocol`/`venueChain` denominators intentionally stay whole-corpus so the resolver change reads as a real drop, and best-row and alt-row ratios are reported separately.
- External opportunity rows (`lending-opportunity`, `fixed-yield`, and `structured-tranche`) and native yield source-risk do not modify any V9 Backing, Exit, or Economic Control pillar, cap, score, or grade. They may inform opportunity-level yield risk labels or DEWS yield-anomaly inputs only through explicitly versioned consumer methodology.
- Any future Safety Score impact from yield evidence requires a V9 Safety methodology update and matching structured Safety Score changelog entry before runtime scoring can consume those fields.
- [DEWS methodology](./dews.md) consumes a bounded subset of populated structured yield evidence inside the existing Yield Anomaly sub-signal: reward-heavy rows, thin or stale sources, source switches, high source-risk penalties, reviewed medium/high-risk venue tiers, and rank-attribution drivers for source-risk or source-switch moves. Missing, malformed, or neutral source-risk fields and legacy warning-only rows remain explicit no-ops.

Rollback compatibility is part of the contract. Production-shaped `v7.48` payloads without `publication`, `publishedRank`, `liveRank`, `sourceRisk`, or `rankChangeAttribution` remain valid. With no nested source-risk penalty, v8 resolves the same neutral penalty (`1`) and keeps the benchmark-aware v7 scoring path equivalent.

### Supporting Metrics

| Metric           | Formula                                                                        | Description                                                                                  |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `yieldStability` | `1 - CV(30d samples)`, rounded to two decimals | 0–1, higher = more consistent. Null for fewer than two samples, `abs(mean) < 1e-10`, or non-finite CV |
| `yieldToRisk`    | `apy30d / (101 - safetyScore)`                                                 | Raw yield per unit of risk                                                                   |
| `excessYield`    | `apy30d - benchmarkRate`                                                       | 30-day average APY above the row's selected benchmark                                        |
| `effectiveYield` | `max(0, apy30d + 0.25 * excessYield + hurdleRebase)` | Benchmark-aware yield before risk and consistency penalties; rebase is zero for USD-currency rows or missing rates |
| `rowUtility`     | `effectiveYield / sourceRisk.sourceRiskPenalty` after neutral/clamp resolution | Source-risk-adjusted utility term used before the safety penalty                             |
| `apy7d`          | Timestamp-filtered 7d average                                                  | 7-day trailing APY (uses `recorded_at >= now - 7d`, not proportional slicing)                |
| `apy30d`         | Simple average of 30d samples                                                  | 30-day trailing APY                                                                          |
| `apyVariance30d` | Standard deviation of 30d APY samples | Published APY volatility measure (despite the field name, not variance) |
| `medianApy` | Global TVL-weighted median over selected rows with finite positive APY and TVL | Persisted and published as null when no eligible observations exist; divergence warnings and chart reference lines are omitted |

---

## Benchmark Registry

Yield Intelligence now uses a small benchmark registry instead of a single global T-bill field.

**Benchmarks currently supported:**

| Key        | Label                            | Primary source                                                                                                           | Notes                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USD`      | USD 3M T-Bill                    | FRED `DGS3MO`, then Treasury.gov yield curve XML                                                                         | Default benchmark and backward-compatible top-level `riskFreeRate`; Treasury.gov is used as a fallback when FRED is unavailable                                                                                                                                                                     |
| `USD_EFFR` | USD effective federal funds rate | New York Fed latest EFFR endpoint, then FRED `DFF`                                                                       | Optional product-specific benchmark and the PYS comparison override for USD T-bill/MMF proxies; not the default USD hurdle                                                                                                                                                                          |
| `EUR`      | EUR 3M compounded €STR           | ECB Data API (`EST/B.EU000A2QQF32.CR`)                                                                                   | Native benchmark for EUR pegs; retained-last-market fallback covers feed outages                                                                                                                                                                                                                    |
| `CHF`      | CHF 3M compounded SARON          | SIX delayed `SAR3MC` download                                                                                            | Public feed is delayed by one business day; not labeled as a proxy                                                                                                                                                                                                                                  |
| `GBP`      | GBP 3M compounded SONIA          | FRED graph CSV for SONIA Compounded Index `IUDZOS2`, then ALFRED graph CSV, then Bank of England IADB `IUDZOS2` fallback | Annualized from the trailing 90-day index change; metadata source `fred-sonia-compounded-index` or `alfred-sonia-compounded-index` before the BoE fallback (`boe-sonia-compounded-index`), fallback mode `gbp-sonia-compounded-index-failed`                                                        |
| `JPY`      | JPY overnight call (TONA proxy)  | Bank of Japan Time-Series Data Search `STRDCLUCON`                                                                       | Used as a TONA-equivalent proxy                                                                                                                                                                                                                                                                     |
| `MXN`      | MXN CETES 28d                    | Banxico SIE API (series `SF43936`)                                                                                       | `BANXICO_TOKEN` enables the official Banxico feed; when missing/failing, MXN retains the last market source when available or remains unavailable so rows fall back to USD. Issuer-controlled product pages are not shared MXN benchmark fallbacks. |
| `BRL`      | BRL SELIC over                   | BCB SGS `11`, then `1178` | Same effective overnight instrument: `11` daily percent compounds over 252 business days; `1178` annual percent is used directly. Zero placeholders, invalid bodies/dates and out-of-bounds rates are rejected. |
| `AUD`      | AUD cash-rate target; interbank overnight proxy on fallback | Reserve Bank of Australia F1 money-market CSV | Prefers the cash-rate target (`rba-cash-rate-target`). Missing/invalid target uses valid interbank overnight evidence (`rba-interbank-overnight`), labeled `AUD interbank overnight (cash-rate proxy)` with `isProxy: true`, `isFallback: true` and `fallbackMode: "aud-interbank-overnight-proxy"` in cache and public metadata. Both invalid retains the existing unavailable/last-market behavior; no new benchmark key. |
| `CAD`      | CAD Bank rate (policy, monthly)  | Bank of Canada Valet API (series `V122530`)                                                                              | Series `V122530` is the monthly administered Bank of Canada policy rate, not CORRA; the monthly cadence is why CAD carries the 45-day observation bound. Currently fetched but unused by published rows, so it is listed under `unusedBenchmarkKeys` rather than gating the registry rollup. |
| `RUB`      | RUB CBR key rate                 | Central Bank of Russia DailyInfo `KeyRateXML` SOAP feed                                                                  | Native benchmark for RUB pegs; validation accepts up to 100% so high key-rate regimes are not rejected by the standard 20% ceiling                                                                                                                                                                  |
| `TRY`      | TRY BIST TLREF overnight         | CBRT EVDS (`TP.BISTTLREF.ORAN`)                                                                                          | Native benchmark for TRY pegs; validation accepts up to 100% so Turkish reference-rate regimes are not rejected by the standard 20% ceiling                                                                                                                                                         |
| `SGD`      | SGD SORA (unavailable)           | —                                                                                                                        | Reserved for a future MAS SORA feed; SGD pegs fall back to USD until a stable public source is wired                                                                                                                                                                                                |

**Observation-age bounds:** `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC` in `shared/lib/yield-benchmark-freshness.ts` owns each key's `recordDate` age bound, independently enforced alongside the 48-hour fetch TTL. Either failure is stale. Daily/overnight series get 5 days: `USD`, `USD_EFFR`, `EUR`, `GBP`, `JPY`, `MXN`, `BRL`, `AUD`, `SGD`. Calendar-matched bounds are `CHF` 7 days (delayed SAR3MC plus holiday clusters), `TRY` 10 days (TCMB holidays), `RUB` 12 days (January closures), and `CAD` 45 days (monthly Bank rate).
Future fetch or observation timestamps outside the five-minute clock-skew allowance are never converted to age zero. When a key has an observation-age bound, a missing or unparseable `recordDate` is non-healthy; an invalid required USD member makes the registry invalid without discarding readable non-USD evidence.
Detailed and summary benchmark metadata expose canonical `maxFetchAgeSec` and per-key `maxRecordAgeSec`; currency-selection policy (`fallback-usd`) alone never degrades feed health.
NY Fed EFFR observations must pass the shared `USD_EFFR` record-age/future-skew bounds before primary success; stale/future records proceed to FRED `DFF`, then retained evidence without renewing the original market clock.
BRL attempts are sequential under one `TREASURY_RATES:BRL` circuit. Unavailable, invalid, stale or future SGS11 evidence proceeds to SGS1178; both must pass the shared five-day publisher-date/five-minute skew gate before publication. Sources are `bcb-selic` and `bcb-selic-1178`; admitted SGS1178 is current market evidence, not a proxy or retained fallback. Both unavailable preserves original market provenance with `bcb-selic-failed-retained`. Same-host failover is not provider diversity; CDI, Copom targets, expectations and Tesouro yields are not substitutes.
Exact feed URLs are owned by the [benchmark constants](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/constants.ts); provider selection and parsing belong to [`fetch-tbill-rate`](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/cron/fetch-tbill-rate.ts).


**Stored as:** `cache` table, key `"risk_free_rates"`, with the legacy USD-only key `"risk_free_rate"` still written for compatibility.

**Fallback:** `RISK_FREE_RATE_FALLBACK = 3.75%` applies to USD only. Other benchmarks prefer a retained last-known source-backed value when available; otherwise they remain unavailable and rows fall back to USD when selection requires it. MXN does not use issuer-controlled product pages as benchmark fallbacks.

**Tokenized-treasury benchmark overrides:** Some rate-derived treasury-like products tokenize the same instrument as their local benchmark, which can compress excess-yield and PYS context toward zero. `benchmarkOverrideKey` lets a rate-derived row compute APY from its configured product benchmark while comparing PYS/excess-yield against an explicit benchmark hurdle. USD T-bill/MMF-style proxies use `USD_EFFR` as the comparison hurdle; EUTBL and UKTBL carry explicit same-currency override keys. CETES has no active issuance reader; its retained MXN benchmark mapping does not authorize source or catalog activation.

**Currencies still falling back to USD:** AED, IDR, ZAR, SGD (and any other peg currency not listed above). These remain as `benchmarkSelectionMode: "fallback-usd"` until a stable public feed is wired for each.

**Selection rules:**

- USD is the default benchmark for the stack and remains the top-level `riskFreeRate` / `provenance.benchmark`
- Yield rows switch to a peg-native benchmark when the stablecoin's benchmark currency is supported
- Rate-derived configs can explicitly override the benchmark key when the asset's benchmark should differ from the peg currency
- When a native benchmark is unavailable, the row falls back to USD and records `benchmarkSelectionMode: "fallback-usd"`

Client display resolution keeps each finite rate with its actual benchmark identity: published row first, then its keyed registry entry, then the USD registry or top-level USD `riskFreeRate`. Incomplete legacy foreign evidence can therefore show a USD-labelled `display fallback` frame, never a USD number labelled CHF/EUR. This display-only context does not rewrite the row's published `benchmarkSelectionMode`, feed-fallback evidence or scoring hurdle; unavailable evidence remains unavailable. PYS explanations use the published hurdle, not a reconstructed display fallback.

Hourly benchmark catch-up refreshes when USD market evidence is missing/older than 24 hours, the newest registry market fetch is missing/older than 24 hours, or USD observation age exceeds its bound. It also refreshes once a USD, USD_EFFR, or GBP observation is within one day of its record-age bound, even with a younger fetch, to catch T+1 prints before expiry. Other keys' observation ages do not independently trigger catch-up. `resolveBenchmarkRefreshNeed` in `worker/src/cron/fetch-tbill-rate.ts` owns this policy; freshness TTLs are unchanged.

**Usage:** The hourly core yield sync resolves `excessYield` from 30-day average APY and rate-derived APY against each row's selected benchmark. Detail cards, hero chips, and history charts render that row-level label. The `/yield` scatter plot always keeps a benchmark frame visible: homogeneous scopes use the shared visible benchmark, while mixed scopes use the default USD benchmark as an orientation frame and rely on row-level tags for the exact hurdle. The plot renders the full filter-visible ranking universe; APY outlier capping changes only vertical placement and never removes opportunities.


Benchmark descriptors in `worker/src/cron/fetch-tbill-rate.ts` have independent `TREASURY_RATES:<descriptor>` circuit keys: an open circuit applies only that currency's retained/hardcoded fallback policy while other descriptors continue. SGD is a null registry slot, not a fetched feed. Retry admission uses retained market-fetch and observation age, not registry cache-write time; a running supplemental catch-up defers the slot's benchmark retry.
---

## Warning Signals (Phase 2)

`yield-helpers.ts::detectWarningSignals()` runs in the sync cron and stores baseline results in the `warning_signals` column of `yield_data`. Rankings responses also add a read-time freshness signal. Frontend-visible warning keys are:

| Signal             | Condition                                                                                                                                                                                                                                                                                                          | Meaning                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `yield-spike`      | `currentApy > 2% AND currentApy / apy30d > 2.0`                                                                                                                                                                                                                                                                    | Sudden 2× jump vs. 30d average (absolute floor: 2% APY)                             |
| `yield-divergence` | Finite positive `medianApy` exists and `currentApy > medianApy * 3` | 3× the global TVL-weighted selected-row median; unavailable median produces no warning |
| `negative-trend`   | `apy30d > 1% AND currentApy < apy30d * 0.7`                                                                                                                                                                                                                                                                        | 30% decline from average (absolute floor: 1% baseline)                              |
| `reward-heavy`     | `apyReward / apy > 0.8`                                                                                                                                                                                                                                                                                            | 80%+ from incentives, not base yield                                                |
| `tvl-outflow`      | TVL dropped > 20% from prev week                                                                                                                                                                                                                                                                                   | Capital leaving the protocol                                                        |
| `zero-yield`       | `currentApy === 0 AND apy30d > 0.5%`                                                                                                                                                                                                                                                                               | Yield dropped to zero but had recent activity                                       |
| `data-stale`       | Core source families are older than 3 `sync-yield-data` intervals (currently 360 min); supplemental Aave/Compound + protocol-API rows are older than 6 hours, except Pendle rows (daily lane) accepted through 48 hours and Hashnote USYC, Midas mMEV, and Re Protocol reUSD observations accepted through 72 hours; `price-derived` rows are older than 30 hours; `rate-derived` rows are older than 36 hours; ordinary comparison anchors are older than 14 days; price-derived and Midas/Ondo NAV anchors are older than 45 days | Yield data or its APY comparison anchor is older than the source's expected cadence/window |
| `aging`            | Observation age past the midpoint of its class's cadence-to-stale window (4h core, 5h supplemental, 27h price-derived, 30h rate-derived, 36h Pendle daily lane, 48h slow NAV) | Read-time-only: the row missed its refresh slot; a refresh is expected before the stale bound |
| `data-freshness-unknown` | The row's source reported no observation timestamp | Freshness cannot be established, so PYS is unavailable |
| `reference-benchmark-degraded` | Configured product input or independently required USD normalization reference is degraded or stale | Degraded evidence qualifies the score; stale product evidence yields `source-stale` NR and a stale normalization reference yields `benchmark-stale` NR |
| `benchmark-degraded` | Row comparison hurdle is degraded | Retained/fallback evidence qualifies the score rather than claiming exact evidence |
| `benchmark-stale` | Row comparison hurdle is stale | PYS is unavailable; the same null reason also covers a stale required USD normalization reference |
| `safety-unrated` | Safety is unobserved/unrated | Conservative fallback is visibly qualified; an unavailable common snapshot withholds PYS |
| `opportunity-evidence-missing` | Critical external-opportunity evidence is incomplete | Row remains visible but PYS is NR |

All frontend surfaces (leaderboard, detail section, history chart) format warning signals via the shared `formatYieldWarningSignal()` function in `src/lib/yield-constants.ts`, which maps known signal keys to human-readable labels and falls back to hyphen-to-space conversion for unknown signals.

Evaluation, rankings cache construction, and API reads all assess `data-stale` from source observation and comparison-anchor ages using `worker/src/lib/yield-ranking-helpers.ts`. Evaluation warnings are persisted to `yield_data` and `yield_history`; additional read-time warnings are not written back. `aging` is read-time-only. The table above summarizes the shared source-class budgets; the helper owns their constants and source-key exceptions.

The sync records comparison-anchor freshness under `sourceCoverage.comparisonAnchorFreshness`: anchored row count, stale count, oldest overall anchor age/source, bounded stale examples with each source's `maxAgeSeconds`, and truncation. Status retains source budgets and run provenance; oldest does not mean oldest stale. Ranking count deltas remain in source-coverage metadata, with top-level guard metadata used when publication is blocked. These are permanent read-only diagnostics, not arbitration or publication authority.

The sync also performs a confidence-aware cross-source arbitration pass before `is_best` is chosen:

- accepted candidates outrank rejected candidates, and positive APY outranks non-positive APY
- non-fixed candidates outrank `fixed-yield` candidates before evidence and confidence comparisons
- direct first-party/on-chain evidence outranks curated observations, then discovered observations, modeled proxies, and fallback evidence; confidence breaks ties within an evidence class
- within the same evidence/confidence tier, source-risk-adjusted utility (`effectiveYield / sourceRiskPenalty`) is compared when either candidate has a finite resolved penalty, including an evidence-derived penalty; otherwise comparison falls through to current APY, TVL, then source key
- materially divergent discovered or fallback rows can be rejected when an eligible higher-confidence canonical source disagrees by more than 35%; rejected canonical candidates cannot veto another source
- arbitration compares candidates on the pre-run switch count plus a flat 0.1 would-switch margin, with a deterministic source-key tie-break so both input orders agree
- a non-rejected curated explicit pool takes precedence over auto-discovered same-asset, same-yield-type candidates even when discovery is the incumbent; those candidates remain alternatives rather than being rejected by this precedence rule
- the arbitration winner must itself be publishable: a rejected winner (for example NR on source-freshness-unknown) is skipped, so the coin publishes no `is_best` row that generation instead of a least-bad substitute
- a `canonical-zero-vs-positive` anomaly is flagged when a high-confidence source reads 0% but a lower-confidence source reports > 1% APY

This selection behavior is surfaced in row-level `provenance` metadata on `/api/yield-rankings`.

---

## Engineering Contract

The methodology above owns public behavior; this section owns runtime contracts.

[Runtime ownership and scoped reads](./yield-intelligence-operations.md#runtime-ownership-and-scoped-reads) details compact taxonomy, independent query startup and coin/history projection boundaries.

### Persistence And Publication

- Apply migration `0265_yield_history_observation_clock.sql` before using `source_observed_at`. Current/source-aware recent/daily history and publish-time PYS replay evidence retain their distinct storage roles. Null-overwriting conflict updates never renew source clocks; CAS, generation guards and atomic writes govern. Publication builds one shared selection for persistence/rankings, validated before and after construction. [Storage and diagnostic details](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/yield-intelligence-appendix.md#publication-storage-and-diagnostics) own schema/replay fields, retention and reason vocabulary.
- Atomic SQL projections derive from fixed, ordered local column specifications, with an explicit decision-retention CASE override. Current-row conflicts overwrite every non-key column, including nulls; history ignores only its primary-key conflicts, while decision evidence retains replacement semantics. The strictly newer cache CAS, generation guards, rows and freshness sentinel remain one atomic batch.
- `YieldRankingsResponseSchema` validates preview and final rankings before atomic publication. Schema/duplicate-ID failure increments `validationFailures`, leaves the prior generation intact and returns unapplied/degraded work.
- [Storage details](./yield-intelligence-operations.md#publication-storage-appendix) own alias repair, generation fences, compaction and replay; preserve history and surface exhausted retries.
- Public rankings expose only a validated published generation; failed validation or publication leaves the prior snapshot intact. Rankings full/summary and history reassess the shared `yield-data` bands at response time: fresh through 10,800 seconds, degraded through 21,600 seconds, then stale. Both non-fresh states emit HTTP Warning 110, `Cache-Control: no-store`, and `_meta.reason: "yield-publication-age"`.
- One admission/quarantine boundary feeds views, rankings, current rows, history, and decision evidence. Non-finite core APYs or invalid alternate comparisons quarantine the source with `yield-publication:quarantined-source:<id>:<field>` rather than poisoning the generation; non-finite stored history APYs are excluded from trailing statistics.
- Rejected winners do not enter selected health. Coverage/mix regressions warn but valid rows publish; empty total, unavailable safety, unreadable prior rankings or a severe total-count loss block with diagnostics. Applied work returns `ok` with independent quality findings; unapplied work is `degraded`. Pendle-only loss is advisory. Atomic publication includes matching freshness/generation evidence; non-clean or held-safety runs suppress destructive cleanup and advance the degraded streak. Exact thresholds, exceptions and metadata are in [publication diagnostics](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/yield-intelligence-appendix.md#publication-storage-and-diagnostics).
- Aging and independent freshness assessment precede every live/publish-time safety branch, including explicit NR and pipeline gaps. Selected `sourceRisk.sourceAgeSeconds` follows provenance `sourceObservedAt`, or published age plus elapsed cache time if absent; alternate ages advance by elapsed publication time, unknown ages stay null. Comparison anchors, benchmark fetch/record evidence, rate-product inputs, and their warnings/null reasons are reassessed even when safety is unavailable; safety loss does not remove fresh APY or rehabilitate rejected source evidence.
- Pool-input clocks remain independent of publication: age `provenance.dlPools` before projection/reuse, preserve absent clocks as null, and disclose the reference strip's inclusive 7,200-second warning budget.
- History uses `buildFreshnessMeta` with the bands above. Missing authoritative cutoff, including failed cron lookup, serves readable points stale with `publication-cutoff-unavailable`, even with a fallback cache cap.
- Final admission runs after linked-variant projection and before evaluation/arbitration for every `lending-opportunity`, `fixed-yield` and `structured-tranche` candidate, across tracked, explicit, auto-discovered and supplemental paths. Require current tracked supply and measured finite `sourceTvlUsd >= max(candidate chain absolute floor, 0.1% of USD-denominated tracked supply)`. `CHAIN_LENDING_TVL_FLOOR_USD` owns chain overrides: $100K default and $25K on configured smaller/pre-mainnet ecosystems. This covers every peg, including GOLD/SILVER; supply/AUM cannot substitute for venue TVL and the absolute floor alone never admits a final row. Royco market/vault floors additionally apply.
- Aave TVL converts decimal-admitted underlying quantity with an independently fresh observed USD quote and admitted cache clock; never assume parity. Missing/nominal/stale/invalid valuation omits the row; non-finite products reject. [Valuation details](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/yield-intelligence-appendix.md#external-opportunity-valuation) own helpers and reasons.
- Freshness eligibility precedes confidence arbitration; expired candidates remain auditable rather than winning through confidence or an absolute-floor fallback.

### Public Wire Contract

- Full and summary rankings and history publish `_meta` with `updatedAt`, `ageSeconds`, `status`, `assessedAt`, `freshBudgetSec`, `degradedBudgetSec`, and nullable `reason`. Assessment fields are required whenever `_meta` is present.
- Summary rows retain `benchmarkSelectionMode`, `benchmarkIsFallback`, benchmark age bounds, `provenance.sourceMaxAgeSeconds`, selected anomalies, and up to eight alternate lane projections (`yieldType`, `yieldSource`, `apy30d`). `alternateSourceCount` stays complete; source-board lanes disclose omissions and missing anomaly evidence. Feed fallback is independent of selection policy.
- Detailed provenance retains nullable `sourceObservedAt` and `sourceAgeSeconds` without discarding other evidence. Unavailable `medianApy` remains null. Rankings, alternatives, and history preserve raw nonnegative `sourceRisk.rewardShare`, including ratios above 1. Public serialization does not replace unavailable values with zero or cap persisted evidence.
- Safety provenance preserves the accepted safety generation and its original `publishedAt`, with `maxAgeSeconds: 86400`; publishing a new yield generation never renews the safety clock. `safety-snapshot-coverage` is emitted only for measured coverage below the shared 0.75 floor; unavailable coverage names `safety-snapshot-unavailable`, while `safety-snapshot-held` is a quality advisory.
- Publish-time and live-hydration Safety coverage preserve nullable `trackedCount`/`coverageRatio`: null is unavailable, never `0%`/complete. The canonical score-map producer returns an empty map with `coveredCount: 0`, null denominator/ratio, the upstream reason and null publication identity/time when its source is unavailable; that empty result is not measured coverage. The reference strip shows “Safety coverage unavailable” plus source reason; measured zero shows `0%`, and held accepted coverage keeps its measured percentage and held reason. Current/held admission and source-age budgets remain separate and unchanged.
- Rankings cache reads validate the schema and publication contract before transformation; malformed payloads return HTTP `503`, never a raw cached `200` fallback.
- The embedded detail model (`useYieldDetailSectionModel`) resolves registry lifecycle before `useYieldRankingsCoin`: frozen IDs pass `enabled: false`, a retained ranking still renders, and absent rankings settle as the frozen archive note (no loading, “not available yet” or retry). `YieldDetailSection`'s 30-day history read stays independent; active coins keep their loading/error handling.


### Producers And Consumers

[Runtime owners](./yield-intelligence-operations.md#runtime-ownership-and-scoped-reads) lists producer/API/frontend entrypoints; [API Reference](./api-reference.md) owns HTTP schemas. Public status separates stale/missing publication from source quality.

Producer evaluation and live/publish-time API hydration share normalized evidence qualification, safety-warning membership and final PYS scoring in `worker/src/lib/yield-ranking-helpers.ts`, consuming the canonical safety resolution without renaming its fields. Source/benchmark acquisition, published-provenance preference, explicit NR/identity admission and source selection remain caller-owned; the producer's cheaper pre-arbitration utility pass does not compute a final score. Caller-admitted null reasons retain their context-specific priority, and a reason always withholds PYS without turning a legitimately rounded-zero score into NR. PYS weights and calibration are unchanged.

Runtime readers consume authored source configs directly; the adapter manifest is a sorted projection, not a reconstructed runtime registry. Price-derived eligibility remains enforced during resolution. Benchmark loading retains both the readable registry and its cache-readability state.

History input construction and source evaluation expose only awaited cooperative APIs. Their row/coin cadence, per-iteration cancellation checks, and progress-before-yield ordering are shared by runtime and tests; deterministic tests may inject an immediately resolved `yieldToEventLoop` callback without selecting a separate execution mode.

Morpho, Pendle, Yearn Kong and Beefy share only a local candidate-envelope constructor in `sources-optional.ts`: providers pass explicit identity, percent APY, pool, source key, label, yield type and per-row observation time. Optional identity-field presence and provider-specific source-key casing remain intact. Fetch/parser boundaries, budgets, exception handling and cleanup stay provider-owned; `SIMPLE_SUPPLEMENTAL_FAMILIES` remains the family runner authority.

### Failure Semantics

- Missing history produces an explicitly immature or not-rated result; the pipeline does not fabricate trailing observations. Current anchor-only sources are separate persistence inputs, excluded from measured coverage and public selections until a return exists. Guard diagnostics expose `anchorOnlySourceCount`; missing/held coverage does not become healthy because an anchor was read.
- Missing cards retain qualified conservative fallback; live `NR` cards with null scores retain null Safety/PYS and do not count as hydrated coverage. Default/explicit-NR rows carry `safetyReason`: `report-card-score-missing` (including missing underlying cards on structured opportunities) or `report-card-grade-not-rated`.
- Failed source resolution omits rows rather than inventing APY; thin/unmeasured deposit-venue TVL is never replaced by coin supply. Exhausted bulk `stablecoins` D1 reads fail visibly and retain the generation; unparseable supply records `yield-supply-map:malformed`. No resolved yield-bearing coins returns `degraded` / `no-yield-bearing-coins` with `yield-sync-no-yield-bearing-coins`.
- The timed tracked-source registry owns reader exception isolation: one structured warning with the source label precedes one `failed` outcome callback, then resolution continues without that source. The existing source budget reports `timeout` once; parent cancellation propagates instead of becoming a failure. Expected missing or invalid domain evidence remains `null` without a failure outcome. Provider-level fallback and supplemental-family completeness policies remain separate.
- Negative APY remains valid input for identity-valid native/wrapper DeFiLlama observations, weighted holder constituents, and Midas/Hashnote/Ondo NAV annualizations within the shared deterministic envelope. Losing observations and their valid NAV anchors remain available for publication and history; non-positive trailing APY publishes null PYS with `apy-non-positive`, not an unexplained zero. Invalid annualization is unavailable and cannot seed history. Explicit opportunity-specific bounds, including Yearn yBOLD's `(0, 100]%` gate, remain unchanged.
- A circuit-broken provider removes only that source family. Independent tiers may still publish.
- Monthly coverage audits defer on unavailable/malformed rankings or supply, preserving prior reports and making no durable candidate writes. Valid empty rankings/protocol arrays remain available evidence; missing categories stay unknown. Malformed category evidence retains a conservative report but degrades the run. Complete detector cohorts/count denominators survive display limits. [Audit admission details](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/yield-intelligence-appendix.md#coverage-audit-input-admission) own projections, input shapes and reasons.
- Current and held V9 ratings require finite, non-future accepted timestamps within the inclusive 24-hour budget owned by `shared/lib/yield-safety-fallback.ts`. Held ratings retain advisory `safety-snapshot-held` and warning `yield-safety-publication-held`; health and clock admission are separate, and below-floor coverage independently degrades quality. Unavailable safety defers before resolution with `safety-snapshot-unavailable:<reason>`: identified snapshots failing clock admission use `safety-publication-clock-out-of-budget`, otherwise the upstream reason. Original identity/time, accepted-publication age and `productive: false` remain visible; the yield generation is retained.
- Trailing windows are timestamp-based, so cron gaps do not shift their boundaries.
- Recheck V9 identity before publication; incompatible rollover retains the coherent loaded snapshot. Live hydration requires compatible model/schema/policy/build identity and an admitted original safety clock; recompute safety and ordering, expiring cohorts at live/cache evidence deadlines. Status/public health share admission. Publish-time fallback requires BOTH original yield/safety clocks within 24h; missing identity or expired/invalid clocks clears Safety to NR. Only live/non-default opportunity safety counts as hydration coverage; source/benchmark aging can still withhold PYS. Fallback alone adds no Warning; NR/partial hydration adds 199 independently of publication-age 110. [Hydration mechanics](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/yield-intelligence-appendix.md#safety-hydration-mechanics) own rollover, clocks and wire reasons.
- `safety-score-index-*` integrity failures never use publish-time safety fallback; identity compatibility alone cannot override unreadable or invalid canonical publication health.
- Unreadable persisted warnings are unknown, not clean. The point stays available with `warningSignals: []` plus `warningSignalsStatus: "unreadable"`; a valid empty list carries no unreadable marker.

### Presentation Boundaries

- Rows expose yield type, confidence, freshness, source risk and explicit PYS null reasons. Deposit opportunities are not passive holder yield. Unavailable values sort last in either direction and remain distinct from observed zero; retained alternate TVL follows the same rule without changing APY order or show-more counts. Unknown warning evidence is not clean evidence.
- Access facts display positive withdrawal delays below one minute as `<1 min`, distinct from an observed zero (`0 min`) and unavailable evidence (`Unknown`). Hour/day formatting is unchanged.
- Reference-rate currency glyphs use the shared `PEG_CURRENCY_SYMBOLS` taxonomy, with deliberate strip-specific CHF (`Fr`) and MXN (`Mex$`) overrides.
- A row's safety `>= 60` and APY30d above its resolved display benchmark determine `Sweet Spot`, `Danger Zone`, `Play It Safe` or `Why Bother?`. Legacy missing native evidence can use the explicitly USD-labelled display fallback described in [Benchmark Registry](#benchmark-registry), without implying that published PYS used that hurdle. Missing score or all benchmark evidence means no zone chip. Scatter zones use one chart-wide reference, so a non-USD row chip can differ. High PYS means well-paid risk, not endorsement.
- The scatter uses a linear APY domain that includes scored negative observations with negative ticks. Rare extreme outliers at either end (at least 12 rows, at most 8% of rows per side, and an extreme beyond 1.35× the candidate rail) pin to a disclosed `>N` upper or `<N` lower rail instead of compressing every other row; each rail's count stays beside the chart and tooltips keep the original APY. A broadly occupied losing tail stays linear. Plotted totals include railed rows; unscored rows are separately counted, including in an entirely unscored view.
- `/yield/` lands on Opportunistic (safety `>= 50`, warnings hidden). Explicit URL risk axes override band defaults; selecting a band replaces risk axes but retains research filters. Clearing one axis selects neutral `risk=any` while keeping the other axes explicit. Comparisons use the unbanded universe so low-grade selections remain visible.
- APY and benchmark levels use `%`; spreads, benchmark adjustments and hurdle re-bases use `pp`, including the collapsed instrument board and scatter tooltip. Differences that round to zero display `+0.00 pp`, never negative zero. Breakdowns use the published benchmark/reference evidence and preserve actual null reasons. Missing evidence never implies an estimated score or default safety. Neutralize-and-rescore factor deltas are explanatory and need not sum to final PYS.
- Stablecoin detail is an at-a-glance summary; the per-coin yield workbench is history-first and remains `noindex`. `/yield/` and stablecoin detail pages are indexable. Workbench links disclose fallback context when a dedicated workbench is unavailable.
- Selected-source history stitches published selections, while headline APY30d uses the current source only. Missing observations and NR points remain gaps; alternate-only timestamps are not interpolated. Unavailable median/previous-source evidence stays unavailable.
- Workbench warning groups retain signal/source identity and every occurrence, with an inclusive maximum 24-hour span anchored to each group's newest observation. Adjacent repeats cannot extend that span; grouping changes neither producer warnings nor source arbitration.
- Daily APY attribution compares the last observed close of adjacent UTC day buckets only. Missing days are not interpolated or treated as one daily move; without a valid pair the result is insufficient data, while independently dated publication-ledger source-switch evidence remains eligible.
- Rank attribution compares the previous publication: explicit null means measured unchanged, absence means no comparison. Contributions are heuristic, not additive causal decomposition. Refresh failures and API quality warnings stay visible with retry; one failed comparison series does not hide successful series.
- Counts describe yield-source rows, not coins. Safety provenance remains explicit, including opportunity-derived, default or unknown safety in exports. Benchmark selection policy is distinct from feed quality, and a new cache timestamp cannot renew benchmark or source evidence.
