# Telegram Operator Queries

Use these SQL snippets from the Cloudflare D1 console or `wrangler d1 execute` during PharosWatchBot incidents. They are read-only unless explicitly noted.

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
  SUM(CASE WHEN COALESCE(expires_at, created_at + 3600) <= ? THEN 1 ELSE 0 END) AS expired,
  SUM(CASE WHEN processing_owner IS NOT NULL AND COALESCE(processing_expires_at, 0) > ? THEN 1 ELSE 0 END) AS claimed
FROM telegram_pending_alerts
GROUP BY 1, 2, 3
ORDER BY priority ASC, rows DESC;
```

Replace each `?` with the current Unix timestamp.

Pending rows for one chat:

```sql
SELECT
  id,
  chat_id,
  source_type,
  alert_type,
  priority,
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

Do not manually advance a baseline while expiry debt remains or reset a plan generation. `telegram_legacy_overflow_state` and any surviving `telegram-source:legacy-overflow:v1:*` source rows are a terminal audit trail of the removed one-time importer; nothing writes them any more.

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

Treat both states as execution-unknown once the claim expiry has passed. Inspect Telegram/user reports and the exact job payload context before any manual resend. Never reset these rows to `planned` merely to make the dispatcher retry them.

There is no operator acknowledgement action left. `POST /api/admin-telegram-delivery-control` (action `acknowledge_execution_unknown`), which archived a reviewed ID set fail-closed while preserving the authoritative `execution_unknown` outcome, was retired on 2026-08-09. Reviewed rows now wait for the automatic 90-day archive, which performs the same projection and dead-letter copy with `reason = 'execution_unknown_archived'`. Do not hand-edit `execution_unknown` rows to shortcut it; restoring early acknowledgement requires reverting the endpoint's removal commit.

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

Processed updates by status and age:

```sql
SELECT
  status,
  effect_state,
  intent_kind,
  COUNT(*) AS rows,
  MIN(received_at) AS oldest_received_at,
  MAX(COALESCE(processed_at, received_at)) AS newest_activity_at,
  SUM(CASE WHEN status = 'processing' AND received_at < ? - 300 THEN 1 ELSE 0 END) AS stale_processing
FROM telegram_processed_updates
GROUP BY status, effect_state, intent_kind
ORDER BY rows DESC;
```

Webhook effects requiring reconciliation (bounded oldest-first sample):

```sql
SELECT
  update_id,
  update_type,
  chat_id,
  status,
  effect_state,
  intent_version,
  intent_kind,
  mutation_applied_at,
  effect_started_at,
  effect_kind,
  effect_ordinal,
  error_class,
  claim_owner,
  claim_generation
FROM telegram_processed_updates
WHERE effect_state IN ('started', 'execution_unknown')
  AND status <> 'processed'
ORDER BY COALESCE(effect_started_at, received_at) ASC
LIMIT 5001;
```

Never reset these rows to `planned` or delete them merely to trigger a retry. Reconcile the exact Telegram-visible effect first; ambiguous outbound effects are at-most-once by design and retained for 90 days.

Recent failed webhook updates:

```sql
SELECT
  update_id,
  status,
  received_at,
  processed_at,
  error_class
FROM telegram_processed_updates
WHERE status = 'failed'
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
