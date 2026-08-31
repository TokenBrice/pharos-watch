# Yield Intelligence

Risk-adjusted yield tracking and ranking for yield-bearing stablecoins and curated lending opportunities. Computes APY from deterministic on-chain reads, curated DeFiLlama pools, protocol-native yield APIs, price history, and benchmark-derived fallbacks; scores each coin via the Pharos Yield Score (PYS); and serves a dedicated `/yield` page plus a stablecoin-detail yield section. That detail section now renders for any asset with a live published ranking row, even when the coin itself is not statically marked `yieldBearing` (for example USDC/USDT lending opportunities or XAUT's curated Yo Protocol venue).

> **Agent navigation** — Grep the heading you need: Methodology Versioning · Tracked Coins · Source-Aware APY Resolution · Pharos Yield Score (PYS) · Benchmark Registry · Warning Signals · Engineering Contract.

---

## Methodology Versioning

- **Current methodology version:** `v8.42`
- **Public changelog page:** `/methodology/yield-changelog/`
- **Canonical source:** `shared/lib/methodology-versions/yield-methodology.ts`

Yield versions are bumped when APY source resolution, source arbitration, history semantics, PYS scoring logic, or score-affecting publication rules change.

Detailed release history lives under `shared/data/methodology-changelogs/yield-methodology/` and is rendered at `/methodology/yield-changelog/`. Keep version deltas in that structured source rather than duplicating them in this methodology reference.

The current scoring contract is:

- Fresh rows publish `calculationMode`, `evidenceClass`, `evidenceCompleteness`, and `scoreQualification`. Direct complete evidence can be exact; modeled/fallback or incomplete noncritical evidence is qualified rather than presented as exact.
- Fresh rows using the conservative `40 / NR` safety fallback, or an external opportunity with measured venue TVL but incomplete venue/market evidence, retain a numeric estimated PYS plus the precise `safety-unrated` or `opportunity-evidence-missing` warning. External opportunities with null or non-finite venue TVL are removed before evaluation. Unknown/stale source freshness and stale benchmarks remain NR with a null PYS.
- `sourceRisk.observationCount30d` counts distinct UTC observation days, including the current publication day. Limited-history treatment remains active until seven distinct days are represented.
- External `lending-opportunity`, `fixed-yield`, and `structured-tranche` rows publish source-keyed `sourceRisk.opportunityRisk` evidence without changing the underlying stablecoin's Report Card.
- When the Royco Dawn tranche model or the external-opportunity assessment supplies a row's `safetyScore` / `safetyGrade`, the row publishes `provenance.safetyProvenance: "opportunity-safety"`. That grade is **not** Safety Score V9. Every surface that renders it labels it as opportunity-derived from `shared/lib/yield-opportunity-provenance.ts`: the leaderboard and instrument board mark the badge and carry the explanation in its title and screen-reader label, the leaderboard CSV adds a `Safety provenance` column, and the Picker records `MergedRow.safetyProvenance`, folds it into the dataset hash, and names it in the shortlist card's authored explanation.
- Freshness eligibility is applied before confidence arbitration. Expired candidates stay auditable, and every benchmark key used by published rows is evaluated independently; the hard benchmark scoring TTL is 48 hours.
- A final resolve-stage eligibility pass runs after linked-variant projection and before evaluation/arbitration. It removes every `lending-opportunity`, `fixed-yield`, and `structured-tranche` candidate whose tracked stablecoin supply is unavailable, or whose measured `sourceTvlUsd` is null, non-finite, or below `max(chain absolute floor, 0.1% of current tracked supply)`, across tracked, explicit, auto-discovered, supplemental, and linked-variant paths. Unlike the discovery-time size gate, this pass never admits on the absolute floor alone. Structured-tranche rows additionally retain Royco's bespoke market/vault floors.

Source ownership, projection, provider order, publication guards, and compatibility behavior are documented in the sections below.
---

## Tracked Coins

Every stablecoin with `flags.yieldBearing: true` in `shared/lib/stablecoins/registry.ts` is inventoried by the yield manifest. Live cron resolution operates on the active subset (`status !== "pre-launch"`), while pre-launch or intentionally uncovered assets remain visible to operators through explicit manifest entries instead of silently disappearing from coverage accounting. Pre-launch status is declared in the asset's per-coin file under `shared/data/stablecoins/coins/*.json`, loaded through `shared/data/stablecoins/coins.generated.json`, and skipped by explicit lending override publication until the per-coin entry moves into the active lifecycle. The sync also supports deterministic custom sources for select non-yield-bearing coins, exact-pool curated overrides for select non-stablecoin assets, plus automatic lending pool discovery for tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), including coins already flagged `yieldBearing`. `yieldConfig` is used when present to provide canonical source/type labels; auto-discovered lending rows synthesize protocol-derived labels when the source is `defillama-auto`. Tracked savings wrappers own their own runtime pool/on-chain readers and history. When a tracked wrapper has a live native/wrapper yield source, the publisher may also expose that source on the active parent stablecoin with a `linked-variant:<variantId>:<sourceKey>` key for comparison and coverage context; this does not mark the parent `yieldBearing` purely because the wrapper exists, and external opportunity rows (`lending-opportunity`, `fixed-yield`, or `structured-tranche`) are not projected from variants to parents.

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

**Config:** `ON_CHAIN_RATE_CONFIGS` in `worker/src/lib/yield-config/yield-config.ts`

```ts
interface OnChainRateConfig {
  stablecoinId: string;
  chain: string;
  contract: string; // vault contract address
  selector: string; // 4-byte function selector
  decimals: number;
  inputAmount: string; // hex-encoded input (e.g. 1e18)
  // optional measured venue TVL when no pinned DL pool join exists
  tvlRead?: { kind: "erc4626-total-assets"; decimals: number };
}
```

The generic-vault inventory, exact contracts, chain assignments, selectors, and lifecycle state are owned by
`ON_CHAIN_RATE_CONFIGS` and its typed rate-source registry. Do not copy that changing roster here. Generic entries use
the configured `convertToAssets(uint256)` reader; protocol-specific or quarantined assets use the dedicated paths and
lifecycle records described below.

`scrvusd-curve` is intentionally quarantined from this generic Tier 1 reader because its trailing 7-day `convertToAssets(1e18)` delta understated Curve's current scrvUSD savings APY. It uses the scrvUSD special-case estimator below instead. `ustb-superstate` is quarantined because the tracked USTB token is not an ERC-4626 vault; restoring deterministic USTB coverage requires a dedicated Superstate NAV-oracle adapter, not another generic `convertToAssets` attempt.

The monthly yield coverage audit re-probes explicit generic `convertToAssets` quarantines when monthly `chainRpcs` are available. No quarantined adapter currently carries an audit probe config (`QUARANTINED_DETERMINISTIC_PROBE_CONFIGS` is empty), so this re-probe lane stays dormant until an operator seeds one. Successful nonzero probe rates inside the `<=300%` exchange-rate envelope produce `quarantineReadyToRestore`, `quarantineProbeSummary`, and an operator queue candidate with kind `quarantine-ready-to-restore`; restoration remains manual and requires an operator to move the adapter back into hourly coverage. `scrvusd-curve` remains quarantined because its dedicated current-rate reader is canonical, while USTB is not re-probed because its interface mismatch is structural. Lifecycle review dates remain recorded in the typed registry.

**APY formula:**

```
apy = ((rate_now / rate_7d_ago) ^ (365.25 / 7) - 1) * 100
```

The generic exchange-rate reader rejects computed APY above `DETERMINISTIC_APY_SANITY_MAX = 300`. Rejected observations are not published as `onchain` rows and the suspicious current exchange rate is not written as a new anchor; the resolver continues through lower tiers so curated DeFiLlama, protocol-API, or rate-derived coverage can win. The post-V9 sync records the rejected Tier 1 count at `sourceCoverage.onChainEnvelopeRejectionCount` and bounded examples at `sourceCoverage.onChainEnvelopeRejections` with a truncation flag. Those examples are diagnostic sync metadata only; fallback resolution is unchanged. Negative APY remains allowed because it is bounded by the ratio formula and can be useful stress evidence.

Even when Tier 1 succeeds, the cron still falls through to Tier 2 to collect additional wrapper/native DeFiLlama rows. If no previous exchange rate exists yet (first sync), Tier 1 emits a seed row with `currentApy: 0`, `apyBase: null`, and the current `exchangeRate` so the rate is persisted in `yield_history`. This breaks the bootstrapping deadlock: without the seed, the on-chain source would never resolve because it needs a 7-day-old rate, but the rate was never stored because the source never resolved. Subsequent syncs (7+ days later) will find the seed rate and compute a real APY. Once real on-chain APY samples exist, those bootstrap seeds are excluded from rolling `apy7d`, `apy30d`, `excessYield`, yield stability, and PYS calculations because they are anchor placeholders, not observed zero-yield periods.

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

This keeps wrapper pools like `fxSAVE` and `msY` eligible even when DeFiLlama marks them `stablecoin: false`, and it also preserves exact curated non-stablecoin venues such as XAUT's isolated Yo Protocol market.

**Layer 1 — Static map:** `YIELD_POOL_MAP` maps Pharos ID to a DL pool UUID. Filters for `exposure === "single"`. Finds the native/primary yield source. If a mapped UUID is missing from the DL payload, the sync logs `[yield-sync] Pool UUID ... not found in DL response, falling through` and continues to Layer 2/3 fallback matching.

2026-05-22 source corrections: `usdn-smardex` now uses the exact SMARDEX USDN DeFiLlama single-exposure pool after its `navToken` flag was corrected to false. `a7a5-old-vector` was initially represented as an intentional yield gap, then gained RUB key-rate-derived coverage in v8.291. On 2026-07-15, base AZND was corrected to a fixed-peg non-NAV token and its configured yield type was moved to the exact loAZND wrapper path, preventing base-token market prices from being annualized as vault yield.

**Layer 2 — Variant map:** `YIELD_VARIANT_MAP` maps to a wrapper/savings pool symbol and can also pin the wrapper chain, address, and preferred DeFiLlama project. Resolution prefers `(chain, address, project)` when configured, then `(chain, address)`, and only falls back to symbol on an unambiguous chain-scoped match. Filters for `exposure === "single"` only (stablecoin flag intentionally relaxed, since savings wrappers like fxSAVE are not flagged `stablecoin = true` in DeFiLlama).

**Layer 3 — Base-symbol fallback:** Used only when both static maps miss. Resolution first tries underlying-token address matches, then exact normalized symbol equality. Substring-only symbol matches are no longer accepted, so prefixed/suffixed wrapper symbols must be corroborated by underlying-token address evidence. Symbols shorter than 4 characters are still excluded from fallback symbol matching to prevent false positives. Filters for `exposure === "single"` and `stablecoin === true`. Ambiguous fallback candidates are dropped instead of guessed.

**Exact weighted pool groups:** `YIELD_WEIGHTED_POOL_GROUPS` can collapse multiple exact DeFiLlama pool UUIDs into one TVL-weighted APY row when Pharos tracks one protocol asset but the yield wrapper is deployed as chain-isolated, non-fungible vaults. This is currently used for `sdusd-dtrinity`, where Ethereum and Fraxtal sdUSD dStake pools publish under one synthetic DeFiLlama source key.

**Exact-pool overrides:** `EXPLICIT_YIELD_SOURCE_POOL_MAP` can publish curated non-stablecoin venues when the pool UUID, project, chain, and symbol all match and the usual APY / TVL quality gates still pass. This is currently used for `xaut-tether` via Yo Protocol. These overrides stay outside generic gold/silver auto-discovery, which prevents basket venues such as Multipli's mixed-RWA pools from being treated as single-asset commodity yield sources. On 2026-05-13, XAUT gained a second curated venue on Lista Lending (BSC) alongside the existing Yo Protocol pin, and PAXG was added as a non-yield-bearing exact-pool entry on Hydration (Polkadot).

**Variant mapping:** `YIELD_VARIANT_MAP` entries supply labels and pool matching for wrapper/savings tokens:

| Base Coin          | Wrapper | Purpose                        |
| ------------------ | ------- | ------------------------------ |
| USBD (253)         | sUSBD   | BIMA savings wrapper           |
| AZND (327)         | loAZND  | Mu Digital locked wrapper      |
| Neutrl USD (346)   | sNUSD   | Neutrl staked USD              |
| Avalon USDa (220)  | sUSDa   | Avalon staked USDa             |
| infiniFi USD (298) | siUSD   | infiniFi savings               |
| Falcon USD (246)   | sUSDf   | Falcon Finance savings         |
| Unitas (283)       | sUSDu   | Unitas savings                 |
| Yuzu USD (344)     | syzUSD  | Yuzu savings                   |
| fxUSD (168)        | fxSAVE  | Concentrator savings           |
| Flying Tulip ftUSD | sftUSD  | Flying Tulip staking           |
| Hermetica USDh     | sUSDh   | Hermetica staking wrapper      |
| Saturn USDat       | sUSDat  | Saturn staking vault           |

`YIELD_VARIANT_MAP` is only used when the yield-bearing wrapper is not already modeled as its own tracked asset. As of May 13, 2026, `sUSDe`, `sUSDS`, `sDAI`, `sfrxUSD`, `scrvUSD`, `sUSDai`, `stcUSD`, `sAID`, `msY`, K3 `sBOLD`, and `savUSD` are tracked directly, so their base assets no longer resolve through those wrapper paths. Added 2026-05-13: gtUSDC (Gauntlet/Morpho), spUSDC and spUSDT (Spark Savings), sGHO (Aave SM), yBOLD, and yvUSDC (Yearn) now own their own native pool sources. Added 2026-05-22: base `gho-aave` no longer inherits the tracked sGHO source, and base `dola-inverse-finance` no longer publishes the untracked sDOLA wrapper source. Removed 2026-08-31: base `bold-liquity` no longer carries a yBOLD variant entry or a curated DeFiLlama pool pin, because both resolved to the tracked wrapper's own Yearn pool and republished it as BOLD's headline yield. AA_FalconXUSDC remains NAV/price-derived until a usable single-exposure nonzero APY source is available.

APY, base/reward split, pool TVL, and pool UUID are all taken directly from the DL response.

### Tier 2.5: Protocol-Native Yield APIs

For coins whose native savings path is published by the protocol itself but is not exposed as a usable DeFiLlama pool, the sync can ingest a curated protocol-owned earn endpoint directly.

Protocol-specific lending-market readers that query protocol state directly also live in this tier. Even when the transport is an on-chain call, these rows are treated as curated protocol-native venues rather than Tier 1 deterministic native-wrapper sources, so arbitration still prefers a stronger native wrapper or savings source when one exists.

This tier can also carry explicit wrapper-over-wrapper native sources when the upstream venue is a distinct managed wrapper around a tracked native yield token. K3 `sBOLD` owns this path directly as `sbold-k3-capital`, and Yearn `yBOLD` owns it as `ybold-yearn`. Base BOLD does not inherit either: it publishes its own deterministic Liquity V2 Stability Pool aggregate.

Royco Dawn markets also live in this tier. The supplemental source lane reads the Dawn market explorer API and emits separate `structured-tranche` rows for the senior and junior vaults in each verified market above the local Royco TVL floor. Rows use the stable source keys `royco-dawn:<chainId>:<marketId>:senior` and `royco-dawn:<chainId>:<marketId>:junior`; the tranche share tokens are not added to the stablecoin registry. Identity resolution maps the Royco deposit token back to a tracked underlying stablecoin by chain/address first, with configured wrapper-variant addresses such as Neutrl `sNUSD` attached to their tracked parent when the wrapper is not a first-class stablecoin row.

Pendle supplemental PT markets also live in this tier. The Pendle REST reader emits active stable-category principal-token markets as `fixed-yield` protocol-API rows using implied APY, the PT market address as `sourcePool`, and source keys shaped as `protocol-api:pendle:<chain>:<marketAddress>`. Identity resolution keeps the PT market's underlying asset symbol/address for stablecoin matching. These rows are external opportunity alternatives: they can attach to the matched underlying stablecoin for comparison, but they do not replace native holder-yield rows or project through variant inheritance.

External `lending-opportunity`, `fixed-yield`, and `structured-tranche` rows undergo the final resolve-stage size gate: `sourceTvlUsd` must be measured and must clear the higher of the chain-specific absolute floor and `0.1%` of the tracked stablecoin's current supply. The pass covers tracked, explicit, auto-discovered, supplemental, and linked-variant candidates; null or non-finite TVL is ineligible, and structured-tranche floors augment Royco's bespoke market/vault floors. Published lending-opportunity suggestions additionally exclude venues whose DeFiLlama `poolMeta` or supplemental source label identifies them as Resolv / `USR`, `stUSR`, or `wstUSR` linked. Native holder-yield rows remain in the broader inventory and are not subject to this external-opportunity rule; any row carrying one of the three scoped yield types is subject regardless of source family.

**Current tracked optional adapters:**

| Coin ID               | Source                              | Endpoint                                                                                             |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `scrvusd-curve`       | `Curve Savings crvUSD current-rate` | on-chain scrvUSD Yearn V3 profit-unlock reader                                                       |
| `usbd-bima`           | `BIMA savings (sUSBD)`              | `https://bima.money/api/earn/pools?network=Ethereum&user=0x0000000000000000000000000000000000000000` |
| `cetes-etherfuse`     | `Etherfuse CETES current issuance`  | Etherfuse first-party Next data at `https://app.etherfuse.com/bonds/cetes`                           |
| `lusd-liquity`        | `B.Protocol LQTY-only source`       | deterministic on-chain LQTY-only source reader                                                       |
| `bd-basedollar`       | `Base Dollar Stability Pools (interest-only)` | deterministic on-chain five-branch Liquity V2 Stability Pool reader                              |
| `bold-liquity`        | `Liquity V2 Stability Pools (interest-only)` | deterministic on-chain three-branch Liquity V2 Stability Pool reader                              |
| `ybold-yearn`         | `Yearn yBOLD Stability Pool vault`  | ydaemon `https://ydaemon.yearn.fi/1/vaults/<vault>` (yBOLD TVL, staked ysyBOLD net APR)              |
| `usyc-hashnote`       | `Hashnote USYC`                     | Hashnote protocol API                                                                                |
| `mmev-midas`          | `Midas mMEV/USD Oracle`             | on-chain issuer-listed mMEV/USD NAV oracle with historical anchor rows                               |
| `usdy-ondo-finance`   | `Ondo USDY oracle`                  | on-chain Ondo oracle with historical anchor rows                                                     |
| `reusd-re-protocol`   | `Re Protocol Basis-Plus (reUSD)`     | `https://api.re.xyz/price` (`reUSD` observations)                                                    |
| `zys-zephyr-protocol` | `Zephyr Scanner ZYS returns`        | `https://zephyrprotocol.com/api/v1/historicalreturns`                                                |

The BIMA adapter uses the protocol's published Ethereum earn feed, selects the USBD savings row, maps `amountTVL` to `sourceTvlUsd`, and uses the higher of `unboostedAPR` / `boostedAPR` as the current APY. Low-signal rows with negligible TVL or effectively zero APR are dropped instead of being published as meaningful yield. These rows are source-keyed as `protocol-api:bima-susbd` and participate in the same confidence-weighted arbitration as other curated sources.

The Royco Dawn adapter maps APY ratios to percent APY, measured tranche-vault TVL to `sourceTvlUsd`, and market coverage/utilization/status/drawdown plus share-token addresses into nested `sourceRisk` fields. Royco rows carry `venueRiskTier: "unknown"` until a reviewed venue-risk audit assigns a sourced tier. They also carry investability flags for withdrawal constraints, verified listing status, and whether the row is senior protected or junior first-loss. KYC/access booleans are nullable; the current Dawn market payload does not expose explicit KYC or jurisdiction restriction fields, so those penalties apply only if future source evidence populates them. The universal measured-TVL gate augments Royco's bespoke market/vault floors.

The Etherfuse CETES adapter reads the current CETES Stablebond issuance from Etherfuse's first-party Next data and maps `interestRateBps / 100` to APY. It publishes `protocol-api:etherfuse-cetes-current-issuance` with the current token amount as the exchange-rate observation when available. This source prevents MXN NAV appreciation plus USD/MXN FX movement from being annualized by the generic price-derived fallback.

The Yearn yBOLD adapter reads Yearn's first-party ydaemon vault endpoint twice: the yBOLD vault (`0x9f43…a3d8`) supplies `sourceTvlUsd`, and the Staked yBOLD vault (`0x2334…91cd`) supplies the net APR. yBOLD's own price-per-share is flat because Yearn routes the Liquity V2 Stability Pool return to holders who stake into `ysyBOLD`, so the staked net APR is the advertised yBOLD yield. The adapter fails closed unless the staked vault's underlying asset is still the tracked yBOLD vault, and rejects APR outside `(0, 100]%` or TVL below the 100k publication floor. It publishes `protocol-api:yearn:ybold` as a `lending-vault` row; the curated DeFiLlama pool `4c29f645-…` stays pinned as a lower-evidence corroborating alternative.

The Midas mMEV adapter reads the issuer-listed Ethereum mMEV/USD oracle, decodes its Chainlink-style `latestRoundData()` answer using the oracle `decimals()`, and publishes `protocol-api:midas-mmev-nav-oracle` as a NAV-appreciation row. Oracle answers must be positive, decimals must be within the supported range, and `updatedAt` must be no older than three days. Like other NAV-oracle rows, the first successful observation can seed `exchange_rate` history with `currentApy=0`; later runs compute APY from a prior published oracle anchor between 7 and 45 days old.

The Re Protocol adapter reads the official daily price feed's `reUSD` series and publishes its latest APY and NAV as `protocol-api:re-protocol-reusd`. Observations must have a positive NAV, an APY within the accepted envelope, and a UTC date no older than three days. The source belongs directly to `reusd-re-protocol`; the separate junior `reUSDe` Insurance Alpha product is not treated as a yield variant of reUSD. Historical rows written under the misattributed `protocol-api:re-protocol-reusde` key are suppressed and purged through the yield-history ownership-handoff safeguards.

The Zephyr adapter reads the protocol's historical-return API and publishes the one-day effective APY only for `zys-zephyr-protocol`. This keeps base ZSD non-yield-bearing while still showing the native ZYS yield-share return on `/yield`.

#### Optional gated supplemental source: vaults.fyi

vaults.fyi is an optional supplemental source family for coverage review and selected allowlisted lending opportunities. It is disabled by default and is not required for normal Yield Intelligence operation:

- Configure the key only as a Worker secret/runtime binding. Do not commit a vaults.fyi credential or place one in docs.
- `VAULTS_FYI_ENABLED=true` plus `VAULTS_FYI_API_KEY` is required before the supplemental cron fetches vaults.fyi.
- With no `VAULTS_FYI_RANKABLE_VAULTS`, the adapter runs a bounded detailed-vault inventory probe, records provider telemetry, and publishes no rankable candidates. Inventory volume is reported separately from supplemental candidate counts.
- `VAULTS_FYI_RANKABLE_VAULTS` is a CSV of `network:vaultId` or `network/vaultId` entries. Only matching rows can become supplemental candidates.
- Candidate rows must match a tracked stablecoin by canonical chain and token contract address. Symbol-only matches are rejected.
- The adapter applies TVL, APY, active/corruption/warning, vault-score, and local credit-budget gates before writing cache candidates. Its monthly ledger reserves the full run allowance before provider calls; if that reservation expires before finalization, the full reserved amount is conservatively charged to month-to-date estimated usage before a successor can claim credits, preventing a crashed run from silently undercounting quota consumption.
- Source keys are stable as `protocol-api:vaults-fyi:<chain>:<vault>`. The row `project` and `sourceRisk.venueProtocol` use the underlying protocol slug from vaults.fyi when available.
- Provider telemetry exposes `pageCapReached` and `creditCapReached` so expected bounded probes are distinguishable from provider errors.
- Provider quota/errors fail open: the supplemental family records skipped/partial/failed telemetry but does not make the post-V9 publisher require vaults.fyi. Disabled-family telemetry distinguishes `disabled` (flag off/unset), `no-key` (enabled without runtime secret), and `invalid-config` (malformed enable flag) so operators can tell configuration states apart.

### Opportunity-Level Safety Resolution

One engine resolves every row's published `safetyScore`, `safetyGrade`, `provenance.safetyProvenance`, and `safetyReason` from the underlying stablecoin's Report Card plus opportunity-level risk: `resolveYieldRowSafety(...)` in `shared/lib/yield-opportunity-risk.ts`. The hourly write path (`worker/src/cron/yield-sync/evaluation.ts`) and the API live-safety hydration read path (`worker/src/api/yield-rankings-cache.ts`) both call it, so the read path re-bins the published judgment rather than re-deriving it (ADR-19). The two paths differ in exactly one input — the provenance label a rated resolution carries (`cached-publish` on write, `live-report-card` on hydration).

The ladder's guards:

- **NR-substitution guard.** An opportunity score replaces the underlying score only when the Report Card was observed *and* rated. A missing Report Card (`default-safety`) or an `NR` grade keeps its own unrating; the opportunity contract is still published on `sourceRisk.opportunityRisk`, it just does not move the grade.
- **Reviewed-venue fallback.** Venue risk resolves once, in `resolveVenueRisk(...)`: the row's explicit `venueRiskWeighted` wins, and the reviewed registry keyed by `venueProtocol` (or the DeFiLlama project slug on auto-discovered rows) is the fallback. Unreviewed venues stay `unknown` and produce a `venue-review` evidence gap, never a guessed penalty.
- **Entry gate.** Every `lending-opportunity`, `fixed-yield`, and `structured-tranche` row is assessed, whether or not it already carries a published opportunity contract; holder yield types carry no opportunity contract at all. A row that publishes no source risk gains only its unrated opportunity contract, never fabricated market evidence.
- **Evidence predicates.** `safetyObserved`, `hasVenueRisk`, and `opportunityEvidenceComplete` come from the ladder's own resolution on both paths; `hasHistory` is the published `observationCount30d` (more than one distinct observation day) on both.
- **Degraded snapshot.** When the exact published safety snapshot cannot be read, every safety-derived field (`underlyingSafetyScore`, `trancheSafetyScore`, `trancheSafetyPenalty`, `opportunityRisk`) is stripped and the row publishes `safety-snapshot-unavailable`.

Both penalty engines — the generic external-opportunity engine and the Royco Dawn tranche engine — draw their access, withdrawal, utilization, TVL, and venue terms from one kit (`shared/lib/yield-penalty-terms.ts`) with per-engine magnitude profiles. Venue risk has a single derivation for both: the weighted `1..5` score is canonical and the coarse tier is derived from it, so an engine can never price a venue from a stored tier that disagrees with the weighted score. The generic engine prices the weighted score continuously above the blue-chip threshold; the tranche engine bins it. Royco-only terms (first-loss, coverage, market status, drawdown) stay bespoke.

### Opportunity-Level Tranche Safety

Royco Dawn rows use a row-level tranche Safety Score for PYS instead of blindly reusing the underlying stablecoin's Report Card Safety Score. The raw underlying score remains the ceiling for senior rows unless a future methodology explicitly allows first-loss protection to create an uplift. The current implementation does not uplift senior rows; it only subtracts tranche-specific penalties. Junior rows start with a large first-loss penalty, then add utilization, coverage, market-status, drawdown, TVL, withdrawal, access, and venue-posture penalties. At high utilization, junior rows should usually score materially below the underlying stablecoin.

Published Royco source-risk metadata includes `trancheSide`, `underlyingSafetyScore`, `trancheSafetyScore`, `trancheSafetyPenalty`, `marketCoverageRatio`, `marketMinCoverageRatio`, `marketUtilizationRatio`, `marketUtilizationLimitRatio`, `marketDrawdownRatio`, `marketStatus`, `marketTvlUsd`, `trancheTvlUsd`, `withdrawalDelaySeconds`, `kycRequired`, and `accessRestricted` when available. API hydration recomputes those scores from the live underlying Report Card snapshot before ranking, so a stale cached Royco score is not allowed to overwrite current stablecoin safety data.

### Tier 3: Price-Derived APY

For `navToken` coins and explicit `PRICE_DERIVED_FALLBACK_IDS`. Derives APY from price appreciation in the existing `supply_history` table using the oldest available anchor between 7 and 45 days. These fallback-only paths are now explicit manifest strategies rather than implicit behavior hidden behind `navToken`.

```
apy = ((price_now / price_anchor) ^ (365.25 / lookbackDays) - 1) * 100
```

Zero new API calls — reuses cached price data. Falls through if no price history exists or if the coin has fewer than 7 days of priced history.

The same 300% deterministic APY sanity envelope applies to price-derived rows. A transient price spike, token migration, or one-off NAV correction above that envelope returns no price-derived source instead of publishing a headline APY or displacing a sane curated source.

**Tier 3 as additional source:** For `navToken` and `PRICE_DERIVED_FALLBACK_IDS` coins, Tier 3 also runs when Tier 2 found sources but they all report 0% APY. This handles DL pools that exist but have stale/broken yield data (e.g., a tiny Aave lending market matched via Layer 3 symbol fallback). The price-derived source is added alongside the DL source, and `is_best` picks the higher-APY winner.

**Known limitation:** Price-derived cannot capture yield for tokens that distribute dividends as new tokens while maintaining a fixed $1.00 NAV (e.g., BUIDL, YLDS). These tokens use the rate-derived tier instead (see below).

### Tier 4: Rate-Derived APY

For dividend-distributing tokens (maintain $1.00 NAV, pay yield as new token mints), rebase proxies, and T-bill-backed funds whose yield mechanically tracks short-term rates. Configured via `RATE_DERIVED_CONFIGS` in `worker/src/lib/yield-config/yield-config.ts`.

```
apy = max(0, benchmarkRate - spreadBps / 100)
```

Uses the structured benchmark cache refreshed daily by `fetch-tbill-rate`. USD defaults to the 3-month Treasury yield (`DGS3MO`), but the resolver can switch to a peg-native or product-specific benchmark when one exists. EUR rows use the ECB's official 3-month compounded €STR series. CHF rows use delayed public `SAR3MC` (3-month compounded SARON) from SIX. RUB rows use the Central Bank of Russia key rate from the DailyInfo `KeyRateXML` SOAP feed. TRY rows use CBRT EVDS BIST TLREF (`TP.BISTTLREF.ORAN`). USDGO uses `USD_EFFR`, sourced first from the New York Fed EFFR endpoint and then FRED DFF, because OSL's public material describes the product against the Effective Federal Funds Rate net of fees. Rate-derived configs can also set `benchmarkOverrideKey`: APY is still computed from the configured product benchmark, but PYS/excess-yield benchmark selection and provenance use the override. USD tokenized T-bill/MMF-style proxies use this to compare against `USD_EFFR`; EUR and GBP treasury proxies carry explicit same-currency override keys; A7A5 uses `RUB` for both APY derivation and PYS/excess-yield provenance. If a benchmark fetch fails, the cron retains the last known market benchmark when available and marks provenance as degraded instead of immediately snapping back to the hardcoded default. Because the public SIX compound-rate file is delayed, CHF benchmark `recordDate` can trail the fetch date by one business day even on a healthy run.

**Configured tokens:**

| Token    | Spread (bps) | Rationale                                                                            |
| -------- | ------------ | ------------------------------------------------------------------------------------ |
| BUIDL    | 20           | BlackRock fund, 0.20% management fee                                                 |
| cgUSD    | 35           | Cygnus Finance T-bill proxy, net of 0.35% protocol fee                               |
| YLDS     | 50           | Figure Markets, T-bill rate - 50 bps formula                                         |
| mTBILL   | 0            | Midas, tracks T-bill rate directly                                                   |
| USDN     | 0            | Noble M0 T-bill rebase proxy                                                         |
| OUSG     | 50           | Ondo US Government Bond fund, 0.50% management fee                                   |
| BENJI    | 20           | Franklin Templeton FOBXX gov MMF, 0.20% mgmt fee                                     |
| WTGXX    | 25           | WisdomTree Government MMF Digital Fund, 0.25% mgmt fee                               |
| USTBL    | 10           | Spiko US T-Bills MMF (UCITS), 0.10% TER                                              |
| EUTBL    | 15           | Spiko EU T-Bills MMF (UCITS), modeled net of 0.15%, EUR-denominated (€STR benchmark) |
| sUSD     | 0            | Solayer sUSD, T-bill proxy                                                           |
| UKTBL    | 15           | Spiko UK T-Bills MMF, modeled net of 0.15%, GBP-denominated                          |
| EURSAFO  | 0            | Spiko Amundi Smart Cash overnight swap proxy, EUR-denominated                        |
| GBPSAFO  | 0            | Spiko Amundi Smart Cash overnight swap proxy, GBP-denominated                        |
| EURSPKCC | 0            | Spiko cash-and-carry strategy proxy (EUR risk-free leg)                              |
| FUSD     | 0            | FinChain tokenized T-bill/MMF reserve-yield proxy, USD-denominated                   |
| SAFO     | 0            | Spiko Amundi Smart Cash overnight swap proxy, USD-denominated                        |
| SPKCC    | 0            | Spiko cash-and-carry strategy proxy, USD risk-free leg                               |
| USDGO    | 38           | OSL/Anchorage USDGO, EFFR-linked reserve-yield proxy using `USD_EFFR` net of 0.38%   |
| wiTRY    | 0            | Brix TRY yield product, BIST TLREF overnight proxy using `TRY`                       |
| A7A5     | 100          | Old Vector A7A5, CBR key-rate reserve-yield proxy using `RUB` net of 1.00pp          |

Note: thBILL was previously rate-derived and remains in Tier 1 `ON_CHAIN_RATE_CONFIGS`. USTB's former generic entry is quarantined because the tracked token is not ERC-4626; its current DeFiLlama source remains available while a dedicated Superstate NAV-oracle adapter is deferred.
VBILL is intentionally not rate-derived in v8.23; its coin metadata documents an on-chain NAVLink-style NAV feed, so it belongs to a future NAV-oracle source lane rather than this benchmark-proxy roster.

Rate-derived runs after Tier 3 in the resolution loop and participates in the `is_best` selection like any other source. For tokens that also have price-derived or DL sources, the highest-APY source wins.

### Automatic Lending Pool Discovery (Wave 2)

For tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), the sync cron can append the best lending pool from a curated protocol allowlist. This runs after the base four-tier resolution, so yield-bearing coins can also receive an additional `defillama-auto` source row when a distinct lending market passes filters. LUSD uses this to retain Aave as an alternative source alongside the deterministic B.Protocol estimate.
The non-gold/silver condition limits this generic discovery lane only; it does not create a supply-gate bypass for GOLD/SILVER candidates admitted through explicit or other paths.

