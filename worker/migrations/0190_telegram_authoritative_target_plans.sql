-- rollout-safety: backward-compatible
-- Replace cache-authoritative Telegram overflow with cursorable source-event
-- planning rows and make every rendered target chunk replayable from D1.

ALTER TABLE telegram_alert_source_events
  ADD COLUMN target_plan_state TEXT NOT NULL DEFAULT 'unstarted'
  CHECK (target_plan_state IN (
    'unstarted', 'capturing', 'planning', 'materializing', 'ready',
    'delivery_open', 'degraded', 'expired'
  ));

ALTER TABLE telegram_alert_source_events
  ADD COLUMN target_plan_generation INTEGER NOT NULL DEFAULT 0
  CHECK (target_plan_generation >= 0);

ALTER TABLE telegram_alert_source_events
  ADD COLUMN target_plan_owner TEXT
  CHECK (target_plan_owner IS NULL OR length(target_plan_owner) <= 200);

ALTER TABLE telegram_alert_source_events
  ADD COLUMN target_plan_claim_expires_at INTEGER;

ALTER TABLE telegram_alert_source_events
  ADD COLUMN target_plan_started_at INTEGER;

ALTER TABLE telegram_alert_source_events
  ADD COLUMN target_plan_completed_at INTEGER;

ALTER TABLE telegram_alert_source_events
  ADD COLUMN target_delivery_opened_at INTEGER;

ALTER TABLE telegram_alert_source_events
  ADD COLUMN subscriber_horizon_at INTEGER;

ALTER TABLE telegram_alert_source_events
  ADD COLUMN subscriber_high_water_chat_id TEXT;

ALTER TABLE telegram_alert_source_events
  ADD COLUMN subscriber_cursor_chat_id TEXT;

ALTER TABLE telegram_alert_source_events
  ADD COLUMN planning_cursor_chat_id TEXT;

ALTER TABLE telegram_alert_source_events
  ADD COLUMN target_plan_count INTEGER NOT NULL DEFAULT 0
  CHECK (target_plan_count >= 0);

ALTER TABLE telegram_alert_source_events
  ADD COLUMN target_materialized_count INTEGER NOT NULL DEFAULT 0
  CHECK (target_materialized_count >= 0);

CREATE INDEX IF NOT EXISTS idx_tase_target_plan_resume
  ON telegram_alert_source_events(target_plan_state, detected_at)
  WHERE target_plan_state NOT IN ('delivery_open', 'expired');

CREATE TABLE IF NOT EXISTS telegram_alert_target_expiry_progress (
  source_event_id TEXT NOT NULL,
  plan_generation INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'complete')),
  processed_subscribers INTEGER NOT NULL DEFAULT 0 CHECK (processed_subscribers >= 0),
  processed_pages INTEGER NOT NULL DEFAULT 0 CHECK (processed_pages >= 0),
  processed_plans INTEGER NOT NULL DEFAULT 0 CHECK (processed_plans >= 0),
  processed_targets INTEGER NOT NULL DEFAULT 0 CHECK (processed_targets >= 0),
  remaining_subscribers INTEGER NOT NULL DEFAULT 0 CHECK (remaining_subscribers >= 0),
  remaining_pages INTEGER NOT NULL DEFAULT 0 CHECK (remaining_pages >= 0),
  remaining_plans INTEGER NOT NULL DEFAULT 0 CHECK (remaining_plans >= 0),
  remaining_targets INTEGER NOT NULL DEFAULT 0 CHECK (remaining_targets >= 0),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (source_event_id, plan_generation)
);

CREATE INDEX IF NOT EXISTS idx_tatep_resume
  ON telegram_alert_target_expiry_progress(state, updated_at, source_event_id);

