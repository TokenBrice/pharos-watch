# Yield PYS v8 Production-Snapshot Calibration Artifact

Generated: 2026-05-13T18:25:23.000Z

Scope: production-snapshot calibration for the methodology v8 PYS source-risk layer. The input is the public site-data `/yield-rankings` payload captured on 2026-05-13 after publication generation `yield-1778696402` (`updatedAt = 1778696402`, 2026-05-13T18:20:02.000Z) emitted populated nested `sourceRisk.*` fields. Golden-fixture source-risk driver evidence is recorded in `docs/process/yield-pys-v8-calibration-2026-05-13.md`. This artifact is evidence only and does not change runtime behavior.

## Candidate Formula For Analysis

```text
sourceRiskPenalty = clamp(row.sourceRisk?.sourceRiskPenalty ?? legacy row.sourceRiskPenalty ?? derivedNeutralPenalty, 1, 2.5)
sourceAdjustedUtility = current effectiveYield / sourceRiskPenalty
yieldEfficiency = sourceAdjustedUtility / adjustedRiskPenalty
pysV8 = clamp(round(yieldEfficiency * sustainabilityMultiplier * scalingFactor), 0, 100)
```

Unknown source-risk inputs are neutral. The before column recomputes the v7 baseline without source-risk penalties; the after column applies the v8 candidate penalty.

## Distribution

Rows analyzed: 131

| metric | PYS v8 candidate |
| --- | ---: |
| p10 | 1 |
| p50 | 6 |
| p90 | 15 |
| max | 100 |

## Capped Scores

| side | count capped at 100 |
| --- | ---: |
| before | 1 |
| after | 1 |

## Null-Rate Coverage

| field | present | null/missing | null rate |
| --- | ---: | ---: | ---: |
| sourceRiskPenalty | 131 | 0 | 0.0% |
| rewardShare | 35 | 96 | 73.3% |
| sourceDepthRatio | 90 | 41 | 31.3% |
| sourceAgeSeconds | 131 | 0 | 0.0% |
| sourceSwitchCount30d | 131 | 0 | 0.0% |
| observationCount30d | 131 | 0 | 0.0% |
| venueRiskTier | 131 | 0 | 0.0% |

## Non-USD Cohort Checks

| cohort | rows | p50 PYS | p90 PYS | max PYS | capped at 100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| CHF | 1 | 27 | 27 | 27 | 0 |
| EUR | 4 | 6 | 9 | 9 | 0 |

## Top 20 Before

| rank | id | symbol | APY 30d | PYS | source | driver |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | cetes-etherfuse | CETES | 154.79 | 100 | Mexican government CETES bonds | stale |
| 2 | bold-liquity | BOLD | 8.01 | 73 | Liquity Stability Pool (via Yearn yBOLD) | apy-or-baseline |
| 3 | nwisdom-nest | nWISDOM | 79.18 | 44 | Nest Wisdom Vault NAV (WisdomTree-backed strategy) | stale |
| 4 | zchf-frankencoin | ZCHF | 3.50 | 27 | Frankencoin Savings | apy-or-baseline |
| 5 | usdat-saturn | USDat | 19.72 | 24 | Saturn staking (sUSDat) | source-switch |
| 6 | djed-coti | DJED | 12.03 | 23 | Liqwid | apy-or-baseline |
| 7 | apyusd-apyx | apyUSD | 19.13 | 22 | Apyx apyUSD vault | source-switch |
| 8 | nusd-neutrl | NUSD | 8.53 | 22 | Neutrl savings (sNUSD) | source-switch |
| 9 | usdn-smardex | USDN | 8.04 | 21 | SMARDEX USDN rebasing vault | apy-or-baseline |
| 10 | lusd-liquity | LUSD | 2.59 | 21 | B.Protocol Stability Pool (LQTY only) | reward-heavy |
| 11 | ausd-agora | AUSD | 7.43 | 20 | Upshift | apy-or-baseline |
| 12 | apxusd-apyx | apxUSD | 14.46 | 19 | Pendle: APYX apxUSD | source-switch |
| 13 | usdp-parallel | USDp | 6.47 | 19 | Parallel Savings (sUSDp) | apy-or-baseline |
| 14 | dai-makerdao | DAI | 3.93 | 19 | Yearn: DAI-1 yVault | apy-or-baseline |
| 15 | iusd-indigo-protocol | iUSD | 5.13 | 16 | Liqwid | apy-or-baseline |
| 16 | usdc-circle | USDC | 3.47 | 16 | Aave v3 (ethereum) | source-switch |
| 17 | frxusd-frax | FRXUSD | 10.19 | 15 | Morpho Blue | apy-or-baseline |
| 18 | usdg-paxos | USDG | 5.52 | 15 | Pendle: Global Dollar USDG | source-switch |
| 19 | luausd-lumi-finance | LUAUSD | 16.45 | 14 | Lumi Finance LUAUSD NAV mechanics | stale |
| 20 | usd3-reserve-protocol | USD3 | 12.86 | 13 | Reserve Protocol collateral yield | source-switch |

## Top 20 After