**Allowlist** (`LENDING_PROTOCOL_ALLOWLIST` in `worker/src/lib/yield-config/yield-config.ts`):

| Tier                                                       | Protocols                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tier 1                                                     | aave-v3, aave-v4, compound-v2, compound-v3, dolomite, sparklend, spark-savings, maple, yearn-finance                                                                                                               |
| Tier 2                                                     | fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, morpho-blue, pendle, curve-llamalend, exactly, flux-finance, gains-network, lazy-summer-protocol, moonwell-lending, silo-v2                      |
| Tier 3                                                     | justlend, openeden-usdo, multipli.fi, jupiter-lend, stables-labs-usdx, benqi-lending                                                                                                                               |
| Tier 4                                                     | radiant-v2, fraxlend-v2, clearpool, centrifuge, sturdy-v2, goldfinch, truefi, lagoon, liqwid, lista-lending, loopscale, more-markets, navi-lending, overnight-finance, smardex-usdn, vesper, felix-cdp, sovryn-dex |
| Tier A (2026-03-25, >$50M TVL)                             | wildcat-protocol, tectonic, upshift, venus-flux, avantis, cap, resupply, zerobase-cedefi                                                                                                                           |
| Tier B (2026-03-25, $10M–$50M TVL)                         | convex-finance, yo-protocol, clearpool-lending, 3jane-lending, hyperlend-pooled, zest-v2, liquity-v2, echelon-market, termmax, beefy, gearbox                                                                      |
| Tier C (2026-05-13, $10M+ TVL audit)                       | autofinance, neverland, metrom, mystic-finance-lending, bitway, frankencoin                                                                                                                                        |
| Wave 2 (2026-06-09, category-gated thin/app-chain lenders) | aries-markets, blend-pools-v2, current, curvance, scallop-lend, tydro                                                                                                                                              |
| Wave 3 (2026-06-11, audit-queue follow-up)                 | bifi, fraxlend                                                                                                                                                                                                     |

