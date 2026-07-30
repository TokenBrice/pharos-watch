-- rollout-safety: backward-compatible
-- Archive the exact reviewed production execution-unknown backlog without
-- replaying Telegram effects or changing their final delivery outcome.
-- Production evidence was captured read-only on 2026-07-15. Rows above the
-- reviewed id cutoff are deliberately outside this migration.

-- Refuse the migration unless the live queue or an idempotent dead-letter
-- replay matches every reviewed per-source fingerprint, and the exact ten
-- authoritative job target ledgers still have their reviewed bucket counts.
WITH
expected_pending (
  source_event_id, alert_type, row_count, min_id, max_id, id_sum,
  chat_count, owner_count,
  min_created, max_created, created_sum,
  min_started, max_started, started_sum,
  min_completed, max_completed, completed_sum,
  priority_sum, min_priority, max_priority, preference_generation_sum,
  message_length_sum, dedupe_length_sum, scope_length_sum, markup_length_sum,
  owner_lost_count, timeout_count
) AS (VALUES
  ('telegram-source:v1:6b720f298b9e431463312ba1b23c4f85', 'dews',   1,   785,   785,      785,   1, 1, 1783729661, 1783729661,   1783729661, 1783729692, 1783729692,   1783729692, 1783731188, 1783731188,   1783731188,   20, 20, 20, 0,    275,   26,    55,    565,   1, 0),
  ('telegram-source:v1:7e835a90de4c68daec79e8fa9a9e6a63', 'depeg', 76, 23263, 23359,  1771639,  76, 1, 1784050037, 1784050037, 135587802812, 1784052251, 1784052251, 135587971076, 1784053361, 1784055462, 135588143678,  760, 10, 10, 4,  34351, 1716,  6851,  32009,  76, 0),
  ('telegram-source:v1:819781859ec1723680693a7d562d2284', 'depeg',276, 22818, 23093,  6335718, 276, 1, 1784039839, 1784039839, 492394995564, 1784040142, 1784040142, 492395079192, 1784041946, 1784053361, 492397897716, 2760, 10, 10, 8,  72864, 5914, 12420, 169085, 276, 0),
  ('telegram-source:v1:881425beae03dc9a4657fd29fd4ee4ff', 'depeg',  1,  1861,  1861,     1861,   1, 1, 1783756361, 1783756361,   1783756361, 1783756414, 1783756414,   1783756414, 1783758462, 1783758462,   1783758462,   10, 10, 10, 0,    272,   26,    51,    540,   1, 0),
  ('telegram-source:v1:8bdd3703b49abccac055e6079c9331e6', 'depeg',169, 17040, 17376,  2922180, 169, 1, 1783966335, 1783966335, 301490310615, 1783967910, 1783967910, 301490576790, 1783970123, 1783970241, 301490960109, 1690, 10, 10, 7,  45513, 3619,  9133, 110486, 169, 0),
  ('telegram-source:v1:c21a04fe56b20e4f20167492380d5aea', 'depeg',  1,  1581,  1581,     1581,   1, 1, 1783755461, 1783755461,   1783755461, 1783755510, 1783755510,   1783755510, 1783756414, 1783756414,   1783756414,   10, 10, 10, 0,    274,   26,    51,    540,   1, 0),
  ('telegram-source:v1:c49f3510ea45e73416fc54788d5121af', 'depeg',  1,   901,   901,      901,   1, 1, 1783743761, 1783743761,   1783743761, 1783743805, 1783743805,   1783743805, 1783747387, 1783747387,   1783747387,   10, 10, 10, 0,    276,   26,    49,    530,   1, 0),
  ('telegram-source:v1:c946a51c134a090da415f73434fa3a51', 'depeg',230, 22538, 22816,  5221296, 230, 1, 1784039542, 1784039542, 410329094660, 1784040142, 1784040142, 410329232660, 1784041534, 1784041946, 410329601410, 2300, 10, 10, 9, 102244, 5140, 22682,  88898, 230, 0),
  ('telegram-source:v1:d16dc7b86f06aa113cc1eaa913561ec3', 'depeg',  1,  1302,  1302,     1302,   1, 1, 1783753661, 1783753661,   1783753661, 1783753706, 1783753706,   1783753706, 1783755510, 1783755510,   1783755510,   10, 10, 10, 0,    273,   26,    50,    535,   1, 0),
  ('telegram-source:v1:dbd0f01512f40f7ce5655be124f417a3', 'safety',  2,  7757,  7802,    15559,   2, 2, 1783846362, 1783846362,   3567692724, 1783846588, 1783846665,   3567693253, 1783846588, 1783846665,   3567693253,   40, 20, 20, 0,   1246,   46,   208,    780,   0, 2)
),
live_actual AS (
  SELECT
    source_event_id, alert_type, COUNT(*) AS row_count,
    MIN(id) AS min_id, MAX(id) AS max_id, SUM(id) AS id_sum,
    COUNT(DISTINCT chat_id) AS chat_count,
    COUNT(DISTINCT delivery_owner) AS owner_count,
    MIN(created_at) AS min_created, MAX(created_at) AS max_created,
    SUM(created_at) AS created_sum,
    MIN(delivery_started_at) AS min_started,
    MAX(delivery_started_at) AS max_started,
    SUM(delivery_started_at) AS started_sum,
    MIN(delivery_completed_at) AS min_completed,
    MAX(delivery_completed_at) AS max_completed,
    SUM(delivery_completed_at) AS completed_sum,
    SUM(priority) AS priority_sum, MIN(priority) AS min_priority,
    MAX(priority) AS max_priority,
    SUM(preference_generation) AS preference_generation_sum,
    SUM(length(message_html)) AS message_length_sum,
    SUM(length(dedupe_key)) AS dedupe_length_sum,
    SUM(length(alert_scope_json)) AS scope_length_sum,
    SUM(length(markup_policy_json)) AS markup_length_sum,
    SUM(CASE WHEN last_error_class = 'pending_effect_owner_lost' THEN 1 ELSE 0 END) AS owner_lost_count,
    SUM(CASE WHEN last_error_class = 'timeout' THEN 1 ELSE 0 END) AS timeout_count
  FROM telegram_pending_alerts
  WHERE delivery_state = 'execution_unknown'
    AND id <= 23359
  GROUP BY source_event_id, alert_type
),
archive_actual AS (
  SELECT
    source_event_id, alert_type, COUNT(*) AS row_count,
    MIN(pending_id) AS min_id, MAX(pending_id) AS max_id,
    SUM(pending_id) AS id_sum,
    COUNT(DISTINCT chat_id) AS chat_count,
    COUNT(DISTINCT delivery_owner) AS owner_count,
    MIN(created_at) AS min_created, MAX(created_at) AS max_created,
    SUM(created_at) AS created_sum,
    MIN(delivery_started_at) AS min_started,
    MAX(delivery_started_at) AS max_started,
    SUM(delivery_started_at) AS started_sum,
    MIN(delivery_completed_at) AS min_completed,
    MAX(delivery_completed_at) AS max_completed,
    SUM(delivery_completed_at) AS completed_sum,
    SUM(priority) AS priority_sum, MIN(priority) AS min_priority,
    MAX(priority) AS max_priority,
    SUM(preference_generation) AS preference_generation_sum,
    SUM(length(message_html)) AS message_length_sum,
    SUM(length(dedupe_key)) AS dedupe_length_sum,
    SUM(length(alert_scope_json)) AS scope_length_sum,
    SUM(length(markup_policy_json)) AS markup_length_sum,
    SUM(CASE WHEN last_error_class = 'pending_effect_owner_lost' THEN 1 ELSE 0 END) AS owner_lost_count,
    SUM(CASE WHEN last_error_class = 'timeout' THEN 1 ELSE 0 END) AS timeout_count
  FROM telegram_alert_dead_letters
  WHERE reason = 'execution_unknown_archived'
    AND delivery_state = 'execution_unknown'
    AND pending_id <= 23359
  GROUP BY source_event_id, alert_type
),
expected_jobs (
  job_id, source_event_id, alert_type, target_count, planned_count,
  accepted_count, enqueued_count, failed_count, cancelled_count,
  expired_count, execution_unknown_count
) AS (VALUES
  ('telegram:telegram-source:v1:6b720f298b9e431463312ba1b23c4f85:dews',   'telegram-source:v1:6b720f298b9e431463312ba1b23c4f85', 'dews',    47, 0,  46, 0, 0, 0, 0,   1),
  ('telegram:telegram-source:v1:7e835a90de4c68daec79e8fa9a9e6a63:depeg', 'telegram-source:v1:7e835a90de4c68daec79e8fa9a9e6a63', 'depeg',  296, 0, 220, 0, 0, 0, 0,  76),
  ('telegram:telegram-source:v1:819781859ec1723680693a7d562d2284:depeg', 'telegram-source:v1:819781859ec1723680693a7d562d2284', 'depeg',  277, 0,   0, 0, 1, 0, 0, 276),
  ('telegram:telegram-source:v1:881425beae03dc9a4657fd29fd4ee4ff:depeg', 'telegram-source:v1:881425beae03dc9a4657fd29fd4ee4ff', 'depeg',  279, 0, 278, 0, 0, 0, 0,   1),
  ('telegram:telegram-source:v1:8bdd3703b49abccac055e6079c9331e6:depeg', 'telegram-source:v1:8bdd3703b49abccac055e6079c9331e6', 'depeg',  337, 0, 168, 0, 0, 0, 0, 169),
  ('telegram:telegram-source:v1:c21a04fe56b20e4f20167492380d5aea:depeg', 'telegram-source:v1:c21a04fe56b20e4f20167492380d5aea', 'depeg',  279, 0, 278, 0, 0, 0, 0,   1),
  ('telegram:telegram-source:v1:c49f3510ea45e73416fc54788d5121af:depeg', 'telegram-source:v1:c49f3510ea45e73416fc54788d5121af', 'depeg',  310, 0, 309, 0, 0, 0, 0,   1),
  ('telegram:telegram-source:v1:c946a51c134a090da415f73434fa3a51:depeg', 'telegram-source:v1:c946a51c134a090da415f73434fa3a51', 'depeg',  279, 0,  49, 0, 0, 0, 0, 230),
  ('telegram:telegram-source:v1:d16dc7b86f06aa113cc1eaa913561ec3:depeg', 'telegram-source:v1:d16dc7b86f06aa113cc1eaa913561ec3', 'depeg',  279, 0, 278, 0, 0, 0, 0,   1),
  ('telegram:telegram-source:v1:dbd0f01512f40f7ce5655be124f417a3:safety','telegram-source:v1:dbd0f01512f40f7ce5655be124f417a3', 'safety',  52, 0,  50, 0, 0, 0, 0,   2)
),
target_buckets AS (
  SELECT target.job_id, target.target_key,
    CASE
      WHEN target.final_delivery_state IS NOT NULL THEN target.final_delivery_state
      WHEN target.cancelled_at IS NOT NULL THEN 'cancelled'
      WHEN target.effect_state = 'execution_unknown' THEN 'execution_unknown'
      WHEN target.status = 'sent' THEN 'accepted'
      WHEN target.status = 'failed' THEN 'failed'
      WHEN target.status = 'expired' THEN 'expired'
      WHEN target.status = 'queued' OR target.effect_state IN ('sending', 'complete') THEN 'enqueued'
      ELSE 'planned'
    END AS bucket
  FROM telegram_alert_job_targets target
  WHERE target.job_id IN (SELECT job_id FROM expected_jobs)
),
job_actual AS (
  SELECT
    job.job_id, job.source_event_id, job.alert_type,
    COUNT(bucket.target_key) AS target_count,
    SUM(CASE WHEN bucket.bucket = 'planned' THEN 1 ELSE 0 END) AS planned_count,
    SUM(CASE WHEN bucket.bucket = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
    SUM(CASE WHEN bucket.bucket = 'enqueued' THEN 1 ELSE 0 END) AS enqueued_count,
    SUM(CASE WHEN bucket.bucket = 'failed' THEN 1 ELSE 0 END) AS failed_count,
    SUM(CASE WHEN bucket.bucket = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
    SUM(CASE WHEN bucket.bucket = 'expired' THEN 1 ELSE 0 END) AS expired_count,
    SUM(CASE WHEN bucket.bucket = 'execution_unknown' THEN 1 ELSE 0 END) AS execution_unknown_count
  FROM telegram_alert_jobs job
  LEFT JOIN target_buckets bucket ON bucket.job_id = job.job_id
  WHERE job.job_id IN (SELECT job_id FROM expected_jobs)
  GROUP BY job.job_id, job.source_event_id, job.alert_type
),
fingerprints AS (
  SELECT
    NOT EXISTS (SELECT * FROM expected_pending EXCEPT SELECT * FROM live_actual)
      AND NOT EXISTS (SELECT * FROM live_actual EXCEPT SELECT * FROM expected_pending) AS live_exact,
    NOT EXISTS (SELECT * FROM expected_pending EXCEPT SELECT * FROM archive_actual)
      AND NOT EXISTS (SELECT * FROM archive_actual EXCEPT SELECT * FROM expected_pending) AS archive_exact,
    NOT EXISTS (SELECT * FROM expected_jobs EXCEPT SELECT * FROM job_actual)
      AND NOT EXISTS (SELECT * FROM job_actual EXCEPT SELECT * FROM expected_jobs) AS jobs_exact
)
SELECT CASE
  WHEN (
    NOT EXISTS (SELECT 1 FROM live_actual)
    AND NOT EXISTS (SELECT 1 FROM archive_actual)
    AND NOT EXISTS (
      SELECT 1 FROM telegram_alert_jobs
      WHERE job_id IN (SELECT job_id FROM expected_jobs)
         OR source_event_id IN (SELECT source_event_id FROM expected_pending)
    )
    AND NOT EXISTS (
      SELECT 1 FROM telegram_alert_job_targets
      WHERE source_event_id IN (SELECT source_event_id FROM expected_pending)
    )
  ) THEN 1
  WHEN (SELECT jobs_exact FROM fingerprints) = 1
    AND (
      (
        (SELECT live_exact FROM fingerprints) = 1
        AND NOT EXISTS (SELECT 1 FROM archive_actual)
        AND (SELECT COUNT(*) FROM telegram_pending_alerts
             WHERE delivery_state = 'execution_unknown' AND id <= 23359) = 758
        AND (SELECT COUNT(DISTINCT chat_id) FROM telegram_pending_alerts
             WHERE delivery_state = 'execution_unknown' AND id <= 23359) = 319
        AND (SELECT COUNT(DISTINCT dedupe_key) FROM telegram_pending_alerts
             WHERE delivery_state = 'execution_unknown' AND id <= 23359) = 758
        AND (SELECT COUNT(DISTINCT source_event_id) FROM telegram_pending_alerts
             WHERE delivery_state = 'execution_unknown' AND id <= 23359) = 10
        AND (SELECT COUNT(DISTINCT delivery_owner) FROM telegram_pending_alerts
             WHERE delivery_state = 'execution_unknown' AND id <= 23359) = 10
        AND NOT EXISTS (
          SELECT 1 FROM telegram_pending_alerts
          WHERE delivery_state = 'execution_unknown'
            AND id <= 23359
            AND (
              source_type <> 'risk_alert' OR attempts <> 0 OR chunk_index <> 0
              OR delivery_generation <> 1 OR delivery_owner IS NULL
              OR dedupe_key IS NULL OR source_event_id IS NULL
              OR alert_scope_json IS NULL OR preference_generation IS NULL
              OR markup_policy_json IS NULL OR expires_at IS NULL
              OR not_before_at IS NOT NULL OR retry_after_sec IS NOT NULL
              OR delivery_claim_expires_at IS NOT NULL
              OR processing_owner IS NOT NULL OR processing_started_at IS NOT NULL
              OR processing_expires_at IS NOT NULL
            )
        )
        AND (SELECT SUM(disable_notification) FROM telegram_pending_alerts
             WHERE delivery_state = 'execution_unknown' AND id <= 23359) = 452
        AND (SELECT SUM(id) FROM telegram_pending_alerts
             WHERE delivery_state = 'execution_unknown' AND id <= 23359) = 16272822
        AND (SELECT COUNT(*)
             FROM telegram_pending_alerts pending
             JOIN telegram_alert_job_targets target
               ON target.pending_dedupe_key = pending.dedupe_key
              AND target.source_event_id = pending.source_event_id
              AND target.final_delivery_state = 'execution_unknown'
             WHERE pending.delivery_state = 'execution_unknown'
               AND pending.id <= 23359) = 758
      )
      OR (
        NOT EXISTS (SELECT 1 FROM live_actual)
        AND (SELECT archive_exact FROM fingerprints) = 1
        AND (SELECT COUNT(*) FROM telegram_alert_dead_letters
             WHERE reason = 'execution_unknown_archived'
               AND delivery_state = 'execution_unknown'
               AND pending_id <= 23359) = 758
        AND (SELECT COUNT(DISTINCT chat_id) FROM telegram_alert_dead_letters
             WHERE reason = 'execution_unknown_archived'
               AND delivery_state = 'execution_unknown'
               AND pending_id <= 23359) = 319
        AND (SELECT COUNT(DISTINCT dedupe_key) FROM telegram_alert_dead_letters
             WHERE reason = 'execution_unknown_archived'
               AND delivery_state = 'execution_unknown'
               AND pending_id <= 23359) = 758
        AND NOT EXISTS (
          SELECT 1 FROM telegram_alert_dead_letters
          WHERE reason = 'execution_unknown_archived'
            AND delivery_state = 'execution_unknown'
            AND pending_id <= 23359
            AND (
              source_type <> 'risk_alert' OR attempts <> 0 OR chunk_index <> 0
              OR delivery_generation <> 1 OR delivery_owner IS NULL
              OR dead_letter_key <> 'pending:' || pending_id || ':delivery:' || delivery_generation
            )
        )
        AND (SELECT COUNT(*)
             FROM telegram_alert_dead_letters dead
             JOIN telegram_alert_job_targets target
               ON target.pending_dedupe_key = dead.dedupe_key
              AND target.source_event_id = dead.source_event_id
              AND target.final_delivery_state = 'execution_unknown'
             WHERE dead.reason = 'execution_unknown_archived'
               AND dead.delivery_state = 'execution_unknown'
               AND dead.pending_id <= 23359) = 758
      )
    ) THEN 1
  ELSE json('0207 telegram execution unknown archive guard drift')
END;

-- Copy the reviewed live cohort with the same deterministic identity and
-- lifecycle snapshot used by the runtime dead-letter path. A replay accepts an
-- existing row only when every archived field still matches.
INSERT INTO telegram_alert_dead_letters (
  dead_letter_key, pending_id, chat_id, message_html, source_type, alert_type,
  priority, created_at, expired_at, attempts, last_error_class, reason,
  dedupe_key, chunk_index, source_event_id, alert_scope_json,
  preference_generation, markup_policy_json, delivery_state, delivery_owner,
  delivery_generation, delivery_started_at, delivery_completed_at,
  delivery_claim_expires_at
)
SELECT
  'pending:' || pending.id || ':delivery:' || pending.delivery_generation,
  pending.id, pending.chat_id, pending.message_html, pending.source_type,
  pending.alert_type, pending.priority, pending.created_at, unixepoch(),
  pending.attempts, pending.last_error_class, 'execution_unknown_archived',
  pending.dedupe_key, pending.chunk_index, pending.source_event_id,
  pending.alert_scope_json, pending.preference_generation,
  pending.markup_policy_json, pending.delivery_state, pending.delivery_owner,
  pending.delivery_generation, pending.delivery_started_at,
  pending.delivery_completed_at, pending.delivery_claim_expires_at
FROM telegram_pending_alerts pending
WHERE pending.delivery_state = 'execution_unknown'
  AND pending.id <= 23359
ON CONFLICT(dead_letter_key) WHERE dead_letter_key IS NOT NULL DO UPDATE SET
  dead_letter_key = excluded.dead_letter_key
WHERE telegram_alert_dead_letters.pending_id IS excluded.pending_id
  AND telegram_alert_dead_letters.chat_id IS excluded.chat_id
  AND telegram_alert_dead_letters.message_html IS excluded.message_html
  AND telegram_alert_dead_letters.source_type IS excluded.source_type
  AND telegram_alert_dead_letters.alert_type IS excluded.alert_type
  AND telegram_alert_dead_letters.priority IS excluded.priority
  AND telegram_alert_dead_letters.created_at IS excluded.created_at
  AND telegram_alert_dead_letters.attempts IS excluded.attempts
  AND telegram_alert_dead_letters.last_error_class IS excluded.last_error_class
  AND telegram_alert_dead_letters.reason IS excluded.reason
  AND telegram_alert_dead_letters.dedupe_key IS excluded.dedupe_key
  AND telegram_alert_dead_letters.chunk_index IS excluded.chunk_index
  AND telegram_alert_dead_letters.source_event_id IS excluded.source_event_id
  AND telegram_alert_dead_letters.alert_scope_json IS excluded.alert_scope_json
  AND telegram_alert_dead_letters.preference_generation IS excluded.preference_generation
  AND telegram_alert_dead_letters.markup_policy_json IS excluded.markup_policy_json
  AND telegram_alert_dead_letters.delivery_state IS excluded.delivery_state
  AND telegram_alert_dead_letters.delivery_owner IS excluded.delivery_owner
  AND telegram_alert_dead_letters.delivery_generation IS excluded.delivery_generation
  AND telegram_alert_dead_letters.delivery_started_at IS excluded.delivery_started_at
  AND telegram_alert_dead_letters.delivery_completed_at IS excluded.delivery_completed_at
  AND telegram_alert_dead_letters.delivery_claim_expires_at IS excluded.delivery_claim_expires_at;

-- Verify that every still-live reviewed row has an exact archive snapshot
-- before allowing any queue deletion.
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1
    FROM telegram_pending_alerts pending
    WHERE pending.delivery_state = 'execution_unknown'
      AND pending.id <= 23359
      AND NOT EXISTS (
        SELECT 1
        FROM telegram_alert_dead_letters dead
        WHERE dead.dead_letter_key = 'pending:' || pending.id || ':delivery:' || pending.delivery_generation
          AND dead.pending_id IS pending.id
          AND dead.chat_id IS pending.chat_id
          AND dead.message_html IS pending.message_html
          AND dead.source_type IS pending.source_type
          AND dead.alert_type IS pending.alert_type
          AND dead.priority IS pending.priority
          AND dead.created_at IS pending.created_at
          AND dead.attempts IS pending.attempts
          AND dead.last_error_class IS pending.last_error_class
          AND dead.reason = 'execution_unknown_archived'
          AND dead.dedupe_key IS pending.dedupe_key
          AND dead.chunk_index IS pending.chunk_index
          AND dead.source_event_id IS pending.source_event_id
          AND dead.alert_scope_json IS pending.alert_scope_json
          AND dead.preference_generation IS pending.preference_generation
          AND dead.markup_policy_json IS pending.markup_policy_json
          AND dead.delivery_state IS pending.delivery_state
          AND dead.delivery_owner IS pending.delivery_owner
          AND dead.delivery_generation IS pending.delivery_generation
          AND dead.delivery_started_at IS pending.delivery_started_at
          AND dead.delivery_completed_at IS pending.delivery_completed_at
          AND dead.delivery_claim_expires_at IS pending.delivery_claim_expires_at
      )
  )
  AND (
    (NOT EXISTS (
       SELECT 1 FROM telegram_pending_alerts
       WHERE delivery_state = 'execution_unknown' AND id <= 23359
     )
     AND NOT EXISTS (
       SELECT 1 FROM telegram_alert_dead_letters
       WHERE reason = 'execution_unknown_archived'
         AND delivery_state = 'execution_unknown'
         AND pending_id <= 23359
     ))
    OR (SELECT COUNT(*) FROM telegram_alert_dead_letters
        WHERE reason = 'execution_unknown_archived'
          AND delivery_state = 'execution_unknown'
          AND pending_id <= 23359) = 758
  ) THEN 1
  ELSE json('0207 telegram execution unknown archive copy mismatch')
END;

-- Delete only live rows whose exact archive snapshot was just verified. This
-- keeps any newer execution-unknown row and any concurrently changed row live.
DELETE FROM telegram_pending_alerts
WHERE delivery_state = 'execution_unknown'
  AND id <= 23359
  AND EXISTS (
    SELECT 1
    FROM telegram_alert_dead_letters dead
    WHERE dead.dead_letter_key = 'pending:' || telegram_pending_alerts.id || ':delivery:' || telegram_pending_alerts.delivery_generation
      AND dead.pending_id IS telegram_pending_alerts.id
      AND dead.chat_id IS telegram_pending_alerts.chat_id
      AND dead.message_html IS telegram_pending_alerts.message_html
      AND dead.source_type IS telegram_pending_alerts.source_type
      AND dead.alert_type IS telegram_pending_alerts.alert_type
      AND dead.priority IS telegram_pending_alerts.priority
      AND dead.created_at IS telegram_pending_alerts.created_at
      AND dead.attempts IS telegram_pending_alerts.attempts
      AND dead.last_error_class IS telegram_pending_alerts.last_error_class
      AND dead.reason = 'execution_unknown_archived'
      AND dead.dedupe_key IS telegram_pending_alerts.dedupe_key
      AND dead.chunk_index IS telegram_pending_alerts.chunk_index
      AND dead.source_event_id IS telegram_pending_alerts.source_event_id
      AND dead.alert_scope_json IS telegram_pending_alerts.alert_scope_json
      AND dead.preference_generation IS telegram_pending_alerts.preference_generation
      AND dead.markup_policy_json IS telegram_pending_alerts.markup_policy_json
      AND dead.delivery_state IS telegram_pending_alerts.delivery_state
      AND dead.delivery_owner IS telegram_pending_alerts.delivery_owner
      AND dead.delivery_generation IS telegram_pending_alerts.delivery_generation
      AND dead.delivery_started_at IS telegram_pending_alerts.delivery_started_at
      AND dead.delivery_completed_at IS telegram_pending_alerts.delivery_completed_at
      AND dead.delivery_claim_expires_at IS telegram_pending_alerts.delivery_claim_expires_at
  );

SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM telegram_pending_alerts
    WHERE delivery_state = 'execution_unknown' AND id <= 23359
  )
  AND (
    (SELECT COUNT(*) FROM telegram_alert_dead_letters
     WHERE reason = 'execution_unknown_archived'
       AND delivery_state = 'execution_unknown'
       AND pending_id <= 23359) IN (0, 758)
  ) THEN 1
  ELSE json('0207 telegram execution unknown archive delete mismatch')
