## Task

Fix the peg-status denominator so NAV tokens that do not have a fixed peg do not count against the homepage / depeg-tracker `coinsAtPeg / totalTracked` aggregate.

## Findings

- `worker/src/api/peg-summary.ts` includes NAV tokens in `coins[]` with `currentDeviationBps = null`.
- The same handler currently sets `summary.totalTracked = coins.length`, which leaks those NAV rows into the denominator.
- Existing docs already say NAV tokens are excluded from peg deviation metrics, so this is an implementation bug, not a methodology change.

## Plan

1. Change the peg-summary aggregate to count only peg-eligible rows in `summary.totalTracked`.
2. Keep NAV rows in `coins[]` so per-coin surfaces still render `NAV` / null deviation correctly.
3. Update the peg-summary contract tests and API reference to reflect the corrected summary semantics.
4. Run focused tests plus the relevant lint/build/typecheck validation.