**Discovery logic:** Filters DL pools by `exposure === "single"`, `stablecoin === true`, project in allowlist, and reserved-pool exclusion. Resolution prefers underlying-token address matches over symbol matches. Symbol-only matching is allowed only when the coin remains unambiguous after chain scoping; otherwise the candidate is dropped. Current quality gates require `apy >= 0.1` and measured pool TVL at least the chain-specific absolute floor (`$100K` default, `$25K` on configured smaller/pre-mainnet ecosystems); deposit-venue candidates also require the `0.1%` supply-relative floor, and the final resolve-stage pass applies that measured-size rule to every scoped external-opportunity candidate regardless of source path.

**Source-management audit inputs:** the DEX-liquidity job caches a compact DeFiLlama `/protocols` slug/category snapshot under the `defillama-protocols` cache key. The monthly yield coverage audit reuses that cache to annotate protocol recommendations with DeFiLlama category metadata. `high-confidence` allowlist recommendations require both the existing TVL/pool-count shape and a category of Lending, CDP, RWA Lending, or Uncollateralized Lending; missing categories or non-lending categories stay `review-needed`. The 2026-06-09 Wave 2 allowlist additions are category-gated Lending protocols with live single-asset stablecoin pools on smaller/pre-mainnet or app-chain ecosystems; the 2026-06-11 Wave 3 follow-up promoted `bifi` and `fraxlend` from audit-queue evidence, while normal safety, APY, TVL, and source-shape gates still control publication. Speculative non-lending categories were excluded by the same protocol category gate. The monthly audit also re-probes explicit generic `convertToAssets` quarantines through monthly `chainRpcs` when available, emitting restore-readiness metadata and a `quarantine-ready-to-restore` candidate only after a nonzero rate passes the deterministic envelope. The 2026-07-09 lifecycle review kept overdue quarantines and intentional gaps status-neutral when no verified runtime APY path was available, updated their notes with the review disposition, and moved their `nextReviewAt` windows forward.

