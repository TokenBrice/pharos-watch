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
  SUM(CASE WHEN t.status = 'planned' THEN 1 ELSE 0 END) AS planned,
  SUM(CASE WHEN t.status = 'queued' THEN 1 ELSE 0 END) AS queued,
  SUM(CASE WHEN t.status = 'sent' THEN 1 ELSE 0 END) AS sent,
  SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN t.status = 'expired' THEN 1 ELSE 0 END) AS expired,
  SUM(CASE WHEN t.effect_state = 'sending' THEN 1 ELSE 0 END) AS effect_sending,
  SUM(CASE WHEN t.effect_state = 'execution_unknown' THEN 1 ELSE 0 END) AS execution_unknown
FROM telegram_alert_jobs j
LEFT JOIN telegram_alert_job_targets t ON t.job_id = j.job_id
WHERE j.created_at >= ? - 86400
GROUP BY j.job_id
ORDER BY j.created_at DESC
LIMIT 50;
```

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
  COUNT(*) AS rows,
  MIN(received_at) AS oldest_received_at,
  MAX(COALESCE(processed_at, received_at)) AS newest_activity_at,
  SUM(CASE WHEN status = 'processing' AND received_at < ? - 300 THEN 1 ELSE 0 END) AS stale_processing
FROM telegram_processed_updates
GROUP BY status
ORDER BY rows DESC;
```

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
