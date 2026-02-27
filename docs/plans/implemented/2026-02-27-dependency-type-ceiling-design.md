# Dependency Type Classification with Score Ceilings

**Date:** 2026-02-27
**Status:** Approved

## Problem

The current dependency scoring system uses collateral weight alone to determine how much an upstream stablecoin affects a dependent coin's score. This misses cases where the dependency is more critical than the collateral weight implies:

- **Pure wrappers** (syrupUSDC → USDC): The coin's entire value derives from the upstream.
- **Mechanism-critical** (DAI → USDC via PSM): The upstream is essential to the peg mechanism, even if it's a minority of collateral.

Example: DAI is 35% USDC-backed. If USDC degrades to score 60, DAI's current dependency score is `0.35×60 + 0.65×75 = 69.75`. But DAI's PSM (its primary peg keeper) would be broken — the score should reflect that DAI can't outscore its critical dependency.

## Solution

Add a `type` field to each `DependencyWeight` entry. After computing the existing blended score, apply a ceiling based on the most critical upstream dependencies.

### Data Model

```typescript
export type DependencyType = 'wrapper' | 'mechanism' | 'collateral';

export interface DependencyWeight {
  id: string;
  weight: number;
  type?: DependencyType;  // default: 'collateral'
}
```

### Type Definitions

| Type | Meaning | Ceiling | Example |
|---|---|---|---|
| `wrapper` | Coin is a thin layer around upstream | upstream_score - 3 | syrupUSDC → USDC |
| `mechanism` | Upstream is critical to peg mechanism | upstream_score | DAI → USDC (PSM) |
| `collateral` | Standard collateral relationship | none (current behavior) | USDe → USDC (15%) |

### Scoring Formula

After the existing blended score computation:

```
WRAPPER_PENALTY = 3

ceiling = +Infinity
for each resolved dependency:
  if type == 'wrapper':  ceiling = min(ceiling, upstream_score - WRAPPER_PENALTY)
  if type == 'mechanism': ceiling = min(ceiling, upstream_score)

// Apply weak-dep penalty before ceiling
if any upstream < 75: score -= 10

final_score = min(score, ceiling)
final_score = clamp(0, 100)
```

### Example: Normal Conditions (USDC = 95)

| Coin | Deps | Blended | Ceiling | Final | Old |
|---|---|---|---|---|---|
| syrupUSDC | USDC 1.0 wrapper | 95 | 92 | **92** | 95 |
| DAI | USDC 0.35 mechanism | 82 | 95 | **82** | 82 |
| reUSD | crvUSD 0.95 wrapper | ~crvUSD | crvUSD-3 | **crvUSD-3** | ~crvUSD |
| USDe | USDT+USDC 0.15 collat | 81 | none | **81** | 81 |

### Example: USDC Degrades to 60

| Coin | Blended | Ceiling | Final | Old |
|---|---|---|---|---|
| syrupUSDC | 60 | 57 | **57** | 60 |
| DAI | 69.75 | 60 | **60** | 69.75 |
| USDe | 75 | none | **75** | 75 |

## Data Curation

Most existing dependencies remain `collateral` (the default). Key reclassifications:

| Coin | Upstream | Type | Rationale |
|---|---|---|---|
| syrupUSDC | USDC | wrapper | Pure yield wrapper |
| DAI | USDC | mechanism | PSM is the peg keeper |
| reUSD | crvUSD | wrapper | Leveraged crvUSD loop |
| USDAI | USDC/USDT (via M0) | wrapper | Wraps underlying stables |
| FPI | FRAX | wrapper | 100% FRAX-backed |
| PUSD | USDC | wrapper | 100% USDC-backed |
| scUSD | various | wrapper/collateral | Wraps multiple stablecoins |

Full classification requires reviewing all 64 dependency entries in `stablecoins.ts`.

## Affected Code

1. **`src/lib/types.ts`** — Add `DependencyType`, update `DependencyWeight`
2. **`src/lib/report-cards.ts`** — Add ceiling logic to `scoreDependencyRisk()`, update detail text
3. **`src/lib/stablecoins.ts`** — Add `type` field to dependencies that need reclassification
4. **`worker/src/api/report-cards.ts`** — No changes needed (type flows through existing `rawInputs.dependencies`)
5. **Stress test** — Automatically benefits (calls `scoreDependencyRisk()` which now applies ceilings)
6. **UI detail text** — Show dependency type in the breakdown string

## Out of Scope

- Multi-hop recursive dependency resolution
- Automated dependency type detection
- Topological sort for Phase 2 ordering
- Dependency map visual edge style changes (can be done later)