**Queue-guided allowlist rounds:** Future lending allowlist expansions start from the monthly coverage audit's `operatorQueue.recommendationCandidates` entries with kind `lending-allowlist`. Those candidates are derived from unmatched high-TVL single-exposure stablecoin pools outside the current allowlist, must pass the protocol-category gate for `high-confidence` status, and include DeFiLlama source links, pool examples, promotion metadata, and a suggested `LENDING_PROTOCOLS` snippet anchored near `YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR`. Operators can still review or reject candidates, but broad manual protocol hunting is no longer the default expansion path.

**Chain-specific absolute floor:** the absolute lending-opportunity TVL gate is table-driven through `CHAIN_LENDING_TVL_FLOOR_USD`. The default floor remains `$100K`; Aptos, Berachain, Cardano, Ink, Monad, Plasma, Solana, Stacks, Stellar, and Sui use the configured `$25K` smaller/pre-mainnet floor. The `0.1%` supply-relative gate now applies to every peg currency and every scoped deposit-venue class, including GOLD/SILVER; tracked supply values are USD-denominated. This closes the metal-peg bypass that let a roughly `$2B`-market-cap coin surface on a `$366K` venue and extends the existing v7.0 supply-share rule universally.

**Observable size requirement:** Published `lending-opportunity`, `fixed-yield`, and `structured-tranche` rows require measured venue-level `sourceTvlUsd` and must clear the final size gate. Protocol-native or other source readers that cannot attach measured venue TVL are omitted from published coverage rather than using coin supply or another proxy.

