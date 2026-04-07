# Effective Exit Score: Best-Path + Diversification Model

**Date:** 2026-04-07
**Status:** Approved
**Scope:** Replace the weighted-blend effective exit formula with a best-path model

---

## Problem

The current effective exit score blends DEX liquidity and redemption backstop scores using fixed weights (`dex × 0.55 + redemption × 0.45`), with DEX acting as a floor via `max()`. This creates three concrete problems:

1. **Thin DEX actively hurts strong redemption coins.** Example with iUSD (DEX=41, redemption=70): the blend produces 54, while having *no* DEX data would yield `min(70, 70 × 0.75) = 52`. More exit options should never lower the score.

2. **The blend structurally devalues the dominant exit path.** CeFi and DeFi coins that invest in strong redemption infrastructure (permissionless onchain redeem, PSM swaps, collateral redeem) see their scores dragged down by moderate DEX liquidity. DAI with a 100-score PSM and DEX=63 currently scores only 80.

3. **Perverse incentives.** The blend rewards averaging two mediocre paths over having one excellent path, which doesn't reflect how users actually exit positions.

External feedback confirmed this: *"Averaging seems like the wrong approach. Teams are going to optimize for an either/or solution."*

## Design

### New Formula

Replace the weighted blend with a **best-path + diversification bonus** model:

```
Both paths exist:
  bestPath  = max(dex, redemption)
  bonus     = min(dex, redemption) × DIVERSIFICATION_FACTOR  // 0.10
  effective = min(100, round(bestPath + bonus))

DEX only:        round(dex)
Redemption only: round(redemption)       // no cap, no discount
Neither:         null
```

### Constants

**Removed:**
- `EFFECTIVE_EXIT_WEIGHTS = { liquidity: 0.55, redemption: 0.45 }` — deleted entirely

**Added:**
- `EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR = 0.10`

Redemption-only coins now use the raw redemption backstop score with no cap or discount — removing both the old implicit cap (70) and discount (×0.75). Existing guardrails prevent inflation:
- Route family caps: `offchain-issuer ≤ 65`, `queue-redeem ≤ 70`
- Component scoring penalizes restricted access (`issuer-api` = 40/100)
- Confidence gating excludes low-confidence routes from Safety Score uplift

### Core Principle

A user's exit quality equals their best available exit path. Having a second viable path is a diversification bonus, but a weak second path never drags the score down.

### Score Impact (live production data)

| Coin | DEX | Redeem | Route | Old | New | Delta |
|---|---|---|---|---|---|---|
| LUSD | 51 | 90 | collateral-redeem | 69 | 95 | +26 |
| iUSD | 41 | 70 | queue-redeem | 54 | 74 | +20 |
| USDC | 71 | 65 | offchain-issuer | 71 | 78 | +7 |
| USDT | 63 | 65 | offchain-issuer | 64 | 71 | +7 |
| DAI | 63 | 100 | psm-swap | 80 | 100 | +20 |
| frxUSD | 69 | 93 | stablecoin-redeem | 80 | 100 | +20 |
| BOLD | 67 | 88 | collateral-redeem | 76 | 95 | +19 |
| GHO | 61 | 98 | psm-swap | 78 | 100 | +22 |
| USDe | 56 | 71 | stablecoin-redeem | 63 | 77 | +14 |
| crvUSD | 66 | — | DEX-only | 66 | 66 | 0 |

Biggest beneficiaries: coins with strong permissionless redemption (DAI, GHO, frxUSD, LUSD, BOLD). DEX-only coins unaffected. CeFi offchain-issuer coins see modest uplift, appropriately capped by route family limits.

## Files to Change

### Core logic
- **`shared/lib/redemption-backstop-scoring.ts`** — Replace `EFFECTIVE_EXIT_WEIGHTS` with `EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR`. Rewrite `computeEffectiveExitScore()` to use best-path + bonus formula. Remove redemption-only cap/discount.

### Tests
- **`shared/lib/__tests__/redemption-backstop-scoring.test.ts`** — Rewrite all `computeEffectiveExitScore` test cases to match new formula. Add monotonicity test (adding any path never lowers score). Add diversification bonus tests.

### Version
- **`shared/lib/redemption-backstop-version.ts`** — Add v3.7 changelog entry documenting the model change from weighted blend to best-path + diversification.

### Methodology page
- **`src/app/methodology/sections/core/safety-scores-section.tsx`** — Update the "Redemption Backstop and Effective Exit" section (~lines 197-216): replace formula display, update prose to explain best-path model.

### Documentation
- **`docs/redemption-backstops.md`** — Update formula description (~lines 88-95), update `effectiveExitWeights` API reference to reflect new constants.
- **`docs/report-cards.md`** — Update "Liquidity / Exit Details" section (~lines 43-57) with new formula and rationale.

### API methodology response
- **`worker/src/lib/redemption-backstops-store.ts`** — The `buildMethodology()` function (line ~429) exposes `effectiveExitWeights: { liquidity, redemption }` using the old `EFFECTIVE_EXIT_WEIGHTS` import. Replace with `effectiveExitModel: { diversificationFactor: 0.10, model: "best-path" }`. Update the import from `EFFECTIVE_EXIT_WEIGHTS` to `EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR`.

### Snapshot test (recomputes the score)
- **`worker/src/lib/__tests__/report-cards-snapshot.test.ts`** — Line 264: `effectiveExitScore` assertion changes from 56 → 91 (max(29,88) + min(29,88)×0.10). Line 265: `dimensions.liquidity.score` assertion changes from 56 → 91. Optionally update mock input at line 228 for consistency.

### API test (reads pre-stored value, no formula logic)
- **`worker/src/api/__tests__/redemption-backstops.test.ts`** — The assertion at line 114 checks a DB fixture value (56), not a computed value. No change needed — this tests serialization, not computation.

### No changes needed
- `shared/lib/report-card-peg-liquidity.ts` — calls `computeEffectiveExitScore()` with same signature
- `shared/lib/report-card-core.ts` — dimension weights unchanged
- `shared/lib/report-card-overall.ts` — unchanged
- `worker/src/lib/report-cards-snapshot.ts` — unchanged
- `shared/types/report-cards.ts` — unchanged
- `src/components/report-card.tsx` — display only, no formula logic
- `src/components/stablecoin-detail/redemption-backstop-card.tsx` — display only
- Worker cron pipeline — same interface

## Decisions Log

| Decision | Choice | Rationale |
|---|---|---|
| Blend vs best-path | Best-path | Blending penalizes specialization; users exit via best path |
| Diversification factor | 0.10 (10%) | Modest bonus for having multiple paths without inflating scores |
| Redemption-only cap | None | Route family caps (65/70) and component scoring are sufficient guardrails |
| Access model double-counting | No | Redemption backstop score already penalizes restricted access at 20% weight |
| Diversification bonus shape | Flat (linear) | Simpler than scaled/tiered alternatives; difference is minimal in practice |
