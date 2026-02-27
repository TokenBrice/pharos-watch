# Safety Score Redesign: Peg Stability as Multiplier

**Date**: 2026-02-27
**Status**: Approved

## Problem

Peg Stability (25% weight) doesn't differentiate stablecoins — most score 90-100, so it inflates everyone equally. Meanwhile, coins with truly broken pegs (sUSD at 10) aren't punished enough, and coins without DEX liquidity get 0 (an F) instead of NR.

## Design

### 1. Remove Peg Stability from base weighted sum

The overall score becomes a **4-factor base** with redistributed weights:

| Dimension | Old Weight | New Weight |
|---|---|---|
| Peg Stability | 25% | — (removed from base) |
| Liquidity | 20% | **27.8%** (25/90) |
| Resilience | 20% | **27.8%** (25/90) |
| Decentralization | 10% | **11.1%** (10/90) |
| Dependency Risk | 25% | **33.3%** (30/90) |

Stored weights: `{ liquidity: 0.25, resilience: 0.25, decentralization: 0.10, dependencyRisk: 0.30 }`. NR dimensions still redistribute proportionally among rated ones. Minimum 2 rated base dimensions required (was 3 of 5).

### 2. Apply Peg Stability as a power-curve multiplier

After computing the base score, apply: `final = base × (PSI / 100) ^ 0.20`

| PSI | Multiplier | Effect |
|---|---|---|
| 100 | 1.00 | No penalty |
| 95 | 0.99 | ~1% penalty |
| 90 | 0.98 | ~2% penalty |
| 80 | 0.96 | ~4% penalty |
| 65 (LUSD) | 0.92 | ~8% penalty |
| 10 (sUSD) | 0.63 | ~37% penalty |
| NR (NAV) | 1.00 | No penalty (peg N/A) |
| 0 (dead) | 0.00 | Zeroed out |

### 3. Lower grade thresholds by 5 points

Compensates for structural deflation from removing the typically-high peg dimension:

| Grade | Old Min | New Min |
|---|---|---|
| A+ | 97 | **92** |
| A | 93 | **88** |
| A- | 90 | **85** |
| B+ | 85 | **80** |
| B | 80 | **75** |
| B- | 75 | **70** |
| C+ | 70 | **65** |
| C | 65 | **60** |
| C- | 60 | **55** |
| D | 50 | **45** |
| F | 0 | 0 |

### 4. Methodology version bump

v3.3 → v4.0 (major scoring model change).

## Key outcomes (simulated)

- **BOLD**: 91 A → 87 A (sole A-tier coin)
- **LUSD**: 79 B → 76 B+ (rewarded for elite resilience/decentralization)
- **USDC**: 79 B → 75 B+ (top liquidity)
- **USDT/DAI**: 79/78 B → 74/73 B (stable)
- **fxUSD**: 77 B → 71 B (stable)
- **sUSD**: 53 C → 42 D/F (properly punished)

## Files to change

1. `src/lib/report-cards.ts` — weights, thresholds, `computeOverallGrade()`, version
2. `src/lib/types.ts` — `DimensionKey` type (remove `pegStability` from weights, keep as dimension)
3. `worker/src/api/report-cards.ts` — methodology response (weights no longer include pegStability)
4. `src/app/about/page.tsx` — methodology section (new formula description, updated weights/thresholds)
5. `docs/report-cards.md` — full methodology docs update
6. `src/components/report-card.tsx` — radar chart still shows all 5 dimensions (no change needed)
