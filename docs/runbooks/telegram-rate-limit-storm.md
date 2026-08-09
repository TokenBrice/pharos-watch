# Runbook: Telegram Rate-Limit Storm

## Symptom

The pending delivery queue is growing run-over-run, and a large share of the dispatcher's retry classes is `rate_limit` (HTTP 429).

Detection signals:

- `/api/status` -> `telegramBot.pendingDeliveries` trends upward across consecutive runs.
- `crons["dispatch-telegram-alerts"].lastRun.metadata` reports `oldestPendingAgeSec`, `estimatedDrainTimeSec`, `pendingNearTtlCount`, or `pendingCapacityAfter.nearTtl` above normal.
- `telegramBot.retryErrorClassCounts.rate_limit` dominates.
- Watchdog status: active (non-expired) pending count `> 500` sustained for 20 min or more, oldest pending age 15 min or more, estimated drain time 30 min or more, or any near-TTL pending row degrades the watchdog status.
- `oldestPendingDeliveryAgeSec` approaching `PENDING_TTL_SEC` (7200 for risk/legacy rows); use each row's explicit `expires_at` for shorter launch/admin work.
- `npm run check:telegram-load` shows the matching 429-storm scenario exceeding the one-hour maximum at the current watcher scale.

## Quick Diagnostic Checklist

1. **Is it global or per-chat?** With per-chat rate-limit isolation (P0-R3), one chat's 429 no longer cascades to others. Inspect `telegramBot.retryErrorClassCounts` together with `pendingDeliveryBacklog.deferred` — heavy `deferred` against a small set of chats means per-chat backoff is doing its job. Later same-chat rows/chunks are short-circuited inside the same run rather than re-sent.
2. **Telegram Bot API global limit hit?** Sustained 429 across many distinct chats indicates global throttling rather than per-chat backoff. The sender also treats an otherwise ambiguous 429 with `Retry-After >= 30s` as bot-wide and escalates to global backoff when several distinct chats return 429 in one run. Cross-reference [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) for the repo's six-request trigger budget; the dispatcher batches at 4 to preserve headroom.
3. **Single chat starving the queue?** A chat with many subscriptions can still consume multiple message chunks inside the 3,600-attempt per-run cap. The per-chat `not_before_at` backoff prevents starvation, but inspect the chat's queue directly (`GET /api/admin-telegram-chat/:chatId` was retired on 2026-08-09):

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT delivery_state, COUNT(*) AS rows, MIN(created_at) AS oldest_created_at, MAX(not_before_at) AS latest_not_before_at FROM telegram_pending_alerts WHERE chat_id = '<chatId>' GROUP BY delivery_state;"
   ```

   The per-row queries in [`telegram-operator-queries.md`](./telegram-operator-queries.md) cover the rest of what that endpoint returned.
4. **Watchdog firing?** Confirm whether the watchdog alert has already been raised (P0-O4). If so, an operator notification is in flight.
5. **Backlog expiration risk?** If `oldestPendingDeliveryAgeSec > 2700` or `pendingDeliveryBacklog.expired > 0`, switch to [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md) before sending any broadcast or manual resend.

## Remediation

1. **Wait one drain cycle.** Each dispatch run reserves up to 1,800 of its 3,600 message attempts for the pending queue and drains existing due rows before authoritative target planning. Risk-alert pending rows are ordered ahead of low-priority admin broadcasts, and fresh risk alerts do not spend the run's pending-drain share on admin broadcasts during contention. If `pendingDeliveries`, `oldestPendingAgeSec`, and `estimatedDrainTimeSec` are decreasing run-over-run, no action.
2. **Size the pending queue for a specific chat.** `POST /api/telegram-pending`, the filtered operator clear, was retired on 2026-08-09. Its dry-run preview is still available as a plain read against the same filter the endpoint used:

   ```bash
   npx --no-install wrangler d1 execute stablecoin-db --remote --command \
     "SELECT COUNT(*) AS matched FROM telegram_pending_alerts WHERE chat_id = '<chatId>' AND delivery_state = 'pending';"
   ```

   The destructive clear has no honest equivalent: the endpoint dead-lettered each row with `reason = 'manual_clear'`, projected its target to `cancelled`, and only then deleted, all in one bounded pass. A hand-written `DELETE` skips that bookkeeping and destroys the evidence trail. Let scheduled TTL cleanup drain the rows instead, and if an incident truly requires a manual clear, revert the endpoint's removal commit.
3. **Let scheduled expiry cleanup handle expired rows.** Never treat row age as expiry: a `created_at` cutoff is not `expires_at`, and filtering on it can cancel still-live risk, launch, or recap alerts. Scheduled cleanup evaluates explicit expiry (with the legacy two-hour fallback), dead-letters expired rows with `reason = 'ttl_expired'`, and marks their targets expired before deletion.
4. **Pause low-priority sends.** Do not run admin broadcasts while 429 dominates. The live broadcast endpoint also refuses an unavailable transport circuit/permit and requires a successful private canary plus a hard 15-minute TTL reserve, but those guards do not justify adding low-priority work during an active storm. Risk alerts take priority over recovery notices.
5. **Investigate root cause.** If 429 is sustained without an obvious driver, check Cloudflare logs for outbound Telegram POSTs and confirm no client is replaying historical events through a non-production dispatcher.
6. **Last resort: pause affected delivery modes.** The `/api/admin-telegram-delivery-control` endpoint was retired on 2026-08-09, but `telegram_delivery_pauses` still gates every send: write the generation-fenced pause row directly. Pause `fresh` to stop new risk sends, `pending` to stop backlog drain, or `admin` to stop broadcasts; give each pause a reason and an expiry within 24 hours, since nothing validates that for you now. Follow [`telegram-bot-wide-outage.md`](./telegram-bot-wide-outage.md) for the exact statements and recovery. Do not delete the `circuit:telegram-api` breaker row to pause sends: that clears breaker state and lets the next run probe again.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Pending Delivery Queue — retry/TTL contract and dedupe-key semantics.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) — connection-budget operating assumption and rate-limit isolation note.
- [`docs/architecture.md`](../architecture.md) — cron topology.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — when no messages are going out at all (a storm can present as no delivery).
- [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md) — when pending rows approach their source-specific expiry (two-hour risk, 90-minute launch, or 45-minute admin).
- [`telegram-admin-broadcast-safety.md`](./telegram-admin-broadcast-safety.md) — broadcasts must wait until rate-limit pressure clears.
- [`telegram-bot-wide-outage.md`](./telegram-bot-wide-outage.md) — supported fresh, pending, and admin delivery pauses plus half-open recovery.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) — D1 diagnostics for pending, jobs, dead letters, webhook dedupe, and usage funnels.