END;

-- Rebuild only the reviewed job cohort from authoritative target buckets. The
-- bucket classification and status precedence mirror runtime reconciliation.
WITH reviewed_jobs(job_id) AS (VALUES
  ('telegram:telegram-source:v1:6b720f298b9e431463312ba1b23c4f85:dews'),
  ('telegram:telegram-source:v1:7e835a90de4c68daec79e8fa9a9e6a63:depeg'),
  ('telegram:telegram-source:v1:819781859ec1723680693a7d562d2284:depeg'),
  ('telegram:telegram-source:v1:881425beae03dc9a4657fd29fd4ee4ff:depeg'),
  ('telegram:telegram-source:v1:8bdd3703b49abccac055e6079c9331e6:depeg'),
  ('telegram:telegram-source:v1:c21a04fe56b20e4f20167492380d5aea:depeg'),
  ('telegram:telegram-source:v1:c49f3510ea45e73416fc54788d5121af:depeg'),
  ('telegram:telegram-source:v1:c946a51c134a090da415f73434fa3a51:depeg'),
  ('telegram:telegram-source:v1:d16dc7b86f06aa113cc1eaa913561ec3:depeg'),
  ('telegram:telegram-source:v1:dbd0f01512f40f7ce5655be124f417a3:safety')
),
target_buckets AS (
  SELECT target.job_id,
    CASE
      WHEN target.final_delivery_state IS NOT NULL THEN target.final_delivery_state
      WHEN target.cancelled_at IS NOT NULL THEN 'cancelled'
      WHEN target.effect_state = 'execution_unknown' THEN 'execution_unknown'
      WHEN target.status = 'sent' THEN 'accepted'
      WHEN target.status = 'failed' THEN 'failed'
      WHEN target.status = 'expired' THEN 'expired'
      WHEN target.status = 'queued' OR target.effect_state IN ('sending', 'complete') THEN 'enqueued'
      ELSE 'planned'
    END AS bucket
  FROM telegram_alert_job_targets target
  WHERE target.job_id IN (SELECT job_id FROM reviewed_jobs)
),
counts AS (
  SELECT
    reviewed.job_id,
    COUNT(bucket.bucket) AS target_count,
    SUM(CASE WHEN bucket.bucket = 'planned' THEN 1 ELSE 0 END) AS planned_count,
    SUM(CASE WHEN bucket.bucket = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
    SUM(CASE WHEN bucket.bucket = 'enqueued' THEN 1 ELSE 0 END) AS enqueued_count,
    SUM(CASE WHEN bucket.bucket = 'failed' THEN 1 ELSE 0 END) AS failed_count,
    SUM(CASE WHEN bucket.bucket = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
    SUM(CASE WHEN bucket.bucket = 'expired' THEN 1 ELSE 0 END) AS expired_count,
    SUM(CASE WHEN bucket.bucket = 'execution_unknown' THEN 1 ELSE 0 END) AS execution_unknown_count
  FROM reviewed_jobs reviewed
  LEFT JOIN target_buckets bucket ON bucket.job_id = reviewed.job_id
  GROUP BY reviewed.job_id
)
UPDATE telegram_alert_jobs
SET target_count = COALESCE((SELECT target_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0),
    planned_count = COALESCE((SELECT planned_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0),
    accepted_count = COALESCE((SELECT accepted_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0),
    sent_count = COALESCE((SELECT accepted_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0),
    enqueued_count = COALESCE((SELECT enqueued_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0),
    failed_count = COALESCE((SELECT failed_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0),
    cancelled_count = COALESCE((SELECT cancelled_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0),
    expired_count = COALESCE((SELECT expired_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0),
    execution_unknown_count = COALESCE((SELECT execution_unknown_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0),
    status = CASE
      WHEN COALESCE((SELECT target_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0) = 0 THEN 'discovered'
      WHEN COALESCE((SELECT failed_count + expired_count + execution_unknown_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0) > 0 THEN 'degraded'
      WHEN COALESCE((SELECT planned_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0) > 0 THEN 'discovered'
      WHEN COALESCE((SELECT enqueued_count FROM counts WHERE counts.job_id = telegram_alert_jobs.job_id), 0) > 0 THEN 'queued'
      ELSE 'sent'
    END,
    metadata = CASE
      WHEN json_valid(metadata) THEN json_set(
        metadata,
        '$.countersSource', 'authoritative-target-rows',
        '$.reconciledAt', unixepoch()
      )
      ELSE json_object(
        'countersSource', 'authoritative-target-rows',
        'reconciledAt', unixepoch()
      )
    END
WHERE job_id IN (SELECT job_id FROM reviewed_jobs);

SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1
    FROM telegram_alert_jobs job
    WHERE job.job_id IN (
      'telegram:telegram-source:v1:6b720f298b9e431463312ba1b23c4f85:dews',
      'telegram:telegram-source:v1:7e835a90de4c68daec79e8fa9a9e6a63:depeg',
      'telegram:telegram-source:v1:819781859ec1723680693a7d562d2284:depeg',
      'telegram:telegram-source:v1:881425beae03dc9a4657fd29fd4ee4ff:depeg',
      'telegram:telegram-source:v1:8bdd3703b49abccac055e6079c9331e6:depeg',
      'telegram:telegram-source:v1:c21a04fe56b20e4f20167492380d5aea:depeg',
      'telegram:telegram-source:v1:c49f3510ea45e73416fc54788d5121af:depeg',
      'telegram:telegram-source:v1:c946a51c134a090da415f73434fa3a51:depeg',
      'telegram:telegram-source:v1:d16dc7b86f06aa113cc1eaa913561ec3:depeg',
      'telegram:telegram-source:v1:dbd0f01512f40f7ce5655be124f417a3:safety'
    )
      AND (
        job.status <> 'degraded'
        OR job.execution_unknown_count = 0
        OR json_extract(job.metadata, '$.countersSource') <> 'authoritative-target-rows'
      )
  ) THEN 1
  ELSE json('0207 telegram job counter reconciliation mismatch')
END;
