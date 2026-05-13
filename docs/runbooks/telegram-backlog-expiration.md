# Runbook: Telegram Backlog and Expiration Risk

## Symptom

`telegram_pending_alerts` is growing, the oldest row is near its TTL, or `/api/status` reports expired pending rows.

Detection signals:

- `/api/status` -> `telegramBot.pendingDeliveries` increases across consecutive five-minute runs.
- `telegramBot.oldestPendingDeliveryAgeSec > 2700` (45 minutes) means risk-alert rows are inside the final 15-minute TTL window. Launch/admin rows use a shorter 30-minute TTL, so avoid broadcasts once pending age is over 15 minutes.
- `telegramBot.pendingDeliveryBacklog.expired > 0` means rows have already aged past their `expires_at` or the legacy `PENDING_TTL_SEC = 3600` fallback.
- `crons["dispatch-telegram-alerts"].lastRun.metadata.pendingDroppedTtlExpired > 0`, `pendingNearTtlCount > 0`, `oldestPendingAgeSec > 900`, or `estimatedDrainTimeSec > 1800`.

## Current Capacity Math

The current sender attempts up to 3,600 fresh chunks per run and drains up to 900 pending chunks per run. At a five-minute cadence, the pending queue can drain roughly 10,800 chunks/hour when Telegram accepts sends and no new higher-priority work arrives. Risk-alert pending rows are ordered ahead of admin broadcasts; when fresh risk alerts exist, the pending-drain slice is restricted to risk-priority rows so admin broadcasts do not consume the risk-alert run budget. Dispatch also writes `telegram_alert_jobs` / `telegram_alert_job_targets` manifests before sending so target counts and dedupe keys remain auditable during rollout.

Use the load harness before a planned broad send:

```bash
npm run check:telegram-load
```

The script reports estimated drain time and D1 operation counts for 500, 1,000, 5,000, and 10,000 active watchers. The 10,000-watcher scenario is exploratory and should not block emergency triage.

## Quick Diagnostic Checklist

1. **Is the queue still draining?** Compare `pendingDeliveries`, `pendingDeliveryBacklog.due`, `oldestPendingDeliveryAgeSec`, `oldestPendingAgeSec`, and `estimatedDrainTimeSec` across two five-minute runs.
2. **Are rows deferred?** A high `pendingDeliveryBacklog.deferred` count with `retryErrorClassCounts.rate_limit` points to Telegram 429 behavior. Follow [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md).
3. **Are expired rows accumulating?** If `expired > 0`, clear them after confirming the latest dispatcher run is healthy. Scheduled cleanup copies expired rows to `telegram_alert_dead_letters` before deleting them.
4. **Is an admin broadcast pending?** Stop any planned broadcast until `oldestPendingDeliveryAgeSec < 900` and the queue is decreasing.
5. **Is D1 under pressure?** If D1 queueing or telemetry writes are competing with dispatch, follow [`d1-telemetry-kill-switch.md`](./d1-telemetry-kill-switch.md).

## Remediation

1. **Pause low-priority sends.** Do not run admin broadcasts, broad manual resends, or non-urgent operator notices while risk-alert rows are close to expiry.
2. **Let healthy drain continue.** If `pendingDeliveries` is decreasing and no rows are expired, wait one or two cycles. Opening the Telegram circuit breaker stops drain too, so avoid it unless Telegram is actively rejecting most sends.
3. **Clear expired rows.**

   ```bash
   curl -X POST \
        -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        -H "X-Pharos-Admin: 1" \
        -H "Idempotency-Key: clear-telegram-pending-expired-$(date +%s)" \
        "https://ops-api.pharos.watch/api/telegram-pending?older_than_sec=3600"
   ```

4. **Clear one abusive chat if needed.** If one chat dominates pending rows and is not a high-priority risk recipient, clear only that chat with `?chat_id=<chatId>`.
5. **Do not rewrite `created_at` to extend TTL.** Extending alert life by mutating D1 rows makes latency and audit data dishonest. TTL changes should ship as a reviewed sender change with explicit severity policy.
6. **After recovery, run a dry-run broadcast only if needed.** Follow [`telegram-admin-broadcast-safety.md`](./telegram-admin-broadcast-safety.md).

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Pending Delivery Queue.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) for sender budget assumptions.
- [`telegram-rate-limit-storm.md`](./telegram-rate-limit-storm.md) for 429-dominated incidents.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) for zero-send incidents.
