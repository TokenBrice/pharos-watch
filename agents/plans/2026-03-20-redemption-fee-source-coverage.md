# Redemption Fee Source Coverage Plan

## Goal

Backfill docs-backed redemption-fee coverage for every asset currently modeled by the redemption backstop module, then surface that fee logic explicitly on the stablecoin detail card.

## Constraints

- Keep the scoring framework itself unchanged.
- Only use fixed `feeBps` when official docs support a bounded basis-point fee.
- For dynamic, conditional, flat-minimum, or undisclosed schedules, expose a descriptive fee string instead of false precision.
- Preserve existing route-family, access, settlement, execution, and capacity modeling unless the fee research directly invalidates the current cost assumption.

## Implementation

1. Inventory every configured redemption-backstop asset and map each one to its tracked docs / website links.
2. Review official docs or issuer pages for redemption-fee policy.
3. Split each route into one of three buckets:
   - fixed bounded fee
   - documented variable / conditional fee
   - public docs reviewed but no numeric schedule published
4. Extend the shared/API snapshot contract with `feeDescription` so non-fixed fees can be rendered explicitly.
5. Update the card copy to prefer docs-backed fee text over generic unknown-fee language.
6. Document the methodology impact and archive the per-asset findings in `/agents/research/`.

## Verification

- `npm test`
- `npm run lint`
- `npm run build`
- `npm run check:doc-counts`
- `cd worker && npx tsc --noEmit`
