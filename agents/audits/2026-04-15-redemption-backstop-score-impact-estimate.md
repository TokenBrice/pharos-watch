# Redemption Backstop Score Impact Estimate

Date: 2026-04-15

## Baseline

Data pulled from live site-data endpoints during this review:

- `/ _site-data/redemption-backstops`: `updatedAt = 1776244570`, 147 configured rows, methodology `v3.8`
- `/ _site-data/report-cards`: `updatedAt = 1776243651`, methodology `v6.98`, `redemptionStale = false`, `liquidityStale = false`
- `/ _site-data/stablecoins`: `updatedAt = 1776243651`

Method:

- Direct Redemption Backstop score deltas were modeled with the current code path and current stablecoin supply / DEX inputs.
- Safety Score impacts are direct-card recomputations using current report-card dimensions with only the Liquidity / Exit dimension changed. This does not propagate dependency-risk changes to downstream dependents, so full production reruns may add second-order deltas.
- These are scenario estimates, not proposed final methodology.

## Scenario A - Stricter Live / Proxy Capacity Eligibility

Assumption: live reserve capacity must either have stronger current freshness proof or fall back to the configured reviewed ratio. If the fallback is heuristic, report cards do not use it for Liquidity / Exit uplift.

Most affected current rows:

| Coin | Current RB | Scenario RB | Current liq | Scenario liq | Overall | Grade | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `dai-makerdao` | 100 | 98 | 100 | 60 | 85 -> 72 | A -> B | Sky proxy fallback remains high direct score, but low confidence removes Safety Score uplift |
| `usds-sky` | 100 | 98 | 100 | 70 | 83 -> 74 | A -> B | Same Sky proxy/fallback pattern |
| `iusd-infinifi` | 70 | 70 | 74 | 43 | 70 -> 60 | B -> C+ | Queue cap keeps direct score unchanged, but fallback confidence drops to low |
| `usdf-falcon` | 65 | null | 70 | 54 | 68 -> 63 | B- -> C+ | No configured fallback ratio; route becomes unrated if live proxy capacity is blocked |

Rows with limited/no current impact under this scenario:

- `wsrusd-reservoir` is already using its documented-bound fallback: current Safety Score stays unchanged.
- `usde-ethena` is already fallback/low-confidence and not used for Safety Score uplift: current Safety Score stays unchanged.
- `usdo-openeden` is already `missing-capacity`: no current score impact.
- `gho-aave` and `zchf-frankencoin` only drop in the blunt "no live telemetry at all" model. A sensible implementation should likely exempt same-run onchain direct capacity evidence, so they are not listed as likely affected.

Interpretation:

The largest live-eligibility score risk is not the direct backstop score. It is the confidence transition from dynamic medium/high to low-confidence fallback, which disables Safety Score redemption uplift.

## Scenario B - Eventual-Only Routes No Longer Uplift Liquidity / Exit

Assumption: `capacitySemantics = eventual-only` remains visible as a Redemption Backstop route, but report-card Liquidity / Exit only uses DEX liquidity unless the route also has immediate-bounded/current-exercisable evidence.

Summary:

- 40 currently used eventual-only rows would lose redemption uplift.
- 35 currently rated cards have direct-card overall score impact.
- In this scenario, every rated affected card changed grade.

Largest direct-card overall deltas:

