# Runbook: Review Renewal

Triggered by `StatusCause.code`:
- `price_gap_reviews_expiring`
- `price_gap_reviews_expired`
- `price_gap_reviews_invalid`
- `price_market_hours_calendars_invalid`
- `price_market_hours_calendars_expired`
- `reserve_feed_reviews_expiring`
- `reserve_feed_reviews_expired`
- `reserve_feed_reviews_invalid`

## Symptom

An operational review that acknowledges a missing live price or a matched stale/erroring reserve feed is approaching expiry, has expired, or is invalid. The `*_expiring` causes are admin-only informational watches: they fire only while a review is currently acknowledging a gap or feed, with `0 < expiresAt - nowSec <= STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC` (48 hours, inclusive, in `shared/lib/status-thresholds.ts`). The message lists stablecoin IDs by soonest expiry, the UTC ISO expiry, and whole hours left; its metric records the exact remaining seconds for the soonest review.

These notices do not change health status, create a status transition, or enter public incident history. An acknowledgement is not a price, fresh reserve evidence, a successful sync, or a scoring exception. Existing missing-price and reserve-health gates remain independent.

## First checks

1. Open Admin triage → **Informational watch**, identify the lane and stablecoin IDs, and follow the review's expiry and evidence. If an overall cause list is crowded, inspect `causes.dataQuality` on admin `GET /api/status?refresh=live`; it retains the lane-specific cause.
2. **Price gap:** inspect `/api/health.activePriceCoverage.missingActiveAssets[].acknowledgedGap` for owner, reason, HTTPS sources, review date, and expiry. The gap remains in `missingActiveIds`; `expiredGapReviewIds` and `invalidGapReviewIds` name reviews that acknowledge nothing. Active-price coverage is not exposed on `/api/status`.
3. **Reserve feed:** inspect `/api/status.reserveComposition.acknowledgedFeeds` for matched reviews, plus `expiredFeedReviewIds` and `invalidFeedReviewIds`. Check the asset's raw reserve evidence and latest attempt category, warning codes, and error text before deciding whether the existing review still describes the failure. An unmatched new failure must not inherit the old acknowledgement.
4. Re-read the official evidence. Decide whether the source has recovered, whether a fresh dated review is justified, or whether the missing-price listing needs a freeze/delist decision. Do not advance an expiry merely to keep the dashboard green.

## Renewal procedure

### Price-gap reviews

Edit `STABLECOIN_PRICE_GAP_REVIEWS` in `worker/src/lib/stablecoin-publication-coverage.ts`:

- Keep the exact active stablecoin identity and a nonblank accountable owner and reason.
- Record fresh, relevant public evidence using HTTPS sources and a nonfuture `reviewedAt` (Unix seconds). The resolver enforces this: a review dated after the evaluation clock is reported in `invalidGapReviewIds` and acknowledges nothing.
- Set `expiresAt > reviewedAt` and keep the acknowledgement within the documented roughly 30-day review policy. The resolver validates date shape, ordering and the nonfuture review date, not that duration cap; enforce the policy during review. Renewal is a new review decision, not automatic date extension.
- Never substitute an invented quote, lower a price-validation floor, or change source freshness to close the gap. If the source recovers, the normal price pipeline clears the gap without a new acknowledgement.
- After verifying recovery through an admitted source with its real observation clock, remove an obsolete expired review instead of renewing an acknowledgement the asset no longer needs. Preserve source-specific freshness and admission guards; a merely numeric upstream response is not recovery.
- For unresolved venue divergence, record the rejected quote and the alternative venue's identity/depth limits, keep the gap missing, and use only a short explicit source-review deadline. An acknowledgement does not establish that the divergence is harmless or admit either venue.
- If current official evidence announces termination, name the lifecycle owner's archive/freeze decision and deadline explicitly. A temporary review changes no lifecycle fields, proves no redemption, and must not become a substitute for that decision.
- Keep source-review acknowledgement expiry separate from an existing lifecycle/holder-exit decision deadline. A fresh source review may acknowledge the still-missing price for a short explicit interval, but must retain the original lifecycle deadline and accountable owner in its reason; it neither satisfies that decision nor authorizes extending it. Report any outstanding lifecycle decision explicitly at hand-off.
- Recheck inherited-price dependencies as well as the asset's own exact contracts. A stale parent quote, fallback-confidence parent, below-floor pool or unreviewed native cross-rate is not recovery. Record actual observation clocks and depth; an empty market response is different from a failed request.

