# Chain Total Supply Reconciliation

## Assumptions

- The dashboard `Total Stablecoin MCap` and the chains page `Total Stablecoin Supply` should refer to the same all-tracked market total.
- Chain rows should still represent only supply that the provider attributes to a concrete chain.
- The residual between all-tracked supply and chain-attributed supply should remain visible rather than being assigned to an invented chain.

## Evidence

- Live `/_site-data/stablecoins` at 2026-04-24 10:43 UTC sums to about `$339.46B` across all peg buckets.
- Live `/_site-data/chains` at the same `updatedAt` reports about `$320.06B`.
- The two payloads share the same freshness timestamp, so cache age does not explain the mismatch.
- The gap is mostly assets with valid total supply but no `chainCirculating` buckets in the stablecoins cache. The largest live gaps were `sUSDS`, `XAUT`, `PAXG`, `sUSDe`, `syrupUSDC`, and `USTB`.

## Plan

1. Change the chain aggregator to compute `globalTotalUsd` from all-tracked circulating supply when those buckets are present, falling back to chain-attributed totals for test/minimal inputs.
2. Add explicit `chainAttributedTotalUsd`, `unattributedTotalUsd`, and global trend percentages to the `/api/chains` response.
3. Update the chains leaderboard to use the endpoint-provided global 7d trend and show the residual as `Unattributed` in the dominance legend.
4. Update chain API/page docs and focused tests.
