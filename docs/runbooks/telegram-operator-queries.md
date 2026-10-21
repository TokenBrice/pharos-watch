# Telegram Operator Queries

Use these read-only SQL snippets during PharosWatchBot incidents. This page owns reusable diagnostics; the [incident runbooks](../telegram-alerts.md#runbooks) retain their prerequisites, stop conditions, remediation, and readback.

> **Agent navigation** — [Incident entry](#read-only-incident-entry) · [Pending queue](#pending-queue) · [Subscriber controls](#subscriber-delivery-controls) · [Transport circuit](#transport-circuit) · [Delivery pauses](#delivery-pauses) · [Alert jobs](#alert-jobs) · [Dispatch diagnostics](#dispatch-runtime-diagnostics) · [Source target planning](#source-target-planning) · [Dead letters](#dead-letters) · [Webhook dedupe](#webhook-dedupe) · [Usage funnel](#usage-funnel)

## Read-Only Incident Entry

- Use authorized access to admin `/api/status` and the primary Worker D1 database, `stablecoin-db`. For origin-access setup, follow [Operator Origin Access](../operator-origin-access.md); query access does not authorize mutations.
- Compare `telegramBot.pendingDeliveries`, `pendingDeliveryBacklog`, `oldestPendingDeliveryAgeSec`, and `retryErrorClassCounts` across two five-minute runs. Read dispatch timing and capacity from the Access-protected `GET /api/status-cron-detail?job=dispatch-telegram-alerts` -> `cron.runs[0].metadata`; also inspect the watchdog and relevant `budgetOnlySurfaces`. Keep incident-specific thresholds in the selected runbook.
- Run SQL in the Cloudflare D1 console or with `npx --no-install wrangler d1 execute stablecoin-db --remote --command "<SQL>"` from `worker/`. Replace every `?` with the current Unix timestamp (seconds), and substitute only the affected chat/update/job/source identifiers. Preserve the inspected IDs, owners, generations, and timestamps for readback.
- These queries use the active schema in `worker/migrations/0000_baseline.sql` plus subsequent migrations. Confirm deployed schema parity before interpreting a failed query as an empty result. Never reset or delete `sending`, `started`, or `execution_unknown` evidence to force replay; incident-specific mutation authority is not supplied here.

## Pending Queue

Pending by priority, source, alert type, and age:

```sql
SELECT
  COALESCE(priority, 50) AS priority,
  COALESCE(source_type, 'legacy') AS source_type,
  COALESCE(alert_type, 'unknown') AS alert_type,
  COUNT(*) AS rows,
  MIN(created_at) AS oldest_created_at,
  MAX(? - created_at) AS oldest_age_sec,
  SUM(CASE WHEN COALESCE(expires_at, created_at + 7200) <= ? THEN 1 ELSE 0 END) AS expired,
  SUM(CASE WHEN processing_owner IS NOT NULL AND COALESCE(processing_expires_at, 0) > ? THEN 1 ELSE 0 END) AS claimed
FROM telegram_pending_alerts
GROUP BY 1, 2, 3
ORDER BY priority ASC, rows DESC;
```

### Pending Rows For One Chat

Pending rows for one chat, including its delivery state:

```sql
SELECT
  id,
  chat_id,
  source_type,
  alert_type,
  priority,
  delivery_state,
  attempts,
  last_error_class,
  created_at,
  expires_at,
  not_before_at,
  processing_owner,
  processing_expires_at,
  dedupe_key,
  chunk_index
FROM telegram_pending_alerts
WHERE chat_id = '<chat_id>'
ORDER BY COALESCE(priority, 50) ASC, created_at ASC;
```

Size the chat's backlog by delivery state and backoff:

```sql
SELECT delivery_state, COUNT(*) AS rows,
       MIN(created_at) AS oldest_created_at,
       MAX(not_before_at) AS latest_not_before_at
FROM telegram_pending_alerts
WHERE chat_id = '<chat_id>'
GROUP BY delivery_state;
```

Count pending rows for the inspected chat:

```sql
SELECT COUNT(*) AS matched
FROM telegram_pending_alerts
WHERE chat_id = '<chat_id>' AND delivery_state = 'pending';
```

Sizing is read-only; [delivery remediation](./telegram-no-delivery.md#remediation) owns stop conditions and mutation prohibitions.

## Subscriber Delivery Controls

```sql
SELECT chat_id, alert_snooze_until_ts, quiet_hours_enabled,
       quiet_hours_start_utc, quiet_hours_end_utc, timezone,
       consecutive_block_count, consecutive_block_first_at,
       global_alert_dews, global_alert_depeg, global_alert_safety,
       global_alert_launch, global_alert_reserve, global_alert_freeze,
       preference_generation, created_at, last_active_at
FROM telegram_subscribers
WHERE chat_id = '<chat_id>';
```

Interpret snooze, quiet-hours, block strikes, missing follows, and missing-subscriber evidence with [Single chat affected](./telegram-no-delivery.md#quick-diagnostic-checklist), not with an operator resend.

## Transport Circuit

```sql
SELECT state, generation, cause_class, cause_scope, distinct_failure_count,
       first_failure_at, last_failure_at, last_success_at, opened_at,
       next_probe_at, probe_owner, probe_generation, probe_expires_at,
       probe_limit, probe_attempted, updated_at
FROM telegram_transport_circuit
WHERE singleton_id = 1;
```

## Delivery Pauses

```sql
SELECT mode, generation, expires_at, reason, actor, created_at, updated_at
FROM telegram_delivery_pauses
ORDER BY mode;
```

[Delivery pauses](./telegram-no-delivery.md#pause) owns absent/expired-row interpretation, generation/audit requirements and readback; this query grants no write authority.

## Alert Jobs

Recent alert jobs with target-status breakdown:

```sql
SELECT
  j.job_id,
  j.alert_type,
  j.source_event_id,
  j.severity,
  j.created_at,
  j.status,
  j.target_count,
  j.planned_count,
  j.accepted_count,
  j.enqueued_count,
  j.failed_count,
  j.cancelled_count,
  j.expired_count,
  j.execution_unknown_count,
  j.metadata
FROM telegram_alert_jobs j
WHERE j.created_at >= ? - 86400
ORDER BY j.created_at DESC
LIMIT 50;
```

These counters are reconciled from mutually exclusive target buckets. `metadata.countersSource` should be `authoritative-target-rows`.

## Dispatch Runtime Diagnostics

The latest `dispatch-telegram-alerts` cron metadata exposes `authoritativePlanning` for source-event runs. Read it from `/api/status` or inspect the stored JSON directly:

```sql
SELECT
  id,
  started_at,
  duration_ms,
  json_extract(metadata, '$.authoritativePlanning.sourceEventId') AS source_event_id,
  json_extract(metadata, '$.authoritativePlanning.sourceEventFamilies') AS source_families,
  json_extract(metadata, '$.authoritativePlanning.capturedSubscriberCount') AS captured_chats,
  json_extract(metadata, '$.authoritativePlanning.plannedTargetCount') AS planned_targets,
  json_extract(metadata, '$.authoritativePlanning.capturePageCount') AS capture_pages,
  json_extract(metadata, '$.authoritativePlanning.planningPageCount') AS planning_pages,
  json_extract(metadata, '$.authoritativePlanning.fanoutInputLoadCallCount') AS fanout_loads,
  json_extract(metadata, '$.authoritativePlanning.fanoutInputCacheHitCount') AS fanout_cache_hits,
  json_extract(metadata, '$.authoritativePlanning.fanoutInputLoadMs') AS fanout_input_ms,
  json_extract(metadata, '$.authoritativePlanning.targetMaterializationD1Ms') AS materialization_ms,
  json_extract(metadata, '$.authoritativePlanning.enqueueHandoffMs') AS handoff_ms,
  json_extract(metadata, '$.authoritativePlanning.pendingDrainSendMs') AS pending_drain_ms
FROM cron_runs
WHERE job = 'dispatch-telegram-alerts'
ORDER BY started_at DESC
LIMIT 25;
```

For an unchanged capture page, `fanoutInputCacheHitCount` should increase when planning reuses the page and `fanoutInputLoadCallCount` should not exceed the capture-page count. A generation change deliberately invalidates that cache. Use the direct/preset/global/snooze loader timings and candidate-horizon timing to isolate query pressure; use materialization, duplicate-suppression, and handoff timings to isolate D1 write pressure. The target-plan coordinator writes an immediate progress checkpoint and another every eight transitions, so a stale-slot investigation should also inspect the most recent `target-plan-progress` record.

## Source Target Planning

Oldest nonterminal source events and their frozen cohort:

```sql
SELECT
  source_event_id,
  status,
  detected_at,
  expires_at,
  target_plan_state,
  target_plan_generation,
  target_plan_owner,
  target_plan_claim_expires_at,
  subscriber_horizon_at,
  subscriber_high_water_chat_id,
  subscriber_cursor_chat_id,
  planning_cursor_chat_id,
  target_plan_count,
  target_materialized_count,
  last_error_class
FROM telegram_alert_source_events
WHERE status IN ('resolving', 'planned', 'baseline_committed')
ORDER BY detected_at, source_event_id
LIMIT 25;
```

Planning outcomes for one source generation:

```sql
SELECT planning_outcome, COUNT(*) AS chats
FROM telegram_alert_planning_subscribers
WHERE source_event_id = '<source_event_id>'
  AND plan_generation = <generation>
GROUP BY planning_outcome
ORDER BY chats DESC;
```

Bounded expiry debt:

```sql
SELECT *
FROM telegram_alert_target_expiry_progress
WHERE state = 'running'
ORDER BY updated_at, source_event_id;
```

Never advance a baseline with expiry debt or reset a plan generation. Historical legacy-overflow sources remain evidence, not replayable input; [delivery remediation](./telegram-no-delivery.md#remediation) owns recovery.

Targets that missed one alert:

```sql
SELECT
  chat_id,
  target_key,
  chunk_index,
  status,
  error_class,
  created_at,
  enqueued_at,
  sent_at,
  failed_at,
  effect_state,
  effect_owner,
  effect_generation,
  effect_claimed_at,
  effect_started_at,
  effect_completed_at,
  effect_claim_expires_at,
  pending_dedupe_key
FROM telegram_alert_job_targets
WHERE job_id = '<job_id>'
  AND status <> 'sent'
ORDER BY status, created_at ASC;
```

Fresh effects requiring reconciliation:

```sql
SELECT
  job_id,
  target_key,
  chat_id,
  chunk_index,
  alert_type,
  status,
  effect_state,
  effect_owner,
  effect_generation,
  effect_started_at,
  effect_completed_at,
  error_class
FROM telegram_alert_job_targets
WHERE effect_state IN ('sending', 'execution_unknown')
ORDER BY COALESCE(effect_started_at, created_at) ASC;
```

After claim expiry, sending and execution-unknown require exact Telegram-visible reconciliation, not reset to planned. Reviewed unknown work waits for automatic 90-day audit archival; no operator early-acknowledgement path exists. [Delivery remediation](./telegram-no-delivery.md#remediation) owns the no-replay contract.

## Dead Letters

Dead letters by reason:

```sql
SELECT
  reason,
  COALESCE(source_type, 'legacy') AS source_type,
  COALESCE(alert_type, 'unknown') AS alert_type,
  COUNT(*) AS rows,
  MIN(created_at) AS oldest_created_at,
  MAX(expired_at) AS newest_dead_letter_at
FROM telegram_alert_dead_letters
WHERE expired_at >= ? - 86400
GROUP BY 1, 2, 3
ORDER BY rows DESC;
```

Manual clears by chat:

```sql
SELECT
  chat_id,
  COUNT(*) AS rows,
  MIN(created_at) AS oldest_created_at,
  MAX(expired_at) AS cleared_at
FROM telegram_alert_dead_letters
WHERE reason = 'manual_clear'
  AND expired_at >= ? - 86400
GROUP BY chat_id
ORDER BY rows DESC
LIMIT 50;
```

## Webhook Dedupe

### Processed Update

Inspect one reported update:

```sql
SELECT update_id, received_at, processed_at, update_type, chat_id, status, error_class
FROM telegram_processed_updates
WHERE update_id = <update_id>;
```

No row after a 5xx means the claim was released for Telegram's redelivery.

### Pending Command State

```sql
SELECT chat_id, ambiguous_ticker, action_type, expires_at
FROM telegram_pending_disambiguation
WHERE chat_id = '<chat_id>';
```

Ingress no longer reads or writes these rows; see [setup state](./telegram-webhook-retry-dedupe.md#setup-state).

### Webhook Status

Processed updates by status and age:

```sql
SELECT
  status,
  COUNT(*) AS rows,
  MIN(received_at) AS oldest_received_at,
  MAX(COALESCE(processed_at, received_at)) AS newest_activity_at,
  SUM(CASE WHEN status = 'processing' AND received_at < ? - 60 THEN 1 ELSE 0 END) AS stale_processing
FROM telegram_processed_updates
GROUP BY status
ORDER BY rows DESC;
```

Stale `processing` rows (crashed requests) and legacy `failed` rows are reclaimed by the next delivery of that `update_id` and pruned after seven days; do not delete them by hand. Handled failures are `processed` rows with an `error_class`:

```sql
SELECT update_id, update_type, received_at, processed_at, error_class
FROM telegram_processed_updates
WHERE error_class IS NOT NULL
ORDER BY COALESCE(processed_at, received_at) DESC
LIMIT 50;
```

## Usage Funnel

Start source and setup completion:

```sql
SELECT
  event_type,
  source_category,
  action_detail,
  outcome,
  SUM(count) AS events,
  MIN(first_seen_at) AS first_seen_at,
  MAX(last_seen_at) AS last_seen_at
FROM telegram_usage_daily
WHERE day >= date('now', '-7 days')
  AND event_type IN ('start', 'deep_link', 'setup_choice', 'setup_complete')
GROUP BY 1, 2, 3, 4
ORDER BY event_type, events DESC;
```

Reply failures by command and failure class:

```sql
SELECT
  COALESCE(NULLIF(action_detail, ''), 'unknown') AS command,
  COALESCE(NULLIF(failure_class, ''), 'unknown') AS failure_class,
  SUM(count) AS failures,
  MIN(first_seen_at) AS first_seen_at,
  MAX(last_seen_at) AS last_seen_at
FROM telegram_usage_daily
WHERE day >= date('now', '-1 day')
  AND event_type = 'reply_failure'
GROUP BY 1, 2
ORDER BY failures DESC;
```