**Explicit venue exclusion:** Even when a pool clears the generic quality gates above, published lending-opportunity suggestions exclude venues whose DeFiLlama `poolMeta` or supplemental source label identifies them as Resolv / `USR`, `stUSR`, or `wstUSR` linked.

**Yield type:** `lending-opportunity` — distinguishes these from native yield coins on the frontend. The direct Aave v3 on-chain supply-rate path uses the same classification so rankings/cache schema validation stays aligned across deterministic and auto-discovered lending rows.

**Data source:** `defillama-auto` — distinguishes from static-mapped `defillama` pools.

**Eligibility evaluated dynamically:** If a coin's safety score drops below 50, it stops receiving auto-discovered yield data. If it rises back to 50 or above, it starts automatically.

**Explicit deterministic edge cases:** `AUTO_LENDING_POOL_MAP` can also pin a small number of exact-symbol, single-asset lending markets for coins that would otherwise be blocked by ambiguous matching or by the generic safety gate. These rows still pass the same pool-shape and source-quality checks; the bypass is coin-specific and documented rather than global.

Current deterministic pins include `usdx-hex-trust`, `reusd-resupply`, `xusd-babelfish`, and `usda-anzens`. `xusd-babelfish` has a coin-specific safety bypass because the tracked asset is Rootstock-only and Sovryn is the canonical Bitcoin-side venue. `reusd-resupply` also has a coin-specific exact-pool bypass because the repaired Pendle row was reviewed while live report-card safety was 49/100, one point below the generic gate. Both bypassed rows still have to pass the normal DeFiLlama shape, APY, and TVL checks. Stale pins such as the former `doc-money-on-chain` and `pmusd-precious-metals` entries are removed rather than bypassed when their current pools no longer clear the standing gates.

**Same-symbol collision blocks:** `AUTO_LENDING_COLLISION_BLOCKLIST` stores coin-specific false-positive guards for pools that are valid DeFiLlama rows but belong to a different tracked asset. The 2026-06-11 audit added guards for cases such as Kava USDX vs Hex Trust USDX, Virtue VUSD vs Monad VUSD, and legacy Nexus/Synapse NUSD vs Neutrl NUSD. These blocks apply before deterministic override resolution and before dynamic same-symbol matching.

**Exact curated venues outside auto-discovery:** `EXPLICIT_YIELD_SOURCE_POOL_MAP` is a separate lane for curated venues that must stay outside the generic stablecoin auto-discovery universe — currently the commodity pins for `xaut-tether` and `paxg-paxos` plus the K3 `sbold-k3-capital` wrapper pool. Unlike `AUTO_LENDING_POOL_MAP`, these rows are not broadening the generic stablecoin discovery universe; they only publish the exact named pool after matching the expected venue metadata.

The monthly coverage audit now treats both `AUTO_LENDING_POOL_MAP` and `EXPLICIT_YIELD_SOURCE_POOL_MAP` as exact covered DeFiLlama surfaces. Its high-TVL gap report intentionally focuses on unsupported protocol families instead of re-flagging already-allowlisted markets that the runtime already supports dynamically. It also verifies deterministic auto-lending overrides against current pool-shape, APY, supply-relative TVL, Safety Score, allowlist, and collision-block gates; failures become `stale-auto-lending-override` headline queue items for operator review. Quarantine re-probe output is advisory: `quarantineReadyToRestore` and `quarantineProbeSummary` identify candidates for manual restoration, but the audit does not mutate hourly source configuration.

---

## Pharos Yield Score (PYS)

Risk-adjusted ranking (0–100) that balances yield magnitude against source risk, stablecoin safety, and consistency.

**Formula (`computePYS()` in `shared/lib/yield-scoring.ts`):**

```
benchmarkSpread     = apy30d - benchmarkRate
effectiveYield      = max(0, apy30d + benchmarkSpread * 0.25)
sourceRiskPenalty   = clamp(sourceRisk.sourceRiskPenalty ?? 1, 1, 2.5)
rowUtility          = effectiveYield / sourceRiskPenalty
riskPenalty         = max(0.5, (101 - safetyScore) / 20)
yieldEfficiency     = rowUtility / (riskPenalty ^ 1.75)
sustainabilityMult  = max(0.3, 1.0 - apyVarianceScore)
PYS                 = clamp(round(yieldEfficiency * sustainabilityMult * scalingFactor), 0, 100)
```

**Components:**

