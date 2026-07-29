# Runbook: Telegram Backlog and Expiration Risk

## Symptom

`telegram_pending_alerts` is growing, the oldest row is near its TTL, or `/api/status` reports expired pending rows.

Detection signals:

- `/api/status` -> `telegramBot.pendingDeliveries` increases across consecutive five-minute runs.
- `telegramBot.oldestPendingDeliveryAgeSec > 6300` (105 minutes) means two-hour risk-alert rows are inside the final 15-minute TTL window. Launch rows use 90 minutes and admin rows use 45 minutes, so evaluate those source types against their own expiry rather than the aggregate oldest-row age.
- `telegramBot.pendingDeliveryBacklog.expired > 0` means rows have already aged past their explicit `expires_at` or the legacy `PENDING_TTL_SEC = 7200` fallback.
- `crons["dispatch-telegram-alerts"].lastRun.metadata.pendingDroppedTtlExpired > 0`, `pendingNearTtlCount > 0`, `oldestPendingAgeSec > 900`, or `estimatedDrainTimeSec > 1800`.

## Current Capacity Math

The authoritative sender hands every planned chunk through the pending lifecycle. One run attempts up to 1,800 pending chunks (`TELEGRAM_PENDING_DRAIN_BUDGET`) inside the shared 3,600-message ceiling and the four-minute send-loop soft deadline. `dispatch-telegram-alerts` has a 14-minute app-level timeout, while the trigger runs every five minutes and is lease-protected. At a five-minute cadence, the healthy queue can drain roughly 21,600 chunks/hour when Telegram accepts sends and no new higher-priority work arrives. Risk-alert rows remain ordered ahead of admin broadcasts. The bot-wide transport circuit stops untouched waves during systemic failure and admits only one-to-four half-open probe chats before normal draining resumes. Authoritative alert-job target rows preserve exact target, payload, expiry, and terminal outcome throughout that process.

Pending rows are claim-based. A drain stamps `processing_owner`, `processing_started_at`, and `processing_expires_at` before sending, and a later drain can reclaim rows whose claim expired. This means a temporarily stuck row should show either a future `not_before_at` / Telegram backoff or an expired processing claim before manual intervention.

Use the load harness before a planned broad send:

```bash
npm run check:telegram-load
```

The script reports estimated drain time and D1 operation counts for 500, 1,000, 5,000, and 10,000 active watchers. The 10,000-watcher scenario is exploratory and should not block emergency triage.

## Quick Diagnostic Checklist

1. **Is the queue still draining?** Compare `pendingDeliveries`, `pendingDeliveryBacklog.due`, `oldestPendingDeliveryAgeSec`, `oldestPendingAgeSec`, and `estimatedDrainTimeSec` across two five-minute runs.
2. **Are rows deferred?** A high `pendingDeliveryBacklog.deferred` count with `retryErrorClassCounts.rate_limit` points to Telegram 429 behavior. Follow [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md).
3. **Are expired rows accumulating?** If `expired > 0`, clear them after confirming the latest dispatcher run is healthy. Scheduled cleanup copies expired rows to `telegram_alert_dead_letters` and marks alert-job targets `expired` before deleting live pending rows.
4. **Is an admin broadcast pending?** Stop any planned broadcast until `oldestPendingDeliveryAgeSec < 900` and the queue is decreasing.
5. **Is D1 under pressure?** If D1 queueing or telemetry writes are competing with dispatch, follow [`d1-telemetry-kill-switch.md`](./d1-telemetry-kill-switch.md).

## Remediation

1. **Pause low-priority sends.** Do not run admin broadcasts, broad manual resends, or non-urgent operator notices while risk-alert rows are close to expiry.
2. **Let healthy drain continue.** If `pendingDeliveries` is decreasing and no rows are expired, wait one or two cycles. Circuit state and operator pauses are separate controls. If continued delivery is worsening the incident, use [`telegram-bot-wide-outage.md`](./telegram-bot-wide-outage.md) to pause `pending`; pause `fresh` separately when new risk sends must also stop. Do not reset the transport circuit to simulate a pause.
3. **Let scheduled expiry cleanup handle expired rows.** Do not use `older_than_sec` as an expiry filter: the admin endpoint filters by `created_at`, not `expires_at`, so an age-based clear can cancel still-live risk, launch, or recap alerts. Scheduled cleanup evaluates explicit `expires_at` (with the legacy two-hour fallback), dead-letters expired rows, and marks their targets expired before deletion.
4. **Clear one abusive chat only when explicitly intended.** If one chat dominates pending rows and is not a high-priority risk recipient, preview with `?chat_id=<chatId>&dry_run=1`, then clear only that chat with `?chat_id=<chatId>`. Filtered manual clears copy rows to `telegram_alert_dead_letters` with `reason = 'manual_clear'` before deleting the live queue rows.
5. **Do not rewrite `created_at` to extend TTL.** Extending alert life by mutating D1 rows makes latency and audit data dishonest. TTL changes should ship as a reviewed sender change with explicit severity policy.
6. **After recovery, run a dry-run broadcast only if needed.** Follow [`telegram-admin-broadcast-safety.md`](./telegram-admin-broadcast-safety.md).

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Pending Delivery Queue.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) for sender budget assumptions.
- [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md) for 429-dominated incidents.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) for zero-send incidents.
- [`telegram-bot-wide-outage.md`](./telegram-bot-wide-outage.md) for generation-fenced delivery pauses and recovery.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) for D1 diagnostics during delivery incidents.
