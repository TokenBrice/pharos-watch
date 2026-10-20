# Runbook: Telegram Delivery, Backlog and Bot-Wide Outages

## Symptom

Use this procedure for missing subscriber alerts, a growing or expiring pending queue, Telegram 429 storms, authentication failures across chats, or intentional delivery pauses. Commands/callbacks that disappear belong to [ingress and retry incidents](./telegram-webhook-retry-dedupe.md); unresolved digest photo/text effects belong to [digest outbox recovery](./telegram-digest-outbox.md).

Start with the [read-only incident entry](./telegram-operator-queries.md#read-only-incident-entry). Query access does not authorize mutation or replay. Choose the branch before changing controls:

| Observation | Branch |
| --- | --- |
| Several distinct chats fail, all sends fail, or Telegram authentication fails | [Bot-wide transport](#bot-wide-transport), then [Pause](#pause) / [Recover](#recover) |
| Queue grows and `rate_limit` dominates | [Rate-limit storm](#rate-limit-storm); distinguish chat-local backoff from bot-wide escalation |
| Due/deferred work ages toward its explicit expiry, or expired rows accumulate | [Backlog and expiration](#backlog-and-expiration) |
| Events detected but no delivery, repeated snapshot seed, or one silent chat | [Quick diagnostic checklist](#quick-diagnostic-checklist) |
| Safety-only silence | Inspect the watchdog's canonical safety-source provenance, even if pending backlog is its primary reason |

Freeze uses its own outbox. Its observations are `eventsDetected.freeze`, while `freezeTargetCount` measures durable recipient work; `freezeObserved`, `freezeQueued`, and `freezeSkippedNoAudience` are outbox progress-stage `countTotals`, not top-level last-run metadata. An observed event alone does not prove an audience.

## Quick Diagnostic Checklist

Compare at least two five-minute runs. Per-run counters come from the Access-protected `GET /api/status-cron-detail?job=dispatch-telegram-alerts` -> `cron.runs[0].metadata`, not the `telegramBot` block or the `/api/status` summary (which carries only `latestRunFacts`).

1. **Provider breaker or transport circuit?** `/api/status.providerCircuitHealth.openProviders` lists open/half-open entries (`providerId: "telegram-api"`); `/api/health.circuits["telegram-api"]` is the full provider map. An open provider breaker skips fan-out. It is separate from the durable bot-wide transport controller and operator pauses; use [Bot-wide transport](#bot-wide-transport) for those. Do not clear either circuit merely to force delivery.
2. **D1 or preset-source hold?** Follow [database connectivity](./db-connectivity.md). Incomplete preset resolution holds all new direct, global, and preset planning for that source event; inspect `presetFailure`, `presetQueryFailures`, and `presetResolutionFailures`. Existing pending work may still drain and freeze has an independent outbox. [Preset resolution failure](./telegram-preset-resolution-failure.md) owns the source-wide hold: never bypass `allComplete` or treat unresolved presets as an empty audience.
3. **Pending lifecycle?** Compare `telegramBot.pendingDeliveries`, `pendingDeliveryBacklog`, `oldestPendingDeliveryAgeSec`, and `retryErrorClassCounts`. Growing due work routes to [backlog](#backlog-and-expiration); deferred 429 work routes to [rate limits](#rate-limit-storm). Preference reasons (`preference_snoozed`, `preference_preset_unavailable`, `preference_generation_changed`, `recap_snoozed`) are not Telegram transport failures.
4. **Unknown effects?** If `pendingDeliveryBacklog.executionUnknown > 0`, inspect [one-chat pending rows](./telegram-operator-queries.md#pending-rows-for-one-chat) and [source target effects](./telegram-operator-queries.md#source-target-planning). Do not retry unknown work until exact Telegram acceptance has been reconciled. Compare the same IDs, owners, and generations across slots, not only aggregate counts. Dispatch's bounded maintenance may reconcile expired `sending` claims and interrupted target/recap terminal projections even in orphan-only, eventless, and circuit-open runs. Repair-only runs must retain `pendingAttempted=0` and `messagesSent=0`; fresh claims remain untouched and `execution_unknown` is immutable, not replayable.
5. **Safety-only silence?** Read `cron.runs[0].metadata.safetySource` from the Access-protected `GET /api/status-cron-detail?job=telegram-degradation-watchdog`, including when pending backlog masks its reason. `failureReason` distinguishes `v9-publication-held`, `v9-snapshot-read-failed`, and `v9-snapshot-invalid`. Compare `sourcePublicationGenerationId` with `acceptedPublicationGenerationId`, and `ageSeconds` with `freshnessMaxAgeSec` at `assessedAtSec`. Null provenance is unavailable, not a matching identity. Held details retain onset, age, and reason codes; suppression stays fail-closed until accepted recovery.
6. **Source planning slow?** `authoritativePlanning` separates source-preset, candidate-horizon, capture/fan-out loading, validation, routing, materialization, duplicate suppression, handoff, and pending-drain time. High `candidateHorizonQueryMs` isolates candidate/index work; high direct/preset/global/snooze loader fields isolate inputs; `fanoutInputLoadCallCount > capturePageCount` without preference churn indicates lost page reuse. High `targetMaterializationD1Ms` versus `enqueueHandoffMs` separates manifest from handoff cost. Compare `capturedSubscriberCount` with the source's actual target scope before accepting a large cohort as expected.
7. **Snapshot seed?** `snapshotSeeded: true` means the run reseeded rather than sending (24-hour staleness gate; [snapshot behavior](../telegram-alerts.md#first-run--stale-snapshot-behavior)). If it persists across three successful runs, inspect `alert:dews-snapshot`, `alert:dews-alertable-snapshot`, and `alert:depeg-snapshot` for missing/malformed values. A malformed `alert:safety-snapshot` suppresses safety only; it never seeds the whole run.
8. **Single chat?** Use [subscriber controls](./telegram-operator-queries.md#subscriber-delivery-controls), [pending rows](./telegram-operator-queries.md#pending-rows-for-one-chat), [dead letters](./telegram-operator-queries.md#dead-letters), and [source planning](./telegram-operator-queries.md#source-target-planning). There is no per-chat admin HTTP diagnostic endpoint. Check:
   - `alert_snooze_until_ts > now`: timed snooze, except exact `4102444800`, the indefinite `/pause` sentinel. User recovery is `/pause off` or `/unsnooze`.
   - Quiet hours enabled and the current local hour inside their window. The `*_utc` columns are hour integers interpreted in the row's `timezone`; only null/unknown zones use UTC.
   - `consecutive_block_count >= 2`: repeated Telegram 403s auto-disable follows.
   - No direct or preset follows and all `global_alert_*` flags off: no audience for this chat.
   - No subscriber row: `/forget`, Mini App forget-me, or inactive cleanup atomically removes chat-owned pending/target/plan/dead-letter rows; migration re-points them. Leftovers require reconciliation of a partial delete or concurrent drain, not speculative replay.
9. **Webhook secret?** Failed validation returns `200 ok` without dispatch. After rotation inspect throttled `auth-missing-secret` / `auth-invalid-secret` actions; logs never expose secret values. [Secret rotation](./telegram-secret-rotation.md) owns recovery.

Transport error classes include `rate_limit`, `blocked`, `chat_not_found`, `chat_migrated`, `formatting_error`, `payload_too_large`, `bad_request`, `auth_error`, `server_error`, `timeout`, `network`, and `unknown`. Classify confirmed rejection separately from post-fence uncertainty.

## Remediation

These stop conditions apply to every branch:

- **No raw clear or TTL extension.** Never substitute `DELETE` or a `created_at` cutoff for explicit expiry; that can cancel still-live risk, launch, admin, or recap work. Do not rewrite `created_at` to extend TTL or latency history. Scheduled cleanup evaluates `expires_at` (legacy fallback only when absent), projects target/recap outcomes, attempts diagnostic dead-letter retention, and performs fenced deletion.
- **No manual replay.** There is no operator resend path. Read exact payload/target evidence from `telegram_alert_job_targets` and `telegram_alert_dead_letters`; hand-enqueueing bypasses plan/digest verification. If an incident truly requires replay or bounded manual-clear semantics, restore/add a separately reviewed audited control rather than improvising SQL. A clear must preserve dead-letter `manual_clear`, target cancellation, recap state, and bounded/audited deletion together.
- **No circuit reset as pause.** Transport inference and operator delivery pauses are independent. [Pause](#pause) is the sole authority for the missing emergency-control prerequisite; direct pause writes are not authorized here.
- **Protect higher-priority risk work.** Stop admin broadcasts, broad resends, and non-urgent notices during 429 pressure or expiry risk. Let healthy drain continue for one or two cycles when counts/ages/drain estimates decrease and nothing has expired.
- **Unknown remains unknown.** A timeout, network loss, or lost owner after the send fence is not a known rejection. Preserve exact effect evidence for reconciliation; never force it back to pending.

Apply source/subscriber repairs only after diagnosis:

| Cause | Safe response and readback |
| --- | --- |
| Snapshot stale loop | Confirm a successful dispatch after reseed; inspect the three seed-gate cache keys above. Do not delete source generations or partial manifests. |
| User blocked | User unblocks bot, runs `/start`, then completes setup/re-subscribes. Auto-disable cleared direct/preset/global follows; `/start` alone does not restore them. Successful queued send resets strikes. |
| Snooze/quiet hours | User chooses `/unsnooze` or `/unmutehours`; no operator mutation. |
| No alert audience | Compare `telegramBot.alertTypeChats.<type>` with source observations; for freeze inspect durable `freezeTargetCount` and outbox progress, not observation count alone. |
| Webhook drift | Inspect `budgetOnlySurfaces` for `telegram-registration-reconciliation`; every tokened tick checks all four units and records per-unit skipped/succeeded/failed. Missing token is an error, not a healthy skip. Force `npx tsx scripts/maintenance/register-telegram.ts --action webhook` only when that unit fails and automatic repair cannot wait. |
| Provider breaker | Use [lease/breaker recovery](./lease-and-breaker-recovery.md), separately from [transport recovery](#recover). |
| Backlog / 429 / bot-wide failure | Follow the corresponding branch below and preserve original expiry, priority, owners, and generations. |

A maintenance/recovery announcement is optional, not a repair. After pressure clears, follow [broadcast safety](./telegram-admin-broadcast-safety.md): narrow dry run, known private `canaryChatId`, and `deliveryEstimate.hasMaterialTtlReserve == true`. Live execution sends every canary chunk first and only then enqueues low-priority fleet rows; there is no backlog-risk override.

## Capacity Math

[Load Simulation and Query Plans](../telegram-alerts.md#load-simulation-and-query-plans) is the capacity-policy owner; constants live in `shared/lib/telegram-delivery-policy.ts`. For triage, distinguish theoretical healthy throughput from promised latency:

- Every planned chunk enters the pending lifecycle. A run attempts at most 1,800 pending chunks inside the shared 3,600-message ceiling and four-minute send-loop soft deadline. The dispatch app timeout is 4.5 minutes, cadence five minutes, with a lease.
- `1,800 × 12 = 21,600` chunks/hour is healthy drain capacity only when Telegram accepts sends and no new higher-priority work arrives; it is not a subscriber count or delivery guarantee. Risk rows precede low-priority admin work.
- The bot-wide circuit stops untouched waves under systemic failure; recovery admits only one-to-four distinct-chat probes before normal drain. Exact target, payload, expiry, and terminal outcome remain durable in the target ledger.

Before a planned broad send, run:

```bash
npm run check:telegram-load
```

The harness reports drain time/D1 costs for 500, 1,000, 5,000, and 10,000 watchers, including storm scenarios. The 10,000-watcher tier is exploratory and must not block emergency triage. The linked owner distinguishes blocking SLO tiers from advisory planning tiers; do not treat healthy arithmetic as permission to bypass the canary/TTL guards.

## Backlog and Expiration

Use [Pending Queue](./telegram-operator-queries.md#pending-queue) and retain each source's explicit expiry. `pendingDeliveries` rising across consecutive runs, `pendingNearTtlCount > 0`, `pendingDroppedTtlExpired > 0`, or `pendingDeliveryBacklog.expired > 0` indicate different stages of risk, not equivalent TTLs.

| Signal | Meaning / action |
| --- | --- |
| `oldestPendingDeliveryAgeSec > 900` (15 min) | Operational warning and broadcast stop threshold; wait until below 900 and queue decreasing before planning a broadcast. This is not row expiry. |
| `estimatedDrainTimeSec > 1800` | Drain-risk warning; compare trend and source TTL reserve. |
| `oldestPendingDeliveryAgeSec > 2700` (45 min) | Escalate from 429 triage to this expiry branch before any notice/resend. This is not the risk-alert TTL. |
| `oldestPendingDeliveryAgeSec > 6300` (105 min) | Two-hour risk rows are in their final 15 minutes; launch/admin/recap expire on their own schedules. |
| `pendingDeliveryBacklog.expired > 0` | Explicit `expires_at` (or legacy 7,200-second fallback) is already past; check scheduled cleanup and terminal outcomes. |

[Pending Delivery Queue](../telegram-alerts.md#pending-delivery-queue) owns all source TTLs. Do not infer expiry from aggregate oldest age when mixed source types are present.

1. Compare pending/due/deferred totals, oldest ages, and estimated drain across two slots. Deferred work plus `rate_limit` suggests backoff; see [Rate-limit storm](#rate-limit-storm).
2. Confirm latest dispatch health when expired work accumulates. Let scheduled expiry handle it. Dead-letter copy is best-effort diagnostic retention: target/recap expiry projection and fenced deletion continue if it fails. Missing dead letters do not prove no expiry; inspect terminal outcomes and `cleanup-expired-pending-dead-letter-bypass`.
3. Stop planned broadcasts until the queue is decreasing and oldest age is below 900 seconds. If D1/telemetry competes with dispatch, use [telemetry kill switch](./db-connectivity.md#telemetry-kill-switch).
4. Size a dominant chat with [one-chat pending evidence](./telegram-operator-queries.md#pending-rows-for-one-chat), including delivery-state/backoff counts. There is no filtered clear endpoint; direct deletion skips dead-letter, target, recap, and audit bookkeeping.
5. Let healthy drain run. If continued transport worsens the incident, use [Pause](#pause), not raw SQL or circuit resets. TTL changes require reviewed sender/severity policy, never incident-time timestamp edits.

### Claim and Maintenance Readback

A drain stamps `processing_owner`, `processing_started_at`, and `processing_expires_at`. Expired pre-effect processing claims may be reclaimed. Once `delivery_state='sending'` crosses the effect fence, expired ownership instead reconciles by owner/generation CAS to immutable `execution_unknown`.

Every lifecycle runs bounded stale-claim, target-final, terminal-target, and recap repair before due-gated transport, even with eventless/circuit-open/orphan-only queues. Stale/terminal/recap passes use `PENDING_DELETE_CHUNK_SIZE` in ID order; target-final projection keeps its 90-row cap. Maintenance changes force a capacity refresh but consume no send budget. Overflow repairs on later slots; fresh claims, ordinary expiry cadence, and the separate 90-day unknown retention remain unchanged. A failed maintenance pass never authorizes a send.

## Rate-Limit Storm

A queue growing with `retryErrorClassCounts.rate_limit` dominant needs chat-scope diagnosis before global controls:

1. **One/few chats deferred:** per-chat `not_before_at` isolates 429s; later same-chat rows/chunks short-circuit in that run. A long `Retry-After` alone never makes a chat-local 429 global. Inspect deferred count and [one-chat rows](./telegram-operator-queries.md#pending-rows-for-one-chat); do not clear them.
2. **Many distinct chats throttled:** the durable controller opens after **3 distinct chats fail inside 60 seconds in the same failure scope** (rate-limit and transient counts are not pooled). Auth or explicitly bot-wide failure may open immediately. The repo has a six-request trigger budget; sender batches of four retain headroom ([limits](../worker-and-api-limits.md)). Continue at [Bot-wide transport](#bot-wide-transport).
3. **Watchdog degraded:** inspect `cron.runs[0].metadata` from the Access-protected `GET /api/status-cron-detail?job=telegram-degradation-watchdog`. This watchdog marks its run degraded; it does not send an operator notification. A first breach records onset. Active pending count **>500**, oldest pending age **at least 15 minutes**, estimated drain **at least 30 minutes**, or execution-unknown work **at least 15 minutes old** degrades after a **sustained 20-minute** breach. Near-TTL work degrades on the next evaluation without waiting 20 minutes. An unknown capacity read degrades telemetry and preserves onset keys rather than fabricating an empty queue/recovery.
4. **Expiry risk:** oldest age over 2700 or expired rows routes to [Backlog and expiration](#backlog-and-expiration), retaining explicit source expiry.

Wait one healthy cycle if pending count, age, and drain estimate all decrease. Existing due risk rows drain before authoritative planning; fresh risk work cannot spend the pending-drain share on admin broadcasts during contention. Stop broadcasts while 429 dominates even though live broadcast also enforces transport permits, private canary, and hard 15-minute TTL reserve. If pressure persists without an obvious driver, inspect outbound Telegram POST logs for a non-production dispatcher replaying historical events. Emergency pause requires the reviewed control below; the missing control is an operational gap, not permission to bypass audit.

## Bot-Wide Transport

Use [Transport Circuit](./telegram-operator-queries.md#transport-circuit) and [Delivery Pauses](./telegram-operator-queries.md#delivery-pauses). The durable circuit and pause state gate fresh handoff, pending drain, digest, and admin broadcast. Read `state`, `generation`, `cause_class`, `cause_scope`, `distinct_failure_count`, `opened_at`, `next_probe_at`, and half-open owner/expiry before any recovery.

Pause rows are not seeded: absent `fresh`, `pending`, or `admin` means inactive with generation `0`. An existing expired row is inert but retains its generation. Inspect pending age and unknown effects before controls; timeout/network errors after the fence remain ambiguous.

The controller prunes observations older than five minutes during qualifying closed-state failure-observation batches; this is opportunistic pruning, not a scheduled hard-retention promise. Raw Telegram response bodies never enter storage/general logs. The cron freshness-watchdog operator alert sends **outside delivery pauses and these transport controls** to private `TELEGRAM_OPERATOR_CHAT_ID`; unset suppresses it, never falls back to the public channel. It is separate from the Telegram degradation watchdog's status-only outcome.

## Pause

There is **no supported operator pause/resume mutation**. Modes are `fresh`, `pending`, and `admin`; an admin pause does not silence webhook replies. Read-only D1 inspection is not write authority.

If an emergency pause is required, restore/add a separately reviewed Access-protected control or script using `setTelegramDeliveryPause()` semantics, with all of:

- exact mode and caller-validated self-expiry between 60 seconds and 24 hours (the helper itself does not enforce this range);
- captured current generation (`0` only for an absent row);
- conditional state mutation and conditional keep-forever `admin_action_audit` action `telegram-delivery-pause` in the **same D1 batch**;
- zero-change conflict handling and post-write readback.

The audit row is written only if the inspected generation wins. Extending/re-pausing an existing row uses its captured generation, increments it by one on success, and preserves `created_at`. Mismatch leaves both state and audit unchanged. Do not run a raw insert/update, reset `circuit:telegram-api`, or leave a permanent operator audit incomplete.

## Recover

1. Correct credentials or wait for Telegram recovery without clearing queued rows. [Secret rotation](./telegram-secret-rotation.md) owns credential overlap.
2. Let the durable circuit reach `next_probe_at`. Exactly one owner may claim a **one-to-four-distinct-chat half-open probe**; other invocations defer.
3. A confirmed reachable response closes the circuit. A single chat-local 429 is inconclusive, not proof of bot-wide failure. Do not reset the circuit to force a large live batch: the bound protects the untouched tail from bad credentials or a continuing outage.
4. Resume an operator pause only through the same reviewed control/script using captured current generation and `resumeTelegramDelivery()` semantics. Pair the conditional mutation and `telegram-delivery-resume` audit; a zero-row result is conflict, not success. Read back before retrying.
5. Verify untouched work kept original priority, expiry, and lifecycle. Reconcile `execution_unknown` separately; no operator resend path exists. Confirm queue trend over subsequent five-minute slots and inspect terminal target/recap outcomes as well as send counters.

## Recap Retirement Stop and Drain

This is the personalized watchlist recap's operated withdrawal, not a bot-wide pause or retirement of public editorial digests. Keep the existing public five-minute trigger, role, leases, shared drain and terminal maintenance. No fleet broadcast, raw SQL mutation, forced recap run, resend, table drop or consumer deletion belongs to this stage.

**User notice.** The final notice body is owned by `TELEGRAM_RECAP_RETIREMENT_NOTICE` in `shared/lib/telegram-recap-rollout.ts`:

> We're retiring personalized daily watchlist recaps. Your watchlist and alert settings won't change, and your regular alerts and public market digests will continue. Thank you for using PharosWatchBot!

Use three explicit configuration stages on the same existing `TELEGRAM_RECAP_ROLLOUT_MODE` binding. The checked-in configuration is off; a release is not evidence that any user received a notice.

1. **Stop (`off`).** Record the source/merge SHA, public Worker version/verified activation time, last public recap-planner admission, final preference/target clocks and rollback-compatible version. Observe the first natural five-minute execution with recap `rollout.mode=off` and `skipped=recap-rollout-off`. It must cancel only unstarted recap work before shared drain, preserve accepted/in-flight/unknown effects, and admit no new ordinary plans. Wait for pre-stop public invocations to settle under their original fences; never clear a lease to accelerate the stop.
2. **Notice (`retirement-notice`).** Only after the initial stop is observed, deploy this temporary value on the existing binding. Controls and enrolment remain off. The final scheduled edition is notice-only, even without material facts or a fresh Tape; no ordinary recap planning runs. It is queued once per still-opted-in private chat at its existing due schedule, through the original target/queue/effect-fence path. Notice mode cancels ordinary queued recap work but preserves notice targets. Existing local-date identity collisions advance to the next safe scheduled date without rewriting an earlier edition. Normal pause, snooze, block, quiet-hour, generation, expiry and transport guards are not bypassed. The durable `recap-retirement-notice:v1` fingerprint prevents a second notice on later dates, including after cancellation, failure or an unknown send.
3. **Final stop (`off`).** Compare the captured opted-in cohort with final notice targets; every still-eligible chat must have a terminal notice outcome, with unavailable/missing-timezone evidence or unnotified chats investigated rather than called complete. Record cancellations/failures explicitly; an unknown effect is terminal uncertainty, never proof of receipt or permission to resend. Only after this accounting and zero pending/sending recap work, deploy off again. Observe its first natural execution and a later five-minute slot with no new targets. Keep code, client contract, schema, notice markers and shared unknown/effect-fence evidence until this proof is accepted. Feature removal remains separately gated.

Use approved SELECT-only inspection via `--command`, never `--file`, following [remote D1 inspection](../worker-infrastructure.md#remote-d1-inspection). Capture the initial enabled/private cohort in restricted operator evidence, not public logs or this runbook; recheck erasure/opt-out changes before claiming notice completeness. These readbacks give separate target, transport and clock evidence:

```sql
SELECT status, COUNT(*) FROM telegram_recap_targets GROUP BY status;
SELECT delivery_state, COUNT(*) FROM telegram_pending_alerts
WHERE source_type = 'personalized_recap' GROUP BY delivery_state;
SELECT COUNT(*) AS nonterminal_targets FROM telegram_recap_targets
WHERE status IN ('planned', 'queued');
SELECT status, COUNT(*) FROM telegram_recap_targets
WHERE watchlist_fingerprint = 'recap-retirement-notice:v1' GROUP BY status;
SELECT COUNT(*) AS opted_in_without_notice
FROM telegram_recap_preferences p JOIN telegram_subscribers s USING (chat_id)
WHERE p.enabled = 1 AND p.chat_kind = 'private'
  AND NOT EXISTS (SELECT 1 FROM telegram_recap_targets t
    WHERE t.chat_id = p.chat_id
      AND t.watchlist_fingerprint = 'recap-retirement-notice:v1');
SELECT MAX(created_at) AS last_target_created_at,
       MAX(queued_at) AS last_target_queued_at,
       MAX(completed_at) AS last_target_completed_at,
       MAX(updated_at) AS last_target_evidence_at FROM telegram_recap_targets;
SELECT MAX(created_at) AS last_preference_created_at,
       MAX(updated_at) AS last_preference_write_at FROM telegram_recap_preferences;
SELECT MAX(updated_at) AS last_pending_evidence_at FROM telegram_pending_alerts
WHERE source_type = 'personalized_recap';
```

For final acceptance, `nonterminal_targets` is zero and there are no `pending` or `sending` recap rows. Retained `sent`/`execution_unknown` records are terminal audit, not backlog to empty. Compare identities and new-target clocks over both off observations; cleanup counters and `pendingEffects=false` alone are not drain proof. Preserve the final admission cutoff (verified off activation plus the settled last pre-stop public attempt), target clocks, final terminal-evidence clock, outcome counts, observation times and rollback floor. Failed reads are pending evidence, never zero work.

Compatible rollback is deliberate and only possible before consumer deletion; it must preserve original claims, generations and terminal outcomes. Do not remove notice markers through ordinary retention or reset accepted/unknown rows. Later destructive cleanup requires closure of the rollback floor and at least 90 days from final recap evidence, a fresh zero-use proof and verified Time Travel in a separately authorized window; `/forget` erasure remains available throughout.

## Cross-References

- [Telegram behavior](../telegram-alerts.md): dispatch, snapshots, durable delivery, and load policy.
- [Reusable operator queries](./telegram-operator-queries.md): read-only pending, source/target, pause, circuit, dedupe, and dead-letter evidence.
- [Admin broadcast safety](./telegram-admin-broadcast-safety.md): optional notices after risk work recovers.
- [Ingress/retries/setup](./telegram-webhook-retry-dedupe.md): missing command/callback effects, not queue resends.
- [Database connectivity](./db-connectivity.md) and [limits](../worker-and-api-limits.md): D1 and trigger-wide constraints.