| Coin | Route | RB | DEX | Liquidity | Overall | Grade | Supply / mcap |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |
| `aid-gaib` | stablecoin-redeem | 92 | 17 | 94 -> 17 | 68 -> 44 | B- -> D | $18M |
| `cusd-cap` | basket-redeem | 87 | 25 | 90 -> 25 | 64 -> 43 | C+ -> D | $93M |
| `fpi-frax` | collateral-redeem | 84 | 24 | 86 -> 24 | 64 -> 43 | C+ -> D | $96M |
| `usda-avalon` | stablecoin-redeem | 78 | 9 | 79 -> 9 | 61 -> 40 | C+ -> D | $271M |
| `satusd-river` | collateral-redeem | 88 | 17 | 90 -> 17 | 63 -> 43 | C+ -> D | $158M |
| `m-m0` | offchain-issuer | 65 | 11 | 66 -> 11 | 66 -> 47 | B- -> D | $284M |
| `mnee-mnee` | offchain-issuer | 65 | 13 | 66 -> 13 | 69 -> 51 | B- -> C- | $101M |
| `mtbill-midas` | offchain-issuer | 65 | 13 | 66 -> 13 | 72 -> 55 | B -> C | $48M |
| `usnd-nerite` | collateral-redeem | 82 | 34 | 85 -> 34 | 83 -> 67 | A -> B- | $1M |
| `usdr-stablr` | offchain-issuer | 65 | 19 | 67 -> 19 | 72 -> 56 | B -> C | $6M |
| `eurq-quantoz` | offchain-issuer | 65 | 22 | 67 -> 22 | 69 -> 54 | B- -> C- | $6M |
| `idrt-rupiah-token` | offchain-issuer | 65 | 15 | 67 -> 15 | 58 -> 43 | C -> D | $10M |
| `usdx-hex-trust` | offchain-issuer | 65 | 4 | 65 -> 4 | 48 -> 34 | D -> F | $43M |
| `feusd-felix` | collateral-redeem | 93 | 55 | 99 -> 55 | 71 -> 57 | B -> C | $75M |
| `pusd-pleasing` | offchain-issuer | 65 | 27 | 68 -> 27 | 59 -> 45 | C -> D | $120M |

Highest market-cap affected rows:

| Coin | Supply / mcap | Liquidity | Overall | Grade |
| --- | ---: | ---: | ---: | --- |
| `usdy-ondo-finance` | $2.17B | 69 -> 40 | 70 -> 60 | B -> C+ |
| `syrupusdc-maple` | $1.67B | 74 -> 42 | 64 -> 53 | C+ -> C- |
| `syrupusdt-maple` | $1.06B | 73 -> 34 | 60 -> 47 | C+ -> D |
| `u-united-stables` | $972M | 95 -> 55 | 66 -> 52 | B- -> C- |
| `ousg-ondo-finance` | $600M | 83 -> NR | 69 -> 56 | B- -> C |
| `usd0-usual` | $558M | 92 -> 57 | 68 -> 56 | B- -> C |
| `a7a5-old-vector` | $553M | 68 -> 32 | 41 -> 31 | D -> F |
| `usx-solstice` | $369M | 95 -> 63 | 70 -> 59 | B -> C |
| `usdai-usd-ai` | $298M | 100 -> 60 | 78 -> 64 | B+ -> C+ |
| `m-m0` | $284M | 66 -> 11 | 66 -> 47 | B- -> D |

Interpretation:

This is the broadest and most methodology-sensitive change. It does not necessarily need to change the standalone Redemption Backstop score. The safer first move is to keep direct route quality visible while preventing eventual-only routes from automatically uplifting Safety Score Liquidity / Exit.

## Scenario C - Ethena Ratio Denominator Normalization

Current live reserve metadata for `usde-ethena`:

- `immediateRedeemableUsd = 5.170B`
- adapter-published ratio: `0.8859` of backing assets
- ratio against current supply: `0.8872`

Current published redemption row is already fallback / low-confidence:

- Redemption Backstop score: 71
- Safety Score redemption used: false
- Liquidity / Exit: 56
- Overall: 49, grade D

If current Ethena live reserve metadata were accepted as clean without any other policy change:

- Redemption Backstop score would model around 88.
- Effective exit would model around 94.
- Liquidity / Exit would rise from 56 to 94.
- Direct-card overall would rise from 49 to about 62, grade D -> C+.

But the ratio-denominator fix alone has almost no current numeric effect because supply and backing-assets denominator are close right now. The bigger issue is whether Ethena's stable bucket should be treated as Safety Score-eligible live proxy capacity.

## Practical Impact Ranking

1. `eventual-only` Safety Score gating: largest broad impact, many double-digit overall-score drops.
2. live/proxy capacity eligibility: concentrated but material impact on DAI, USDS, iUSD, and Falcon USDF.
3. route availability sources: zero or limited current impact unless a route is impaired, but major incident-time impact.
4. Ethena ratio normalization: small current denominator impact, but large if live proxy capacity becomes eligible again.
5. snapshot generation consistency and enum/telemetry validation: reliability and fail-closed behavior, not intended methodology score changes.

