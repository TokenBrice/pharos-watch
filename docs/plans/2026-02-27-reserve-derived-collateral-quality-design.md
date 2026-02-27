# Reserve-Derived Collateral Quality Scoring

## Problem

The Safety Score Resilience dimension classifies collateral quality using a coarse 5-tier enum (`native`, `eth-lst`, `rwa`, `alt-lst-bridged-or-mixed`, `exotic`), inferred from `backing + governance` flags. This frequently misrepresents coins with curated reserve compositions. ZCHF is the motivating example: its reserves are 45% wrapped BTC + 30% ETH/LSTs + 10% gold + 15% exotic, but it's labeled "Alt-L1 LSTs / Bridged / Mixed" (score 20) — far too harsh for a portfolio that's 75% blue-chip crypto.

Now that ~94 stablecoins have curated reserve compositions, we should derive the collateral quality score from that data rather than a blunt enum.

## Design

### 1. Expand ReserveRisk from 3 to 5 tiers

The current 3-tier system (`low` / `medium` / `high`) can't distinguish USDC from delta-neutral perp strategies — both are "medium." The tiers measure **collateral quality** (counterparty risk, verifiability, trust assumptions), not price volatility.

| Tier | Quality Score | Definition | Examples |
|------|--------------|-----------|----------|
| `very-low` | 100 | No/minimal counterparty risk | Native ETH, native BTC, government securities, cash, repos, physical gold/silver |
| `low` | 75 | One trusted party, well-audited | ETH LSTs (wstETH, rETH), major stablecoins (USDC, USDT), BUIDL, USTB, sDAI |
| `medium` | 50 | Moderate counterparty/complexity | Wrapped cross-chain (WBTC, tBTC), established DeFi (Aave), transparent tokenized RWAs |
| `high` | 25 | Significant trust assumptions | Alt-L1 tokens (BNB, SOL, DOT), alt-L1 LSTs, bridged altcoins, opaque RWAs, delta-neutral strategies |
| `very-high` | 5 | Maximum trust/complexity risk | Governance tokens, leveraged/exotic strategies, algorithmic mechanisms, opaque assets |

**Type change** in `src/lib/types.ts`:
```typescript
export type ReserveRisk = "very-low" | "low" | "medium" | "high" | "very-high";
```

### 2. Computed Collateral Quality Score

New function in `src/lib/report-cards.ts`:

```typescript
const RESERVE_QUALITY_SCORE: Record<ReserveRisk, number> = {
  "very-low": 100, low: 75, medium: 50, high: 25, "very-high": 5,
};

function computeCollateralQualityFromReserves(reserves: ReserveSlice[]): number {
  const totalPct = reserves.reduce((s, r) => s + r.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce(
    (s, r) => s + r.pct * RESERVE_QUALITY_SCORE[r.risk], 0,
  );
  return Math.round(weighted / totalPct);
}
```

### 3. Integration into Resilience Scoring

In `scoreResilience()`:

1. If the coin has curated reserves (`meta.reserves?.length > 0`), compute the weighted score from slices.
2. Otherwise, fall back to the existing `CollateralQuality` enum inference (from `backing + governance`).

The `collateralQuality` enum field on `StablecoinMeta` and the `inferResilienceDefaults()` function remain unchanged — they serve as the fallback for coins without curated reserves.

### 4. Graceful Score Display

The Resilience detail string maps the computed score back to a human label using the tier whose score is closest, plus the actual number:

```
Collateral: Low risk (78/100)
```

Format: `"Collateral: {tier label} ({score}/100)"`. The tier label comes from the 5-tier names:

| Tier | Display Label |
|------|--------------|
| `very-low` | Very low risk |
| `low` | Low risk |
| `medium` | Medium risk |
| `high` | High risk |
| `very-high` | Very high risk |

The nearest-tier lookup uses score midpoints: ≥88 → very-low, ≥62 → low, ≥37 → medium, ≥15 → high, <15 → very-high.

### 5. Treemap Visualization (5 colors)

Update `RISK_COLORS` and `RISK_LABELS` in `src/components/reserve-treemap.tsx`:

