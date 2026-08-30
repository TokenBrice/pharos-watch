# Runbook: Telegram Alerts Not Delivering

## Symptom

Users report missing alerts despite a recent DEWS/depeg/safety/launch/reserve event, or admin status shows a non-zero `eventsDetected` family count (`dews`, `depeg`, `safety`, `launch`, `reserve`) but `messagesSent == 0` across consecutive dispatch runs. Freeze alerts use a dedicated outbox: inspect its metadata fields `freezeObserved`, `freezeQueued`, and `freezeSkippedNoAudience`; do not expect freeze to appear in generic `eventsDetected` counters.

Detection signals:

- Admin `/api/status` `crons["dispatch-telegram-alerts"].lastRun.metadata` shows zero `messagesSent` while an `eventsDetected` family count is non-zero across consecutive runs. (These per-run counters are dispatch-cron metadata; the `telegramBot` block does not carry them.)
- `crons["dispatch-telegram-alerts"].lastRun.metadata` reports `snapshotSeeded: true` repeatedly.
- `crons["dispatch-telegram-alerts"].lastRun.metadata` includes capacity fields: `freshCandidateCount`, `freshOverflow`, `pendingAttempted`, `pendingSent`, `pendingRetryQueued`, `pendingExpired`, `oldestPendingAgeSec`, `estimatedDrainTimeSec`, `perAlertTypeTargets`, and fan-out timing (`fanoutQueryMs`, `fanoutBuildMs`, `fanoutTotalMs`). For source-event runs, `authoritativePlanning` splits source-preset, candidate-horizon, capture/fan-out loader, preference validation, routing, materialization, duplicate suppression, handoff, and pending-drain time and includes page/load/cache/target counts.
- `telegramBot.retryErrorClassCounts` dominated by a single value. Transport classes are `rate_limit`, `blocked`, `chat_not_found`, `chat_migrated`, `formatting_error`, `payload_too_large`, `bad_request`, `auth_error`, `server_error`, `timeout`, `network`, and `unknown`. Deferral reasons share the column (`preference_snoozed`, `preference_preset_unavailable`, `preference_generation_changed`, `recap_snoozed`) and point at preference/snooze state rather than Telegram transport.
- A specific user reports silence: pull their per-chat state with the D1 queries below.

## Quick Diagnostic Checklist

1. **Circuit breaker open?** `/api/status` -> `providerCircuitHealth.openProviders` (look for an entry with `providerId: "telegram-api"`; only open/half-open circuits are listed). The full per-source circuit map is on `/api/health` -> `circuits` -> `telegram-api`. An open breaker skips fan-out entirely.
2. **D1 healthy?** Cross-check with [`db-connectivity.md`](./db-connectivity.md). Preset query/resolution failures degrade preset delivery only; direct and global delivery should continue with `presetFailure`, `presetQueryFailures`, and `presetResolutionFailures` set in dispatch metadata.
3. **Pending queue draining?** `/api/status` -> `telegramBot.pendingDeliveries`, `pendingDeliveryBacklog`, and `oldestPendingDeliveryAgeSec`. A growing backlog points to a rate-limit storm or expiration risk — see [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md) and [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md).
   If `pendingDeliveryBacklog.executionUnknown > 0`, inspect both pending rows and fresh target effects with [`telegram-operator-queries.md`](./telegram-operator-queries.md). Do not retry an unknown target until an operator has reconciled whether Telegram accepted it.
