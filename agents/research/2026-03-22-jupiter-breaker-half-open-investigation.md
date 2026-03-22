# Jupiter Breaker Half-Open Investigation - 2026-03-22

## Scope

Investigate why the `jupiter-prices` circuit breaker shows `half-open` on the ops surface and determine whether it reflects an active upstream problem or stale local state.

## Live Findings

- `GET https://api.pharos.watch/api/health` on `2026-03-22T13:32:43Z` returned:
  - `jupiter-prices.state = "half-open"`
  - `consecutiveFailures = 16`
  - `lastSuccessAt = null`
  - `openedAt = 1774017093` (`2026-03-20T14:31:33Z`)
- The same health payload showed every other circuit breaker closed.
- `GET https://api.pharos.watch/api/stablecoins` at the same time showed:
  - `0` assets with `priceSource = "jupiter"`
  - `0` missing-price assets on Solana

## Cause

Two separate facts explain the current status:

1. The breaker originally opened on March 20 because the pre-fix Jupiter fallback rejected V3 quotes when optional `createdAt` metadata was older than `JUPITER_MAX_AGE_SEC`.
2. The current worker code still consulted the breaker before checking whether the Jupiter pass had any candidates. That meant an old open breaker could transition to `half-open` on a run where no Solana fallback work existed, then remain stuck there because no probe request or `recordOutcomeSafe(...)` call followed.

This makes the current `half-open` state a stale observability artifact, not evidence of an ongoing live Jupiter outage.

## Code Follow-Up

Applied a minimal fix in `worker/src/cron/enrich-prices-passes.ts`:

- `runCmcPass()`: return early before breaker checks when nothing is missing
- `runDexScreenerPass()`: return early before breaker checks when nothing is missing
- `runJupiterPass()`: compute candidates first and skip breaker checks entirely when there are no Solana fallback candidates

Added regression coverage in `worker/src/cron/__tests__/enrich-prices.test.ts` for those idle-path cases.

## Operational Assessment

- No urgent operator intervention is warranted.
- The public API is healthy and the Jupiter fallback is not currently needed for live pricing coverage.
- The existing production breaker row may remain `half-open` until either:
  - a future run actually has Jupiter candidates and records a success, or
  - the row is manually cleared in D1.

The code fix prevents the stale `half-open` state from recurring on future idle runs.
