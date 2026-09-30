# Yield Intelligence

Risk-adjusted yield tracking and ranking for yield-bearing stablecoins and curated lending opportunities. Computes APY from deterministic on-chain reads, curated DeFiLlama pools, protocol-native yield APIs, price history, and benchmark-derived fallbacks; scores each coin via the Pharos Yield Score (PYS); and serves a dedicated `/yield` page plus a stablecoin-detail yield section. That detail section now renders for any asset with a live published ranking row, even when the coin itself is not statically marked `yieldBearing` (for example USDC/USDT lending opportunities or XAUT's curated Yo Protocol venue).

> **Agent navigation** — Grep the heading you need: Methodology Versioning · Tracked Coins · Source-Aware APY Resolution · Pharos Yield Score (PYS) · Benchmark Registry · Warning Signals · Engineering Contract.

---

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-yield-methodology -->`v8.46`<!-- GENERATED-END: methodology-version-yield-methodology -->
- **Public changelog page:** `/methodology/yield-changelog/`
- **Canonical source:** `shared/lib/methodology-versions/registry.ts`

Yield versions are bumped when APY source resolution, source arbitration, history semantics, PYS scoring logic, or score-affecting publication rules change.

Detailed release history lives under `shared/data/methodology-changelogs/yield-methodology/` and is rendered at `/methodology/yield-changelog/`. Keep version deltas in that structured source rather than duplicating them in this methodology reference.

The current scoring contract is:

- Fresh rows publish `calculationMode`, `evidenceClass`, `evidenceCompleteness`, and `scoreQualification`. Direct complete evidence can be exact; modeled/fallback or incomplete noncritical evidence is qualified rather than presented as exact. Benchmark and reference-benchmark freshness gates change `scoreQualification` (exact → estimated, or NR) without changing the seven-field `evidenceCompleteness` denominator.
- Fresh rows using the conservative `40 / NR` safety fallback may retain an estimated PYS with `safety-unrated`; an unavailable common safety snapshot is a different condition and withholds scoring. Missing critical opportunity evidence produces NR and `opportunity-evidence-missing`, not an estimated score, while leaving an otherwise eligible row publishable. Unknown/stale source freshness and stale benchmarks also produce null PYS. A degraded USD reference makes affected non-USD rows estimated with `reference-benchmark-degraded`; a stale reference makes them NR (`benchmark-stale`). Missing variance or invalid score inputs withhold PYS independently of source eligibility.
- `sourceRisk.observationCount30d` counts distinct UTC observation days, including the current publication day. Limited-history treatment remains active until seven distinct days are represented.
- External `lending-opportunity`, `fixed-yield`, and `structured-tranche` rows publish source-keyed `sourceRisk.opportunityRisk` evidence without changing the underlying stablecoin's Report Card.
- When the Royco Dawn tranche model or the external-opportunity assessment supplies a row's `safetyScore` / `safetyGrade`, the row publishes `provenance.safetyProvenance: "opportunity-safety"`. That grade is **not** Safety Score V9. Every surface that renders it labels it as opportunity-derived from `shared/lib/yield-opportunity-provenance.ts`: the leaderboard and instrument board mark the badge and carry the explanation in its title and screen-reader label, the leaderboard CSV adds a `Safety provenance` column, and the Picker records `MergedRow.safetyProvenance`, folds it into the dataset hash, and names it in the shortlist card's authored explanation.
- Freshness eligibility is applied before confidence arbitration. Expired candidates stay auditable, and every benchmark key is assessed independently against both a 48-hour fetch TTL and its own observation-age bound (`YIELD_BENCHMARK_RECORD_MAX_AGE_SEC` in `shared/lib/yield-benchmark-freshness.ts`: 5 days for daily/overnight series, 7 days CHF, 10 days TRY, 12 days RUB, 45 days CAD). Either expired bound makes evidence stale; a fresh fetch cannot renew an old observation. Producer guards, registry health, write/read evaluation, and frontend explanations share this policy. The USD reference used by the v8.43 rebase is gated by the same classifier.
- A final resolve-stage eligibility pass runs after linked-variant projection and before evaluation/arbitration. It removes every `lending-opportunity`, `fixed-yield`, and `structured-tranche` candidate whose tracked stablecoin supply is unavailable, or whose measured `sourceTvlUsd` is null, non-finite, or below `max(chain absolute floor, 0.1% of current tracked supply)`, across tracked, explicit, auto-discovered, supplemental, and linked-variant paths. Unlike the discovery-time size gate, this pass never admits on the absolute floor alone. Structured-tranche rows additionally retain Royco's bespoke market/vault floors.
- Source roles and effective yield types are assigned at construction, before the final size gate. Own-symbol yield-bearing NAV receipts on tracked chains retain their catalog holder identity; projecting that return onto a parent creates a deposit opportunity, not passive parent-token yield.
- `scoreQualified` describes evidence qualification (`scoreQualification !== "NR"`), not whether a numeric score exists. A source can have qualified evidence yet no PYS because its APY, effective yield, scaling, or variance is unavailable or ineligible; use `pharosYieldScore` and `pysNullReason` for score availability.

Source ownership, projection, provider order, publication guards, and compatibility behavior are documented in the sections below.
---

## Tracked Coins

Every stablecoin with `flags.yieldBearing: true` in `shared/lib/stablecoins/registry.ts` is inventoried by the yield manifest. Live cron resolution operates on the active subset (`status !== "pre-launch"`), while pre-launch or intentionally uncovered assets remain visible to operators through explicit manifest entries instead of silently disappearing from coverage accounting. Pre-launch status is declared in the asset's per-coin file under `shared/data/stablecoins/coins/*.json`, loaded through `shared/data/stablecoins/coins.generated.json`, and skipped by explicit lending override publication until the per-coin entry moves into the active lifecycle. The sync also supports deterministic custom sources for select non-yield-bearing coins, exact-pool curated overrides for select non-stablecoin assets, plus automatic lending pool discovery for tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), including coins already flagged `yieldBearing`. `yieldConfig` is used when present to provide canonical source/type labels; auto-discovered lending rows synthesize protocol-derived labels when the source is `defillama-auto`. Tracked savings wrappers own their own runtime pool/on-chain readers and history. When a tracked wrapper has a live native/wrapper yield source, the publisher may also expose that source on the active parent stablecoin with a `linked-variant:<variantId>:<sourceKey>` key for comparison and coverage context; this does not mark the parent `yieldBearing` purely because the wrapper exists, and external opportunity rows (`lending-opportunity`, `fixed-yield`, or `structured-tranche`) are not projected from variants to parents.

Open USD (`ousd-open-standard`) is not a holder-yield asset: the [issuer reserve page](https://reserves.bridge.xyz/ousd) describes underlying earnings shared with participating platforms, not an on-chain holder return. The 2026-09-30 report-only coverage audit found no Open USD gap, so no `INTENTIONAL_GAP_REASONS` entry is needed. Origin Dollar's `OUSD` native pool remains pinned to `ousd-origin-protocol`; generic yield matching requires exact address evidence or an unambiguous chain-scoped symbol and cannot transfer that native source to Open USD. Revisit if a public holder-return instrument or an identity-bound lending market appears.

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

Invalid inputs or overflowed annualization return an explicit unavailable result with a named rejection reason; they do not become a 0% observation or a new history anchor. A genuine unchanged exchange rate still measures 0%.

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

This keeps configured wrapper pools like `fxSAVE` eligible even when DeFiLlama marks them `stablecoin: false`, and it also preserves exact curated non-stablecoin venues such as XAUT's isolated Yo Protocol market.

**Layer 1 — Static map:** `YIELD_POOL_MAP` maps Pharos ID to a DL pool UUID. Filters for `exposure === "single"` and identifies the native/primary yield source. A missing pinned UUID fails closed for that native mapping; it cannot borrow a generic venue's APY under the native label. Dead-pin diagnostics retain `missing-pool`. Independent configured source tiers may still resolve.

2026-05-22 source corrections: `usdn-smardex` now uses the exact SMARDEX USDN DeFiLlama single-exposure pool after its `navToken` flag was corrected to false. `a7a5-old-vector` was initially represented as an intentional yield gap, then gained RUB key-rate-derived coverage in v8.291. On 2026-07-15, base AZND was corrected to a fixed-peg non-NAV token and its configured yield type was moved to the exact loAZND wrapper path, preventing base-token market prices from being annualized as vault yield.

**Layer 2 — Variant map:** `YIELD_VARIANT_MAP` maps to a wrapper/savings pool symbol and can also pin the wrapper chain, address, and preferred DeFiLlama project. Resolution prefers configured address identity, and only falls back to symbol when address evidence is absent and the chain-scoped match is unambiguous. Supplied contradictory address evidence fails closed rather than reverting to the ticker. Filters for `exposure === "single"` only (stablecoin flag intentionally relaxed, since savings wrappers like fxSAVE are not flagged `stablecoin = true` in DeFiLlama).

Same-chain, same-symbol receipt ambiguity requires a curated UUID rather than choosing maximum TVL. Native pins include steakUSDT, steakUSDC (the verified V1 receipt), and sDOLA; the frozen msY asset has no native pin. USYC uses its verified Ethereum `circle-usyc` pool, and VBILL uses the BSC native fund pool reporting distributed holder yield. srUSDe uses Strata's native senior receipt pool `843be062-d836-43ef-9670-c78d6ecb60bf`; USTB uses its Ethereum issuer-fund pool `1910847a-f8b5-40ce-a1ab-1dafdded5fbb`, not a collateral market or bridged venue. Runtime pool configuration is authoritative; the unused catalog `yieldConfig.defiLlamaPoolId` field has been removed. A supplied underlying address that contradicts the tracked contract also blocks Layer 3 ticker fallback.

**Layer 3 — Base-symbol fallback:** Used only when both static maps miss and the coin has no Tier-1 on-chain rate config (a configured on-chain rate already measures the coin's intrinsic yield, so a symbol guess could only add a third-party venue; the skip holds even when that run's read fails). Address-corroborated candidates must also have the tracked instrument's exact normalized symbol and no same-chain same-symbol ambiguity. An underlying-address match alone establishes a deposit asset, never receipt ownership: differently named tranches stay in the supplemental opportunity lane, so Royco's senior tranche cannot become apyUSD native holder yield. When corroborating address evidence is unavailable, only an unambiguous exact-symbol candidate is eligible; supplied contradictory addresses fail closed. Symbols shorter than 4 characters are excluded from fallback matching. Filters require `exposure === "single"` and `stablecoin === true`, and exclude yield-tokenization markets (`pendle-v2`, `spectra-v2`): their PT implied APY and market TVL are not the wrapper's native return. Pendle markets publish separately as `fixed-yield` protocol-API rows. Ambiguous fallback candidates are dropped instead of guessed.

**Exact weighted pool groups:** `YIELD_WEIGHTED_POOL_GROUPS` can collapse multiple exact DeFiLlama pool UUIDs into one TVL-weighted APY row when Pharos tracks one protocol asset but the yield wrapper is deployed as chain-isolated, non-fungible vaults. This is currently used for `sdusd-dtrinity`, where Ethereum and Fraxtal sdUSD dStake pools publish under one synthetic DeFiLlama source key.

Total, base, and reward APY use the same complete admitted TVL universe. Before aggregation, a missing pool reward is proven zero only when its finite base APY is at least its total APY (the shared A9 rule). If any constituent component is still unresolved, that aggregate component is null; total APY and full measured TVL remain available. A small incentivized pool's reward APY is never reweighted onto the whole group.

Ethereum Frankencoin Savings is an exact external `lending-opportunity` for ZCHF, reachable without `flags.yieldBearing`. A non-rejected curated explicit pool takes precedence over auto-discovered candidates of the same asset and yield type, including an incumbent: Ethereum savings wins over Gnosis, which remains an alternative. Plain ZCHF holdings do not earn the savings APY. K3 sBOLD's raw Liquity Stability Pool mapping is quarantined because measured holder exchange-rate returns materially diverged from the pool APY over matched 7-day and 30-day windows. HedgeCore sUSD's Venus mapping is also quarantined and recorded as an intentional source gap. Its on-chain `convertToAssets`, `exchangeRateStored`, and `totalAssets` interfaces reverted in the 2026-09-27 review; the issuer's documented 93% Venus-yield pass-through is not measured holder-return equivalence. The earlier decision to keep the gross Venus quote was reversed; no fee-adjusted approximation substitutes for holder evidence.

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

This tier can carry wrapper-over-wrapper native sources when the upstream venue measures the managed wrapper's own return. Yearn `yBOLD` and K3 `sBOLD` own their first-party holder paths directly, including sBOLD's K3-specific Yearn/Kong supplemental source. Base BOLD does not inherit that holder identity: it publishes its own deterministic Liquity V2 Stability Pool aggregate, with wrapper projections retained only as external opportunities. Quarantining sBOLD's raw-pool mapping is a source correction, not a coverage removal; sBOLD also remains eligible for price-derived fallback.

Royco Dawn markets also live in this tier. The supplemental source lane reads the Dawn market explorer API and emits separate `structured-tranche` rows for the senior and junior vaults in each verified market above the local Royco TVL floor. Rows use the stable source keys `royco-dawn:<chainId>:<marketId>:senior` and `royco-dawn:<chainId>:<marketId>:junior`; the tranche share tokens are not added to the stablecoin registry. Identity resolution maps the Royco deposit token back to a tracked underlying stablecoin by chain/address first, with configured wrapper-variant addresses such as Neutrl `sNUSD` attached to their tracked parent when the wrapper is not a first-class stablecoin row.

Pendle supplemental PT markets also live in this tier. The Pendle REST reader emits active stable-category principal-token markets as `fixed-yield` protocol-API rows using implied APY, the PT market address as `sourcePool`, and source keys shaped as `protocol-api:pendle:<chain>:<marketAddress>`. Identity resolution keeps the PT market's underlying asset symbol/address for stablecoin matching. These rows are external opportunity alternatives: they can attach to the matched underlying stablecoin for comparison, but they do not replace native holder-yield rows or project through variant inheritance.

Supplied token addresses are authoritative in protocol-native identity resolution: an unresolved address never falls back to a unique ticker. In particular, Axis USDx Pendle markets cannot attach to Hex Trust USDX.

Source links resolve instrument keys before protocol labels or issuer fallbacks. Valid DeFiLlama UUIDs link to the individual pool unless a configured pool-specific or pinned native deep link exists; validated linked variants use child ownership. Weighted aggregates link to the owning application, never a fabricated pool. Pendle keys resolve to the market's PT swap page with chain context. Ethereum Frankencoin Savings links to `https://app.frankencoin.com/savings?chain=ethereum`; Gnosis links to its own DeFiLlama pool. Non-pool sources retain protocol/issuer fallbacks.

External `lending-opportunity`, `fixed-yield`, and `structured-tranche` rows undergo the final resolve-stage size gate: `sourceTvlUsd` must be measured and must clear the higher of the chain-specific absolute floor and `0.1%` of the tracked stablecoin's current supply. The pass covers tracked, explicit, auto-discovered, supplemental, and linked-variant candidates; null or non-finite TVL is ineligible, and structured-tranche floors augment Royco's bespoke market/vault floors. Published lending-opportunity suggestions additionally exclude venues whose DeFiLlama `poolMeta` or supplemental source label identifies them as Resolv / `USR`, `stUSR`, or `wstUSR` linked. Native holder-yield rows remain in the broader inventory and are not subject to this external-opportunity rule; any row carrying one of the three scoped yield types is subject regardless of source family.
All supplemental candidates pass the shared `PYS_APY_SANITY_MAX = 300` envelope before cache publication and again when the cache is read. Over-envelope rows are rejected and counted separately from malformed rows.

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
- Rankable candidates require a parseable upstream observation timestamp no later than assessment time and no older than the six-hour supplemental budget. Missing or invalid timestamps never become run time; rejected entries remain audit-only.
- The adapter applies TVL, APY, active/corruption/warning, vault-score, and local credit-budget gates before writing cache candidates. Its monthly ledger reserves the full run allowance before provider calls; if that reservation expires before finalization, the full reserved amount is conservatively charged to month-to-date estimated usage before a successor can claim credits, preventing a crashed run from silently undercounting quota consumption.
- Source keys are stable as `protocol-api:vaults-fyi:<chain>:<vault>`. The row `project` and `sourceRisk.venueProtocol` use the underlying protocol slug from vaults.fyi when available.
- Provider telemetry exposes `pageCapReached` and `creditCapReached` so expected bounded probes are distinguishable from provider errors.
- Provider quota/errors remain optional-source failures and do not make the post-V9 publisher require vaults.fyi. Configuration controls fail closed: an enabled source requires D1-backed circuit and credit accounting before any provider call, and a wholly malformed allowlist retains the previous family snapshot instead of publishing an empty replacement.

Supplemental discovery isolates ordinary per-target failures while preserving bounded family publication. Morpho splits tracked symbol filters into batches of at most 100 (the public GraphQL limit), paginates each batch independently, and keeps the existing overall request deadline. Aave refreshes the verified Ethereum USDC, Arbitrum USDT, and Base USDC reserves plus three rotating tracked-contract targets, in two batches of at most three inside the 28-second family deadline. Successful generations replace the family snapshot rather than accumulating old windows or refreshing their timestamps. Successful targets publish when a strict majority resolves; budget exhaustion, systemic zero-resolution, or at least 50% misses retains the previous family snapshot. Long-tail probes do not imply a listed reserve or continuous coverage.

Royco Dawn uses the official `/api/v1/ecosystem/explore` directory with one-based pagination, admits only verified `marketv2` entries, and fetches `/api/v1/market/info/{chainId}/{marketId}` for each market's USD TVL and full tranche-risk evidence in batches of at most three. The directory's native-NAV amounts and Day markets are not admitted through the Dawn adapter. Missing, future, or stale APY evidence skips only the affected tranche; a failed detail read or exhausted family budget is reported explicitly without discarding healthy candidates already collected.

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

For `navToken` coins or explicit `PRICE_DERIVED_FALLBACK_IDS` only when the catalog explicitly identifies `nav-appreciation` or `lending-vault`, the peg benchmark mapping is USD or absent, and no intentional holder-return gap applies. Derives APY from USD price appreciation in `supply_history` using the oldest available anchor between 7 and 45 days. Manifest price-derived strategies describe this eligible estimate, not every NAV flag or historical fallback ID.

```
apy = ((price_now / price_anchor) ^ (365.25 / lookbackDays) - 1) * 100
```

Zero new API calls — reuses cached price data. Falls through if no price history exists or if the coin has fewer than 7 days of priced history.

The same 300% deterministic APY sanity envelope applies to price-derived rows. A transient price spike, token migration, or one-off NAV correction above that envelope returns no price-derived source instead of publishing a headline APY or displacing a sane curated source.

**Tier 3 as additional source:** For eligible coins, Tier 3 also runs when Tier 2 found sources but they all report 0% APY. The price-derived source is added alongside the DL source, and `is_best` is decided by confidence-weighted arbitration — never by raw APY alone or by promoting a rejected candidate as a least-bad fallback.

**Known limitation:** USD price drift cannot measure EUR-native return, distributed rewards, or rebasing yield. bC3M, stkGHO, and USDB therefore have no price-derived holder-return coverage; intentional gaps stay unavailable until a reviewed return source exists. Dividend-distributing products use an explicit native pool or a reviewed rate-derived proxy instead; VBILL is pinned to its native fund pool.

### Tier 4: Rate-Derived APY

For dividend-distributing tokens (maintain $1.00 NAV, pay yield as new token mints), rebase proxies, and T-bill-backed funds whose yield mechanically tracks short-term rates. Configured via `RATE_DERIVED_CONFIGS` in `worker/src/lib/yield-config/yield-config.ts`.

```
apy = max(0, benchmarkRate - spreadBps / 100)
```

Uses the structured benchmark cache refreshed daily by `fetch-tbill-rate`. USD defaults to the 3-month Treasury yield (`DGS3MO`), but the resolver can switch to a peg-native or product-specific benchmark when one exists. EUR rows use the ECB's official 3-month compounded €STR series. CHF rows use delayed public `SAR3MC` (3-month compounded SARON) from SIX. RUB rows use the Central Bank of Russia key rate from the DailyInfo `KeyRateXML` SOAP feed. TRY rows use CBRT EVDS BIST TLREF (`TP.BISTTLREF.ORAN`). USDGO uses `USD_EFFR`, sourced first from the New York Fed EFFR endpoint and then FRED DFF, because OSL's public material describes the product against the Effective Federal Funds Rate net of fees. Rate-derived configs can also set `benchmarkOverrideKey`: APY is still computed from the configured product benchmark, but PYS/excess-yield benchmark selection and provenance use the override. USD tokenized T-bill/MMF-style proxies use this to compare against `USD_EFFR`; EUR and GBP treasury proxies carry explicit same-currency override keys; A7A5 uses `RUB` for both APY derivation and PYS/excess-yield provenance. If a benchmark fetch fails, the cron retains the last known market benchmark when available and marks provenance as degraded instead of immediately snapping back to the hardcoded default. Because the public SIX compound-rate file is delayed, CHF benchmark `recordDate` can trail the fetch date by one business day even on a healthy run.

Product-input freshness is assessed independently of the comparison hurdle. A fresh EFFR comparison cannot refresh a stale USD T-bill input used to derive USTBL, Noble USDN, Solayer sUSD, FUSD, or cgUSD APY. Retained market evidence remains degraded, missing observation time stays missing, and stale product evidence prevents scoring. A hardcoded fallback with no last market rate cannot produce a product APY candidate; healthy benchmark-minus-spread arithmetic is unchanged. Invalid benchmark-registry readability remains visible as `yield-benchmarks:registry-invalid` input quality.

The configured dependency resolver is shared by source resolution, evaluation, and both live-safety and preserved-safety API reads. USDGO consumes EFFR for both product and hurdle, so a USD T-bill outage alone does not stale its source or withhold its score. Non-USD products independently require the USD normalization reference: a stale USD reference with a healthy EUR product yields `benchmark-stale`, not `source-stale`. A stale product yields `source-stale`; an independently stale comparison hurdle yields `benchmark-stale`. Retained product or normalization evidence carries `reference-benchmark-degraded`; healthy arithmetic is unchanged.

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
VBILL is not rate-derived: its verified BSC DeFiLlama native fund pool reports distributed holder yield. Its NAV metadata is not permission to annualize USD price drift as that return.

Rate-derived runs after Tier 3 in the resolution loop and participates in the `is_best` selection like any other source, under the same confidence-weighted arbitration (deterministic rows rank ahead of fallback-derived rows; a rejected candidate is skipped, so the coin can publish no `is_best` row for that generation rather than a least-bad one).

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
| 2026-09-23 drain (audit-queue lending promotions)         | sky-lending, justlend-v1, accountable, pareto-credit, inverse-finance-firm, segment-finance, save                                                       |

**Discovery logic:** Filters DL pools by `exposure === "single"`, `stablecoin === true`, project in allowlist, and reserved-pool exclusion. Resolution prefers underlying-token address matches over symbol matches. Symbol-only matching is allowed only when the coin remains unambiguous after chain scoping; otherwise the candidate is dropped. Current quality gates require `apy >= 0.1` and measured pool TVL at least the chain-specific absolute floor (`$100K` default, `$25K` on configured smaller/pre-mainnet ecosystems); deposit-venue candidates also require the `0.1%` supply-relative floor, and the final resolve-stage pass applies that measured-size rule to every scoped external-opportunity candidate regardless of source path.
**Source-management audit inputs:** the DEX-liquidity job caches a compact DeFiLlama `/protocols` slug/category snapshot under the `defillama-protocols` cache key. The monthly yield coverage audit reuses that cache to annotate protocol recommendations with DeFiLlama category metadata. `high-confidence` allowlist recommendations require both the existing TVL/pool-count shape and a category of Lending, CDP, RWA Lending, or Uncollateralized Lending; missing categories or non-lending categories stay `review-needed`. The 2026-06-09 Wave 2 allowlist additions are category-gated Lending protocols with live single-asset stablecoin pools on smaller/pre-mainnet or app-chain ecosystems; the 2026-06-11 Wave 3 follow-up promoted `bifi` and `fraxlend` from audit-queue evidence, while normal safety, APY, TVL, and source-shape gates still control publication. The 2026-09-23 drain promoted the seven remaining category-gated `lending-allowlist` candidates from the 2026-09-01 audit queue (`sky-lending`, `justlend-v1`, `accountable`, `pareto-credit`, `inverse-finance-firm`, `segment-finance`, `save`; categories re-verified live against `api.llama.fi/protocols`), which clears the unmatched high-TVL lending pools those venues account for. Speculative non-lending categories were excluded by the same protocol category gate. The monthly audit also re-probes explicit generic `convertToAssets` quarantines through monthly `chainRpcs` when available, emitting restore-readiness metadata and a `quarantine-ready-to-restore` candidate only after a nonzero rate passes the deterministic envelope. The 2026-07-09 lifecycle review kept overdue quarantines and intentional gaps status-neutral when no verified runtime APY path was available, updated their notes with the review disposition, and moved their `nextReviewAt` windows forward.

**Queue-guided allowlist rounds:** Future lending allowlist expansions start from the monthly coverage audit's `operatorQueue.recommendationCandidates` entries with kind `lending-allowlist`. Those candidates are derived from unmatched high-TVL single-exposure stablecoin pools outside the current allowlist, must pass the protocol-category gate for `high-confidence` status, and include DeFiLlama source links, pool examples, promotion metadata, and a suggested `LENDING_PROTOCOLS` snippet anchored near `YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR`. Operators can still review or reject candidates, but broad manual protocol hunting is no longer the default expansion path.

Discovery evaluates each candidate's own chain-specific absolute floor, not the stablecoin's first contract chain.

**Chain-specific absolute floor:** the absolute lending-opportunity TVL gate is table-driven through `CHAIN_LENDING_TVL_FLOOR_USD`. The default floor remains `$100K`; Aptos, Berachain, Cardano, Ink, Monad, Plasma, Solana, Stacks, Stellar, and Sui use the configured `$25K` smaller/pre-mainnet floor. The `0.1%` supply-relative gate now applies to every peg currency and every scoped deposit-venue class, including GOLD/SILVER; tracked supply values are USD-denominated. This closes the metal-peg bypass that let a roughly `$2B`-market-cap coin surface on a `$366K` venue and extends the existing v7.0 supply-share rule universally.
If the bulk `stablecoins` supply cache is missing, malformed, or unreadable, discovery degrades and does not admit new external opportunities through the absolute-floor fallback. The fallback remains available only for a genuinely absent individual coin inside an otherwise valid supply map.

**Observable size requirement:** Published `lending-opportunity`, `fixed-yield`, and `structured-tranche` rows require measured venue-level `sourceTvlUsd` and must clear the final size gate. Protocol-native or other source readers that cannot attach measured venue TVL are omitted from published coverage rather than using coin supply or another proxy.

**Explicit venue exclusion:** Even when a pool clears the generic quality gates above, published lending-opportunity suggestions exclude venues whose DeFiLlama `poolMeta` or supplemental source label identifies them as Resolv / `USR`, `stUSR`, or `wstUSR` linked.

**Yield type:** `lending-opportunity` — distinguishes these from native yield coins on the frontend. The direct Aave v3 on-chain supply-rate path uses the same classification so rankings/cache schema validation stays aligned across deterministic and auto-discovered lending rows.

**Data source:** `defillama-auto` — distinguishes from static-mapped `defillama` pools.

**Eligibility evaluated dynamically:** If a coin's safety score drops below 50, it stops receiving auto-discovered yield data. If it rises back to 50 or above, it starts automatically.

**Explicit deterministic edge cases:** `AUTO_LENDING_POOL_MAP` can also pin a small number of exact-symbol, single-asset lending markets for coins that would otherwise be blocked by ambiguous matching or by the generic safety gate. These rows still pass the same pool-shape and source-quality checks; the bypass is coin-specific and documented rather than global.

Current deterministic pins are `u-united-stables`, `eurcv-societe-generale-forge`, `usdx-hex-trust`, `usdo-openeden`, and `usdm-moneta`. The 2026-09-23 audit drain removed eight stale overrides rather than bypassing their failures: `eusd-electronic-usd`, `usdh-native-markets`, `dllr-sovryn`, `reusd-resupply`, and `xusd-babelfish` lost their pinned DeFiLlama pools entirely (the Sovryn DLLR/XUSD surfaces are gone, so the former Rootstock-venue and repaired-Pendle bypasses went with them), `tgbp-tokenised` sat at zero APY, and `feusd-felix` plus `usda-anzens` fell below the generic safety gate on current report-card scores. Bypassed rows still have to pass the normal DeFiLlama shape, APY, and TVL checks, and stale pins such as the former `doc-money-on-chain` and `pmusd-precious-metals` entries are removed rather than bypassed when their current pools no longer clear the standing gates.

**Same-symbol collision blocks:** `AUTO_LENDING_COLLISION_BLOCKLIST` stores coin-specific false-positive guards for pools that are valid DeFiLlama rows but belong to a different tracked asset. The 2026-06-11 audit added guards for cases such as Kava USDX vs Hex Trust USDX, Virtue VUSD vs Monad VUSD, and legacy Nexus/Synapse NUSD vs Neutrl NUSD. The blocklist also carries pool-scoped multi-asset-vault entries: `dusd-alto` blocks the Yearn vault holding frxUSD plus DUSD (pool-id prefix `a5f9e3ff`) and `sdola-inverse-finance` blocks the Yearn vault holding sDOLA plus an untracked asset (pool-id prefix `98fcaeb8`); a `pool` match is prefix-compared against the DeFiLlama pool id, so a multi-asset vault guard cannot leak to other pools in the same protocol. These blocks apply before deterministic override resolution and before dynamic same-symbol matching.

**Exact curated venues outside auto-discovery:** `EXPLICIT_YIELD_SOURCE_POOL_MAP` is a separate lane for named venues outside generic discovery, including the commodity pins for `xaut-tether` and `paxg-paxos` and Ethereum Frankencoin Savings for `zchf-frankencoin`. Unlike `AUTO_LENDING_POOL_MAP`, these rows publish only the exact named pool after matching expected venue metadata. The K3 sBOLD raw Stability Pool mapping is quarantined, not a supported wrapper-return source.

The monthly coverage audit now treats both `AUTO_LENDING_POOL_MAP` and `EXPLICIT_YIELD_SOURCE_POOL_MAP` as exact covered DeFiLlama surfaces. Its high-TVL gap report intentionally focuses on unsupported protocol families instead of re-flagging already-allowlisted markets that the runtime already supports dynamically. It also verifies deterministic auto-lending overrides against current pool-shape, APY, supply-relative TVL, Safety Score, allowlist, and collision-block gates; failures become `stale-auto-lending-override` headline queue items for operator review. The audit additionally walks curated native/variant/weighted pins (`YIELD_POOL_MAP`, `YIELD_VARIANT_MAP`, `YIELD_WEIGHTED_POOL_GROUPS`) and queues any pin whose DeFiLlama pool has disappeared as a `missing-pool` item classified `coverage-outage` (a live surface lost) or `dead-config` (a stale pin), counted at `deadCuratedPinCount` and announced by the `curated-pin-missing` cron event. The three pool-backed queue kinds are deduped by pool id; `missing-protocol` items are one representative pool per known non-lending protocol above the $5M floor (unknown categories stay in the high-TVL queue so the `lending-allowlist` derivation is unchanged); native exact-pool candidates are grouped per tracked asset with queue ids `native-exact-pool:<stablecoinId>`; and source-family projects no longer appear in pool-level buckets. Quarantine re-probe output is advisory: `quarantineReadyToRestore` and `quarantineProbeSummary` identify candidates for manual restoration, but the audit does not mutate hourly source configuration. The 2026-09-01 audit ran before the detector refactor landed later that month, so its cached headline counts (279 gaps) still carried the pre-refactor pool double-counting; the 2026-09-23 drain reviewed the queue under the current detectors, landed the eight stale-override removals and seven lending promotions above, refreshed the three stale venue-risk reviews (`aave-v3`, `compound-v3`, `morpho-blue`, re-verified against live audit directories and DeFiLlama TVL), and dispositioned the residual `missing-protocol` cohort as documented intentional gaps: those projects carry non-lending DeFiLlama categories (RWA funds, basis trading, yield aggregators, risk curators, capital allocators), so the category gate excludes them from the lending allowlist by design and no durable machine-readable venue surface exists to adapt without speculative scrapers. The residual is watch-severity under the queue budget and is re-reviewed by each monthly audit.

---

## Pharos Yield Score (PYS)

Risk-adjusted ranking (0–100) that balances yield magnitude against source risk, stablecoin safety, and consistency. PYS answers one question — *is this APY paying enough for the risk taken?* — so it is yield per unit of risk, not a recommendation and not a safety verdict. A D-grade coin can still rank above an A+ coin when it pays a lot for a lot of risk. Every surface that names PYS carries that framing, and each row also shows the joint safety × yield **zone** described under Presentation Boundaries.

Since v8.43 the effective yield is scored on a USD footing: `apy30d + 0.25 · spread + (usdBenchmarkRate − benchmarkRate)`, which is the closed form `usdBenchmarkRate + 1.25 · spread` — the score depends only on the USD risk-free rate and the row's excess over its own local hurdle, so a peg's inflation or policy-rate compensation is never credited as yield (before v8.43 wTRY at ~38% APY, +1.3 over TLREF, ranked beside USDC at +0.8 over T-bills). This is the covered-interest-parity reading of excess yield — it assumes a frictionless hedge and ignores FX basis; PYS does not model FX carry or hedging cost, which is why CHF/EUR rows with hurdles below the USD rate score higher than their nominal APY suggests.

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
| `usdBenchmarkRate`             | registry `USD` rate      | Reference risk-free rate (`riskFreeRate` on the payload) the local hurdle is swapped for (v8.43). Published only while the USD entry classifies healthy on its own feed evidence; missing or gated → `hurdleRebase` is 0 and the row scores as under v8.42 |
| `hurdleRebase`                 | unbounded                | `usdBenchmarkRate - benchmarkRate`; exactly 0 for USD-currency rows (both the `USD` T-bill and `USD_EFFR` benchmarks), negative for high-rate pegs (TRY, RUB), positive for CHF/EUR hurdles below the USD rate |
| `effectiveYield`               | `>= 0`                   | Raw APY plus 25% of benchmark spread plus the hurdle re-base, floored at zero before the safety divisor. Equal benchmark-relative excess scores equally in every currency |
| `sourceRisk.sourceRiskPenalty` | `1–2.5` after resolution | Nested source-risk multiplier derived from measured source evidence. Missing/invalid values are neutral (`1`); values below 1 clamp to 1 and above 2.5 clamp to 2.5 |
| `rowUtility`                   | `>= 0`                   | `effectiveYield / sourceRiskPenalty`, used before the safety curve                                                                                                  |
| `safetyScore`                  | 0–100                    | Report card overall score. `PYS_DEFAULT_SAFETY_SCORE` (40) for unrated coins                                                                                        |
| `riskPenalty`                  | 0.5–5.05                 | Raw safety penalty before the power curve is applied                                                                                                                |
| `riskPenalty^1.75`             | ~0.30–17.01              | Effective divisor used by PYS after the steeper safety curve is applied                                                                                             |
| `apyVarianceScore`             | 0–1 or null              | `1 - yieldStability`, using the published two-decimal stability derived from trailing coefficient of variation. Null for fewer than two samples, near-zero mean, or non-finite CV; unavailable variance withholds PYS |
| `scalingFactor`                | 8                        | Global constant (`PYS_SCALING_FACTOR` in `constants.ts`) tuned after the steeper safety curve                                                                       |

Published PYS is null whenever `pysNullReason` exists. The shared write/read reason ladder uses the following precedence; an otherwise eligible NR source can remain published and selected. Numeric 0 is reserved for a valid score that rounds to zero, with a null reason.

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

Yield v8 exposes optional `sourceRisk` and `rankChangeAttribution` shapes in shared API schemas. PYS and source arbitration consume the nested source-risk penalty; source-board, source-sheet, detail-page, and DEWS consumers can also read populated source-risk and rank-attribution evidence. `rankChangeAttribution` is computed generation-over-generation at publish time against the previous publication — `previousRank` is the rank under the served comparator before live safety hydration (published rank is still emitted separately), so tie-group reorders are not movement, and a payload published under a different methodology version drives `primaryDriver: "methodology"` when no evidence field explains the move. Missing evidence remains neutral:

- `sourceRisk` may be omitted, `null`, or partially populated on ranking, history, and alt-source rows.
- Public API source-risk fields are nested under `sourceRisk.*` (`sourceRisk.sourceRiskPenalty`, `sourceRisk.rewardShare`, and so on). Do not document or consume flattened public fields such as top-level `sourceRiskPenalty`; calibration scripts that ingest saved payloads must normalize from the nested API contract before analysis.
- `sourceRisk.sourceRiskPenalty` is the active v8 source-risk multiplier. It is derived from reliable `rewardShare`, `sourceDepthRatio`, `sourceAgeSeconds`, `sourceSwitchCount30d`, `observationCount30d`, sourced venue inputs (the `venueRiskWeighted` 1–5 score and its derived `venueRiskTier`), and reviewer-set `dependencyConcentration` where available. Missing, `null`, or invalid evidence is equivalent to a neutral multiplier of `1`; values below 1 clamp to 1 and values above `PYS_MAX_SOURCE_RISK_PENALTY` (`2.5`) clamp to 2.5.
- Frontend source-risk driver labels use the same scoring thresholds: `reward-heavy` when `rewardShare > 0.5`, `thin source depth` when `sourceDepthRatio < 0.001`, `limited history` when `0 < observationCount30d < 7`, and `source changed` when the selected source changed versus the prior published snapshot or `sourceSwitchCount30d > 0`. The `stale source` driver is the exception: it fires on the row's source-family-aware freshness classification (`sourceFreshness === "stale"`), not on the flat `sourceAgeSeconds > 6h` rule that the PYS source-risk penalty uses.
- The `/yield` depth lens is explanatory context, not guaranteed executable capacity. Rows are classified only when both `sourceRisk.sourceDepthRatio` and measured `sourceTvlUsd` are present: `deep` is `>= 1%` of tracked stablecoin supply, `moderate` is `0.1%` to `< 1%`, and `thin` is `< 0.1%`. External-opportunity rows without measured venue TVL are ineligible; native rows without measured venue TVL render `Native · depth n/a` and a muted `Native` marker in the TVL cell (the venue is the asset itself), not `Unknown depth` or a dash. No AUM or coin-supply figure substitutes for venue TVL in display, depth gating, or penalties.
- The depth band thresholds have one home: `YIELD_SOURCE_DEPTH_BANDS` in `shared/lib/selector/yield-source.ts`. The `/yield` depth lens classifies rows from it, and the Picker's rail-depth comparator ranks candidate rails on the same three bands (`deep` highest, `thin` lowest) rather than on the raw supply fraction. A rail with no depth evidence at all ranks below every measured band — an unsized venue is not a shallow one.
- DeFiLlama rows use the shared DeFiLlama input metadata timestamp/age when an individual resolved row does not carry `sourceObservedAt`, so provenance and PYS source-age penalties are based on the same freshness evidence.
- `sourceRisk.venueRiskTier: "unknown"`, `null`, or omitted means the venue tier has not been sourced. Unknown tier is neutral, not a hidden high-risk default. The one exception is the Royco Dawn tranche engine's own venue-posture profile, which charges an unsourced venue +2 (senior) / +3 (junior) tranche-safety points — a mid-band posture inside that bespoke opportunity score; the PYS source-risk penalty and the DEWS venue branches stay neutral on unknown.
- The Picker consumes the same contract without re-defaulting it: `RecommendedSource.sourceRiskTier` is `"low" | "mid" | "high" | null`, an unsourced tier publishes `null` and renders "tier not sourced", and the rail comparator scores an unknown tier at the neutral 55. An unresolved `venueChain` likewise degrades only that rail — chain-less rails are filtered before ranking, so a coin keeps its yield coverage whenever any rail resolves (`shared/lib/selector/yield-source.ts`, `selector-v2.5`).
- The same rule governs supply: the Picker's universal exclusions distinguish `supply-unavailable` (no usable current-supply reading this run — the coin is missing from `/api/stablecoins`, or carries no finite circulating bucket) from `below-supply-floor` (an observed supply under `$5M`). An unread supply is never summed, ranked, or published as `$0` (`shared/lib/selector/exclusions.ts`, `selector-v2.6`).
- `shared/lib/yield-source-risk-registry.ts` owns the typed runtime `YIELD_RISK_CONFIG` registry of reviewed venues, including each venue's concise reviewer rationale; `shared/data/yield-source-risk-evidence.json` owns the full citation arrays under the exact same venue keys, with structural coverage enforcing the 1:1 relationship. `worker/src/cron/yield-sync/source-risk.ts` consumes the venue registry without re-exporting its test-only inventory symbols. Each runtime entry carries five Yearn-style sub-scores — `audits` (20%), `centralization` (30%), `fundsManagement` (30%), `liquidity` (15%), `operational` (5%), each `1..5` with higher = riskier — weighted into a `1..5` venue-risk score. The coarse `venueRiskTier` is DERIVED from that weighted score (`< 2.5` → `low`, `< 3.5` → `medium`, otherwise `high`) and is never stored independently.
- The monthly yield coverage audit applies a quarterly review cadence to both reviewed venue scores and dependency-concentration entries. Evidence older than 90 days is queued for re-verification; staleness does not change a venue tier or source-risk penalty.
- The venue penalty moved from flat buckets to a continuous, calibration-preserving curve `max(0, venueRiskWeighted - 2.0) * 0.15`: weighted `≤ 2.0` → `0` (the legacy `low` no-op is preserved exactly for the blue-chip set), `3.0` → `+0.15` (the legacy `medium`), `4.0` → `+0.30`, `5.0` → `+0.45`. The curve applies only when a venue carries category scores; unscored venues stay neutral, and the legacy tier branch (`high` +0.35 / `medium` +0.15) remains the fallback. The penalty knee (`2.0`) sits intentionally below the low/medium tier cutoff (`2.5`): the tier is a coarse display/DEWS bucket while the penalty is continuous, so a `low`-tier venue scoring `2.0`–`2.5` (e.g. Gearbox, Exactly, Liqwid) is low-but-not-pristine and carries a small proportional penalty (≤ +0.075), while only true blue-chips (≤ `2.0`) are an exact no-op.
- `sourceRisk.dependencyConcentration` is a reviewer-set, stablecoin-id-keyed signal (not auto-derived) capturing cross-venue concentration that per-venue tiering structurally misses. It adds `+0.10` (`medium`) or `+0.20` (`high`) to the source-risk penalty (`low` is a zero-penalty informational severity). The registry is authoritative for the current reviewed set; unseeded coins stay neutral.
- The `yvusdc-yearn` calibration anchor is Yearn's [May 2026 yvUSDC-1 risk report](https://github.com/yearn/risk-score/blob/master/reports/report/yearn-yvusdc.md). Re-review the dependency entry if Yearn materially revises the report, the vault diversifies away from Sky, or the Spark venue scores leave the derived `low` tier. The report is review evidence, not a runtime feed.
- DEWS Yield Anomaly reads the derived `venueRiskTier` directly, so its `structured-medium-risk-venue` (+10) and `structured-high-risk-venue` (+25) branches fire across the reviewed registry as of DEWS v6.09; no DEWS threshold changed.
- `sourceRisk.sourceRiskScore` is the 0–100 display normalization of the resolved source-risk penalty. As of v8.13, when no upstream score is provided, the publisher fills it via `computeSourceRiskScoreFromPenalty` (`penalty = 1.0` → `0`; `penalty = PYS_MAX_SOURCE_RISK_PENALTY` (`2.5`) → `100`). The score is informational and does not change PYS — PYS continues to consume the `sourceRiskPenalty` directly. Rollback compatibility: legacy v7.48 payloads still resolve to a neutral penalty when source-risk is absent, and an explicit upstream `sourceRiskScore` value still wins over derivation.
- `sourceRisk.sourceDepthRatio`, `sourceRisk.rewardShare`, `sourceRisk.sourceAgeSeconds`, `sourceRisk.observationCount30d`, `sourceRisk.sourceSwitchCount30d`, `sourceRisk.deploymentPlace`, `sourceRisk.venueProtocol`, `sourceRisk.venueChain`, and `sourceRisk.investabilityFlags` are populated only when supported by existing rows, provenance, publication-generation evidence, or sourced yield-risk config. Missing precision stays missing instead of being guessed from labels.
- `sourceRisk.venueProtocol` resolves through one resolver (explicit value → variant wrapper child-id map → DeFiLlama `project` → source-key route) and is `null` when no venue is known — it never records the derivation method, so the former `price-derived`/`rate-derived` "venues" publish null. Wrapper child ids resolve to their reviewed parent venue (`stusds-sky`/`susds-sky` → `spark-savings`, `stcusd-cap` → `cap`, `scrvusd-curve` → `curve-llamalend`, `savusd-avant` → `avant`, `sfrxusd-frax` → `frax`, `susn-noon` → `noon-capital`, `susde-ethena` → `ethena`, `wsrusd-reservoir` → `reservoir-protocol`) with the aliases `pendle-v2` → `pendle` and `sdai` → `spark-savings`.
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
| `USD_EFFR` | USD effective federal funds rate | New York Fed latest EFFR endpoint, then FRED `DFF`                                                                       | Optional product-specific benchmark for EFFR-linked products such as USDGO; not the default USD hurdle                                                                                                                                                                                              |
| `EUR`      | EUR 3M compounded €STR           | ECB Data API (`EST/B.EU000A2QQF32.CR`)                                                                                   | Native benchmark for EUR pegs; retained-last-market fallback covers feed outages                                                                                                                                                                                                                    |
| `CHF`      | CHF 3M compounded SARON          | SIX delayed `SAR3MC` download                                                                                            | Public feed is delayed by one business day; not labeled as a proxy                                                                                                                                                                                                                                  |
| `GBP`      | GBP 3M compounded SONIA          | FRED graph CSV for SONIA Compounded Index `IUDZOS2`, then ALFRED graph CSV, then Bank of England IADB `IUDZOS2` fallback | Annualized from the trailing 90-day index change; metadata source `fred-sonia-compounded-index` or `alfred-sonia-compounded-index` before the BoE fallback (`boe-sonia-compounded-index`), fallback mode `gbp-sonia-compounded-index-failed`                                                        |
| `JPY`      | JPY overnight call (TONA proxy)  | Bank of Japan Time-Series Data Search `STRDCLUCON`                                                                       | Used as a TONA-equivalent proxy                                                                                                                                                                                                                                                                     |
| `MXN`      | MXN CETES 28d                    | Banxico SIE API (series `SF43936`)                                                                                       | `BANXICO_TOKEN` enables the official Banxico feed; when missing/failing, MXN retains the last market source when available or remains unavailable so rows fall back to USD. Etherfuse CETES current issuance is deliberately limited to the CETES product APY source, not the shared MXN benchmark. |
| `BRL`      | BRL SELIC over                   | BCB SGS API (series `11`)                                                                                                | No auth required; a strictly positive daily percentage is annualized over 252 business days before scoring, while `0.00` placeholders are rejected                                                                                                                                                 |
| `AUD`      | AUD cash-rate target             | Reserve Bank of Australia F1 money-market CSV                                                                            | RBA cash-rate target used as the AUD local cash hurdle                                                                                                                                                                                                                                              |
| `CAD`      | CAD Bank rate (policy, monthly)  | Bank of Canada Valet API (series `V122530`)                                                                              | Series `V122530` is the monthly administered Bank of Canada policy rate, not CORRA; the monthly cadence is why CAD carries the 45-day observation bound. Currently fetched but unused by published rows, so it is listed under `unusedBenchmarkKeys` rather than gating the registry rollup. |
| `RUB`      | RUB CBR key rate                 | Central Bank of Russia DailyInfo `KeyRateXML` SOAP feed                                                                  | Native benchmark for RUB pegs; validation accepts up to 100% so high key-rate regimes are not rejected by the standard 20% ceiling                                                                                                                                                                  |
| `TRY`      | TRY BIST TLREF overnight         | CBRT EVDS (`TP.BISTTLREF.ORAN`)                                                                                          | Native benchmark for TRY pegs; validation accepts up to 100% so Turkish reference-rate regimes are not rejected by the standard 20% ceiling                                                                                                                                                         |
| `SGD`      | SGD SORA (unavailable)           | —                                                                                                                        | Reserved for a future MAS SORA feed; SGD pegs fall back to USD until a stable public source is wired                                                                                                                                                                                                |

**Observation-age bounds:** `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC` in `shared/lib/yield-benchmark-freshness.ts` owns each key's `recordDate` age bound, independently enforced alongside the 48-hour fetch TTL. Either failure is stale. Daily/overnight series get 5 days: `USD`, `USD_EFFR`, `EUR`, `GBP`, `JPY`, `MXN`, `BRL`, `AUD`, `SGD`. Calendar-matched bounds are `CHF` 7 days (delayed SAR3MC plus holiday clusters), `TRY` 10 days (TCMB holidays), `RUB` 12 days (January closures), and `CAD` 45 days (monthly Bank rate).
Future fetch or observation timestamps outside the five-minute clock-skew allowance are never converted to age zero. When a key has an observation-age bound, a missing or unparseable `recordDate` is non-healthy; an invalid required USD member makes the registry invalid without discarding readable non-USD evidence.

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

The hourly benchmark catch-up also refreshes when the required USD market observation exceeds its existing record-age bound, even if the last fetch is younger than 24 hours. This prevents a pre-publication daily fetch from blocking retrieval of a newer official print after the old observation expires. Unused or policy-rate observations do not independently force catch-up. It does not extend observation or fetch TTLs; the USD benchmark canary continues to apply the same current-observation rule.

**Usage:** The hourly core yield sync resolves `excessYield` from 30-day average APY and rate-derived APY against each row's selected benchmark. Detail cards, hero chips, and history charts render that row-level label. The `/yield` scatter plot always keeps a benchmark frame visible: homogeneous scopes use the shared visible benchmark, while mixed scopes use the default USD benchmark as an orientation frame and rely on row-level tags for the exact hurdle. The plot renders the full filter-visible ranking universe; APY outlier capping changes only vertical placement and never removes opportunities.

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
| `data-stale`       | Hourly source families are older than 3 `sync-yield-data` intervals (currently 180 min); supplemental Aave/Compound + protocol-API rows are older than 6 hours, except Pendle rows (daily lane) accepted through 48 hours and Hashnote USYC, Midas mMEV, and Re Protocol reUSD observations accepted through 72 hours; `price-derived` rows are older than 30 hours; `rate-derived` rows are older than 36 hours; ordinary comparison anchors are older than 14 days; price-derived and Midas/Ondo NAV anchors are older than 45 days | Yield data or its APY comparison anchor is older than the source's expected cadence/window |
| `aging`            | Observation age past the midpoint of its class's cadence-to-stale window (2h hourly, 5h supplemental, 27h price-derived, 30h rate-derived, 36h Pendle daily lane, 48h slow NAV) | Read-time-only: the row missed its refresh slot; a refresh is expected before the stale bound |
| `data-freshness-unknown` | The row's source reported no observation timestamp | Freshness cannot be established, so PYS is unavailable |
| `reference-benchmark-degraded` | Configured product input or independently required USD normalization reference is degraded or stale | Degraded evidence qualifies the score; stale product evidence yields `source-stale` NR and a stale normalization reference yields `benchmark-stale` NR |
| `benchmark-degraded` | Row comparison hurdle is degraded | Retained/fallback evidence qualifies the score rather than claiming exact evidence |
| `benchmark-stale` | Row comparison hurdle is stale | PYS is unavailable; the same null reason also covers a stale required USD normalization reference |
| `safety-unrated` | Safety is unobserved/unrated | Conservative fallback is visibly qualified; an unavailable common snapshot withholds PYS |
| `opportunity-evidence-missing` | Critical external-opportunity evidence is incomplete | Row remains visible but PYS is NR |

All frontend surfaces (leaderboard, detail section, history chart) format warning signals via the shared `formatYieldWarningSignal()` function in `src/lib/yield-constants.ts`, which maps known signal keys to human-readable labels and falls back to hyphen-to-space conversion for unknown signals.

At rankings cache-build time, `sync-yield-data` decorates rows with the read-time-only `data-stale` signal when the resolved source observation or its comparison anchor exceeds the source-aware window. Hourly publication families use the shared three-interval threshold (currently 180 minutes; `STALE_THRESHOLD_MS`), supplemental protocol-API and optional Aave/Compound rows use 6 hours (`SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS`), Pendle `protocol-api:pendle:*` rows use 48 hours (`PENDLE_SUPPLEMENTAL_STALE_THRESHOLD_MS`, two daily-lane cycles, because that family fetches at most once per day on the free unkeyed quota), and the exact Hashnote USYC, Midas mMEV NAV, and Re Protocol reUSD source keys use the same 72-hour acceptance window enforced by their adapters (`SLOW_NAV_SOURCE_STALE_THRESHOLD_MS`). Price-derived source observations use 30 hours (`PRICE_DERIVED_STALE_THRESHOLD_MS`), and rate-derived rows use 36 hours (`RATE_DERIVED_STALE_THRESHOLD_MS`) because the benchmark producer is daily; each class also emits the midpoint `aging` signal (2h hourly, 5h supplemental, 27h price-derived, 30h rate-derived, 36h Pendle daily lane, 48h slow NAV) between its refresh cadence and the stale bound. Ordinary exchange-rate comparison anchors use 14 days (`COMPARISON_ANCHOR_STALE_THRESHOLD_MS`); price-derived plus the Midas mMEV and Ondo USDY NAV-oracle rows use 45 days (`LONG_HORIZON_COMPARISON_ANCHOR_STALE_THRESHOLD_MS`) because those adapters deliberately choose anchors from a 7-45 day window. The signal is included in cached rankings responses but is not written back to `yield_data`.

The sync also records comparison-anchor freshness under `sourceCoverage.comparisonAnchorFreshness`. The summary includes the anchored row count, stale anchor count, oldest stale anchor age/source, bounded stale examples with each source's `maxAgeSeconds`, and a truncation flag. Publication metadata additionally records `sourceCoverage.previousPublishedRankingCount` and `sourceCoverage.publishedRankingCountDelta`; severe coverage-regression guards emit the same ranking-count fields at top level before normal source coverage is assembled. `/api/status` exposes both shapes as `yieldHealth.previousRankingCount` and `yieldHealth.rankingCountDelta` so operators can see coverage growth or shrinkage without manually comparing payloads. These summaries are observability-only: stale-anchor warnings still follow the read-time `data-stale` rules above, and the freshness/ranking-delta metadata does not change source arbitration or scoring.

The sync also performs a confidence-aware cross-source arbitration pass before `is_best` is chosen:

- accepted candidates outrank rejected candidates, and positive APY outranks non-positive APY
- non-fixed candidates outrank `fixed-yield` candidates before evidence and confidence comparisons
- direct first-party/on-chain evidence outranks curated observations, then discovered observations, modeled proxies, and fallback evidence; confidence breaks ties within an evidence class
- within the same evidence/confidence tier, source-risk-adjusted utility (`effectiveYield / sourceRiskPenalty`) is compared only when at least one candidate has an operator-provided penalty; otherwise comparison falls through to current APY, TVL, then source key
- materially divergent discovered or fallback rows can be rejected when an eligible higher-confidence canonical source disagrees by more than 35%; rejected canonical candidates cannot veto another source
- arbitration compares candidates on the pre-run switch count plus a flat 0.1 would-switch margin, with a deterministic source-key tie-break so both input orders agree
- a non-rejected curated explicit pool takes precedence over auto-discovered same-asset, same-yield-type candidates even when discovery is the incumbent; those candidates remain alternatives rather than being rejected by this precedence rule
- the arbitration winner must itself be publishable: a rejected winner (for example NR on source-freshness-unknown) is skipped, so the coin publishes no `is_best` row that generation instead of a least-bad substitute
- a `canonical-zero-vs-positive` anomaly is flagged when a high-confidence source reads 0% but a lower-confidence source reports > 1% APY

This selection behavior is surfaced in row-level `provenance` metadata on `/api/yield-rankings`.

---

## Engineering Contract

The methodology above is the durable public contract. Runtime topology, storage details, and incident procedures remain source-owned so this document does not mirror implementation inventories.

### Persistence And Publication

- `worker/migrations/0000_baseline.sql`, later yield migrations, and `worker/migrations/MANIFEST.md` own the D1 schema.
- `yield_data` stores the current multi-source snapshot; `yield_history` stores recent source-aware observations and publish-time scoring evidence, while `yield_history_daily` stores the last published point per stablecoin/source/UTC day for the older public window. Publish-time scoring evidence persists as `pys_inputs_at_publish` (schemaVersion 2, carrying `usdBenchmarkRate` and `hurdleRebase`), and `/api/yield-history` reports per-point `pysReproducibility` as `exact`, `not-scored` (NR row), `legacy-partial`, or `invalid`, warning on invalid replays.
- `worker/src/cron/yield-sync/publication-view.ts` builds selected-source evidence, ordered candidates, decision ledgers, and per-source provenance once. Rankings and persistence consume the same selection; both preview and final validation remain in place.
- `yield_publication_generations` and `yield_source_decisions` record publication state and bounded source-selection evidence. Repeated unchanged anomaly evidence is 30-day audit data; source switches and anomaly-episode boundaries remain durable.
- Public rankings expose only a validated published generation. Rankings and summary assess freshness at response time: fresh through 7,200 seconds, degraded through 14,400 seconds, then stale. Both non-fresh states emit HTTP Warning 110 and `Cache-Control: no-store`. Their `_meta` names the assessment time, freshness budgets, and nullable reason alongside publication time, age, and status. Failed validation or publication attempts leave the prior snapshot intact.
- One admission/quarantine boundary feeds views, rankings, current rows, history, and decision evidence. Non-finite core APYs or invalid alternate comparisons quarantine the source with `yield-publication:quarantined-source:<id>:<field>` rather than poisoning the generation; non-finite stored history APYs are excluded from trailing statistics.
- Rejected diagnostic winners remain excluded from selected-source and benchmark health. Coverage regressions at the existing 60% cohort/count thresholds and direct-to-modeled quality substitution produce loud non-blocking quality reasons and alarms, allowing independent valid rows to publish. Empty total coverage, unavailable common safety, and total coverage below `ceil(previous * 0.4)` when the previous count is at least five still block. Blocked results retain the run's `inputDiagnostics`.
- Applied publications return cron status `ok`; `metadata.quality.degraded` and `reasons` separately carry required-input, benchmark, expired-selected, quarantine, and coverage findings. Unapplied/deferred/blocked work returns a non-`ok` status with `metadata.reason`, not a top-level `fallbackMode`. Pendle-only supplemental failures use `metadata.quality.advisoryReasons`: they remain visible in the admin supplemental tile but do not set `quality.degraded` or flip public producer quality. Probe-only vaults.fyi failures remain diagnostic family rows, excluded from required-input and aggregate supplemental quality.
- Degraded input quality does not advance `freshness:yield-data` and suppresses destructive cleanup. Producer `streakDegradedRuns` counts non-clean publications, including `ok` with degraded quality, and exposes the latest concrete reason; a clean recovery resets it. Publication continuity is not a clean-freshness claim.
- Each publication attempt has an opaque UUID-suffixed generation identity. Insert-only staging, strict newer-timestamp cache CAS, and generation-owned row writes prevent equal-second or older losers from overwriting or finalizing winner artifacts or running retention. Only history primary-key conflicts are ignored; other constraint failures roll back the atomic batch.
- Read-time aging runs before both live-safety and publish-time-safety branches. Selected `sourceRisk.sourceAgeSeconds` follows the same authoritative observation as provenance: `sourceObservedAt`, or published age plus elapsed cache time when the timestamp is absent. Alternate source-risk ages advance by elapsed publication time; unavailable ages stay null. Comparison anchors, benchmark fetch/record evidence, and rate-product inputs are independently reassessed. Detailed and summary row provenance includes `sourceMaxAgeSeconds`.
- History exposes expanded `_meta`. It uses `buildFreshnessMeta` with the shared `yield-data` bands (fresh through 7,200 seconds, degraded through 14,400 seconds, then stale), and `yield-publication-age` when publication evidence is non-fresh. Every non-fresh response emits Warning 110 and `no-store`. Missing authoritative publication cutoff, including failed cron lookups, serves readable points as stale with `publication-cutoff-unavailable`, even if cache metadata supplies a fallback cap.
- The final resolve-stage eligibility pass removes null, non-finite, or thin measured venue-TVL candidates in the three deposit-venue classes before evaluation and arbitration, across tracked, explicit, auto-discovered, supplemental, and linked-variant paths. Only eligible candidates can reach a validated published generation.
- History retention is enforced by the producer. Idempotent cleanup retries transient D1 overloads with the shared bounded, abort-aware retry policy; exhausted retries and schema errors still fail visibly without replaying publication. Legacy rows remain explicitly partial rather than receiving invented evidence.
- Daily compaction searches missing or newer source/day closes below the 30-day raw cutoff, including cold-start and below-watermark backlogs, and writes at most 1,000 closes per run. Raw deletion requires a stored daily close at least as new; uncompacted observations survive for bounded later drains. Previously deleted observations remain gaps: recovery is a separately reviewed action over retained raw data, never synthesis.
- Present corrupt or schema-invalid PYS snapshots are `invalid` with bounded stablecoin/source/time logging. `legacy-partial` is reserved for absent evidence or older non-USD replay inputs; nullable `varianceScore` is valid evidence for an NR row.

### Public Wire Contract

- Full and summary rankings and history publish `_meta` with `updatedAt`, `ageSeconds`, `status`, `assessedAt`, `freshBudgetSec`, `degradedBudgetSec`, and nullable `reason`. Assessment fields are required whenever `_meta` is present.
- Summary rows publish explicit `benchmarkSelectionMode` and `provenance.sourceMaxAgeSeconds`. `benchmarkIsFallback` faithfully describes feed fallback independently of selection policy; clients do not infer currency substitution from it.
- Detailed provenance retains nullable `sourceObservedAt` and `sourceAgeSeconds` without discarding other evidence. Unavailable `medianApy` remains null. Rankings, alternatives, and history preserve raw nonnegative `sourceRisk.rewardShare`, including ratios above 1. Public serialization does not replace unavailable values with zero or cap persisted evidence.


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
- Negative APY remains valid input; non-positive trailing APY publishes null PYS with `apy-non-positive`, not an unexplained zero. Invalid annualization is unavailable and cannot seed history.
- A circuit-broken provider removes only that source family. Independent tiers may still publish.
- The monthly coverage audit defers with `yield-rankings-cache-missing` or `yield-rankings-cache-malformed` when the published rankings cache cannot be read; it does not reinterpret a failed read as zero published assets or enqueue resulting coverage gaps.
- Missing or malformed stablecoin supply defers the coverage audit with `stablecoins-cache-missing` or `stablecoins-cache-malformed`, preserving its prior report rather than treating an absolute floor as a substitute for supply-relative eligibility.
- A held V9 publication is not a withdrawal of the accepted ratings: the compact score map keeps serving the accepted generation (`report-cards.md`: a held response serves the last accepted ratings), so the hourly yield runtime publishes against those ratings with the hold recorded as a degradation reason, as long as the accepted publication stays inside the same stale-coherent window the read path uses. It defers before source resolution with `safety-snapshot-unavailable:<upstream reason>` (for example `safety-snapshot-unavailable:v9-publication-held`) only when no accepted publication is readable at all or the held accepted generation has left that window. An unusable snapshot forces `NR` on every evaluated row and therefore drops every publication view, so such a run cannot publish a ranking row: it is an input outage, not a zero-coverage measurement, and it is never reported as a yield-source coverage regression. A usable snapshot whose coverage is merely degraded still publishes.
- Trailing windows are timestamp-based, so cron gaps do not shift their boundaries.
- Live safety hydration accepts ordinary newer report-card input/publication generations only when the V9 publication model, schema, methodology/policy identity, and evaluation-build digest still match, then recomputes safety-derived row fields and ordering against that live snapshot.
- Missing, incomplete, or evaluation-incompatible live safety hydration uses coherent publish-time safety with `yield-safety-hydration-stale` and `liveSafetyHydration.fallback: "publish-time-snapshot"` only while both the yield publication and its stamped safety publication independently remain within 24 hours (`shared/lib/yield-safety-fallback.ts`). Missing safety time earns no fresh budget. Original safety identity/time stay visible; safety coverage is 0 under the fallback provenance rule. Source and benchmark aging still applies and can withhold PYS during that window. Missing identity or an expired bound clears safety-derived fields to explicit NR. The body-level fallback alone emits no HTTP Warning; NR/partial hydration emits Warning 199, and publication-age Warning 110 remains independent.
- Public health uses the same dual 24-hour yield/safety fallback predicate as rankings hydration. Missing, non-finite, or future safety publication timestamps are unavailable; a recent yield cache cannot renew expired safety evidence.
- Unreadable persisted warnings are unknown, not clean. The point stays available with `warningSignals: []` plus `warningSignalsStatus: "unreadable"`; a valid empty list carries no unreadable marker.

### Presentation Boundaries

- The workbench emits `yield_zero_results` only after ranking data has loaded without a query error. Loading, absent-data, and failed-refresh states are not counted as empty-result exposures; a loaded empty payload still is. This event measures an empty view, not a completed conversion or necessarily a failed search.
- URL filter normalization also waits for loaded, error-free ranking data, so data-derived options cannot erase a valid incoming filter while the request is pending.
- Leaderboard rows keep a fixed visual budget: yield type, zone (row's own benchmark × safety 60; the scatter quadrants are an orientation frame against one chart-wide benchmark, so a non-USD row's chip can differ from its plotted quadrant), confidence, freshness, and warning/source-risk severity. Additional evidence belongs in the expanded panel or detail page.
- The stablecoin detail section is an at-a-glance summary; `/stablecoin/<id>/yield/` is the history-first workbench. The two surfaces must not duplicate whole panels.
- The closed detail summary shows a dense source fact row: linked selected identity, published holder/deposit/estimated role, confidence/freshness, datasource, optional venue/chain/deployment, and score qualification. Deposit opportunities explicitly do not imply passive holder yield; price-return wording follows calculation mode. Diagnostics retain risk, access, decision ledger, and alternates without repeating the identity strip; embedded APY attribution is a headline only.
- Workbench/panel links require static workbench eligibility. Dynamically covered assets without an exported workbench receive one honestly named `/yield/` fallback rather than a dead per-coin link.
- History mode is labelled **Published selected source**: its caption distinguishes stitched selected-source history from headline 30-day APY, which uses only the current source. Missing hourly observations inside 30-day raw retention and daily observations beyond it remain discontinuities; alternate-only timestamps survive without interpolation. The median reference is explicitly global and TVL-weighted, and disappears when unavailable.
- Historical APY attribution checks daily-close source identity and source-switch markers within ±24 hours. A reset current ledger cannot erase a historical switch or supply historical APY impact. Adequate below-threshold history means no material APY change; unavailable prior-source labels disclose that identity was not retained. Unreadable warnings render a neutral hollow marker and explicit tooltip, never a clean-point claim.
- Rank attribution compares the previous publication, not the last-ever movement: explicit null means measured unchanged; absent means no comparison. Contextual contributions use heterogeneous units and are heuristic, not additive causal decomposition; the primary driver renders first, then deterministic key order. Unchanged penalties do not create movement attribution.
- Benchmark spreads are percentage points (`pp`) with the reference level and an accessible full chip description; sub-display-precision gaps normalize to zero. Both detail surfaces pass through the published PYS null reason.
- Retained-data refresh errors and rankings API quality warnings remain visible with retry. Source sheets keep their shell across loading, error, and loaded-but-missing-row states.
- Display breakdowns rebase only for payload methodology at least v8.43 and healthy USD reference evidence. Frontend benchmark classification shares the independent 48-hour fetch TTL and observation bound; missing/future evidence fails closed and cached record age cannot override the record date. Board APY gauges and excess use the same row benchmark resolver as zone chips. Readers use explicit `benchmarkSelectionMode`, independently of feed quality in `benchmarkIsFallback`. Comparison CSV preserves safety provenance, including `default-safety`, or `unknown` when absent. The hero stability highlight is labelled A/A+.
- Deep-link workbenches are runtime analysis surfaces and remain `noindex`; `/yield/` and stablecoin detail pages are the indexable surfaces.
- PYS factor attribution neutralizes one factor at a time and recomputes PYS. Per-factor deltas are explanatory and need not sum to the final score.
- Every row carries a zone chip derived from `resolveYieldZone()` in `src/lib/yield-scatter.ts`: safety `>= 60` × 30-day APY above the row's own benchmark (falling back to the visible USD benchmark) yields `Sweet Spot`, `Danger Zone`, `Play It Safe`, or `Why Bother?`. Labels, descriptions, and static badge classes live in `shared/lib/classification.ts` and name the scatter-plot quadrants; unscored rows or rows with no benchmark render no chip. The hero highlight context and the leaderboard PYS tooltip use the same vocabulary so a top-PYS low-grade row reads as well-paid risk, not as an endorsement.
- `/yield/` lands on the Opportunistic risk band (`YIELD_LANDING_RISK_BUDGET`: safety `>= 50`, warnings hidden). The `risk` URL param selects a band (`conservative`, `balanced`, `opportunistic`, or `any` for no band; `all` is accepted and preserved as a neutral alias); an absent param is the landing band. The band only fills risk-budget keys the URL leaves unset, so explicit `minSafety`, `depth`, `sourcePosture`, `sourceConfidence`, or `warnings` params always win. Clearing one of those keys from the filter controls pins `risk=any` and keeps the other band-derived keys explicit. View presets stack on the current filters (active when their override keys match; counts computed on the stacked filters), and the compare drawer always selects from the unbanded universe so a selected low-grade row never disappears.

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

Historical raw yield pruning rounds its retention cutoff down to a UTC-day boundary, so no partial trailing day is deleted before the next complete-day compaction. Tape warning and PYS comparisons seed every coin from its last pre-watermark row. Structured yield venue identity takes precedence over child asset ids when resolving source risk; child ids are only a fallback.
