# Runbook: Telegram Rate-Limit Storm

## Symptom

The pending delivery queue is growing run-over-run, and a large share of the dispatcher's retry classes is `rate_limit` (HTTP 429).

Detection signals:

- `/api/status` -> `telegramBot.pendingDeliveries` trends upward across consecutive runs.
- `crons["dispatch-telegram-alerts"].lastRun.metadata` reports `oldestPendingAgeSec`, `estimatedDrainTimeSec`, `pendingNearTtlCount`, or `pendingCapacityAfter.nearTtl` above normal.
- `telegramBot.retryErrorClassCounts.rate_limit` dominates.
- Watchdog status: active (non-expired) pending count `> 500`, oldest pending age at least 15 min, estimated drain at least 30 min, or execution-unknown work at least 15 min old degrades after a sustained 20-minute breach. A new episode first records onset; near-TTL work degrades on the next evaluation without waiting 20 minutes. An `unknown` capacity read degrades the run itself.
- `oldestPendingDeliveryAgeSec` approaching `PENDING_TTL_SEC` (7200 for risk/legacy rows); use each row's explicit `expires_at` for shorter launch/admin work.
- `npm run check:telegram-load` shows the matching 429-storm scenario exceeding the one-hour maximum at the current watcher scale.

## Quick Diagnostic Checklist

Start with the shared [read-only incident entry](./telegram-operator-queries.md#read-only-incident-entry); use the storm-specific signals and thresholds below.

1. **Is it global or per-chat?** With per-chat rate-limit isolation (P0-R3), one chat's 429 no longer cascades to others. Inspect `telegramBot.retryErrorClassCounts` together with `pendingDeliveryBacklog.deferred` — heavy `deferred` against a small set of chats means per-chat backoff is doing its job. Later same-chat rows/chunks are short-circuited inside the same run rather than re-sent.
2. **Telegram Bot API global limit hit?** Sustained 429 across many distinct chats indicates global throttling rather than per-chat backoff. Individual 429s stay chat-local no matter how long `Retry-After` is; only the durable distinct-chat controller escalates, opening the bot-wide transport circuit once 3 distinct chats fail inside its 60-second window. Cross-reference [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) for the repo's six-request trigger budget; the dispatcher batches at 4 to preserve headroom.
3. **Single chat starving the queue?** A chat with many subscriptions can still consume multiple message chunks inside the 3,600-attempt per-run cap. The per-chat `not_before_at` backoff prevents starvation. Use [Pending Rows For One Chat](./telegram-operator-queries.md#pending-rows-for-one-chat) for the delivery-state/backoff summary and per-row evidence; `GET /api/admin-telegram-chat/:chatId` was retired on 2026-08-09.
4. **Watchdog firing?** Confirm whether the watchdog has already tripped (P0-O4). It only marks the `telegram-degradation-watchdog` cron run `degraded` with its breach reasons in `metadata` — read that from `/api/status`; no operator notification is sent.
5. **Backlog expiration risk?** If `oldestPendingDeliveryAgeSec > 2700` or `pendingDeliveryBacklog.expired > 0`, switch to [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md) before sending any broadcast or manual resend.

## Remediation

1. **Wait one drain cycle.** Each dispatch run reserves a bounded share of its message attempts for the pending queue (`TELEGRAM_PENDING_DRAIN_BUDGET` of `TELEGRAM_MAX_MESSAGES_PER_RUN` in `shared/lib/telegram-delivery-policy.ts`) and drains existing due rows before authoritative target planning. Risk-alert pending rows are ordered ahead of low-priority admin broadcasts, and fresh risk alerts do not spend the run's pending-drain share on admin broadcasts during contention. If `pendingDeliveries`, `oldestPendingAgeSec`, and `estimatedDrainTimeSec` are decreasing run-over-run, no action.
2. **Size the pending queue for a specific chat.** `POST /api/telegram-pending`, the filtered operator clear, was retired on 2026-08-09. Use the [read-only pending count](./telegram-operator-queries.md#pending-rows-for-one-chat) with the same `chat_id` and `delivery_state = 'pending'` filter its dry-run preview used.

   The destructive clear has no honest equivalent: the endpoint dead-lettered each row with `reason = 'manual_clear'`, projected its target to `cancelled`, and only then deleted, all in one bounded pass. A hand-written `DELETE` skips that bookkeeping and destroys the evidence trail. Let scheduled TTL cleanup drain the rows instead, and if an incident truly requires a manual clear, revert the endpoint's removal commit.
3. **Let scheduled expiry cleanup handle expired rows.** Never treat row age as expiry: a `created_at` cutoff is not `expires_at`, and filtering on it can cancel still-live risk, launch, or recap alerts. Scheduled cleanup evaluates explicit expiry (with the legacy two-hour fallback), attempts a best-effort dead-letter copy with `reason = 'ttl_expired'`, and projects target/recap outcomes before fenced deletion. A failed copy does not prevent expiry: inspect terminal outcomes and the `cleanup-expired-pending-dead-letter-bypass` log, not dead-letter absence, to establish what expired.
4. **Pause low-priority sends.** Do not run admin broadcasts while 429 dominates. The live broadcast endpoint also refuses an unavailable transport circuit/permit and requires a successful private canary plus a hard 15-minute TTL reserve, but those guards do not justify adding low-priority work during an active storm. Risk alerts take priority over recovery notices.
5. **Investigate root cause.** If 429 is sustained without an obvious driver, check Cloudflare logs for outbound Telegram POSTs and confirm no client is replaying historical events through a non-production dispatcher.
6. **Emergency pause requires an audited control.** The `/api/admin-telegram-delivery-control` endpoint was retired on 2026-08-09; there is currently no supported operator pause/resume mutation. Follow [`telegram-bot-wide-outage.md`](./telegram-bot-wide-outage.md#pause), the sole pause/resume authority, for the reviewed-control requirement and generation/audit/readback contract. Do not write raw pause SQL or clear `circuit:telegram-api` to simulate a pause. The missing emergency-pause control is an operational gap, not permission to bypass its audit.

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section Pending Delivery Queue — retry/TTL contract and dedupe-key semantics.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) — connection-budget operating assumption and rate-limit isolation note.
- [`docs/architecture.md`](../architecture.md) — cron topology.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — when no messages are going out at all (a storm can present as no delivery).
- [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md) — when pending rows approach their source-specific expiry (see [`docs/telegram-alerts.md`](../telegram-alerts.md#pending-delivery-queue)).
- [`telegram-admin-broadcast-safety.md`](./telegram-admin-broadcast-safety.md) — broadcasts must wait until rate-limit pressure clears.
- [`telegram-bot-wide-outage.md`](./telegram-bot-wide-outage.md) — pause-state inspection, the current audited-control gap, and half-open recovery.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) — D1 diagnostics for pending, jobs, dead letters, webhook dedupe, and usage funnels.
