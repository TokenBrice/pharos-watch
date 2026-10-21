# Runbook: Telegram Delivery, Backlog and Bot-Wide Outages

## Symptom

Use this procedure for missing subscriber alerts, a growing or expiring delivery backlog, Telegram 429 storms, or authentication failures across chats. Commands and callbacks that disappear belong to [ingress and retry incidents](./telegram-webhook-retry-dedupe.md). Unresolved digest photo/text effects belong to [digest outbox recovery](./telegram-digest-outbox.md).

Delivery v2 stores every send in `telegram_jobs` (one per alert detection, freeze event, broadcast or roll-up) and `telegram_deliveries` (one per job, chat and chunk). [Delivery persistence](../telegram-alerts.md#delivery-persistence) owns the semantics. Start with the [read-only incident entry](./telegram-operator-queries.md#read-only-incident-entry). Query access does not authorize mutation or replay.

| Observation | Branch |
| --- | --- |
| Several distinct chats fail, all sends fail, or Telegram authentication fails | [Bot-wide transport](#bot-wide-transport) |
| Backlog grows and `rate_limit` dominates | [Rate-limit storm](#rate-limit-storm) |
| Due rows age toward `expires_at`, or `expired` rows accumulate | [Backlog and expiration](#backlog-and-expiration) |
| Events detected but nothing delivered, a job stuck in `planning`, repeated snapshot seed, or one silent chat | [Quick diagnostic checklist](#quick-diagnostic-checklist) |
| Safety-only silence | Inspect the watchdog's canonical safety-source provenance |

## Quick Diagnostic Checklist

Compare at least two five-minute runs. Per-run counters come from the Access-protected `GET /api/status-cron-detail?job=dispatch-telegram-alerts` → `cron.runs[0].metadata.deliveryV2` (`alertJobId`, `deliveriesPlanned`, `suppressedDuplicate`, `jobsFailedClosed`, `claimed`, `sent`, `retried`, `failed`, `blocked`, `unknown`, `cancelled`, `drainStoppedReason`, `sweepSendingToUnknown`, `sweepExpired`, `legacyShimActive`).

1. **Provider breaker?** `/api/health.circuits["telegram-api"]`. While it is open the run reports `skipped: "circuit-open"` and `drainStoppedReason: "circuit-open"`. Detection and fan-out continue; only sends are skipped. Do not clear the circuit to force delivery.
2. **Job stuck in `planning`?** `deliveryV2.jobsFailedClosed > 0` or `presetFailure: true` means a fan-out page threw. The usual cause is that preset resolution could not read the stablecoins cache, which fails closed. The job retries every run and is cancelled at its TTL. Follow [preset resolution failure](./telegram-preset-resolution-failure.md) and [database connectivity](./db-connectivity.md). Never treat unresolved presets as an empty audience.
3. **Suppressed, not lost?** `suppressedDuplicate` counts rows whose identical body reached the same chat within 24 h (the anti-flap). A flapping coin produces these by design.
4. **Unknown effects?** `unknown` rows (timeout, network error, or claim expiry after a crash) are never re-sent. Inspect them with [operator queries](./telegram-operator-queries.md#delivery-rows-for-one-chat). There is no operator resend.
5. **Safety-only silence?** Read `cron.runs[0].metadata.safetySource` from `GET /api/status-cron-detail?job=telegram-degradation-watchdog`. `failureReason` distinguishes `v9-publication-held`, `v9-snapshot-read-failed` and `v9-snapshot-invalid`.
6. **Snapshot seed?** `snapshotSeeded: true` means the run reseeded instead of alerting ([snapshot behavior](../telegram-alerts.md#first-run--stale-snapshot-behavior)). If it persists across three runs, inspect the `alert:*-snapshot` cache keys.
7. **Single chat?** Use [subscriber controls](./telegram-operator-queries.md#subscriber-delivery-controls) and [delivery rows for one chat](./telegram-operator-queries.md#delivery-rows-for-one-chat). The row `reason` tells the story: `subscriber_missing`, `chat_snoozed` (deferred to the snooze end; the exact `4102444800` value is the `/pause` sentinel), `coin_snoozed`, `duplicate_prior_delivery`, `predecessor_failed`, `ambiguous_send`, `claim_expired`, `max_attempts`, or a transport error class. `consecutive_block_count >= 2` means repeated 403s auto-disabled the chat's follows.
8. **Webhook secret?** Failed validation returns `200 ok` without dispatch. [Secret rotation](./telegram-secret-rotation.md) owns recovery.

## Remediation

- **No raw clear, replay or TTL extension.** Do not delete, re-insert or re-time rows. `sending` and `unknown` rows are never returned to the queue. A replay would need a separately reviewed, audited control.
- **Protect risk work.** Stop admin broadcasts during 429 pressure or expiry risk. Broadcast rows have priority 90, behind every risk family.
- **User-side fixes.** A blocked user unblocks the bot and re-subscribes; `/start` alone does not restore follows that auto-disable cleared. Snooze and quiet hours are user choices (`/pause off`, settings).
- **Registration drift.** Inspect `budgetOnlySurfaces` for `telegram-registration-reconciliation`. Force `npx tsx scripts/maintenance/register-telegram.ts --action webhook` only when automatic repair cannot wait.

## Backlog and Expiration

`telegramBot.pendingDeliveries`, `pendingDeliveryBacklog`, `oldestPendingDeliveryAgeSec` and `retryErrorClassCounts` read open v2 rows plus any legacy shim rows. The watchdog degrades after a sustained 20-minute breach of: active rows > 500, oldest due ≥ 15 min, estimated drain ≥ 30 min, unknown work ≥ 15 min old, or any row inside 15 minutes of its TTL.

| Signal | Meaning / action |
| --- | --- |
| `oldestPendingDeliveryAgeSec > 900` | Warning and broadcast stop threshold; not row expiry. |
| `oldestPendingDeliveryAgeSec > 6300` | Two-hour risk rows are in their final 15 minutes. |
| `deliveryV2.sweepExpired > 0` | Rows passed `expires_at` and were marked `expired`; check why the drain did not reach them (deadline, circuit, global backoff). |

A run claims pages of 100 rows until the four-minute soft deadline (`drainStoppedReason: "deadline"`), sending to four distinct chats at a time. At the 2026-10 load (~800 recipients per burst) that drains in about a minute.

## Rate-Limit Storm

1. **One chat.** A chat 429 pushes all of that chat's queued rows to the Retry-After deadline (`state='retry'`, `error_class='rate_limit'`). Peers continue.
2. **Many chats.** 429s from two or more chats in one wave raise `telegram:global-send-backoff-until` and stop the run (`drainStoppedReason: "global-backoff"`). Later runs skip sending until the deadline passes. Do not delete the cache key.
3. **Expiry risk.** Go to [Backlog and expiration](#backlog-and-expiration).

## Bot-Wide Transport

The generic `telegram-api` provider breaker is the only bot-wide gate for alert delivery. The legacy `telegram_transport_circuit` and `telegram_delivery_pauses` are no longer consulted by the v2 drain; the legacy shim and the digest outbox still read them until legacy removal. A failing run (attempts made, none accepted or blocked) records a breaker failure. Recovery is the breaker's half-open probe; see [lease/breaker recovery](./lease-and-breaker-recovery.md). Correct credentials or wait for Telegram, and never clear queued rows. There is no supported operator pause/resume mutation.

## Pause

There is no supported operator pause or resume mutation, and the v2 drain does not read `telegram_delivery_pauses`. If an emergency stop is needed, use the documented production config switches (Telegram feature and rollout modes) or a Worker rollback. Never write raw pause or circuit rows.

## Delivery v2 Production Acceptance

**Before deploying the cutover.** The v2 Worker does not resume legacy source events. Each of these must return 0 (run against production with the old Worker still live). If any is non-zero, wait for the old Worker to finish them (at most their 2 h TTL) and re-check:

```sql
SELECT COUNT(*) FROM telegram_alert_source_events WHERE status NOT IN ('complete', 'expired');
SELECT COUNT(*) FROM telegram_freeze_alert_events WHERE status IN ('planning', 'queued');
SELECT COUNT(*) FROM telegram_alert_job_targets WHERE status = 'planned';
```

Run after the cutover deploy and again after the first eventful dispatch (`cd worker && npx wrangler d1 execute stablecoin-db --remote --json --command "…"`):

```sql
-- 1. State mix (no 'sending' older than 10 min; no 'planning' job older than 15 min)
SELECT state, COUNT(*) FROM telegram_deliveries GROUP BY 1;
SELECT COUNT(*) FROM telegram_deliveries WHERE state = 'sending' AND sending_at < unixepoch() - 600;
SELECT COUNT(*) FROM telegram_jobs WHERE state = 'planning' AND created_at < unixepoch() - 900;
-- 2. Duplicate sends = 0
SELECT COUNT(*) FROM (SELECT chat_id, body_hash FROM telegram_deliveries
  WHERE state = 'sent' AND kind IN ('alert') AND done_at > unixepoch() - 86400
  GROUP BY 1, 2 HAVING COUNT(*) > 1);
-- 3. Daily volume within band (~1–1.5k/day pre-policy) and anti-flap active
SELECT kind, state, COUNT(*) FROM telegram_deliveries WHERE created_at > unixepoch() - 86400 GROUP BY 1, 2;
-- 4. Legacy queue empty within 2 h of deploy
SELECT delivery_state, COUNT(*) FROM telegram_pending_alerts
  WHERE delivery_state IN ('pending', 'sending') GROUP BY 1;
```

Also confirm that `/forget` on a test chat removes its `telegram_deliveries` rows.

**Rollback** is a Worker rollback: the tables are additive, and both pipelines share the snapshot and freeze-cursor keys. The old Worker never reads `telegram_jobs` or `telegram_deliveries`. Rows still `pending` or `retry` at rollback are **not delivered**: they are risk alerts at most 2 h old, roll-ups and broadcast rows. Before rolling back, read their volume with `SELECT kind, COUNT(*) FROM telegram_deliveries WHERE state IN ('pending', 'retry', 'sending') GROUP BY 1`, and record it in the incident notes. Detections already committed as jobs are not re-detected by the old Worker, because their baselines have already advanced.

A dispatch run that ends `degraded` with `deliveryV2.planningErrors` had a planning stage fail (freeze detection, alert detection, retraction or fan-out). Drain, the legacy shim and the sweep still ran that run. Inspect the error class and the job's `error` column; a job that keeps failing is cancelled at its TTL.

## Recap Retirement Stop and Drain

Personalized watchlist recaps are retired immediately; **do not enter `retirement-notice` mode or send a notice edition**. Public editorial daily/weekly digests, risk alerts and shared delivery remain active.

Before deploying consumer-removal code, operate the **previous stop-capable release** (WS06-B30, not the cutover checkout) with the existing binding set to `off`. Use the approved release process for activation; its exact public-Worker configuration command, from that release's repository root, is:

```sh
npx --no-install wrangler deploy --config worker/wrangler.toml --strict --var TELEGRAM_RECAP_ROLLOUT_MODE:off
```

This is an operator-only production mutation, not a command to run while implementing retirement. Confirm the selected source is the currently approved stop-capable release so other configuration/code is not rolled back. Record source SHA, activated public version/time, final planner admission and compatible rollback floor. Observe a natural five-minute `off` execution, allow older invocations/claims to settle, then observe a later slot. Do not clear leases, force recap execution, reset/replay unknown effects, hand-enqueue, or delete transport rows.

Run SELECT-only readbacks using `--command`, never `--file` ([remote D1 inspection](../worker-infrastructure.md#remote-d1-inspection)):

```sh
npx --no-install wrangler d1 execute stablecoin-db --config worker/wrangler.toml --remote --json --command "SELECT (SELECT COUNT(*) FROM telegram_recap_targets WHERE status IN ('planned','queued')) AS nonterminal_targets, (SELECT COUNT(*) FROM telegram_pending_alerts WHERE source_type = 'personalized_recap' AND delivery_state IN ('pending','sending')) AS nonterminal_transports;"
```

Both counts must be explicitly observed zero after stop and again immediately before cutover. Capture the following aggregate clocks/outcomes at both natural-slot observations; no new target admissions or queues may appear:

```sql
SELECT status, COUNT(*) AS count FROM telegram_recap_targets GROUP BY status;
SELECT delivery_state, COUNT(*) AS count FROM telegram_pending_alerts
WHERE source_type = 'personalized_recap' GROUP BY delivery_state;
SELECT COUNT(*) AS target_count, MAX(created_at) AS last_target_created_at,
       MAX(queued_at) AS last_target_queued_at,
       MAX(completed_at) AS last_target_completed_at,
       MAX(updated_at) AS last_target_evidence_at FROM telegram_recap_targets;
SELECT MAX(updated_at) AS last_preference_write_at FROM telegram_recap_preferences;
SELECT MAX(updated_at) AS last_transport_evidence_at FROM telegram_pending_alerts
WHERE source_type = 'personalized_recap';
```

Failed/null query envelopes are unavailable evidence, never zero backlog. `sent`/`execution_unknown` are terminal audit, not permission to resend or proof of user receipt. If work remains, retain the stop-capable consumer and investigate its original claim/target fences; **do not deploy removal code**.

Only after accepted zero-work/no-new-admission proof may the cutover remove planner/consumers/controls and the binding. Deploy the v7 Worker before Pages; old explicit contracts reject without mutation, and unversioned retired operations fail schema validation. Confirm the next production five-minute lane still runs risk dispatch and sidecars with no recap task. The cutover has no permanent disabled flag.

No table drop, baseline rewrite or retention-row removal belongs here. Keep recap audit, privacy erasure and existing expiry. Separate destructive cleanup requires at least 90 days after final recap evidence, closed compatible rollback floor, fresh zero-use proof and verified Time Travel. No production stop/drain acceptance is asserted by these instructions.

## Cross-References

- [Telegram behavior](../telegram-alerts.md): dispatch, snapshots, durable delivery, and load policy.
- [Reusable operator queries](./telegram-operator-queries.md): read-only job, delivery, legacy-queue, dedupe and dead-letter evidence.
- [Admin broadcast safety](./telegram-admin-broadcast-safety.md): optional notices after risk work recovers.
- [Ingress/retries/setup](./telegram-webhook-retry-dedupe.md): missing command/callback effects, not queue resends.
- [Database connectivity](./db-connectivity.md) and [limits](../worker-and-api-limits.md): D1 and trigger-wide constraints.