4. **Source planning slow?** Inspect `authoritativePlanning`. A high `candidateHorizonQueryMs` points to candidate/index work; high direct/preset/global/snooze loader fields point to fan-out input reads; `fanoutInputLoadCallCount` above `capturePageCount` without preference-generation churn indicates lost page reuse; high `targetMaterializationD1Ms` or `enqueueHandoffMs` isolates the manifest or handoff phase. Compare `capturedSubscriberCount` with the source's actual target scope before treating a large cohort as expected.
5. **Snapshot seeded?** `snapshotSeeded: true` for the last run means no alerts will be sent (24h staleness gate; see [`docs/telegram-alerts.md`](../telegram-alerts.md) section First-Run / Stale-Snapshot Behavior).
6. **Single chat affected?** `GET /api/admin-telegram-chat/:chatId`, the redacted per-chat diagnostic view, was retired on 2026-08-09. Every table it read is unchanged, so query the chat's delivery controls directly:

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT chat_id, alert_snooze_until_ts, quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc, timezone, consecutive_block_count, consecutive_block_first_at, global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch, global_alert_reserve, global_alert_freeze, preference_generation, created_at, last_active_at FROM telegram_subscribers WHERE chat_id = '<chatId>';"
   ```

   Check for:
   - `alert_snooze_until_ts` greater than the current Unix timestamp (user snoozed; that value is the expiry). The exact value `4102444800` is the `/pause` sentinel — alerts are paused indefinitely, not snoozed; the user resumes with `/pause off` or `/unsnooze`
   - `quiet_hours_enabled = 1` and the current hour **in the row's `timezone`** inside the returned start/end window (the `*_utc` columns are hour-of-day integers interpreted in `timezone`; UTC only when `timezone` is NULL or the zone is unknown to the runtime)
   - `consecutive_block_count >= 2` (subscriber auto-disabled after repeated Telegram 403s)
   - no `telegram_subscriptions` / `telegram_preset_subscriptions` rows for the chat and every `global_alert_*` column 0
   - no `telegram_subscribers` row at all: deletion (`/forget`, mini-app forget-me, inactive-subscriber cleanup) removes that chat's pending, target, plan, and dead-letter rows in the same atomic batch, and chat migration re-points them. Leftover rows for a missing subscriber mean a partially applied delete or a concurrent drain — reconcile before acting

   Use [`telegram-operator-queries.md`](./telegram-operator-queries.md) for the pending-queue, dead-letter, and per-target history queries the retired endpoint bundled into one response.
7. **Webhook secret valid?** Failed validations return `200 ok` silently. Check Cloudflare logs for `telegram-webhook` requests against the configured `TELEGRAM_WEBHOOK_SECRET`, especially if the secret was recently rotated.

## Remediation

1. **Circuit breaker open.** Clear it per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md), breaker key `circuit:telegram-api`.
2. **Snapshot stale loop.** Confirm the dispatch cron has run successfully at least once after the stale-snapshot reseed. If `snapshotSeeded: true` persists across three runs, inspect the snapshot cache keys the seed gate reads (`alert:dews-snapshot`, `alert:dews-alertable-snapshot`, `alert:depeg-snapshot`) for missing or malformed values. A malformed `alert:safety-snapshot` only suppresses safety changes; it never seeds the run.
3. **Single user blocked.** If `consecutive_block_count >= 2`, the user must `/start` again. The flag resets on the next successful send. Confirm they have not blocked the bot in Telegram itself.
4. **Single user snoozed/quiet-hours.** Advise `/unsnooze` or `/unmutehours`. No operator action.
5. **Pending queue full / overflow.** Follow [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md).
6. **No subscribers for the alert type.** For `dews`, `depeg`, `safety`, `launch`, and `reserve`, verify `/api/status` -> `telegramBot.alertTypeChats.<type>` is non-zero for the affected alert type. For freeze alerts, inspect the dedicated outbox metadata fields `freezeObserved`, `freezeQueued`, and `freezeSkippedNoAudience`, then check `/api/status` -> `telegramBot.alertTypeChats.freeze`; do not use generic `eventsDetected` counters for freeze.
7. **Webhook drift.** Inspect `/api/status.budgetOnlySurfaces` for `telegram-registration-reconciliation`. Every tokened tick checks all four units and reports per-unit `skipped`, `succeeded`, or `failed`; a missing bot token is an error signal across registration/transport, not a healthy skip. Force `npx tsx scripts/maintenance/register-telegram.ts --action webhook` only when the webhook unit is failing and automatic repair cannot wait.
8. **Replay one proven historical target.** No longer available: `POST /api/admin-telegram-resend` was retired on 2026-08-09 and there is no other operator replay path. Alert payloads remain readable in `telegram_alert_job_targets` and `telegram_alert_dead_letters` for reconstruction of what a user missed, but hand-enqueuing a pending row bypasses the plan/digest verification the endpoint performed and must not be used as a substitute. If replay is genuinely required, revert the endpoint's removal commit rather than improvising.
9. **Announce a maintenance window or recovery to subscribers.** Dry-run `POST /api/admin-telegram-broadcast` with the narrowest scope and a known private `canaryChatId`. Go live only when `deliveryEstimate.hasMaterialTtlReserve` is true. Live execution sends every chunk to the canary first and enqueues low-priority `admin_broadcast` rows only after the canary succeeds; there is no backlog-risk override. Follow [`telegram-admin-broadcast-safety.md`](./telegram-admin-broadcast-safety.md).

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) — full subsystem behavior, snapshot semantics, dispatch cron contract.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) — trigger-wide connection budget and rate-limit context.
- [`docs/architecture.md`](../architecture.md) — Worker/D1 topology.
- [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md) — when the backlog is growing fast.
- [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md) — when pending age approaches its alert-family TTL.
- [`telegram-webhook-retry-dedupe.md`](./telegram-webhook-retry-dedupe.md) — when commands or callbacks disappear after webhook retries.
- [`db-connectivity.md`](./db-connectivity.md) — when the dispatcher's D1 reads fail.
