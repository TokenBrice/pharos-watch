# Runbook: Telegram Delivery

## Symptom

Use this procedure for missing subscriber alerts, a growing or expiring delivery backlog, Telegram 429 storms, bot-wide send failures, preset resolution failures, or an admin broadcast. Commands and callbacks that disappear belong to [webhook incidents](./telegram-webhook.md). Unresolved digest photo/text effects belong to [digest outbox recovery](./telegram-digest-outbox.md).

Every send is a row in `telegram_deliveries` (one per job, chat and chunk) under a `telegram_jobs` row (one per alert detection, freeze event, freeze batch, roll-up or broadcast). [Delivery persistence](../telegram-alerts.md#delivery-persistence) owns the semantics. Start with the [read-only incident entry](#read-only-incident-entry). Query access does not authorize mutation or replay.

| Observation | Branch |
| --- | --- |
| Several distinct chats fail, all sends fail, or Telegram authentication fails | [Bot-wide transport](#bot-wide-transport) |
| Backlog grows and `rate_limit` dominates | [Rate-limit storm](#rate-limit-storm) |
| Due rows age toward `expires_at`, or `expired` rows accumulate | [Backlog and expiration](#backlog-and-expiration) |
| A job stays in `planning`, or `presetFailure: true` | [Preset resolution failure](#preset-resolution-failure) |
| Events detected but nothing delivered, repeated snapshot seed, or one silent chat | [Quick diagnostic checklist](#quick-diagnostic-checklist) |
| An operator notice must go out | [Admin broadcast preflight](#admin-broadcast-preflight) |

## Quick Diagnostic Checklist

Compare at least two five-minute runs. Per-run counters come from the Access-protected `GET /api/status-cron-detail?job=dispatch-telegram-alerts` → `cron.runs[0].metadata.deliveryV2` (`alertJobId`, `deliveriesPlanned`, `suppressedDuplicate`, `jobsFailedClosed`, `planningErrors`, `heldKinds`, `claimed`, `sent`, `retried`, `failed`, `blocked`, `unknown`, `cancelled`, `drainStoppedReason`, `sweepSendingToUnknown`, `sweepExpired`).

1. **Provider breaker?** `/api/health.circuits["telegram-api"]`. While it is open the run reports `drainStoppedReason: "circuit-open"`. Detection and fan-out continue; only sends are skipped. Do not clear the circuit to force delivery.
2. **Job stuck in `planning`?** `deliveryV2.jobsFailedClosed > 0` or `presetFailure: true` means a fan-out page threw. See [preset resolution failure](#preset-resolution-failure).
3. **Planning stage failed?** A `degraded` run with `deliveryV2.planningErrors` had freeze detection, alert detection, retraction or fan-out throw; drain and sweep still ran. If retraction failed, `heldKinds` lists `freeze`/`freeze_batch` rows held until a later run's check succeeds.
4. **Suppressed, not lost?** `suppressedDuplicate` counts rows whose identical body reached the same chat within 24 h (the anti-flap). A flapping coin produces these by design.
5. **Unknown effects?** `unknown` rows (timeout, network error, or claim expiry after a crash) are never re-sent. Inspect them with [rows for one chat](#delivery-rows-for-one-chat). There is no operator resend.
6. **Safety-only silence?** Read `cron.runs[0].metadata.safetySource` from `GET /api/status-cron-detail?job=telegram-degradation-watchdog`. `failureReason` distinguishes `v9-publication-held`, `v9-snapshot-read-failed` and `v9-snapshot-invalid`.
7. **Snapshot seed?** `snapshotSeeded: true` means the run reseeded instead of alerting ([snapshot behavior](../telegram-alerts.md#first-run--stale-snapshot-behavior)). If it persists across three runs, inspect the `alert:*-snapshot` cache keys.
8. **Single chat?** Use [subscriber controls](#subscriber-delivery-controls) and [rows for one chat](#delivery-rows-for-one-chat). The row `reason` tells the story: `subscriber_missing`, `chat_snoozed` (deferred to the snooze end; `4102444800` is the `/pause` sentinel), `coin_snoozed`, `duplicate_prior_delivery`, `predecessor_failed`, `ambiguous_send`, `claim_expired`, `max_attempts`, or a transport error class. `consecutive_block_count >= 2` means repeated 403s auto-disabled the chat's follows. A chat over the per-chat cap gets no row; its overflow appears in the next daily roll-up.
9. **Webhook secret?** Failed validation returns `200 ok` without dispatch. [Secret rotation](./telegram-webhook.md#secret-rotation) owns recovery.

## Remediation

- **No raw clear, replay or TTL extension.** Do not delete, re-insert or re-time rows. `sending` and `unknown` rows are never returned to the queue. A replay would need a separately reviewed, audited control.
- **Protect risk work.** Stop admin broadcasts during 429 pressure or expiry risk. Broadcast rows have priority 90, behind every risk family.
- **User-side fixes.** A blocked user unblocks the bot and re-subscribes; `/start` alone does not restore follows that auto-disable cleared. Snooze and quiet hours are user choices (`/pause off`, settings).
- **Registration drift.** Inspect `budgetOnlySurfaces` for `telegram-registration-reconciliation`. Force `npx tsx scripts/maintenance/register-telegram.ts --action webhook` only when automatic repair cannot wait.
- **Emergency stop.** There is no operator pause. Use a Worker rollback.

## Backlog and Expiration

`telegramBot.pendingDeliveries`, `pendingDeliveryBacklog`, `oldestPendingDeliveryAgeSec` and `retryErrorClassCounts` read open `telegram_deliveries` rows. The watchdog degrades after a sustained 20-minute breach of: active rows > 500, oldest due ≥ 15 min, estimated drain ≥ 30 min, unknown work ≥ 15 min old, or any row inside 15 minutes of its TTL.

| Signal | Meaning / action |
| --- | --- |
| `oldestPendingDeliveryAgeSec > 900` | Warning and broadcast stop threshold; not row expiry. |
| `oldestPendingDeliveryAgeSec > 6300` | Two-hour risk rows are in their final 15 minutes. |
| `deliveryV2.sweepExpired > 0` | Rows passed `expires_at` and were marked `expired`; check why the drain did not reach them (deadline, circuit, global backoff). |

A run claims pages of 100 rows until the four-minute soft deadline (`drainStoppedReason: "deadline"`), sending to four distinct chats at a time.

## Rate-Limit Storm

1. **One chat.** A chat 429 pushes all of that chat's queued rows to the Retry-After deadline (`state='retry'`, `error_class='rate_limit'`). Peers continue.
2. **Many chats.** 429s from two or more chats in one wave raise `telegram:global-send-backoff-until` and stop the run (`drainStoppedReason: "global-backoff"`). Later runs skip sending until the deadline passes. Do not delete the cache key.
3. **Expiry risk.** Go to [Backlog and expiration](#backlog-and-expiration).

## Bot-Wide Transport

The generic `telegram-api` row in `circuit_breakers` is the only bot-wide gate, for both the alert drain and the digest outbox. A failing run (attempts made, none accepted or blocked) records a breaker failure. Recovery is the breaker's half-open probe; see [lease/breaker recovery](./lease-and-breaker-recovery.md). Correct credentials or wait for Telegram, and never clear queued rows.

## Preset Resolution Failure

A fan-out page that throws (usually preset resolution unable to read the strict `stablecoins` cache, or a failing `telegram_preset_subscriptions` query) fails the job closed: it stays `planning` with its cursor and an `error` class, is retried every run, and is cancelled at its TTL (`expired_while_planning`). Rows already inserted by earlier pages still deliver. Preset-backed recipients are never treated as an empty audience. Signals: `presetFailure: true` and `deliveryV2.jobsFailedClosed > 0` in dispatch metadata, and the job row in [open jobs](#jobs-and-rows).

1. **Stablecoins cache.** The resolver (`resolveTelegramPresetTargets` in `worker/src/telegram/common/presets.ts`) reads the strict `stablecoins` cache plus active tracked metadata. Check the `sync-stablecoins` cron and `/api/status` → `dataQuality.stablecoinsCacheStatus` / `stablecoinsCacheReason`. The next dispatch retries once the cache is readable.
2. **D1 failure or schema drift.** Check [database connectivity](./db-connectivity.md) and that `worker/migrations/MANIFEST.md` matches the deployed Worker.
3. **Registry drift.** Compare followed `preset_id` values with `shared/lib/telegram-presets.ts`. An empty resolved preset is valid when no eligible asset meets its criteria; do not restore an inactive asset or remove a preset because its target set is empty.

```sql
SELECT preset_id, COUNT(*) AS followers
FROM telegram_preset_subscriptions
GROUP BY preset_id
ORDER BY followers DESC;
```

There is no preset-only re-fire and no hand-enqueue after a job expires.

## Admin Broadcast Preflight

`POST /api/admin-telegram-broadcast` ([API](../api-reference-admin.md#post-apiadmin-telegram-broadcast)) sends the private canary synchronously, then records one `broadcast:<digest>` job that the dispatcher fans out with priority 90 and a 45-minute TTL, behind every risk family.

1. **Check backlog health.** Do not broadcast if `oldestPendingDeliveryAgeSec > 900`, `pendingDeliveryBacklog.expired > 0`, `pendingDeliveryBacklog.nearTtl > 0`, `retryErrorClassCounts.rate_limit` dominates, or the `telegram-api` circuit is open. Avoid active depeg, DEWS burst or safety-publication incidents.
2. **Dry run.**

   ```bash
   curl -X POST \
        -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        -H "X-Pharos-Admin: 1" \
        -H "Idempotency-Key: telegram-broadcast-dry-run-$(date +%s)" \
        -H "Content-Type: application/json" \
        --data '{"messageHtml":"<b>Test</b>","scope":"deliverable-watchers","dryRun":true}' \
        https://ops-api.pharos.watch/api/admin-telegram-broadcast
   ```

   Dry-run and live requests preflight `messageHtml` before target selection; unsupported or unbalanced Telegram HTML returns `422` with an error position. Review every chunk of the preview. In the operator panel, live send stays disabled until a successful preview covers the exact current message and audience; **Retry same intent** replays the original body and idempotency key only.
3. **Estimate.** Proceed only when `deliveryEstimate.hasMaterialTtlReserve` is true (at least 15 minutes of reserve inside the 45-minute TTL). Live requests return `409` otherwise; nothing bypasses it.
4. **Scope.** Prefer `deliverable-watchers`. Use `global-subscribers` only for global-alert policy notices and `all` only when intentionally targeting every subscriber row.
5. **Live send** with a stable idempotency key and a private operator `canaryChatId`. Every chunk goes to the canary silently first; a failed canary returns `fleetEnqueued: 0` and records no job. The canary chat is excluded from fan-out.

   ```bash
   curl -X POST \
        -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        -H "X-Pharos-Admin: 1" \
        -H "Idempotency-Key: telegram-broadcast-<incident-or-date>" \
        -H "Content-Type: application/json" \
        --data '{"messageHtml":"<b>Notice</b> ...","scope":"deliverable-watchers","dryRun":false,"canaryChatId":"<private-chat-id>"}' \
        https://ops-api.pharos.watch/api/admin-telegram-broadcast
   ```

6. **Monitor** the returned `jobId` with [open jobs](#jobs-and-rows) for at least two five-minute runs. If rate limits appear, stop further broadcasts and follow [rate-limit storm](#rate-limit-storm).

## Operator Queries

### Read-Only Incident Entry

- Use authorized access to admin `/api/status` and the primary Worker D1 database, `stablecoin-db` ([operator origin access](../operator-origin-access.md)). Query access does not authorize mutations.
- Run SQL with `npx --no-install wrangler d1 execute stablecoin-db --remote --command "<SQL>"` from `worker/`, never `--file` ([remote D1 inspection](../worker-infrastructure.md#remote-d1-inspection)). Replace every `?` with the current Unix timestamp (seconds) and substitute only the affected chat/job identifiers.
- Confirm deployed schema parity before reading a failed query as an empty result. Never reset or delete `sending` or `unknown` evidence to force replay.

### Jobs and Rows

Open and recent jobs with their row mix:

```sql
SELECT j.job_id, j.kind, j.state, j.cursor, j.planned_count, j.error,
       ? - j.created_at AS age_sec, j.expires_at - ? AS ttl_left_sec,
       SUM(d.state IN ('pending', 'retry')) AS open_rows,
       SUM(d.state = 'sending') AS sending,
       SUM(d.state = 'sent') AS sent,
       SUM(d.state = 'suppressed_duplicate') AS suppressed,
       SUM(d.state IN ('failed', 'blocked', 'expired', 'cancelled', 'unknown')) AS other_terminal
  FROM telegram_jobs j
  LEFT JOIN telegram_deliveries d ON d.job_id = j.job_id
 WHERE j.state IN ('planning', 'ready') OR j.created_at > ? - 86400
 GROUP BY j.job_id
 ORDER BY j.created_at DESC
 LIMIT 50;
```

Backlog by priority and state:

```sql
SELECT priority, state, COUNT(*) AS rows,
       SUM(next_attempt_at <= ?) AS due,
       MAX(? - created_at) AS oldest_age_sec,
       MIN(expires_at - ?) AS nearest_ttl_sec
  FROM telegram_deliveries
 WHERE state IN ('pending', 'retry', 'sending')
 GROUP BY 1, 2
 ORDER BY priority, state;
```

Last 24 h outcomes and reasons:

```sql
SELECT kind, state, COALESCE(reason, error_class, '-') AS reason, COUNT(*) AS rows
  FROM telegram_deliveries
 WHERE created_at > ? - 86400
 GROUP BY 1, 2, 3
 ORDER BY rows DESC;
```

Health checks (each should return 0): stale `sending` rows, stuck `planning` jobs, and duplicate alert sends:

```sql
SELECT COUNT(*) FROM telegram_deliveries WHERE state = 'sending' AND sending_at < ? - 600;
SELECT COUNT(*) FROM telegram_jobs WHERE state = 'planning' AND created_at < ? - 900;
SELECT COUNT(*) FROM (SELECT chat_id, body_hash FROM telegram_deliveries
  WHERE state = 'sent' AND kind = 'alert' AND done_at > ? - 86400
  GROUP BY 1, 2 HAVING COUNT(*) > 1);
```

### Delivery Rows For One Chat

```sql
SELECT id, job_id, kind, seq, state, attempts, priority, reason, error_class, status_code,
       created_at, next_attempt_at, expires_at, sending_at, done_at, claim_owner
  FROM telegram_deliveries
 WHERE chat_id = '<chat_id>'
 ORDER BY created_at DESC, job_id, seq
 LIMIT 50;
```

### Subscriber Delivery Controls

```sql
SELECT chat_id, alert_snooze_until_ts, quiet_hours_enabled,
       quiet_hours_start_utc, quiet_hours_end_utc, timezone,
       consecutive_block_count, consecutive_block_first_at,
       global_alert_dews, global_alert_depeg, global_alert_safety,
       global_alert_reserve, global_alert_freeze,
       preference_generation, created_at, last_active_at
FROM telegram_subscribers
WHERE chat_id = '<chat_id>';
```

Roll-up state for the chat (`last_rollup_at` drives the next daily roll-up window):

```sql
SELECT * FROM telegram_rollup_state WHERE chat_id = '<chat_id>';
```

### Usage

Reply failures by command and failure class:

```sql
SELECT COALESCE(NULLIF(action_detail, ''), 'unknown') AS command,
       COALESCE(NULLIF(failure_class, ''), 'unknown') AS failure_class,
       SUM(count) AS failures, MIN(first_seen_at) AS first_seen_at, MAX(last_seen_at) AS last_seen_at
FROM telegram_usage_daily
WHERE day >= date('now', '-1 day') AND event_type = 'reply_failure'
GROUP BY 1, 2
ORDER BY failures DESC;
```

## Cross-References

- [Telegram behavior](../telegram-alerts.md): dispatch, snapshots and delivery persistence.
- [Webhook incidents](./telegram-webhook.md): missing command/callback effects, not queue resends.
- [Database connectivity](./db-connectivity.md) and [limits](../worker-and-api-limits.md): D1 and trigger-wide constraints.