CREATE TABLE IF NOT EXISTS telegram_alert_planning_subscribers (
  source_event_id TEXT NOT NULL,
  plan_generation INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  preference_generation INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  planning_outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (planning_outcome IN (
      'pending', 'target_planned', 'no_matching_scope',
      'preference_changed_ineligible', 'eligible_after_event',
      'snapshot_missing', 'expired'
    )),
  planned_preference_generation INTEGER
    CHECK (planned_preference_generation IS NULL OR planned_preference_generation >= 0),
  initially_eligible INTEGER
    CHECK (initially_eligible IS NULL OR initially_eligible IN (0, 1)),
  planned_at INTEGER,
  PRIMARY KEY (source_event_id, plan_generation, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_taps_scan
  ON telegram_alert_planning_subscribers(source_event_id, plan_generation, chat_id);

CREATE TABLE IF NOT EXISTS telegram_alert_target_plan_pages (
  source_event_id TEXT NOT NULL,
  plan_generation INTEGER NOT NULL,
  page_index INTEGER NOT NULL,
  first_chat_id TEXT,
  last_chat_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'materializing', 'complete', 'expired')),
  expected_plan_count INTEGER NOT NULL DEFAULT 0
    CHECK (expected_plan_count >= 0),
  materialized_plan_count INTEGER NOT NULL DEFAULT 0
    CHECK (materialized_plan_count >= 0),
  expected_target_count INTEGER NOT NULL DEFAULT 0
    CHECK (expected_target_count >= 0),
  materialized_target_count INTEGER NOT NULL DEFAULT 0
    CHECK (materialized_target_count >= 0),
  cursor_plan_ordinal INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error_class TEXT
    CHECK (last_error_class IS NULL OR length(last_error_class) <= 80),
  PRIMARY KEY (source_event_id, plan_generation, page_index)
);

CREATE INDEX IF NOT EXISTS idx_tatpp_resume
  ON telegram_alert_target_plan_pages(source_event_id, plan_generation, status, page_index);

