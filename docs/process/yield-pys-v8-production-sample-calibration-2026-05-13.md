# Yield PYS v8 Production-Snapshot Baseline Calibration Artifact

Generated: 2026-05-13T18:30:00.000Z

Scope: production-snapshot baseline calibration for the methodology v8 PYS source-risk layer. The input is the current public site-data `/yield-rankings` payload captured on 2026-05-13; source-risk fields were not populated in that live payload, so this report proves real-universe distribution, cap pressure, and non-USD cohorts under neutral source-risk fallback. Golden-fixture source-risk driver evidence is recorded in `docs/process/yield-pys-v8-calibration-2026-05-13.md`. This artifact is evidence only and does not change runtime behavior.

## Candidate Formula For Analysis

```text
sourceRiskPenalty = clamp(row.sourceRisk?.sourceRiskPenalty ?? legacy row.sourceRiskPenalty ?? derivedNeutralPenalty, 1, 2.5)
rowUtility = current effectiveYield / sourceRiskPenalty
pysV8 = clamp(round(rowUtility * sustainabilityMultiplier * scalingFactor), 0, 100)
```

Unknown source-risk inputs are neutral. The before column recomputes the v7 baseline without source-risk penalties; the after column applies the v8 candidate penalty.

## Distribution

Rows analyzed: 129

| metric | PYS v8 candidate |
| --- | ---: |
| p10 | 1 |
| p50 | 7 |
| p90 | 20 |
| max | 100 |

## Capped Scores

| side | count capped at 100 |
| --- | ---: |
| before | 1 |
| after | 1 |

## Null-Rate Coverage

| field | present | null/missing | null rate |
| --- | ---: | ---: | ---: |
| sourceRiskPenalty | 0 | 129 | 100.0% |
| rewardShare | 0 | 129 | 100.0% |
| sourceDepthRatio | 0 | 129 | 100.0% |
| sourceAgeSeconds | 0 | 129 | 100.0% |
| sourceSwitchCount30d | 0 | 129 | 100.0% |
| observationCount30d | 0 | 129 | 100.0% |
| venueRiskTier | 0 | 129 | 100.0% |

## Non-USD Cohort Checks

| cohort | rows | p50 PYS | p90 PYS | max PYS | capped at 100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| CHF | 1 | 27 | 27 | 27 | 0 |
| EUR | 4 | 5 | 12 | 12 | 0 |

## Top 20 Before

| rank | id | symbol | APY 30d | PYS | source | driver |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | cetes-etherfuse | CETES | 154.64 | 100 | Mexican government CETES bonds | apy-or-baseline |
| 2 | bold-liquity | BOLD | 7.98 | 73 | Liquity Stability Pool (via Yearn yBOLD) | apy-or-baseline |
| 3 | nwisdom-nest | nWISDOM | 79.74 | 45 | Nest Wisdom Vault NAV (WisdomTree-backed strategy) | apy-or-baseline |
| 4 | zchf-frankencoin | ZCHF | 3.50 | 27 | Frankencoin Savings | apy-or-baseline |
| 5 | usdg-paxos | USDG | 6.69 | 26 | Aave v3 (ethereum) | apy-or-baseline |
| 6 | usdat-saturn | USDat | 19.76 | 24 | Saturn staking (sUSDat) | apy-or-baseline |
| 7 | djed-coti | DJED | 12.03 | 23 | Liqwid | apy-or-baseline |
| 8 | apyusd-apyx | apyUSD | 19.11 | 22 | Apyx apyUSD vault | apy-or-baseline |
| 9 | nusd-neutrl | NUSD | 8.53 | 22 | Neutrl savings (sNUSD) | apy-or-baseline |
| 10 | usdn-smardex | USDN | 8.04 | 21 | SMARDEX USDN rebasing vault | apy-or-baseline |
| 11 | lusd-liquity | LUSD | 2.59 | 21 | B.Protocol Stability Pool (LQTY only) | apy-or-baseline |
| 12 | apxusd-apyx | apxUSD | 14.42 | 20 | Pendle: APYX apxUSD | apy-or-baseline |
| 13 | pyusd-paypal | PYUSD | 4.25 | 20 | Aave v3 (ethereum) | apy-or-baseline |
| 14 | dai-makerdao | DAI | 3.93 | 19 | Yearn: DAI-1 yVault | apy-or-baseline |
| 15 | ausd-agora | AUSD | 7.42 | 18 | Upshift | apy-or-baseline |
| 16 | usdp-parallel | USDp | 6.47 | 18 | Parallel Savings (sUSDp) | apy-or-baseline |
| 17 | iusd-indigo-protocol | iUSD | 5.13 | 16 | Liqwid | apy-or-baseline |
| 18 | usdc-circle | USDC | 3.47 | 16 | Aave v3 (ethereum) | apy-or-baseline |
| 19 | luausd-lumi-finance | LUAUSD | 16.55 | 14 | Lumi Finance LUAUSD NAV mechanics | apy-or-baseline |
| 20 | frxusd-frax | FRXUSD | 10.17 | 14 | Morpho Blue | apy-or-baseline |

