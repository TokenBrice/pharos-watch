# Code Quality Audit - Stablecoin Dashboard

Audit scope: `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, and tests.

Validation run:
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm test -- worker/src/api/__tests__/dex-liquidity.test.ts worker/src/cron/__tests__/sync-bluechip.test.ts worker/src/cron/__tests__/daily-digest.test.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts`

## Executive Summary

Findings by severity:
- Critical: 0
- High: 2
- Medium: 2
- Low: 0

Top findings:
- `worker/src/cron/confirm-pending-depegs.ts:98-107` never records Binance circuit outcomes, so the Binance secondary-price probe can keep retrying forever even after repeated failures.
- `worker/src/api/dex-liquidity.ts:228-236` and `worker/src/lib/depeg-helpers.ts:60-72` swallow unexpected `dex_prices` query failures and fall back to empty data, which hides real DB or SQL regressions.
- `worker/src/cron/sync-bluechip.ts:68-76,183-186` and `worker/src/lib/report-cards-snapshot.ts:186-193` trust cached Bluechip JSON without schema validation, so malformed cache content can silently contaminate downstream scores.
- `worker/src/cron/daily-digest.ts:265-266` logs the full Claude prompt payload, exposing internal operational context and generating unnecessarily large logs.

Overall code quality health: `8/10`.
The codebase is generally strong: it has good runtime validation, explicit cache helpers, a circuit-breaker layer, and a dense regression suite. The remaining issues are concentrated at trust boundaries where the code still falls back too silently.

Estimated technical debt footprint:
- About `5%` of runtime surfaces are affected by meaningful quality issues.
- The affected area is concentrated in cron + API boundary code, not spread evenly across the repo.

## Findings

### High

1. Circuit telemetry is missing for the Binance confirmation probe.
- Location: [worker/src/cron/confirm-pending-depegs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L98), lines 98-107, function `confirmPendingDepegs`.
- Problem: the code checks `shouldAttemptFetch(db, CIRCUIT_SOURCE.BINANCE_PRICES)` and then calls `fetchBinancePrices(signal)`, but it never records success or failure for that source. The Binance circuit breaker therefore never learns from this path and can keep probing a degraded upstream every run.
- Why it matters: this defeats the retry-avoidance mechanism on a path that exists specifically to protect the depeg-confirmation pipeline. Repeated retries waste request budget and can delay confirmation logic.
- Remediation: wrap the Binance fetch in `recordOutcomeSafe` or a small helper that records `success`/`failure` after the fetch completes. Add a regression test that forces repeated Binance failure and asserts the circuit state changes.

2. Unexpected `dex_prices` DB failures are converted into empty datasets.
- Locations:
  - [worker/src/api/dex-liquidity.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/dex-liquidity.ts#L228), lines 228-236, `handleDexLiquidity`.
  - [worker/src/lib/depeg-helpers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-helpers.ts#L60), lines 60-72, `loadDexPriceRows`.
- Problem: both call sites catch any `dex_prices` query failure, only distinguish the `no such table` case in logs, and then return an empty result set.
- Why it matters: this turns genuine DB corruption, permission failures, or query regressions into apparently valid empty data. In the API, users get a 200 response with reduced observability. In depeg confirmation, the system loses a secondary source for deciding whether to promote or reject pending events.
- Remediation: only suppress the known missing-table case. For any other error, surface a hard failure or propagate a degraded status so the caller can fail closed. Add a regression test for non-table query failure.

3. Bluechip cache content is trusted without schema validation on both write and read paths.
- Locations:
  - [worker/src/cron/sync-bluechip.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-bluechip.ts#L68), lines 68-76 and 183-186, `parseExistingRatings` and `ratingsMap` merge.
  - [worker/src/lib/report-cards-snapshot.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot.ts#L186), lines 186-193, bluechip cache load in `buildReportCardsSnapshot`.
- Problem: the producer accepts any parsed object as `Record<string, BluechipRating>`, and the consumer repeats the same assumption. There is no schema check that the cache entries actually contain the shape downstream scoring expects.
- Why it matters: malformed cache JSON can survive persistence and then silently distort report-card scoring. This is a data-integrity problem, not just a type-safety nit.
- Remediation: introduce a shared Zod schema or explicit validator for cached Bluechip ratings, validate on write and on read, and treat invalid cache shape as degraded data. Add a malformed-cache regression test.

### Medium

4. The daily digest logs the full prompt payload before calling Anthropic.
- Location: [worker/src/cron/daily-digest.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest.ts#L265), lines 265-266, `generateDailyDigest`.
- Problem: the prompt contains the full operational context used to generate the digest, including recent digest history and the current data snapshot. Logging it verbatim produces very large logs and exposes internal analysis context unnecessarily.
- Why it matters: this is avoidable data exposure and log bloat on a scheduled worker path. It also happens before the circuit-breaker check, so it logs even when the LLM call is skipped.
- Remediation: replace the prompt dump with a concise metadata log, such as regime, input counts, and request id. If the prompt must be inspectable, gate it behind an explicit debug flag and redact the data payload.

## Prioritized Remediation Roadmap

### Phase 1 - Quick Wins
- `worker/src/cron/daily-digest.ts:265-266` - remove or redact the prompt log. Effort: small.

### Phase 2 - Targeted Refactoring
- `worker/src/cron/sync-bluechip.ts:68-76,183-186` and `worker/src/lib/report-cards-snapshot.ts:186-193` - add shared validation for Bluechip cache JSON and fail degraded on invalid cache shape. Effort: medium.
- `worker/src/api/dex-liquidity.ts:228-236` and `worker/src/lib/depeg-helpers.ts:60-72` - stop swallowing unexpected `dex_prices` query failures; surface degraded/error state instead. Effort: medium.
- `worker/src/cron/confirm-pending-depegs.ts:98-107` - record circuit outcomes around the Binance probe and add regression coverage. Effort: small-to-medium.

### Phase 3 - Structural Improvements
- None required from the current findings.

### Phase 4 - Strategic Overhauls
- None required from the current findings.

## Appendix

### File-by-file finding index
- [worker/src/cron/confirm-pending-depegs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L98) - missing circuit outcome recording for Binance probe.
- [worker/src/api/dex-liquidity.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/dex-liquidity.ts#L228) - unexpected `dex_prices` DB failures converted to empty data.
- [worker/src/lib/depeg-helpers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-helpers.ts#L60) - unexpected `dex_prices` DB failures converted to empty data.
- [worker/src/cron/sync-bluechip.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-bluechip.ts#L68) - unvalidated Bluechip cache parse and merge.
- [worker/src/lib/report-cards-snapshot.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot.ts#L186) - unvalidated Bluechip cache read.
- [worker/src/cron/daily-digest.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest.ts#L265) - full prompt logged to worker output.

### Positive signals
- Strong compile-time guardrails: route definitions, cron metadata, and dependency hydration are centralized rather than scattered.
- The repository has a meaningful test corpus around worker crons, API handlers, and shared helpers, and the local lint/typecheck gates pass cleanly.
- External payloads are usually schema-validated with Zod before they are written or published.
- The codebase already uses circuit breakers, cache freshness metadata, and explicit degraded-mode responses in many of the highest-risk paths.

