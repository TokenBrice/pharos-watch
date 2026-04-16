# Primary-market exit bonus and core settlement rails plan

Date: 2026-04-16

## Goal

Give USDC and USDT appropriate recognition as cornerstone settlement assets without broadly inflating Safety Score ratings for thin issuer-backed coins.

The plan combines:

1. A bounded Safety Score Liquidity / Exit methodology change: documented offchain issuer redemption may add a diversification bonus only when DEX liquidity is already present.
2. A separate UI/ranking surface: "Core settlement rails" highlights very large, deeply deployed, self-backed, high-peg assets without changing their Safety Score directly.

## Assumptions

- Safety Score should still penalize centralized governance; this work should not hide the decentralization tradeoff.
- Documented issuer redemption should not replace missing or tiny DEX liquidity.
- USDC and USDT should receive a modest score bump, not an allowlisted grade override.
- The "core settlement rail" label is informational and should be derived from objective thresholds, not manual favoritism.

## Current state

Live snapshot used for planning:

- report cards updated at `2026-04-15 22:15:29 UTC`
- redemption backstops updated at `2026-04-15 21:15:56 UTC`

USDC:

- rank 15 among active assets
- overall `75 / B+`
- peg `93`
- Liquidity / Exit `71`
- resilience `90`
- decentralization `40`
- dependency risk `95`
- redemption backstop `65`, documented-bound, offchain issuer, eventual-only, currently excluded from Safety Score uplift

USDT:

- rank 33 among active assets
- overall `70 / B`
- peg `99`
- Liquidity / Exit `63`
- resilience `71`
- decentralization `40`
- dependency risk `95`
- redemption backstop `65`, documented-bound, offchain issuer, eventual-only, currently excluded from Safety Score uplift

## Option 1 implementation: bonus-only primary-market exit

### Policy

Allow documented offchain issuer eventual redemption to contribute only the second-path diversification bonus.

Current best-path formula:

`effectiveExit = min(100, max(dex, redemption) + min(dex, redemption) * 0.10)`

For eligible issuer-eventual routes, use a capped contribution:

`eligibleRedemptionScore = min(dexLiquidityScore, redemptionBackstopScore)`

That yields:

`effectiveExit = dexLiquidityScore + min(dexLiquidityScore, redemptionBackstopScore) * 0.10`

### Eligibility gates

The route must be:

- `routeFamily = offchain-issuer`
- `capacitySemantics = eventual-only`
- `capacityConfidence = documented-bound`
- `resolutionState = resolved`
- `modelConfidence != low`
- `score != null`
- `routeStatus` not `paused`, `degraded`, or `cohort-limited`
- DEX liquidity score present
- not in severe active depeg unless the existing strong live-direct route predicate passes

This means no-DEX assets still remain no-DEX; primary-market redemption cannot become a standalone liquidity substitute.

### Expected impact

Using the live snapshot and this bonus-only rule:

- 67 active assets have a non-null DEX score and eligible issuer-eventual route
- Liquidity / Exit delta among affected assets: min `0`, median `+5`, max `+7`, average `+4.87`
- Overall-score delta where changed: min `+1`, median `+2`, max `+3`, average `+1.70`
- 17 active assets change grade

USDC:

- Liquidity / Exit `71 -> 78`
- overall `75 -> 77`
- grade `B+ -> B+`

USDT:

- Liquidity / Exit `63 -> 69`
- overall `70 -> 72`
- grade `B -> B`

This is intentionally modest.

### Files

- `shared/lib/report-card-peg-liquidity.ts`
- `shared/lib/__tests__/report-cards.test.ts`
- `worker/src/lib/report-cards-snapshot-card.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `shared/lib/safety-score-version-data.ts`
- `docs/report-cards.md`
- `docs/report-cards-timeline.md`
- `docs/redemption-backstops.md`
- `src/app/methodology/page.tsx`
- `src/app/methodology/sections/core/safety-scores-section.tsx`
- `src/app/methodology/scoring-changelog/content-v7-0.tsx`

### Test cases

- documented-bound offchain issuer eventual route gets bonus when DEX exists
- same route does not score when DEX is unavailable
- non-issuer eventual-only route remains excluded
- low-confidence issuer route remains excluded
- severe active depeg still excludes issuer-eventual bonus
- immediate-bounded and queue route behavior unchanged
- report-card raw input `redemptionUsedForLiquidity` matches the new DEX-gated behavior

## Option 2 implementation: core settlement rails

### Policy

Add an informational "Core settlement rail" profile for assets that are unusually central to stablecoin settlement.

Proposed objective gates:

- active report card
- market cap at or above `$25B`
- at least `10` chains in the current stablecoins cache
- peg score at or above `90`
- Liquidity / Exit score at or above `60`
- dependency risk at or above `90`
- no upstream dependencies
- redemption backstop score present and non-low-confidence

With the current live data, this highlights USDC and USDT only.

### UI

Add three non-invasive surfaces on `/safety-scores/`:

- a compact "Core settlement rails" strip near the top of the page
- a "Core" sort button that puts core rails first, then falls back to overall score
- a small "Core rail" badge on matching `ReportCardMini` cards

This avoids changing the overall grade while making the two assets visible where users scan ratings.

### Files

- `src/app/safety-scores/view-model.ts`
- `src/app/safety-scores/view-model.test.ts`
- `src/app/safety-scores/client.tsx`
- `src/app/safety-scores/client.test.tsx`
- `src/components/report-card-mini.tsx`
- `src/components/__tests__/report-card-mini.test.tsx` if a focused test does not already exist
- optional docs update in `docs/report-cards.md` or `docs/stablecoin-detail-page.md` only if the badge becomes a durable methodology term

## Validation before implementation

Plan review results:

- Material issue checked: broad eventual-only redemption uplift would re-rate thin/no-DEX issuers. Resolved by using a bonus-only model that requires non-null DEX liquidity.
- Material issue checked: "core rail" could become a manual favoritism label. Resolved by using objective thresholds and deriving the label from live report-card + stablecoin cache inputs.
- Minor issue checked: the "Core" sort may not be obvious if the strip already highlights the assets. Acceptable because the sort is low-cost and reversible.
- Minor issue checked: the issuer bonus affects more assets than USDC/USDT. Acceptable because the maximum direct overall delta is only `+3` and no missing-liquidity asset gets upgraded.

Open issues above minor: none.

## Commit plan

1. Research/provenance batch:
   - plan and research notes
   - issuer source provenance from prior USDC/USDT redemption review
2. Safety Score methodology batch:
   - bonus-only primary-market exit code
   - tests
   - methodology version/docs/changelog
3. Core settlement UI batch:
   - derived core rail model
   - safety page strip/sort/badges
   - tests

## Post-implementation validation

Run at minimum:

- `npm test -- shared/lib/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts src/app/safety-scores/view-model.test.ts src/app/safety-scores/client.test.tsx`
- `npm run check:redemption-backstops`
- `npm run check:doc-sync`
- `npm run lint`
- `npm run typecheck`
- `npm run build`

If touched diffs are deploy-impacting, run `npm run test:merge-gate` before final handoff.

