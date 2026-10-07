# Runbook: Review Renewal

Triggered by `StatusCause.code`:
- `price_gap_reviews_expiring`
- `price_gap_reviews_expired`
- `price_gap_reviews_invalid`
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
- Record fresh, relevant public evidence using HTTPS sources and a nonfuture `reviewedAt` (Unix seconds).
- Set `expiresAt > reviewedAt` and keep the acknowledgement within the documented roughly 30-day review policy. The resolver validates date shape and ordering, not that duration cap; enforce the policy during review. Renewal is a new review decision, not automatic date extension.
- Preserve any `weeklyUtcWindow` that limits applicability. An out-of-window review acknowledges nothing, even before its expiry.
- Never substitute an invented quote, lower a price-validation floor, or change source freshness to close the gap. If the source recovers, the normal price pipeline clears the gap without a new acknowledgement.

### Reserve-feed reviews

Edit `RESERVE_FEED_REVIEWS` in `worker/src/lib/reserve-feed-reviews.ts`:

- Keep the exact configured stablecoin and adapter identity; only independent or static-validated feeds are eligible for operational review.
- Record an accountable owner, specific reason, HTTPS evidence URLs, and valid `evidenceDate` values no later than `reviewedAt`. The review date must not be future-dated.
- Set `expiresAt > reviewedAt` with `expiresAt - reviewedAt <= RESERVE_FEED_REVIEW_MAX_AGE_SEC` (14 days, in `shared/lib/status-thresholds.ts`).
- Match the observed failure category, exact warning-code set, and error prefix when present. Retain at least warning codes or an error prefix; do not broaden them to acknowledge new failures. Timeouts, exhausted run budgets, uncertain writes, and future portfolio clocks are not excused by an existing stale-source review.
- Leave stale/erroring evidence quarantined. Do not rewrite source timestamps, admit an unreviewed report, raise source-age ceilings, or turn the review into scoring-grade evidence.

Run the owning registry and status suites for any renewal, review the changed evidence, and deploy the approved registry before expiry through the normal release process. Never mutate production review state or reset leases/checkpoints as a renewal shortcut.

## At expiry

At `nowSec >= expiresAt`, the registry ignores the acknowledgement automatically. Price gaps remain missing and their normal alert eligibility and duration gates re-arm; matched reserve exclusions stop applying and the unchanged reserve-health gates re-arm. `*_reviews_expired` remains an informational diagnostic, while the underlying unacknowledged gap or feed can independently warn or degrade health. Invalid reviews acknowledge nothing and emit `*_reviews_invalid`. The `*_expiring` reminder disappears at expiry, including if an old payload still carries a past expiry.

## Prevention

- Use the 48-hour informational watch to schedule a fresh evidence review and deploy before the deadline. There is no automatic renewal or separate webhook delivery.
- Reminders cover in-use acknowledgements only. Priced assets, recovered/unmatched feeds, and price reviews outside their weekly UTC window do not trigger a reminder merely because a registry entry is near expiry.
- Keep a windowed review's expiry inside its applicable window when a reminder is needed; otherwise its lapse can occur without an in-use reminder.
- Renew only when current evidence supports the same narrowly scoped acknowledgement. Otherwise let alerts re-arm and address the source or catalog decision.