| rank | id | symbol | APY 30d | PYS | source | driver |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 1 | cetes-etherfuse | CETES | 154.79 | 100 | Mexican government CETES bonds | stale |
| 2 | bold-liquity | BOLD | 8.01 | 73 | Liquity Stability Pool (via Yearn yBOLD) | apy-or-baseline |
| 3 | nwisdom-nest | nWISDOM | 79.18 | 35 | Nest Wisdom Vault NAV (WisdomTree-backed strategy) | stale |
| 4 | zchf-frankencoin | ZCHF | 3.50 | 27 | Frankencoin Savings | apy-or-baseline |
| 5 | djed-coti | DJED | 12.03 | 23 | Liqwid | apy-or-baseline |
| 6 | usdn-smardex | USDN | 8.04 | 21 | SMARDEX USDN rebasing vault | apy-or-baseline |
| 7 | ausd-agora | AUSD | 7.43 | 20 | Upshift | apy-or-baseline |
| 8 | usdp-parallel | USDp | 6.47 | 19 | Parallel Savings (sUSDp) | apy-or-baseline |
| 9 | dai-makerdao | DAI | 3.93 | 19 | Yearn: DAI-1 yVault | apy-or-baseline |
| 10 | usdat-saturn | USDat | 19.72 | 18 | Saturn staking (sUSDat) | source-switch |
| 11 | nusd-neutrl | NUSD | 8.53 | 18 | Neutrl savings (sNUSD) | source-switch |
| 12 | apyusd-apyx | apyUSD | 19.13 | 17 | Apyx apyUSD vault | source-switch |
| 13 | iusd-indigo-protocol | iUSD | 5.13 | 16 | Liqwid | apy-or-baseline |
| 14 | apxusd-apyx | apxUSD | 14.46 | 15 | Pendle: APYX apxUSD | source-switch |
| 15 | frxusd-frax | FRXUSD | 10.19 | 15 | Morpho Blue | apy-or-baseline |
| 16 | lusd-liquity | LUSD | 2.59 | 14 | B.Protocol Stability Pool (LQTY only) | reward-heavy |
| 17 | dola-inverse-finance | DOLA | 11.59 | 13 | Inverse Finance Savings (sDOLA) | apy-or-baseline |
| 18 | usdg-paxos | USDG | 5.52 | 12 | Pendle: Global Dollar USDG | source-switch |
| 19 | usdc-circle | USDC | 3.47 | 12 | Aave v3 (ethereum) | source-switch |
| 20 | luausd-lumi-finance | LUAUSD | 16.45 | 11 | Lumi Finance LUAUSD NAV mechanics | stale |

## Largest Rank Movers

| before | after | delta | id | symbol | before PYS | after PYS | driver | source penalty |
| ---: | ---: | ---: | --- | --- | ---: | ---: | --- | ---: |
| 42 | 26 | 16 | zys-zephyr-protocol | ZYS | 9 | 9 | apy-or-baseline | 1 |
| 37 | 51 | -14 | xaut-tether | XAUT | 10 | 7 | reward-heavy | 1.50 |
| 43 | 57 | -14 | usdsui-sui | USDsui | 9 | 6 | reward-heavy | 1.49 |
| 56 | 70 | -14 | susdai-usd-ai | sUSDai | 7 | 5 | source-switch | 1.30 |
| 55 | 69 | -14 | aznd-mu-digital | AZND | 7 | 5 | source-switch | 1.20 |
| 54 | 68 | -14 | yousd-yield-optimizer | yoUSD | 7 | 5 | source-switch | 1.30 |
| 35 | 23 | 12 | reusd-re-protocol | reUSD | 10 | 10 | apy-or-baseline | 1 |
| 50 | 61 | -11 | rlusd-ripple | RLUSD | 8 | 6 | source-switch | 1.45 |
| 69 | 58 | 11 | usdh-native-markets | USDH | 6 | 6 | apy-or-baseline | 1 |
| 67 | 56 | 11 | hyusd-hylo | HYUSD | 7 | 7 | apy-or-baseline | 1 |
| 66 | 55 | 11 | ustb-superstate | USTB | 7 | 7 | apy-or-baseline | 1 |
| 64 | 75 | -11 | susds-sky | sUSDS | 7 | 5 | source-switch | 1.30 |
| 65 | 76 | -11 | usdy-ondo-finance | USDY | 7 | 5 | source-switch | 1.30 |
| 44 | 54 | -10 | dusd-dtrinity | dUSD | 9 | 7 | source-switch | 1.30 |
| 49 | 59 | -10 | savusd-avant | savUSD | 8 | 6 | source-switch | 1.40 |
| 74 | 65 | 9 | eurcv-societe-generale-forge | EURCV | 6 | 6 | apy-or-baseline | 1 |
| 72 | 63 | 9 | wsrusd-reservoir | wsrUSD | 6 | 6 | apy-or-baseline | 1 |
| 73 | 82 | -9 | usdd-tron-dao-reserve | USDD | 6 | 4 | reward-heavy | 1.50 |
| 57 | 49 | 8 | yzusd-yuzu | YZUSD | 7 | 7 | apy-or-baseline | 1 |
| 25 | 33 | -8 | acred-apollo-securitize | ACRED | 12 | 9 | stale | 1.25 |

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

- This report uses a saved public site-data rankings response. The ranking payload included top-level `methodology.version = "8.0"`, top-level publication metadata, 131 row-level `publicationGenerationId` values, and 131 populated nested `sourceRisk` objects.
- The history site-data lane still had zero populated `publicationGenerationId` and zero populated `sourceRisk` history points for `usdt-tether` at capture time; history remains legacy/null-safe until a Worker deployment and subsequent publication writes history rows with generation metadata.
- Keep scratch calibration reports under `/agents/`; committed rollout evidence belongs under `docs/process/`.
- Pair production-snapshot reports with golden-fixture evidence because live rankings cannot cover every driver edge case.