CREATE TABLE IF NOT EXISTS telegram_alert_target_plans (
  source_event_id TEXT NOT NULL,
  plan_generation INTEGER NOT NULL,
  plan_key TEXT NOT NULL
    CHECK (length(plan_key) BETWEEN 1 AND 200),
  page_index INTEGER NOT NULL,
  plan_ordinal INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('dews', 'depeg', 'safety', 'launch', 'reserve')),
  schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (schema_version = 1),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'materializing', 'materialized', 'expired')),
  preference_generation INTEGER NOT NULL
    CHECK (preference_generation >= 0),
  estimated_chunks INTEGER NOT NULL
    CHECK (estimated_chunks BETWEEN 1 AND 64),
  plan_payload_json TEXT NOT NULL
    CHECK (length(plan_payload_json) BETWEEN 2 AND 262144),
  plan_payload_digest TEXT NOT NULL
    CHECK (length(plan_payload_digest) = 64),
  expected_target_count INTEGER NOT NULL DEFAULT 0
    CHECK (expected_target_count BETWEEN 0 AND 64),
  materialized_target_count INTEGER NOT NULL DEFAULT 0
    CHECK (materialized_target_count BETWEEN 0 AND 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  materialized_at INTEGER,
  PRIMARY KEY (source_event_id, plan_generation, plan_key),
  UNIQUE (source_event_id, plan_generation, plan_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_tatp_resume
  ON telegram_alert_target_plans(
    source_event_id, plan_generation, status, page_index, plan_ordinal
  );

CREATE TABLE IF NOT EXISTS telegram_alert_target_plan_items (
  source_event_id TEXT NOT NULL,
  plan_generation INTEGER NOT NULL,
  plan_key TEXT NOT NULL,
  item_key TEXT NOT NULL
    CHECK (length(item_key) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_event_id, plan_generation, plan_key, item_key)
);

CREATE INDEX IF NOT EXISTS idx_tatpi_source_item
  ON telegram_alert_target_plan_items(source_event_id, item_key, plan_key);

CREATE TRIGGER IF NOT EXISTS trg_taps_source_generation_guard
BEFORE INSERT ON telegram_alert_planning_subscribers
WHEN NOT EXISTS (
  SELECT 1 FROM telegram_alert_source_events source
   WHERE source.source_event_id = NEW.source_event_id
     AND source.target_plan_generation = NEW.plan_generation
     AND source.target_plan_state = 'capturing'
     AND source.expires_at > NEW.captured_at
)
BEGIN
  SELECT RAISE(ABORT, 'telegram planning subscriber source is not capturable');
END;

CREATE TRIGGER IF NOT EXISTS trg_tatp_source_generation_guard
BEFORE INSERT ON telegram_alert_target_plans
WHEN NOT EXISTS (
  SELECT 1 FROM telegram_alert_source_events source
   WHERE source.source_event_id = NEW.source_event_id
     AND source.target_plan_generation = NEW.plan_generation
     AND source.target_plan_state IN ('planning', 'materializing')
     AND source.expires_at > NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'telegram target plan source is not materializable');
END;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN source_event_id TEXT
  CHECK (source_event_id IS NULL OR length(source_event_id) <= 200);

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN plan_generation INTEGER
  CHECK (plan_generation IS NULL OR plan_generation >= 0);

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN plan_key TEXT
  CHECK (plan_key IS NULL OR length(plan_key) <= 200);

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN plan_ordinal INTEGER;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN target_ordinal INTEGER;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN target_schema_version INTEGER
  CHECK (target_schema_version IS NULL OR target_schema_version = 1);

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN message_html TEXT
  CHECK (message_html IS NULL OR length(message_html) <= 16384);

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN disable_notification INTEGER
  CHECK (disable_notification IS NULL OR disable_notification IN (0, 1));

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN alert_scope_json TEXT
  CHECK (alert_scope_json IS NULL OR length(alert_scope_json) <= 65536);

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN preference_generation INTEGER
  CHECK (preference_generation IS NULL OR preference_generation >= 0);

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN markup_policy_json TEXT
  CHECK (markup_policy_json IS NULL OR length(markup_policy_json) <= 16384);

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN target_expires_at INTEGER;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN final_delivery_state TEXT
  CHECK (final_delivery_state IS NULL OR final_delivery_state IN (
    'accepted', 'failed', 'cancelled', 'expired', 'execution_unknown'
  ));

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN final_delivery_at INTEGER;

ALTER TABLE telegram_alert_job_targets
  ADD COLUMN final_delivery_error TEXT
  CHECK (final_delivery_error IS NULL OR length(final_delivery_error) <= 80);

CREATE INDEX IF NOT EXISTS idx_tajt_authoritative_ready
  ON telegram_alert_job_targets(
    source_event_id, plan_generation, status, plan_ordinal, target_ordinal
  );

CREATE INDEX IF NOT EXISTS idx_tajt_pending_source_outcome
  ON telegram_alert_job_targets(pending_dedupe_key, source_event_id, final_delivery_state);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tajt_authoritative_pending_identity
  ON telegram_alert_job_targets(source_event_id, pending_dedupe_key)
  WHERE plan_generation IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_tajt_source_generation_guard
BEFORE INSERT ON telegram_alert_job_targets
WHEN NEW.plan_generation IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM telegram_alert_source_events source
   WHERE source.source_event_id = NEW.source_event_id
     AND source.target_plan_generation = NEW.plan_generation
     AND source.target_plan_state IN ('planning', 'materializing')
     AND source.expires_at > NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'telegram target source is not materializable');
END;

ALTER TABLE telegram_alert_jobs
  ADD COLUMN planned_count INTEGER NOT NULL DEFAULT 0
  CHECK (planned_count >= 0);

ALTER TABLE telegram_alert_jobs
  ADD COLUMN accepted_count INTEGER NOT NULL DEFAULT 0
  CHECK (accepted_count >= 0);

ALTER TABLE telegram_alert_jobs
  ADD COLUMN cancelled_count INTEGER NOT NULL DEFAULT 0
  CHECK (cancelled_count >= 0);

ALTER TABLE telegram_alert_jobs
  ADD COLUMN expired_count INTEGER NOT NULL DEFAULT 0
  CHECK (expired_count >= 0);

ALTER TABLE telegram_alert_jobs
  ADD COLUMN execution_unknown_count INTEGER NOT NULL DEFAULT 0
  CHECK (execution_unknown_count >= 0);

CREATE TABLE IF NOT EXISTS telegram_legacy_overflow_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL
    CHECK (state IN ('absent', 'importing', 'imported', 'corrupt', 'oversized', 'degraded')),
  blob_digest TEXT
    CHECK (blob_digest IS NULL OR length(blob_digest) = 64),
  observed_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (observed_bytes >= 0),
  observed_plan_count INTEGER
    CHECK (observed_plan_count IS NULL OR observed_plan_count >= 0),
  expected_item_count INTEGER
    CHECK (expected_item_count IS NULL OR expected_item_count >= 0),
  synthetic_source_event_id TEXT
    CHECK (synthetic_source_event_id IS NULL OR length(synthetic_source_event_id) <= 200),
  import_cursor INTEGER NOT NULL DEFAULT 0
    CHECK (import_cursor >= 0),
  imported_target_count INTEGER NOT NULL DEFAULT 0
    CHECK (imported_target_count >= 0),
  last_error_class TEXT
    CHECK (last_error_class IS NULL OR length(last_error_class) <= 80),
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  imported_at INTEGER
);