| Component                      | Range                    | Meaning                                                                                                                                                             |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benchmarkRate`                | depends on row           | Row-level benchmark selected from the benchmark registry                                                                                                            |
| `benchmarkSpread`              | unbounded                | `apy30d - benchmarkRate`; positive means the row clears its local benchmark                                                                                         |
| `effectiveYield`               | `>= 0`                   | Raw APY plus 25% of benchmark spread, floored at zero before the safety divisor                                                                                     |
| `sourceRisk.sourceRiskPenalty` | `1–2.5` after resolution | Nested source-risk multiplier derived from measured source evidence. Missing/invalid values are neutral (`1`); values below 1 clamp to 1 and above 2.5 clamp to 2.5 |
| `rowUtility`                   | `>= 0`                   | `effectiveYield / sourceRiskPenalty`, used before the safety curve                                                                                                  |
| `safetyScore`                  | 0–100                    | Report card overall score. `PYS_DEFAULT_SAFETY_SCORE` (40) for unrated coins                                                                                        |
| `riskPenalty`                  | 0.5–5.05                 | Raw safety penalty before the power curve is applied                                                                                                                |
| `riskPenalty^1.75`             | ~0.30–17.01              | Effective divisor used by PYS after the steeper safety curve is applied                                                                                             |
| `apyVarianceScore`             | 0–1 or null              | Coefficient of variation of 30-day APY samples, clamped to [0, 1]. Returns null if < 2 samples or mean ≈ 0 (`abs(mean) < 1e-10`); PYS caller defaults null to 0      |
| `scalingFactor`                | 8                        | Global constant (`PYS_SCALING_FACTOR` in `constants.ts`) tuned after the steeper safety curve                                                                       |

Returns 0 when `apy30d <= 0` or the benchmark-aware `effectiveYield` is non-positive.

The shared scorer exposes the intermediate values (`benchmarkSpread`, `benchmarkAdjustment`, `effectiveYield`, `sourceRiskPenalty`, `rowUtility`, `riskPenalty`, `adjustedRiskPenalty`, `yieldEfficiency`, `sustainabilityMult`). Frontend breakdown components should pass the nested `sourceRisk.sourceRiskPenalty` when they surface v8 source-risk details; the final PYS value is always served by the API.

### Source-Risk, Rank Attribution, and Neutral Policy

Yield v8 exposes optional `sourceRisk` and `rankChangeAttribution` shapes in shared API schemas. PYS and source arbitration consume the nested source-risk penalty; source-board, source-sheet, detail-page, and DEWS consumers can also read populated source-risk and rank-attribution evidence. Missing evidence remains neutral:

- `sourceRisk` may be omitted, `null`, or partially populated on ranking, history, and alt-source rows.
- Public API source-risk fields are nested under `sourceRisk.*` (`sourceRisk.sourceRiskPenalty`, `sourceRisk.rewardShare`, and so on). Do not document or consume flattened public fields such as top-level `sourceRiskPenalty`; calibration scripts that ingest saved payloads must normalize from the nested API contract before analysis.
- `sourceRisk.sourceRiskPenalty` is the active v8 source-risk multiplier. It is derived from reliable `rewardShare`, `sourceDepthRatio`, `sourceAgeSeconds`, `sourceSwitchCount30d`, `observationCount30d`, sourced venue inputs (the `venueRiskWeighted` 1–5 score and its derived `venueRiskTier`), and reviewer-set `dependencyConcentration` where available. Missing, `null`, or invalid evidence is equivalent to a neutral multiplier of `1`; values below 1 clamp to 1 and values above `PYS_MAX_SOURCE_RISK_PENALTY` (`2.5`) clamp to 2.5.
- Frontend source-risk driver labels use the same scoring thresholds: `reward-heavy` when `rewardShare > 0.5`, `thin source depth` when `sourceDepthRatio < 0.001`, `limited history` when `0 < observationCount30d < 7`, and `source changed` when the selected source changed versus the prior published snapshot or `sourceSwitchCount30d > 0`. The `stale source` driver is the exception: it fires on the row's source-family-aware freshness classification (`sourceFreshness === "stale"`), not on the flat `sourceAgeSeconds > 6h` rule that the PYS source-risk penalty uses.
- The `/yield` depth lens is explanatory context, not guaranteed executable capacity. Rows are classified only when both `sourceRisk.sourceDepthRatio` and measured `sourceTvlUsd` are present: `deep` is `>= 1%` of tracked stablecoin supply, `moderate` is `0.1%` to `< 1%`, and `thin` is `< 0.1%`. External-opportunity rows without measured venue TVL are ineligible; native rows without measured venue TVL render `Native · depth n/a` and a muted `Native` marker in the TVL cell (the venue is the asset itself), not `Unknown depth` or a dash. No AUM or coin-supply figure substitutes for venue TVL in display, depth gating, or penalties.
- DeFiLlama rows use the shared DeFiLlama input metadata timestamp/age when an individual resolved row does not carry `sourceObservedAt`, so provenance and PYS source-age penalties are based on the same freshness evidence.
- `sourceRisk.venueRiskTier: "unknown"`, `null`, or omitted means the venue tier has not been sourced. Unknown tier is neutral, not a hidden high-risk default.
- `shared/lib/yield-source-risk-registry.ts` owns the typed `YIELD_RISK_CONFIG` registry of reviewed venues; `worker/src/cron/yield-sync/source-risk.ts` is a runtime facade. Each entry carries five Yearn-style sub-scores — `audits` (20%), `centralization` (30%), `fundsManagement` (30%), `liquidity` (15%), `operational` (5%), each `1..5` with higher = riskier — weighted into a `1..5` venue-risk score. The coarse `venueRiskTier` is DERIVED from that weighted score (`< 2.5` → `low`, `< 3.5` → `medium`, else `high`), not hand-set. The reviewed registry is the source-owned inventory; do not copy its volatile count here. Reviewed scores bind from the DeFiLlama `project` slug on auto-discovered lending rows; unknown or unreviewed venues remain neutral. Review is tied to the monthly yield coverage audit; guessed venue penalties are explicitly out of scope. Each entry carries a `confidence` (`verified` / `partial` / `low`) that is published as `sourceRisk.venueRiskConfidence` and **surfaced, not used to discount the penalty**: an uncertain venue is scored conservatively (uncertainty is treated as risk, mirroring the rubric's "no audit = riskiest" default), and the UI venue-risk chip flags low/partial confidence so the haircut is honest.
- The venue penalty moved from flat buckets to a continuous, calibration-preserving curve `max(0, venueRiskWeighted - 2.0) * 0.15`: weighted `≤ 2.0` → `0` (the legacy `low` no-op is preserved exactly for the blue-chip set), `3.0` → `+0.15` (the legacy `medium`), `4.0` → `+0.30`, `5.0` → `+0.45`. The curve applies only when a venue carries category scores; unscored venues stay neutral, and the legacy tier branch (`high` +0.35 / `medium` +0.15) remains the fallback. The penalty knee (`2.0`) sits intentionally below the low/medium tier cutoff (`2.5`): the tier is a coarse display/DEWS bucket while the penalty is continuous, so a `low`-tier venue scoring `2.0`–`2.5` (e.g. Gearbox, Exactly, Liqwid) is low-but-not-pristine and carries a small proportional penalty (≤ +0.075), while only true blue-chips (≤ `2.0`) are an exact no-op.
- `sourceRisk.dependencyConcentration` is a reviewer-set, stablecoin-id-keyed signal (not auto-derived) capturing cross-venue concentration that per-venue tiering structurally misses. It adds `+0.10` (`medium`) or `+0.20` (`high`) to the source-risk penalty (`low` is a zero-penalty informational severity). The registry is authoritative for the current reviewed set; unseeded coins stay neutral.
- The `yvusdc-yearn` calibration anchor is Yearn's [May 2026 yvUSDC-1 risk report](https://github.com/yearn/risk-score/blob/master/reports/report/yearn-yvusdc.md). Re-review the dependency entry if Yearn materially revises the report, the vault diversifies away from Sky, or the Spark venue scores leave the derived `low` tier. The report is review evidence, not a runtime feed.
- DEWS Yield Anomaly reads the derived `venueRiskTier` directly, so its `structured-medium-risk-venue` (+10) and `structured-high-risk-venue` (+25) branches fire across the reviewed registry as of DEWS v6.09; no DEWS threshold changed.
- `sourceRisk.sourceRiskScore` is the 0–100 display normalization of the resolved source-risk penalty. As of v8.13, when no upstream score is provided, the publisher fills it via `computeSourceRiskScoreFromPenalty` (`penalty = 1.0` → `0`; `penalty = PYS_MAX_SOURCE_RISK_PENALTY` (`2.5`) → `100`). The score is informational and does not change PYS — PYS continues to consume the `sourceRiskPenalty` directly. Rollback compatibility: legacy v7.48 payloads still resolve to a neutral penalty when source-risk is absent, and an explicit upstream `sourceRiskScore` value still wins over derivation.
- `sourceRisk.sourceDepthRatio`, `sourceRisk.rewardShare`, `sourceRisk.sourceAgeSeconds`, `sourceRisk.observationCount30d`, `sourceRisk.sourceSwitchCount30d`, `sourceRisk.deploymentPlace`, `sourceRisk.venueProtocol`, `sourceRisk.venueChain`, and `sourceRisk.investabilityFlags` are populated only when supported by existing rows, provenance, publication-generation evidence, or sourced yield-risk config. Missing precision stays missing instead of being guessed from labels.
- External opportunity rows (`lending-opportunity`, `fixed-yield`, and `structured-tranche`) and native yield source-risk do not modify any V9 Backing, Exit, or Economic Control pillar, cap, score, or grade. They may inform opportunity-level yield risk labels or DEWS yield-anomaly inputs only through explicitly versioned consumer methodology.
- Any future Safety Score impact from yield evidence requires a V9 Safety methodology update and matching structured Safety Score changelog entry before runtime scoring can consume those fields.
- [DEWS methodology](./dews.md) consumes a bounded subset of populated structured yield evidence inside the existing Yield Anomaly sub-signal: reward-heavy rows, thin or stale sources, source switches, high source-risk penalties, reviewed medium/high-risk venue tiers, and rank-attribution drivers for source-risk or source-switch moves. Missing, malformed, or neutral source-risk fields and legacy warning-only rows remain explicit no-ops.

Rollback compatibility is part of the contract. Production-shaped `v7.48` payloads without `publication`, `publishedRank`, `liveRank`, `sourceRisk`, or `rankChangeAttribution` remain valid. With no nested source-risk penalty, v8 resolves the same neutral penalty (`1`) and keeps the benchmark-aware v7 scoring path equivalent.

### Supporting Metrics

| Metric           | Formula                                                                        | Description                                                                                  |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `yieldStability` | `1 - CV(30d samples)`                                                          | 0–1, higher = more consistent. Null if < 2 samples or mean ≈ 0 (`                            | mean | < 1e-10`) |
| `yieldToRisk`    | `apy30d / (101 - safetyScore)`                                                 | Raw yield per unit of risk                                                                   |
| `excessYield`    | `apy30d - benchmarkRate`                                                       | 30-day average APY above the row's selected benchmark                                        |
| `effectiveYield` | `max(0, apy30d + 0.25 * excessYield)`                                          | Benchmark-aware yield term used by PYS before source-risk, safety, and consistency penalties |
| `rowUtility`     | `effectiveYield / sourceRisk.sourceRiskPenalty` after neutral/clamp resolution | Source-risk-adjusted utility term used before the safety penalty                             |
| `apy7d`          | Timestamp-filtered 7d average                                                  | 7-day trailing APY (uses `recorded_at >= now - 7d`, not proportional slicing)                |
| `apy30d`         | Simple average of 30d samples                                                  | 30-day trailing APY                                                                          |
| `variance30d`    | Standard deviation of 30d APY samples                                          | APY volatility measure                                                                       |

---

## Benchmark Registry

Yield Intelligence now uses a small benchmark registry instead of a single global T-bill field.

**Benchmarks currently supported:**

| Key        | Label                            | Primary source                                                                                                           | Notes                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USD`      | USD 3M T-Bill                    | FRED `DGS3MO`, then Treasury.gov yield curve XML                                                                         | Default benchmark and backward-compatible top-level `riskFreeRate`; Treasury.gov is used as a fallback when FRED is unavailable                                                                                                                                                                     |
| `USD_EFFR` | USD effective federal funds rate | New York Fed latest EFFR endpoint, then FRED `DFF`                                                                       | Optional product-specific benchmark for EFFR-linked products such as USDGO; not the default USD hurdle                                                                                                                                                                                              |
| `EUR`      | EUR 3M compounded €STR           | ECB Data API (`EST/B.EU000A2QQF32.CR`)                                                                                   | Native benchmark for EUR pegs; retained-last-market fallback covers feed outages                                                                                                                                                                                                                    |
| `CHF`      | CHF 3M compounded SARON          | SIX delayed `SAR3MC` download                                                                                            | Public feed is delayed by one business day; not labeled as a proxy                                                                                                                                                                                                                                  |
| `GBP`      | GBP 3M compounded SONIA          | FRED graph CSV for SONIA Compounded Index `IUDZOS2`, then ALFRED graph CSV, then Bank of England IADB `IUDZOS2` fallback | Annualized from the trailing 90-day index change; metadata source `fred-sonia-compounded-index` or `alfred-sonia-compounded-index` before the BoE fallback (`boe-sonia-compounded-index`), fallback mode `gbp-sonia-compounded-index-failed`                                                        |
| `JPY`      | JPY overnight call (TONA proxy)  | Bank of Japan Time-Series Data Search `STRDCLUCON`                                                                       | Used as a TONA-equivalent proxy                                                                                                                                                                                                                                                                     |
| `MXN`      | MXN CETES 28d                    | Banxico SIE API (series `SF43936`)                                                                                       | `BANXICO_TOKEN` enables the official Banxico feed; when missing/failing, MXN retains the last market source when available or remains unavailable so rows fall back to USD. Etherfuse CETES current issuance is deliberately limited to the CETES product APY source, not the shared MXN benchmark. |
| `BRL`      | BRL SELIC over                   | BCB SGS API (series `11`)                                                                                                | No auth required; daily percentage annualized over 252 business days before scoring                                                                                                                                                                                                                 |
| `AUD`      | AUD cash-rate target             | Reserve Bank of Australia F1 money-market CSV                                                                            | RBA cash-rate target used as the AUD local cash hurdle                                                                                                                                                                                                                                              |
| `CAD`      | CAD overnight repo (CORRA proxy) | Bank of Canada Valet API (series `V122530`)                                                                              | Overnight repo; CORRA-equivalent                                                                                                                                                                                                                                                                    |
| `RUB`      | RUB CBR key rate                 | Central Bank of Russia DailyInfo `KeyRateXML` SOAP feed                                                                  | Native benchmark for RUB pegs; validation accepts up to 100% so high key-rate regimes are not rejected by the standard 20% ceiling                                                                                                                                                                  |
| `TRY`      | TRY BIST TLREF overnight         | CBRT EVDS (`TP.BISTTLREF.ORAN`)                                                                                          | Native benchmark for TRY pegs; validation accepts up to 100% so Turkish reference-rate regimes are not rejected by the standard 20% ceiling                                                                                                                                                         |
| `SGD`      | SGD SORA (unavailable)           | —                                                                                                                        | Reserved for a future MAS SORA feed; SGD pegs fall back to USD until a stable public source is wired                                                                                                                                                                                                |