### Market-hours calendars

Mento's standing source calendar is separate from `STABLECOIN_PRICE_GAP_REVIEWS`; do not recreate monthly weekend acknowledgements. Inspect `/api/health.activePriceCoverage.scheduledClosureGapIds` and `missingActiveAssets[].scheduledClosure` for `market-closed`, lane, owner, sources, review date and `reviewDeadline`. The five assets remain in `missingActiveIds` and retain their missing streaks. Health reads recompute calendar applicability. At reopening, the gap remains ineligible until `ACTIVE_PRICE_COVERAGE_ALERT_GENERATIONS × CRON_INTERVALS["sync-stablecoins"]` has elapsed since the most recent closure end (currently 30 minutes); then the ordinary persistence gate applies. This excludes closure-only misses without changing measured streaks. Missing/Markets tiles retain producer counts until the next sync. These are not prices, acknowledgements or publication waivers; public breadth still counts them.

At the annual source-review deadline, re-read the pinned `MarketHoursBreaker` and `OracleAdapter` sources plus `BreakerBox`/`BiPoolManager` for broker lanes and `FPMM` for FPMM lanes, verify the current deployed route and exact asset/lane mapping, and update all five HTTPS source URLs to the newly verified mento-core commit together with `reviewedAt`/`reviewDeadline` only after review. The registry owns the dates; it does not use `price_gap_reviews_expiring`/`expired` notices. Track its annual deadline in operator review planning. Future, malformed or overdue calendar reviews suppress nothing; inspect `invalidMarketHoursCalendarIds` / `expiredMarketHoursCalendarIds` and their `price_market_hours_calendars_invalid` / `price_market_hours_calendars_expired` info causes. Verify Friday 20:59/21:00 and Sunday 22:59/23:00 UTC, December 24/31 21:59/22:00, December 25 and January 1; retain no DST adjustment or substitute holiday, and verify the post-reopen gate at 0, one and two producer intervals. If rules or routes drift, remove the unsupported scope and let missing prices alert normally. Acceptance requires the first production closure and reopening with unchanged raw missing counts and restored off-calendar alert eligibility.

### Reserve-feed reviews

Edit `RESERVE_FEED_REVIEWS` in `worker/src/lib/reserve-feed-reviews.ts`:

- Keep the exact configured stablecoin and adapter identity; only independent or static-validated feeds are eligible for operational review.
- Record an accountable owner, specific reason, HTTPS evidence URLs, and valid `evidenceDate` values no later than `reviewedAt`. The review date must not be future-dated.
- Set `expiresAt > reviewedAt` with `expiresAt - reviewedAt <= RESERVE_FEED_REVIEW_MAX_AGE_SEC` (14 days, in `shared/lib/status-thresholds.ts`).
- Match the category, exact warning-code set and full error text (legacy `errorPrefix`, null matches only null). Require warning codes or an error; never broaden a cause. Timeout/network, storage and budget categories are ineligible; uncertain writes, unreadable circuit history and future portfolio clocks remain unacknowledged.
- Leave stale/erroring evidence quarantined. Do not rewrite source timestamps, admit an unreviewed report, raise source-age ceilings, or turn the review into scoring-grade evidence.

Run the owning registry and status suites for any renewal, review the changed evidence, and deploy the approved registry before expiry through the normal release process. Never mutate production review state or reset leases/checkpoints as a renewal shortcut.

## At expiry

At `nowSec >= expiresAt`, the registry ignores the acknowledgement automatically. Price gaps remain missing and their normal alert eligibility and duration gates re-arm; matched reserve exclusions stop applying and the unchanged reserve-health gates re-arm. `*_reviews_expired` remains an informational diagnostic, while the underlying unacknowledged gap or feed can independently warn or degrade health. Invalid reviews acknowledge nothing and emit `*_reviews_invalid`. The `*_expiring` reminder disappears at expiry, including if an old payload still carries a past expiry.

## Prevention

- Use the 48-hour informational watch to schedule a fresh evidence review and deploy before the deadline. There is no automatic renewal or separate webhook delivery.
- Reminders cover in-use acknowledgements only. Priced assets and recovered/unmatched feeds do not trigger a reminder merely because a registry entry is near expiry.
- Renew only when current evidence supports the same narrowly scoped acknowledgement. Otherwise let alerts re-arm and address the source or catalog decision.