## Top 20 After

| rank | id | symbol | APY 30d | PYS | source | driver |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | cetes-etherfuse | CETES | 154.64 | 100 | Mexican government CETES bonds | apy-or-baseline |
| 2 | bold-liquity | BOLD | 7.98 | 73 | Liquity Stability Pool (via Yearn yBOLD) | apy-or-baseline |
| 3 | nwisdom-nest | nWISDOM | 79.74 | 45 | Nest Wisdom Vault NAV (WisdomTree-backed strategy) | apy-or-baseline |
| 4 | zchf-frankencoin | ZCHF | 3.50 | 27 | Frankencoin Savings | apy-or-baseline |
| 5 | usdg-paxos | USDG | 6.69 | 26 | Aave v3 (ethereum) | apy-or-baseline |
| 6 | usdat-saturn | USDat | 19.76 | 24 | Saturn staking (sUSDat) | apy-or-baseline |
| 7 | djed-coti | DJED | 12.03 | 23 | Liqwid | apy-or-baseline |
| 8 | apyusd-apyx | apyUSD | 19.11 | 22 | Apyx apyUSD vault | apy-or-baseline |
| 9 | nusd-neutrl | NUSD | 8.53 | 22 | Neutrl savings (sNUSD) | apy-or-baseline |
| 10 | usdn-smardex | USDN | 8.04 | 21 | SMARDEX USDN rebasing vault | apy-or-baseline |
| 11 | lusd-liquity | LUSD | 2.59 | 21 | B.Protocol Stability Pool (LQTY only) | apy-or-baseline |
| 12 | apxusd-apyx | apxUSD | 14.42 | 20 | Pendle: APYX apxUSD | apy-or-baseline |
| 13 | pyusd-paypal | PYUSD | 4.25 | 20 | Aave v3 (ethereum) | apy-or-baseline |
| 14 | dai-makerdao | DAI | 3.93 | 19 | Yearn: DAI-1 yVault | apy-or-baseline |
| 15 | ausd-agora | AUSD | 7.42 | 18 | Upshift | apy-or-baseline |
| 16 | usdp-parallel | USDp | 6.47 | 18 | Parallel Savings (sUSDp) | apy-or-baseline |
| 17 | iusd-indigo-protocol | iUSD | 5.13 | 16 | Liqwid | apy-or-baseline |
| 18 | usdc-circle | USDC | 3.47 | 16 | Aave v3 (ethereum) | apy-or-baseline |
| 19 | luausd-lumi-finance | LUAUSD | 16.55 | 14 | Lumi Finance LUAUSD NAV mechanics | apy-or-baseline |
| 20 | frxusd-frax | FRXUSD | 10.17 | 14 | Morpho Blue | apy-or-baseline |