**Source URLs:**

```text
https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO
https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json
https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF
https://home.treasury.gov/sites/default/files/interest-rates/yield.xml
https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2QQF32.CR?lastNObservations=5&format=csvdata
https://indexdata.six-group.com/pro/oauth/token
https://indexdata.six-group.com/pro/api/report-download
https://indexdata.six-group.com/download/saron/h_sar3mc_delayed.csv
https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp
https://www.stat-search.boj.or.jp/api/v1/getDataCode
https://www.rba.gov.au/statistics/tables/csv/f1-data.csv
https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43936/datos/oportuno
https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/1?formato=json
https://www.bankofcanada.ca/valet/observations/V122530/json?recent=1
https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx
https://evds3.tcmb.gov.tr/igmevdsms-dis/fe
https://fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2
https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2
```

**Stored as:** `cache` table, key `"risk_free_rates"`, with the legacy USD-only key `"risk_free_rate"` still written for compatibility.

**Fallback:** `RISK_FREE_RATE_FALLBACK = 3.75%` applies to USD only. Other benchmarks prefer a retained last-known source-backed value when available; otherwise they remain unavailable and rows fall back to USD when selection requires it. MXN does not use issuer-controlled product pages as benchmark fallbacks.

**Tokenized-treasury benchmark overrides:** Some rate-derived treasury-like products tokenize the same instrument as their local benchmark, which can compress excess-yield and PYS context toward zero. `benchmarkOverrideKey` lets a rate-derived row compute APY from its configured product benchmark while comparing PYS/excess-yield against an explicit benchmark hurdle. USD T-bill/MMF-style proxies use `USD_EFFR` as the comparison hurdle; EUTBL and UKTBL carry explicit same-currency override keys. CETES still uses its protocol-native issuance adapter plus the MXN CETES benchmark path, so CETES-specific override policy remains a separate future decision.

**Currencies still falling back to USD:** AED, IDR, ZAR, SGD (and any other peg currency not listed above). These remain as `benchmarkSelectionMode: "fallback-usd"` until a stable public feed is wired for each.

**Selection rules:**

- USD is the default benchmark for the stack and remains the top-level `riskFreeRate` / `provenance.benchmark`
- Yield rows switch to a peg-native benchmark when the stablecoin's benchmark currency is supported
- Rate-derived configs can explicitly override the benchmark key when the asset's benchmark should differ from the peg currency
- When a native benchmark is unavailable, the row falls back to USD and records `benchmarkSelectionMode: "fallback-usd"`

**Usage:** The hourly core yield sync resolves `excessYield` from 30-day average APY and rate-derived APY against each row's selected benchmark. Detail cards, hero chips, and history charts render that row-level label. The `/yield` scatter plot always keeps a benchmark frame visible: homogeneous scopes use the shared visible benchmark, while mixed scopes use the default USD benchmark as an orientation frame and rely on row-level tags for the exact hurdle. The plot renders the full filter-visible ranking universe; APY outlier capping changes only vertical placement and never removes opportunities.

---

## Warning Signals (Phase 2)

`yield-helpers.ts::detectWarningSignals()` runs in the sync cron and stores baseline results in the `warning_signals` column of `yield_data`. Rankings responses also add a read-time freshness signal. Frontend-visible warning keys are:

