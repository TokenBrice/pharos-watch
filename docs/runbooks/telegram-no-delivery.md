# Runbook: Telegram Alerts Not Delivering

## Symptom

Users report missing alerts despite a recent DEWS/depeg/safety/launch event, or admin status shows `eventsDetected > 0` but `messagesSent == 0` across consecutive dispatch runs.

Detection signals:

- Admin `/api/status` `crons["dispatch-telegram-alerts"].lastRun.metadata` shows zero `messagesSent` while `eventsDetected > 0` across consecutive runs. (These per-run counters are dispatch-cron metadata; the `telegramBot` block does not carry them.)
- `crons["dispatch-telegram-alerts"].lastRun.metadata` reports `snapshotSeeded: true` repeatedly.
- `crons["dispatch-telegram-alerts"].lastRun.metadata` includes capacity fields: `freshCandidateCount`, `freshOverflow`, `pendingAttempted`, `pendingSent`, `pendingRetryQueued`, `pendingExpired`, `oldestPendingAgeSec`, `estimatedDrainTimeSec`, `perAlertTypeTargets`, and fan-out timing (`fanoutQueryMs`, `fanoutBuildMs`, `fanoutTotalMs`).
- `retryErrorClassCounts` dominated by a single runtime class (`rate_limit`, `blocked`, `bad_request`, `auth_error`, `server_error`, `timeout`, `network`, or `unknown`).
- A specific user reports silence: pull their per-chat state via the admin endpoint below.

## Quick Diagnostic Checklist

1. **Circuit breaker open?** `/api/status` -> `providerCircuitHealth.openProviders` (look for an entry with `providerId: "telegram-api"`; only open/half-open circuits are listed). The full per-source circuit map is on `/api/health` -> `circuits` -> `telegram-api`. An open breaker skips fan-out entirely.
2. **D1 healthy?** Cross-check with [`db-connectivity.md`](./db-connectivity.md). Preset query/resolution failures degrade preset delivery only; direct and global delivery should continue with `presetFailure`, `presetQueryFailures`, and `presetResolutionFailures` set in dispatch metadata.
3. **Pending queue draining?** `/api/status` -> `telegramBot.pendingDeliveries`, `pendingDeliveryBacklog`, and `oldestPendingDeliveryAgeSec`. A growing backlog points to a rate-limit storm or expiration risk — see [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md) and [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md).
   If `pendingDeliveryBacklog.executionUnknown > 0`, inspect both pending rows and fresh target effects with [`telegram-operator-queries.md`](./telegram-operator-queries.md). Do not retry an unknown target until an operator has reconciled whether Telegram accepted it.
4. **Snapshot seeded?** `snapshotSeeded: true` for the last run means no alerts will be sent (24h staleness gate; see [`docs/telegram-alerts.md`](../telegram-alerts.md) section First-Run / Stale-Snapshot Behavior).
5. **Single chat affected?** Inspect the chat's full state:

   ```bash
   curl -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        -H "X-Pharos-Admin: 1" \
        https://ops-api.pharos.watch/api/admin-telegram-chat/<chatId>
   ```

   Check the returned payload for:
   - `subscriber.snooze.active === true` (user snoozed; `subscriber.snooze.untilTs` is the expiry)
   - `subscriber.quietHours.enabled === true` AND current UTC hour inside `subscriber.quietHours.startHourUtc`..`subscriber.quietHours.endHourUtc`
   - subscriber auto-disabled after two 403s within 24h (the `consecutive_block_count >= 2` strike counter is internal to dispatch and not returned by this endpoint; check the D1 table directly with `SELECT consecutive_block_count FROM telegram_subscribers WHERE chat_id = ?`)
   - empty subscriptions / global flags all 0
6. **Webhook secret valid?** Failed validations return `200 ok` silently. Check Cloudflare logs for `telegram-webhook` requests against the configured `TELEGRAM_WEBHOOK_SECRET`, especially if the secret was recently rotated.

## Remediation

1. **Circuit breaker open.** Reset via `POST https://ops-api.pharos.watch/api/reset-circuit-breaker?circuit=telegram-api` with Access service-token headers, `X-Pharos-Admin: 1`, and an `Idempotency-Key`.
2. **Snapshot stale loop.** Confirm the dispatch cron has run successfully at least once after the stale-snapshot reseed. If `snapshotSeeded: true` persists across three runs, inspect the snapshot cache keys (`alert:dews-snapshot`, `alert:dews-alertable-snapshot`, `alert:depeg-snapshot`, `alert:safety-snapshot`) for malformed values.
3. **Single user blocked.** If `consecutive_block_count >= 2`, the user must `/start` again. The flag resets on the next successful send. Confirm they have not blocked the bot in Telegram itself.
4. **Single user snoozed/quiet-hours.** Advise `/unsnooze` or `/unmutehours`. No operator action.
5. **Pending queue full / overflow.** Follow [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md).
6. **No subscribers for the alert type.** Verify `/api/status` -> `telegramBot.alertTypeChats.<type>` is non-zero for the affected alert type.
7. **Webhook drift.** The 5-minute Telegram lane reconciles the webhook automatically. Force a manual reset with `npx tsx scripts/maintenance/register-telegram.ts --action webhook` only if reconciliation is also failing.
8. **Force a single resend.** After the underlying cause is fixed, re-fire a specific alert to one chat via `POST https://ops-api.pharos.watch/api/admin-telegram-resend` with body `{ "chatId": "<id>", "alertType": "dews|depeg|safety|launch|reserve", "stablecoinId": "<id>" }`. The endpoint rebuilds a `synthetic_current_state` alert from current data, uses the same formatter and `sendToChat` path as the dispatch cron, and bypasses the pending queue. It is not exact historical replay. See [`docs/api-reference.md`](../api-reference.md) section `POST /api/admin-telegram-resend`.
9. **Announce a maintenance window or recovery to subscribers.** Use `POST https://ops-api.pharos.watch/api/admin-telegram-broadcast` with body `{ "messageHtml": "<b>...</b>", "scope": "all" | "deliverable-watchers" | "global-subscribers", "dryRun": true | false }`. Prefer `deliverable-watchers` for ordinary recovery notices; use `all` only when intentionally targeting every subscriber row. Run `dryRun: true` first to confirm `targetChatCount`, `targetMessageCount`, and `deliveryEstimate`; then follow [`telegram-admin-broadcast-safety.md`](./telegram-admin-broadcast-safety.md) before the live call. The endpoint enqueues low-priority `admin_broadcast` rows into `telegram_pending_alerts`, so risk alerts stay ahead of broadcasts during contention. See [`docs/api-reference.md`](../api-reference.md) section `POST /api/admin-telegram-broadcast`.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) — full subsystem behavior, snapshot semantics, dispatch cron contract.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) — per-trigger 6-connection cap and rate-limit context.
- [`docs/architecture.md`](../architecture.md) — Worker/D1 topology.
- [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md) — when the backlog is growing fast.
- [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md) — when pending age approaches the 1-hour TTL.
- [`telegram-webhook-retry-dedupe.md`](./telegram-webhook-retry-dedupe.md) — when commands or callbacks disappear after webhook retries.
- [`db-connectivity.md`](./db-connectivity.md) — when the dispatcher's D1 reads fail.