## Largest Rank Movers

| before | after | delta | id | symbol | before PYS | after PYS | driver | source penalty |
| ---: | ---: | ---: | --- | --- | ---: | ---: | --- | ---: |
| 3 | 3 | 0 | nwisdom-nest | nWISDOM | 45 | 45 | apy-or-baseline | 1 |
| 1 | 1 | 0 | cetes-etherfuse | CETES | 100 | 100 | apy-or-baseline | 1 |
| 2 | 2 | 0 | bold-liquity | BOLD | 73 | 73 | apy-or-baseline | 1 |
| 12 | 12 | 0 | apxusd-apyx | apxUSD | 20 | 20 | apy-or-baseline | 1 |
| 15 | 15 | 0 | ausd-agora | AUSD | 18 | 18 | apy-or-baseline | 1 |
| 20 | 20 | 0 | frxusd-frax | FRXUSD | 14 | 14 | apy-or-baseline | 1 |
| 8 | 8 | 0 | apyusd-apyx | apyUSD | 22 | 22 | apy-or-baseline | 1 |
| 24 | 24 | 0 | dola-inverse-finance | DOLA | 13 | 13 | apy-or-baseline | 1 |
| 35 | 35 | 0 | zys-zephyr-protocol | ZYS | 10 | 10 | apy-or-baseline | 1 |
| 22 | 22 | 0 | usd3-reserve-protocol | USD3 | 13 | 13 | apy-or-baseline | 1 |
| 13 | 13 | 0 | pyusd-paypal | PYUSD | 20 | 20 | apy-or-baseline | 1 |
| 43 | 43 | 0 | usp-pikudao | USP | 9 | 9 | apy-or-baseline | 1 |
| 39 | 39 | 0 | xaut-tether | XAUT | 10 | 10 | apy-or-baseline | 1 |
| 4 | 4 | 0 | zchf-frankencoin | ZCHF | 27 | 27 | apy-or-baseline | 1 |
| 45 | 45 | 0 | usdsui-sui | USDsui | 9 | 9 | apy-or-baseline | 1 |
| 9 | 9 | 0 | nusd-neutrl | NUSD | 22 | 22 | apy-or-baseline | 1 |
| 5 | 5 | 0 | usdg-paxos | USDG | 26 | 26 | apy-or-baseline | 1 |
| 7 | 7 | 0 | djed-coti | DJED | 23 | 23 | apy-or-baseline | 1 |
| 6 | 6 | 0 | usdat-saturn | USDat | 24 | 24 | apy-or-baseline | 1 |
| 37 | 37 | 0 | reusd-re-protocol | reUSD | 10 | 10 | apy-or-baseline | 1 |

## Golden Fixture List

| fixture | required assertion |
| --- | --- |
| reward-heavy | high rewardShare produces a driver label and cannot improve from source-risk treatment alone |
| stale | stale sourceAgeSeconds produces a freshness driver when it is the largest penalty |
| low-depth | low sourceDepthRatio produces a depth driver and avoids top-rank promotion from APY alone |
| source-switch | sourceSwitchCount30d or provenance.sourceSwitch labels churn-driven movement |
| bootstrap | low observationCount30d labels bootstrap uncertainty without breaking seed rows |
| negative-zero | zero or negative APY scores 0 and preserves deterministic rank behavior |
| missing-safety | null safetyScore keeps existing default-safety behavior and records coverage |

## Implementation Notes

- Feed this script a saved `/api/yield-rankings` response; if the payload predates public `sourceRisk.*` fields, treat null-rate coverage as a production baseline rather than final v8 source-risk calibration.
- Keep scratch calibration reports under `/agents/`; committed rollout evidence belongs under `docs/process/`.
- Pair production-snapshot reports with golden-fixture evidence when live payloads do not yet include populated source-risk fields.