| Signal             | Condition                                                                                                                                                                                                                                                                                                          | Meaning                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `yield-spike`      | `currentApy > 2% AND currentApy / apy30d > 2.0`                                                                                                                                                                                                                                                                    | Sudden 2× jump vs. 30d average (absolute floor: 2% APY)                             |
| `yield-divergence` | `currentApy > medianApy * 3`                                                                                                                                                                                                                                                                                       | 3× the market median                                                                |
| `negative-trend`   | `apy30d > 1% AND currentApy < apy30d * 0.7`                                                                                                                                                                                                                                                                        | 30% decline from average (absolute floor: 1% baseline)                              |
| `reward-heavy`     | `apyReward / apy > 0.8`                                                                                                                                                                                                                                                                                            | 80%+ from incentives, not base yield                                                |
| `tvl-outflow`      | TVL dropped > 20% from prev week                                                                                                                                                                                                                                                                                   | Capital leaving the protocol                                                        |
| `zero-yield`       | `currentApy === 0 AND apy30d > 0.5%`                                                                                                                                                                                                                                                                               | Yield dropped to zero but had recent activity                                       |
| `data-stale`       | Hourly source families are older than 3 `sync-yield-data` intervals (currently 180 min); supplemental Aave/Compound + protocol-API rows are older than 6 hours, except Hashnote USYC, Midas mMEV, and Re Protocol reUSD observations accepted through 72 hours; `price-derived` rows are older than 36 hours; `rate-derived` rows are older than 48 hours; ordinary comparison anchors are older than 14 days; price-derived and Midas/Ondo NAV anchors are older than 45 days | Yield data or its APY comparison anchor is older than the source's expected cadence/window |

All frontend surfaces (leaderboard, detail section, history chart) format warning signals via the shared `formatYieldWarningSignal()` function in `src/lib/yield-constants.ts`, which maps known signal keys to human-readable labels and falls back to hyphen-to-space conversion for unknown signals.

At rankings cache-build time, `sync-yield-data` decorates rows with the read-time-only `data-stale` signal when the resolved source observation or its comparison anchor exceeds the source-aware window. Hourly publication families use the shared three-interval threshold (currently 180 minutes; `STALE_THRESHOLD_MS`), supplemental protocol-API and optional Aave/Compound rows use 6 hours (`SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS`), and the exact Hashnote USYC, Midas mMEV NAV, and Re Protocol reUSD source keys use the same 72-hour acceptance window enforced by their adapters (`SLOW_NAV_SOURCE_STALE_THRESHOLD_MS`). Price-derived source observations use 36 hours (`PRICE_DERIVED_STALE_THRESHOLD_MS`), and rate-derived rows use 48 hours (`RATE_DERIVED_STALE_THRESHOLD_MS`) because the benchmark producer is daily. Ordinary exchange-rate comparison anchors use 14 days (`COMPARISON_ANCHOR_STALE_THRESHOLD_MS`); price-derived plus the Midas mMEV and Ondo USDY NAV-oracle rows use 45 days (`LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS`) because those adapters deliberately choose anchors from a 7-45 day window. The signal is included in cached rankings responses but is not written back to `yield_data`.

The sync also records comparison-anchor freshness under `sourceCoverage.comparisonAnchorFreshness`. The summary includes the anchored row count, stale anchor count, oldest stale anchor age/source, bounded stale examples with each source's `maxAgeSeconds`, and a truncation flag. Publication metadata additionally records `sourceCoverage.previousPublishedRankingCount` and `sourceCoverage.publishedRankingCountDelta`; severe coverage-regression guards emit the same ranking-count fields at top level before normal source coverage is assembled. `/api/status` exposes both shapes as `yieldHealth.previousRankingCount` and `yieldHealth.rankingCountDelta` so operators can see coverage growth or shrinkage without manually comparing payloads. These summaries are observability-only: stale-anchor warnings still follow the read-time `data-stale` rules above, and the freshness/ranking-delta metadata does not change source arbitration or scoring.

The sync also performs a confidence-aware cross-source arbitration pass before `is_best` is chosen:

- deterministic sources (`onchain`, `rate-derived`) outrank curated protocol-native and DeFiLlama rows
- curated DeFiLlama rows outrank discovered lending opportunities and fallback-derived rows
- non-positive APY rows cannot outrank positive rows
- within the same confidence tier, arbitration compares source-risk-adjusted row utility (`effectiveYield / sourceRiskPenalty`) after source-risk penalty resolution before falling back to raw current APY
- materially divergent discovered or fallback rows can be rejected when a higher-confidence canonical source disagrees by more than 35%
- a `canonical-zero-vs-positive` anomaly is flagged when a high-confidence source reads 0% but a lower-confidence source reports > 1% APY

This selection behavior is surfaced in row-level `provenance` metadata on `/api/yield-rankings`.

---

## Engineering Contract

The methodology above is the durable public contract. Runtime topology, storage details, and incident procedures remain source-owned so this document does not mirror implementation inventories.

### Persistence And Publication

- `worker/migrations/0000_baseline.sql`, later yield migrations, and `worker/migrations/MANIFEST.md` own the D1 schema.
- `yield_data` stores the current multi-source snapshot; `yield_history` stores recent source-aware observations and publish-time scoring evidence, while `yield_history_daily` stores the last published point per stablecoin/source/UTC day for the older public window.
- `yield_publication_generations` and `yield_source_decisions` record publication state and bounded source-selection evidence. Repeated unchanged anomaly evidence is 30-day audit data; source switches and anomaly-episode boundaries remain durable.
- Public rankings expose only a validated published generation. Failed validation, stale-writer, or publication attempts leave the previous public snapshot intact.
- The final resolve-stage eligibility pass removes null, non-finite, or thin measured venue-TVL candidates in the three deposit-venue classes before evaluation and arbitration, across tracked, explicit, auto-discovered, supplemental, and linked-variant paths. Only eligible candidates can reach a validated published generation.
- History retention is enforced by the producer. Legacy rows remain explicitly partial rather than receiving invented evidence.

### Producers And Consumers

| Surface | Owner |
| --- | --- |
| Yield resolution and publication | `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/` |
| Optional slower source families | `worker/src/cron/sync-yield-supplemental.ts` |
| Benchmark registry | `worker/src/cron/fetch-tbill-rate.ts` |
| Source configuration and scoring helpers | `worker/src/lib/yield-config/yield-config.ts`, `worker/src/cron/yield-helpers.ts` |
| Rankings and history APIs | `worker/src/api/cache-handlers.ts`, `worker/src/api/yield-history.ts` |
| Shared wire types | `shared/types/index.ts` |
| Frontend queries and formatting | `src/hooks/api-hooks.ts`, `src/lib/yield-constants.ts` |
| Yield workbench and per-coin analysis | `src/app/yield/`, `src/app/stablecoin/[id]/yield/` |

Schedules are owned by `worker/wrangler.toml`, `shared/lib/cron-jobs.ts`, and `shared/lib/scheduled-runner-registry.ts`. Exact HTTP schemas are owned by [API Reference](./api-reference.md). Operational thresholds, queue handling, failure semantics, and recovery procedures live in [Yield Intelligence Operations](./yield-intelligence-operations.md) and its linked operator guides.

### Failure Semantics

- Missing history produces an explicitly immature or not-rated result; the pipeline does not fabricate trailing observations.
- Unrated assets use the documented conservative safety fallback and remain visibly marked.
- Failed source resolution omits the row from publication rather than inventing an APY; deposit-venue rows with null, non-finite, or thin measured venue TVL are removed rather than estimated or substituted with coin supply.
- Negative APY remains valid input; non-positive trailing APY produces a zero PYS.
- A circuit-broken provider removes only that source family. Independent tiers may still publish.
- Trailing windows are timestamp-based, so cron gaps do not shift their boundaries.
- Live safety hydration accepts ordinary newer report-card input/publication generations only when the V9 publication model, schema, methodology/policy identity, and evaluation-build digest still match, then recomputes safety-derived row fields and ordering against that live snapshot.
- Missing, incomplete, or evaluation-incompatible live safety hydration falls back to the cached payload's own publish-time safety values — coherent by construction, published unchanged with `yield-safety-hydration-stale` and `liveSafetyHydration.fallback: "publish-time-snapshot"` — for up to the 24-hour stale-coherent window (`shared/lib/yield-safety-fallback.ts`). Safety-derived public fields are cleared to explicit NR only when the payload carries no stamped safety identity or the fallback ages past that window; both variants preserve the immutable hourly snapshot provenance.
- Malformed persisted warning payloads decode to an empty warning list so one row cannot fail an endpoint.

### Presentation Boundaries

- Leaderboard rows keep a fixed visual budget: confidence, freshness, and warning/source-risk severity. Additional evidence belongs in the expanded panel or detail page.
- The stablecoin detail section is an at-a-glance summary; `/stablecoin/<id>/yield/` is the history-first workbench. The two surfaces must not duplicate whole panels.
- Deep-link workbenches are runtime analysis surfaces and remain `noindex`; `/yield/` and stablecoin detail pages are the indexable surfaces.
- PYS factor attribution neutralizes one factor at a time and recomputes PYS. Per-factor deltas are explanatory and need not sum to the final score.

### Validation

After methodology, source, schema, or public-contract changes, run the focused tests for the touched source family plus:

```bash
npm run check:doc-sync
npm run check:doc-source-paths
npm run check:verified-doc-links
npm run check:cron-sync
npm run check:cron-connections
```

The structured methodology history lives in `shared/data/methodology-changelogs/yield-methodology/`.
