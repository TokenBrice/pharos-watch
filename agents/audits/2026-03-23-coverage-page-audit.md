# Coverage Page Audit

Date: 2026-03-23

## Scope

- Verified `/coverage/` source mappings against the live public APIs.
- Recomputed feature summaries with the same local coverage helpers used by the page.
- Reviewed user-facing labels, legend coverage, and quick-filter usefulness.

## Live Verification

- Active coin universe on the page remains `161`.
- Coverage helpers matched the current live API payloads for:
  - peg summary
  - report cards
  - DEX liquidity
  - redemption backstops
  - yield rankings
  - mint/burn flows
- No evidence of broken row derivation outside the redemption headline regression already investigated separately.

## Notable Findings

1. Redemption headline was technically accurate after the confidence-model change, but it was not sufficiently informative until the breakdown surfaced heuristic routes.
2. The page legend did not explain `Heur.` or `Config.`, even though those states are visible in redemption badges.
3. The quick-filter toolbar had no redemption filter, making it awkward to inspect the modeled redemption subset even though that is a major coverage dimension on the page.

## Actions

- Keep the redemption headline strict (`strong coverage` only).
- Surface heuristic-route counts in the redemption breakdown.
- Add legend entries for `Heur.` and `Config.`.
- Add a `Redemption` quick filter that shows any coin with a modeled redemption state.