| Tier | Color | Hex |
|------|-------|-----|
| `very-low` | Dark green | `#16a34a` |
| `low` | Green | `#22c55e` |
| `medium` | Amber | `#f59e0b` |
| `high` | Orange | `#f97316` |
| `very-high` | Red | `#ef4444` |

Legend displays all 5 tiers.

### 6. Migration: 3-tier → 5-tier Reserve Slices

Re-classify all ~350 existing reserve slices in `src/lib/stablecoins.ts` and `src/lib/reserve-templates.ts`. The migration rules:

| Old tier | New tier | Condition |
|----------|----------|-----------|
| `low` | `very-low` | Government securities, cash, repos, physical precious metals, native ETH/BTC |
| `low` | `low` | Major stablecoins acting as reserves (rare in current `low`) |
| `medium` | `low` | Major stablecoins (USDC, USDT), top tokenized treasuries (BUIDL, USTB), ETH LSTs, sDAI |
| `medium` | `medium` | Wrapped cross-chain (WBTC, tBTC, cbBTC), established DeFi positions, transparent RWAs |
| `medium` | `high` | Delta-neutral strategies, alt-chain tokens used as collateral |
| `high` | `high` | Alt-L1 LSTs, opaque RWAs, complex DeFi |
| `high` | `very-high` | Governance tokens, exotic/leveraged strategies, algorithmic, opaque |

Produce a migration audit log committed as `docs/plans/2026-02-27-reserve-tier-migration-log.md` with columns: coin, slice name, old tier → new tier. This makes the migration reviewable.

### 7. Build-Time Drift Validation

Add a validation in `src/lib/report-cards.ts` (called during build via type-check or a test):

```typescript
function validateCollateralQualityDrift(coins: StablecoinMeta[]): string[] {
  const errors: string[] = [];
  for (const coin of coins) {
    if (!coin.reserves?.length) continue;
    const computed = computeCollateralQualityFromReserves(coin.reserves);
    const enumScore = COLLATERAL_QUALITY_SCORE[
      resolveResilienceFactors(coin).collateralQuality
    ];
    if (Math.abs(computed - enumScore) > 30) {
      errors.push(
        `${coin.symbol}: computed=${computed}, enum=${enumScore} (drift ${Math.abs(computed - enumScore)})`
      );
    }
  }
  return errors;
}
```

This catches future drift between curated reserves and the enum fallback — the exact ZCHF problem, caught automatically.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/types.ts` | Expand `ReserveRisk` to 5 tiers |
| `src/lib/report-cards.ts` | Add `computeCollateralQualityFromReserves()`, update `scoreResilience()` to use it, add drift validation, update display labels |
| `src/components/reserve-treemap.tsx` | 5 colors, 5 legend labels |
| `src/lib/stablecoins.ts` | Re-classify ~350 reserve slices |
| `src/lib/reserve-templates.ts` | Re-classify template slices |
| `docs/plans/2026-02-27-reserve-tier-migration-log.md` | Audit trail of all tier changes |

## What Does NOT Change

- `CollateralQuality` enum type and `inferResilienceDefaults()` — kept as fallback
- `StablecoinMeta.collateralQuality` field — still usable as override
- Reserve data structure (`ReserveSlice`) — same shape, just wider `risk` union
- Template resolution logic — unchanged
- Overall Resilience formula (4 equal-weight sub-factors) — unchanged

## ZCHF After This Change

| Slice | Old tier | New tier | Score |
|-------|----------|----------|-------|
| Wrapped Bitcoin (WBTC, cbBTC) 45% | medium | medium | 50 |
| ETH / wstETH / LsETH 30% | medium | low | 75 |
| Gold tokens (PAXG, XAUt) 10% | medium | medium | 50 |
| Tokenized RWAs (SPYon, LENDS, REALU) 10% | high | high | 25 |
| Other (CRV, GNO, governance tokens) 5% | high | very-high | 5 |

Weighted score: `(45×50 + 30×75 + 10×50 + 10×25 + 5×5) / 100 = 53.25 ≈ 53`

Old score: 20 (alt-lst-bridged-or-mixed). New score: 53. This better reflects a portfolio that's 75% blue-chip crypto with a small exotic tail.
