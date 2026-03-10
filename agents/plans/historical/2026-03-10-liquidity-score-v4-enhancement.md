# Liquidity Score v4 Enhancement Design

**Date:** 2026-03-10
**Current version:** 3.4
**Target version:** 4.0
**Status:** Approved for implementation

## Problem Statement

The liquidity scoring model (v2-v3.x) systematically compresses scores in the mid-tier. Even USDC/USDT can't reach 100, while stablecoins with objectively deep liquidity (crvUSD at $543M TVL, GHO at $22M across 4 chains) score barely above passing. Three calibration problems drive this:

1. **Volume/Activity uses a linear scale** where 50% daily V/T = 100. The median coin scores 5/100 on this 20%-weighted component. 70% of coins score under 20. It's effectively dead weight for all but the top ~10 coins.
2. **Cross-chain component penalizes single-chain coins** with a hard floor of 15/100. This measures deployment breadth, not liquidity depth. Chain concentration risk is already captured by report card resilience scoring.
3. **Durability is dragged down by noisy organic fraction** (35% weight) and a dead locked-liquidity signal (5% weight, null for every coin). DAI scores 45 durability despite being one of the oldest, most established stablecoins — because DeFiLlama classifies 79% of its pool APY as reward-driven, unable to distinguish mercenary farming from permanent protocol-owned liquidity.

## Changes

### Change 1: Log-scale Volume/Activity

**Current formula:**
```
volumeActivity = min(100, vtRatio * 200)   // 50% V/T = 100
```

**Proposed formula:**
```
volumeActivity = min(100, max(0, 33.3 * log10(max(vtRatio, 0.001) / 0.005)))
```

Calibration anchors:

| V/T ratio | Current | Proposed | Interpretation |
|:---------:|:-------:|:--------:|----------------|
| 0.5% | 1 | ~13 | Minimal but liquidity exists |
| 2% | 4 | ~40 | Low activity, adequate depth |
| 5% | 10 | ~56 | Healthy turnover |
| 15% | 30 | ~78 | Very active |
| 50% | 100 | ~100 | Exceptional (USDC/USDT tier) |

**Rationale:** Trading velocity follows a power-law distribution, same as TVL. The TVL Depth component already uses a log scale that works well — volume should too. The median volumeActivity would move from 5 to ~35, making the component contribute meaningfully across the board.

### Change 2: Remove Cross-chain Component

Remove the cross-chain component entirely and redistribute its 7.5% weight to TVL Depth (+5%) and Pool Quality (+2.5%).

**New composite weights:**

| Component | v3.4 | v4.0 |
|-----------|:----:|:----:|
| TVL Depth | 30% | **35%** |
| Volume Activity | 20% | 20% |
| Pool Quality | 20% | **22.5%** |
| Durability | 15% | 15% |
| Pair Diversity | 7.5% | 7.5% |
| ~~Cross-chain~~ | ~~7.5%~~ | **removed** |

**Rationale:** Cross-chain presence measures deployment strategy, not exit liquidity. A stablecoin's liquidity doesn't get deeper by being on more chains — the TVL depth and pool quality components already capture the aggregate benefit of multi-chain presence through higher effective TVL. Chain concentration risk belongs in resilience scoring (report cards), not liquidity scoring. Removing it avoids double-counting and stops penalizing legitimately deep single-chain stablecoins like LUSD.

### Change 3: Durability Sub-component Rework

Three sub-changes:

#### 3a. Remove locked liquidity sub-component

Every scored coin returns `null` for locked liquidity. The CoinGecko Onchain `locked_liquidity_percentage` field is not populated reliably enough to be a scoring input. Remove it.

#### 3b. Rebalance durability weights

Shift weight away from the noisy organic fraction signal toward our own measured history data.

| Sub-component | v3.4 | v4.0 | Data source |
|---------------|:----:|:----:|-------------|
| Organic fraction | 35% | **15%** | DeFiLlama APY decomposition (noisy, can't distinguish POL from mercenary) |
| TVL stability | 25% | **35%** | Our 30-day TVL history (reliable) |
| Volume consistency | 20% | **25%** | Our 30-day volume history (reliable) |
| Maturity | 15% | **25%** | Our pool age data (reliable) |
| ~~Locked liquidity~~ | ~~5%~~ | **removed** | No usable data |

History-measured signals go from 60% to 85% of durability.

#### 3c. Soften organic fraction curve

**Current formula:**
```
organicScore = min(100, organicFraction * 125)   // linear, 80% = 100
```

**Proposed formula:**
```
organicScore = min(100, sqrt(organicFraction) * 100)   // concave, diminishing returns
```

| Organic fraction | Current | Proposed |
|:----------------:|:-------:|:--------:|
| 10% | 13 | 32 |
| 21% (DAI) | 26 | 46 |
| 50% | 63 | 71 |
| 68% (USDC) | 85 | 82 |
| 85% (crvUSD) | 100 | 92 |
| 100% | 100 | 100 |

**Rationale:** The low end is punished far less while the top compresses slightly. The difference between 85% and 100% organic isn't meaningful enough to warrant a 15-point gap. Combined with the weight reduction to 15%, organic fraction becomes a gentle differentiator rather than a score-killer.

## Projected Impact

Estimated new scores for key stablecoins (rough projections):

| Coin | v3.4 Score | Projected v4.0 | Primary drivers |
|------|:----------:|:--------------:|-----------------|
| USDC | 96 | ~98 | Durability improvement from softened organic |
| USDT | 93 | ~95 | Same as USDC |
| crvUSD | 67 | ~78 | Volume log-scale (+9), cross-chain removal (+2) |
| GHO | 56 | ~65 | Volume log-scale (+7), cross-chain removal (+2) |
| DAI | 69 | ~79 | Volume log-scale (+7), durability fix (+4) |
| LUSD | 39 | ~47 | Cross-chain removal (+2), volume log-scale (+3) |
| FRAX | 52 | ~61 | Volume log-scale (+6), cross-chain removal (+1) |

The top stays near the top, the mid-tier spreads out meaningfully, and single-chain coins with real depth stop being unfairly penalized.

## Implementation Scope

### Code changes

- `worker/src/cron/dex-liquidity/pool-helpers.ts` — `computeLiquidityScore()`: new log-scale volume formula, remove cross-chain component, update weights
- `worker/src/cron/dex-liquidity/pool-helpers.ts` — `computeDurabilityScore()`: remove locked liquidity, rebalance sub-weights, sqrt organic curve
- `worker/src/cron/dex-liquidity/scoring.ts` — remove locked liquidity accumulation from `rebuildMetricsFromPools()` and `computeStablecoinScores()`
- `shared/lib/liquidity-score-version.ts` — add v4.0 changelog entry
- `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts` — update expected scores and component assertions
- `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts` — update scoring and durability test cases

### Documentation updates

- `docs/dex-liquidity.md` — update component table, weights, formulas, durability section
- `docs/methodology-page.md` — update if methodology page references specific formulas or weights

### No changes needed

- Storage schema — no new columns, no removed columns (locked_liq_pct can stay nullable and unused)
- API response shape — `scoreComponents` object drops `crossChain` key; consumers should already handle optional fields
- Frontend — the liquidity leaderboard table and detail cards render whatever components are present; no hardcoded cross-chain display logic to remove

## Methodology Version

This is a v4.0 bump (major) because it changes the composite weight structure and removes a scoring component. All three changes ship together as one version bump.
