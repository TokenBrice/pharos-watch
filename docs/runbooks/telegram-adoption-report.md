# Telegram Adoption Report

Use this runbook to review the privacy-preserving PharosWatchBot acquisition and onboarding funnel.

`GET /api/admin-telegram-adoption-report` was retired on 2026-08-09. It was a pure read aggregation with no UI consumer; nothing about the data changed. The Worker producer (`/api/telegram-adoption` behind the Pages `/pharoswatchbot-adoption` shim plus `worker/src/lib/telegram/adoption-analytics.ts`) is still live and still writes `telegram_adoption_daily` and `telegram_adoption_retention_daily` from CTA clicks, the Telegram pulse, the Mini App, and the webhook `/start` and follow paths. The queries below reproduce what the endpoint returned.

## Read The Report

The report window is the last seven complete UTC days: `currentEnd` is yesterday, `currentStart` is seven days back, and the comparison window runs from fourteen days back to eight days back. Nothing aggregates today, because today is incomplete.

Funnel counts by placement and stage:

```sql
SELECT day, campaign, placement, stage, feature, latency_bucket, outcome,
       SUM(count) AS count, MAX(last_seen_at) AS last_seen_at
FROM telegram_adoption_daily
WHERE day >= date('now', '-14 day')
  AND day <= date('now', '-1 day')
GROUP BY day, campaign, placement, stage, feature, latency_bucket, outcome
ORDER BY day DESC, placement, stage;
```

Split rows with `day >= date('now', '-7 day')` as the current window and the rest as the comparison window. The stages are `cta_click`, `bot_start`, `setup_complete`, `first_follow`, `mini_app_session`, and `first_mutation`. First-mutation latency buckets are the `latency_bucket` values on `first_mutation` rows (`lt_30s`, `30s_2m`, `2m_5m`, `gte_5m`, `unknown`).

Latest D7/D30 retention snapshot:

```sql
SELECT cohort_day, measurement_day, window_days, feature, cohort_size,
       retained_count, measured_at, quality
FROM telegram_adoption_retention_daily
WHERE measurement_day >= date('now', '-7 day')
  AND measurement_day <= date('now', '-1 day')
ORDER BY measurement_day DESC, window_days ASC, feature ASC;
```

Take the newest row per `(window_days, feature)` pair; features are `any`, `direct`, `preset`, and `global`.

Source freshness is `MAX(last_seen_at)` from the daily table and `MAX(measured_at)` from the retention table. Apply the suppression and quality rules below yourself — raw table rows are unsuppressed, which the endpoint's response was not.

## Interpretation Rules

CTA clicks are best-effort browser events. Bot starts are unjoined server-side aggregates counted per `/start`, so a repeat start counts again; only the Telegram milestones (`setup_complete`, `first_follow`) are idempotent per chat. Pharos deliberately stores no identifier that joins those surfaces, so any start-per-click ratio you compute is directional rather than a user conversion rate. It may exceed 100% after shared links, delayed starts, blocked browser telemetry, or cross-day activity.

Positive counts from one through four are suppressed (`TELEGRAM_ADOPTION_LOW_COUNT_THRESHOLD = 5` in `shared/lib/telegram-adoption-analytics.ts`). Denominator suppression applies only to `rate()`: low-denominator rates are suppressed, while stage counts and retention `cohortSize`/`retainedCount` emit zeros as `0`. The raw tables do not apply that rule, so enforce it before sharing or publishing a figure. Do not infer suppressed values from adjacent totals.

Retention cohorts start on the UTC day of a chat's first successful follow, not on `/start`. The denominator is the durable aggregate `first_follow` count for that cohort day. The numerator counts cohort members whose operational subscriber row still has an active `any`, `direct`, `preset`, or `global` follow. A later `/forget` therefore removes that member from the numerator without shrinking the aggregate denominator or retaining a raw analytics identity.

`on_time_snapshot` retention was measured by the first producer refresh after its UTC measurement day completed. Today is never persisted as an incomplete measurement. `catchup_current_state` means the producer missed that completed-day boundary and the bounded seven-day catch-up used current operational follow state. `pre_rollout_unavailable` applies to first-follow cohort days before 2026-07-11, the first fully instrumented UTC day; existing users were marked as historical to prevent false new milestones, but no guessed cohort aggregate was created. An empty post-rollout cohort reports zero cohort/retained counts and a `null` rate. Do not combine the three qualities as if they were equally precise.

The recommended-setup CTA retains its preloaded Telegram subscription behavior and therefore has click attribution only. The hero wizard carries the allowlisted start token through the short-lived setup state and can report setup completion by placement.

## Freshness And Failure

- Funnel rows should normally have a `MAX(last_seen_at)` within the report range when the page or bot was used.
- Retention refresh runs with the 15-minute heavy Telegram pulse producer and fills at most seven missed measurement days.
- An empty placement list is valid during a quiet week. A missing freshness timestamp alongside known traffic indicates a write or migration problem.
- `429` from `/pharoswatchbot-adoption` means either the per-client 10-request minute ceiling or the identifier-free global 3,000-request minute ceiling was reached. The page still opens Telegram; telemetry never blocks navigation.

## Triage

1. Confirm `stablecoin-db` contains `telegram_adoption_daily` and `telegram_adoption_retention_daily`, and that the deployed Worker includes the live adoption producer. Historical migration 0192 is squashed into the active baseline; use the manifest only for lineage.
2. Confirm the Pages project has `SITE_API_ORIGIN`, `SITE_API_SHARED_SECRET`, and the `TELEGRAM_ADOPTION_IP_HASH_SECRET` pepper for the forwarding shim; the CTA quota and aggregate writes run on the Worker’s primary `DB` binding.
3. Check `telegram-retention-cleanup` metadata for adoption table/cache pruning and caps.
4. Check the Telegram pulse run for structured `Telegram adoption retention refresh failed` warnings (`scope` `api`, `level` `warn`).
5. Verify a catalog link contains a `pw1_*` token no longer than 64 characters; arbitrary tokens are intentionally classified as organic/unknown or rejected.

Do not add raw chat IDs, stable pseudonymous user keys, arbitrary URL/referrer strings, or IP-derived quota keys to improve attribution. Product decisions that require a joined funnel need a separate privacy review.
