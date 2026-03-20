# Redemption Backstop Fee Clarity Plan

## Context

GitHub issue [#35](https://github.com/TokenBrice/stablecoin-dashboard/issues/35) reports that the stablecoin detail Redemption Backstop card is unclear about redemption fees. The access dimension already explains who can redeem well enough, so this pass should focus on making fee treatment explicit without changing the broader scoring model.

## Scope

- Add a clear fee summary to the detail-page redemption backstop card
- Keep the existing access block and component subscores intact
- Document the updated card behavior in the verified docs
- Add a focused rendering test for the new fee summary

## Implementation Steps

1. Add a small fee-summary helper in `src/components/stablecoin-detail/redemption-backstop-card.tsx`.
2. Render a dedicated `Redemption Fee` block that:
   - shows exact basis points and percent when `feeBps` is configured
   - otherwise states that the fee is variable / not explicitly modeled
   - preserves room for a future manual/unbounded branch
3. Add a component test covering both configured-fee and unknown-fee render paths.
4. Update `docs/redemption-backstops.md` and `docs/stablecoin-detail-page.md`.
5. Verify with targeted tests, lint, and build/type checks.
