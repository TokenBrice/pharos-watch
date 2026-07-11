# Telegram Adoption Report

Use this runbook to review the privacy-preserving PharosWatchBot acquisition and onboarding funnel.

## Read The Report

Call the Access-authenticated operator endpoint:

```bash
curl https://ops-api.pharos.watch/api/admin-telegram-adoption-report
```

The response covers the last seven complete UTC days. `range.previousStart` and `range.previousEnd` identify the preceding comparison window. It includes:

- allowlisted landing-page placements with CTA clicks, bot starts, and first setup completions;
- first successful Mini App mutation latency buckets;
- the latest D7/D30 active-follow retention snapshot for `any`, `direct`, `preset`, and `global` follows;
- source freshness, suppression, and quality labels.

## Interpretation Rules

CTA clicks are best-effort browser events. Bot starts and Telegram milestones are independently idempotent aggregates. Pharos deliberately stores no identifier that joins those surfaces, so `startPerClickPct` is directional rather than a user conversion rate. It may exceed 100% after shared links, delayed starts, blocked browser telemetry, or cross-day activity.

Counts from one through four are returned as `null`. A zero may be shown only when the relevant denominator/cohort is large enough to avoid disclosing a low-cardinality cell. Do not infer suppressed values from adjacent totals.

Retention cohorts start on the UTC day of a chat's first successful follow, not on `/start`. The denominator is the durable aggregate `first_follow` count for that cohort day. The numerator counts cohort members whose operational subscriber row still has an active `any`, `direct`, `preset`, or `global` follow. A later `/forget` therefore removes that member from the numerator without shrinking the aggregate denominator or retaining a raw analytics identity.

`on_time_snapshot` retention was measured by the first producer refresh after its UTC measurement day completed. Today is never persisted as an incomplete measurement. `catchup_current_state` means the producer missed that completed-day boundary and the bounded seven-day catch-up used current operational follow state. `pre_rollout_unavailable` applies to first-follow cohort days before 2026-07-11, the first fully instrumented UTC day; existing users were marked as historical to prevent false new milestones, but no guessed cohort aggregate was created. An empty post-rollout cohort reports zero cohort/retained counts and a `null` rate. Do not combine the three qualities as if they were equally precise.

The recommended-setup CTA retains its preloaded Telegram subscription behavior and therefore has click attribution only. The hero wizard carries the allowlisted start token through the short-lived setup state and can report setup completion by placement.

## Freshness And Failure

- Funnel rows should normally have `freshness.latestEventAt` within the report range when the page or bot was used.
- Retention refresh runs with the 15-minute heavy Telegram pulse producer and fills at most seven missed measurement days.
- An empty placement list is valid during a quiet week. A missing freshness timestamp alongside known traffic indicates a write or migration problem.
- `429` from `/pharoswatchbot-adoption` means the identifier-free global 3,000-request minute ceiling was reached. The page still opens Telegram; telemetry never blocks navigation.

## Triage

1. Confirm migration `0192_telegram_adoption_analytics.sql` is applied to `stablecoin-db`.
2. Confirm the Pages project has its required primary `DB` D1 binding.
3. Check `telegram-retention-cleanup` metadata for adoption table/cache pruning and caps.
4. Check the Telegram pulse run for `[telegram-adoption] retention refresh failed` warnings.
5. Verify a catalog link contains a `pw1_*` token no longer than 64 characters; arbitrary tokens are intentionally classified as organic/unknown or rejected.

Do not add raw chat IDs, stable pseudonymous user keys, arbitrary URL/referrer strings, or IP-derived quota keys to improve attribution. Product decisions that require a joined funnel need a separate privacy review.
