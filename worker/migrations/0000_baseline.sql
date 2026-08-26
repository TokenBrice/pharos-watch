-- Active fresh-database baseline, accepted 2026-07-30.
-- Consolidates historical migrations 0001 through 0227.
-- Existing databases retain their applied-migration ledger; fresh databases apply
-- this baseline followed by active migrations 0228 onward. See MANIFEST.md.

CREATE TABLE IF NOT EXISTS admin_action_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'error')),
  http_status INTEGER,
  details_json TEXT
, intent_key TEXT);

CREATE TABLE IF NOT EXISTS admin_idempotency_keys (
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL, reservation_owner TEXT, reservation_generation INTEGER NOT NULL DEFAULT 0, execution_started_at INTEGER,
  PRIMARY KEY (action, idempotency_key)
);

CREATE TABLE IF NOT EXISTS api_key_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deactivated', 'rotated')),
  actor TEXT NOT NULL DEFAULT 'admin',
  detail_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_key_rate_limit (
  api_key_id INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (api_key_id, bucket_start)
);

CREATE TABLE IF NOT EXISTS api_key_request_rate_limit_v2 (
  scope TEXT NOT NULL CHECK (scope IN (
    'submission_ip',
    'submission_email',
    'verification_ip',
    'verification_token'
  )),
  subject_hash TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject_hash, bucket_start)
);

CREATE TABLE IF NOT EXISTS api_key_request_stats (
  api_key_id INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, bucket_start)
);

CREATE TABLE IF NOT EXISTS api_key_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  api_key_id INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'pending_verification',
    'issued',
    'rejected',
    'blocked',
    'expired'
  )),
  normalized_email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  requester_name TEXT,
  organization TEXT,
  project_url TEXT,
  use_case TEXT NOT NULL,
  expected_cadence TEXT,
  expected_volume TEXT,
  accepted_terms INTEGER NOT NULL DEFAULT 0,
  self_serve_rate_limit_per_minute INTEGER NOT NULL,
  self_serve_expires_at INTEGER,
  ip_hash TEXT NOT NULL,
  user_agent_hash TEXT,
  honeypot_triggered INTEGER NOT NULL DEFAULT 0,
  verification_token_hash TEXT,
  verification_sent_at INTEGER,
  verification_expires_at INTEGER,
  email_provider_message_id TEXT,
  issued_at INTEGER,
  rejected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, issuance_locked_at INTEGER);

CREATE TABLE IF NOT EXISTS api_key_self_serve_email_claims (
  email_hash TEXT PRIMARY KEY,
  normalized_email TEXT NOT NULL,
  api_key_id INTEGER,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_verification', 'issued', 'released')),
  claimed_at INTEGER NOT NULL,
  released_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_key_self_serve_issuance_limits (
  scope TEXT NOT NULL CHECK (scope IN ('submission_ip_daily')),
  subject_hash TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject_hash, bucket_start)
);

CREATE TABLE IF NOT EXISTS api_key_self_serve_revocations (
  key_prefix TEXT PRIMARY KEY,
  api_key_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_prefix TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_email TEXT,
  tier TEXT NOT NULL DEFAULT 'standard',
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 120,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_used_route TEXT
, traffic_class TEXT NOT NULL DEFAULT 'external'
  CHECK (traffic_class IN ('external', 'site')), expires_at INTEGER, pepper_version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS api_request_consumer_stats (
  bucket_start INTEGER NOT NULL,
  route_key TEXT NOT NULL,
  route_path TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('public-api', 'site-api')),
  consumer_class TEXT NOT NULL CHECK (consumer_class IN ('site', 'external')),
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, route_key, lane, consumer_class)
);

CREATE TABLE IF NOT EXISTS authoritative_vault_rates (
  stablecoin_id TEXT PRIMARY KEY,
  rate REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blacklist_amount_repair_queue (
  event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry', 'resolved', 'unrecoverable')),
  priority INTEGER NOT NULL DEFAULT 100,
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_expires_at INTEGER,
  last_error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (event_id) REFERENCES blacklist_events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blacklist_current_balances (
  id TEXT PRIMARY KEY,
  stablecoin TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  address TEXT NOT NULL,
  amount_native REAL,
  amount_usd REAL,
  source TEXT NOT NULL DEFAULT 'current_balance',
  status TEXT NOT NULL DEFAULT 'resolved',
  observed_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at INTEGER,
  last_error_class TEXT
, config_key TEXT, contract_address TEXT, last_successful_observed_at INTEGER, consecutive_failures INTEGER);

CREATE TABLE IF NOT EXISTS blacklist_events (
  id TEXT PRIMARY KEY,
  stablecoin TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  chain_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  address TEXT NOT NULL,
  amount REAL,
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  explorer_tx_url TEXT NOT NULL,
  explorer_address_url TEXT NOT NULL,
  methodology_version TEXT NOT NULL DEFAULT '3.1'
, amount_native REAL, amount_usd_at_event REAL, amount_source TEXT NOT NULL DEFAULT 'unavailable', amount_status TEXT NOT NULL DEFAULT 'recoverable_pending', contract_address TEXT, config_key TEXT, event_signature TEXT, event_topic0 TEXT, amount_attempt_count INTEGER NOT NULL DEFAULT 0, amount_last_attempted_at INTEGER, amount_last_error_class TEXT, amount_last_provider TEXT, suppression_reason TEXT, reconciliation_manifest_id TEXT, reconciliation_run_id TEXT, provenance_source TEXT, provenance_observed_at INTEGER, source_event_index INTEGER);

CREATE TABLE IF NOT EXISTS blacklist_reconciliation_runs (
  run_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'apply')),
  status TEXT NOT NULL CHECK (status IN ('running', 'verified', 'failed')),
  time_travel_bookmark TEXT,
  expected_event_count INTEGER NOT NULL,
  upstream_event_count INTEGER NOT NULL,
  present_event_count INTEGER NOT NULL DEFAULT 0,
  inserted_event_count INTEGER NOT NULL DEFAULT 0,
  missing_event_count INTEGER NOT NULL DEFAULT 0,
  duplicate_identity_count INTEGER NOT NULL DEFAULT 0,
  expected_destroyed_amount_raw INTEGER NOT NULL DEFAULT 0,
  actual_destroyed_amount_raw INTEGER NOT NULL DEFAULT 0,
  balance_replay_expected_count INTEGER NOT NULL DEFAULT 0,
  balance_replay_matching_count INTEGER NOT NULL DEFAULT 0,
  unresolved_manifest_gap_count INTEGER NOT NULL DEFAULT 0,
  tron_cursor_before INTEGER,
  tron_cursor_after INTEGER,
  tron_safe_head INTEGER,
  arbitrum_min_cursor INTEGER,
  arbitrum_min_safe_head INTEGER,
  arbitrum_expected_config_count INTEGER NOT NULL DEFAULT 0,
  arbitrum_at_safe_head_count INTEGER NOT NULL DEFAULT 0,
  verification_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS blacklist_sync_state (
  config_key TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL DEFAULT 0
, cursor_kind TEXT NOT NULL DEFAULT 'evm_block', cursor_value INTEGER, attempt_generation INTEGER NOT NULL DEFAULT 0, last_attempted_at INTEGER, last_succeeded_at INTEGER, last_skipped_at INTEGER, last_failed_at INTEGER, consecutive_skips INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, last_observed_safe_head INTEGER, last_safe_head_observed_at INTEGER);

CREATE TABLE IF NOT EXISTS block_timestamp_cache (
  chain_id TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_supply_history (
  chain_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,
  total_usd REAL NOT NULL,
  stablecoin_count INTEGER NOT NULL,
  PRIMARY KEY (chain_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS cron_leases (
  job TEXT PRIMARY KEY,
  lease_owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_run_progress (
  job TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stage TEXT,
  items_done INTEGER,
  items_total INTEGER,
  message TEXT,
  lease_owner TEXT,
  metadata TEXT
, slot_started_at INTEGER);

CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  item_count INTEGER,
  metadata TEXT
, slot_started_at INTEGER, idempotency_key TEXT, schedule_key TEXT, producer_path TEXT, producer_kind TEXT, invocation_id TEXT, worker_version TEXT, productive INTEGER NOT NULL DEFAULT 0, publication_count INTEGER NOT NULL DEFAULT 0, calendar_period TEXT);

CREATE TABLE IF NOT EXISTS cron_slot_executions (
  slot_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  result_status TEXT,
  execution_owner TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  metadata TEXT, execution_generation INTEGER NOT NULL DEFAULT 0, invocation_id TEXT, worker_version TEXT,
  PRIMARY KEY (slot_key, slot_started_at)
);

CREATE TABLE IF NOT EXISTS d1_capacity_observations (
  observed_hour INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  database_size_bytes INTEGER NOT NULL CHECK (database_size_bytes >= 0),
  maximum_size_bytes INTEGER NOT NULL CHECK (maximum_size_bytes > 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_digest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at INTEGER NOT NULL,
  digest_text TEXT NOT NULL,
  input_data TEXT NOT NULL,
  digest_title TEXT,
  digest_extended TEXT,
  digest_meta TEXT
);

CREATE TABLE IF NOT EXISTS depeg_backfill_runs (
  run_id TEXT PRIMARY KEY,
  stablecoin_id TEXT NOT NULL,
  start_day INTEGER,
  end_day INTEGER,
  context_days INTEGER,
  source_type TEXT NOT NULL,
  expected_event_count INTEGER NOT NULL DEFAULT 0,
  expected_fingerprint TEXT NOT NULL,
  removed_count INTEGER NOT NULL DEFAULT 0,
  added_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS depeg_event_provenance (
  event_id INTEGER PRIMARY KEY,
  source_kind TEXT NOT NULL,
  replay_run_id TEXT,
  replay_version TEXT,
  source_price_providers TEXT,
  quote_mode TEXT,
  peg_reference_source TEXT,
  supply_source TEXT,
  confirmation_policy TEXT,
  confirmation_point_count INTEGER,
  market_diagnostics_json TEXT,
  policy_adjustments_json TEXT,
  confidence_tier TEXT,
  audit_verdict TEXT,
  public_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES depeg_events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS depeg_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,              -- "above" | "below"
  peak_deviation_bps INTEGER NOT NULL,
  started_at INTEGER NOT NULL,          -- unix seconds
  ended_at INTEGER,                     -- NULL = ongoing
  start_price REAL NOT NULL,
  peak_price REAL,
  recovery_price REAL,
  peg_reference REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'live'   -- "live" | "backfill"
, confirmation_sources TEXT, pending_reason TEXT, close_reason TEXT, recovery_first_seen_at INTEGER);

CREATE TABLE IF NOT EXISTS depeg_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  first_seen_bps INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_price REAL NOT NULL,
  peg_reference REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT 'large-cap'
, last_seen_bps INTEGER, last_seen_at INTEGER, last_price REAL, peak_seen_bps INTEGER, peak_price REAL, updated_at INTEGER);

CREATE TABLE IF NOT EXISTS depeg_pending_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_id INTEGER,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  reason TEXT NOT NULL,
  first_seen_bps INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_price REAL NOT NULL,
  last_seen_bps INTEGER,
  last_seen_at INTEGER,
  last_price REAL,
  peak_seen_bps INTEGER,
  peak_price REAL,
  peg_reference REAL NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('promoted', 'rejected', 'expired', 'recovered', 'superseded', 'unconfirmed-severe')),
  outcome_at INTEGER NOT NULL,
  confirming_sources TEXT,
  opposing_sources TEXT,
  unavailable_sources TEXT,
  circuit_open_sources TEXT,
  final_decision_reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS depeg_resolver_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  peg_currency TEXT NOT NULL,
  governance TEXT NOT NULL,
  direction TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  assessed_at INTEGER NOT NULL,
  event_age_sec INTEGER NOT NULL,
  checkpoint TEXT NOT NULL,
  methodology_version TEXT NOT NULL,
  methodology_version_label TEXT NOT NULL,
  resolution_rubric_version TEXT NOT NULL,
  duration_model_version TEXT NOT NULL,
  incident_grouping_version TEXT NOT NULL,
  support_rules_version TEXT NOT NULL,
  resolution_tier TEXT NOT NULL,
  duration_suppressed INTEGER NOT NULL,
  duration_suppressed_reason TEXT,
  median_remaining_sec INTEGER,
  iqr_low_remaining_sec INTEGER,
  iqr_high_remaining_sec INTEGER,
  stratum TEXT,
  horizons_json TEXT NOT NULL,
  factors_json TEXT NOT NULL,
  row_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(event_id, checkpoint, methodology_version)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_event_repair_authorization_consumptions (
  authorization_id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL,
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  operation TEXT NOT NULL CHECK (
    operation IN (
      'identity_update',
      'delete',
      'incident_link',
      'incident_current_update',
      'provenance_invalidation'
    )
  ),
  consumed_at INTEGER NOT NULL CHECK (consumed_at > 0),
  consumer TEXT NOT NULL CHECK (length(trim(consumer)) > 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_event_repair_authorization_uses (
  authorization_id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL,
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  operation TEXT NOT NULL CHECK (
    operation IN (
      'identity_update',
      'delete',
      'incident_link',
      'incident_current_update',
      'provenance_invalidation'
    )
  ),
  used_at INTEGER NOT NULL CHECK (used_at > 0),
  target_table TEXT NOT NULL CHECK (length(trim(target_table)) > 0),
  target_key TEXT NOT NULL CHECK (length(trim(target_key)) > 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_event_repair_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  operation TEXT NOT NULL CHECK (
    operation IN (
      'identity_update',
      'delete',
      'incident_link',
      'incident_current_update',
      'provenance_invalidation'
    )
  ),
  columns_json TEXT NOT NULL CHECK (json_valid(columns_json)),
  required_revision_id INTEGER,
  required_erratum_id INTEGER,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  CHECK (expires_at >= created_at)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_incident_event_links (
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('observed', 'superseded', 'merged', 'split_from', 'repair_replacement')),
  repair_authorization_id INTEGER,
  linked_at INTEGER NOT NULL CHECK (linked_at > 0),
  note TEXT,
  PRIMARY KEY (incident_key, event_id)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_incident_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_incident_key TEXT NOT NULL CHECK (length(trim(from_incident_key)) > 0),
  to_incident_key TEXT NOT NULL CHECK (length(trim(to_incident_key)) > 0),
  relation TEXT NOT NULL CHECK (relation IN ('merged_into', 'superseded_by', 'split_from')),
  repair_authorization_id INTEGER NOT NULL,
  erratum_id INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  CHECK (from_incident_key != to_incident_key)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_incident_policy_membership (
  incident_key TEXT PRIMARY KEY CHECK (length(trim(incident_key)) > 0),
  stablecoin_id TEXT NOT NULL CHECK (length(trim(stablecoin_id)) > 0),
  prediction_policy_version TEXT NOT NULL CHECK (length(trim(prediction_policy_version)) > 0),
  public_tracked_at_first_seen INTEGER NOT NULL CHECK (public_tracked_at_first_seen IN (0, 1)),
  psi_shadow_at_first_seen INTEGER NOT NULL CHECK (psi_shadow_at_first_seen IN (0, 1)),
  rollout_active_at_enablement INTEGER NOT NULL CHECK (rollout_active_at_enablement IN (0, 1)),
  policy_universe_included INTEGER NOT NULL CHECK (policy_universe_included IN (0, 1)),
  policy_universe_reason TEXT NOT NULL CHECK (
    policy_universe_reason IN (
      'post_effective_public_tracked',
      'rollout_active_public_tracked',
      'psi_shadow_excluded',
      'not_public_tracked'
    )
  ),
  registry_snapshot_json TEXT NOT NULL CHECK (json_valid(registry_snapshot_json)),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_incident_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  previous_event_id INTEGER,
  current_event_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  repair_authorization_id INTEGER,
  erratum_id INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_incidents (
  incident_key TEXT PRIMARY KEY CHECK (incident_key LIKE 'ddr2:%' AND length(incident_key) = 37),
  stablecoin_id TEXT NOT NULL CHECK (length(trim(stablecoin_id)) > 0),
  peg_currency TEXT NOT NULL CHECK (length(trim(peg_currency)) > 0),
  direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  first_event_id INTEGER NOT NULL,
  current_event_id INTEGER NOT NULL,
  first_started_at INTEGER NOT NULL,
  current_started_at INTEGER NOT NULL,
  first_observed_peak_bucket_bps INTEGER NOT NULL CHECK (first_observed_peak_bucket_bps >= 0),
  incident_state TEXT NOT NULL DEFAULT 'active' CHECK (incident_state IN ('active', 'merged', 'superseded', 'split_source')),
  superseded_by_incident_key TEXT,
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (superseded_by_incident_key IS NULL OR superseded_by_incident_key != incident_key)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_lock_opportunity_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL,
  run_id TEXT,
  run_at INTEGER NOT NULL CHECK (run_at > 0),
  eligible_at INTEGER NOT NULL,
  health_status TEXT NOT NULL CHECK (health_status IN ('healthy', 'degraded', 'skipped')),
  action TEXT NOT NULL CHECK (
    action IN (
      'pending',
      'deferred',
      'confirmed_seen',
      'locked_prediction',
      'locked_no_call',
      'publication_retry_pending',
      'publication_failed',
      'published'
    )
  ),
  confirmation_at INTEGER,
  outcome_at INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL CHECK (created_at > 0)
, lock_trigger TEXT CHECK (
  lock_trigger IS NULL OR lock_trigger IN ('scheduled_24h', 'forecast_readiness', 'readiness_backstop')
), forecast_readiness_score REAL CHECK (
  forecast_readiness_score IS NULL OR (forecast_readiness_score >= 0 AND forecast_readiness_score <= 1)
), forecast_readiness_version TEXT CHECK (
  forecast_readiness_version IS NULL OR length(trim(forecast_readiness_version)) > 0
), readiness_threshold REAL CHECK (
  readiness_threshold IS NULL OR (readiness_threshold >= 0 AND readiness_threshold <= 1)
), backstop_at INTEGER CHECK (
  backstop_at IS NULL OR backstop_at > 0
), backstop_delay_sec INTEGER CHECK (
  backstop_delay_sec IS NULL OR backstop_delay_sec >= 0
));

CREATE TABLE IF NOT EXISTS depeg_resolver_prediction_errata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_prediction_id INTEGER NOT NULL CHECK (public_prediction_id > 0),
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL CHECK (event_id > 0),
  assessment_id INTEGER NOT NULL CHECK (assessment_id > 0),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'false_positive',
      'disputed',
      'no_data',
      'event_identity_error',
      'input_corruption',
      'lifecycle_status_error',
      'implementation_bug',
      'hash_mismatch'
    )
  ),
  operator_note TEXT NOT NULL CHECK (length(trim(operator_note)) > 0),
  replacement_assessment_id INTEGER,
  replacement_row_hash TEXT CHECK (
    replacement_row_hash IS NULL OR (length(replacement_row_hash) = 64 AND replacement_row_hash NOT GLOB '*[^0-9a-f]*')
  ),
  row_hash_before TEXT CHECK (
    row_hash_before IS NULL OR (length(row_hash_before) = 64 AND row_hash_before NOT GLOB '*[^0-9a-f]*')
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_prediction_lock_state (
  incident_key TEXT PRIMARY KEY CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL,
  prediction_policy_version TEXT NOT NULL CHECK (length(trim(prediction_policy_version)) > 0),
  eligible_at INTEGER NOT NULL,
  first_eligible_seen_at INTEGER,
  last_attempted_at INTEGER,
  deferral_count INTEGER NOT NULL DEFAULT 0,
  last_deferral_reason TEXT,
  last_state TEXT NOT NULL CHECK (
    last_state IN (
      'pending_lock',
      'lock_deferred',
      'frozen',
      'no_call',
      'publication_retry_pending',
      'publication_failed',
      'published'
    )
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at), lock_trigger TEXT CHECK (
  lock_trigger IS NULL OR lock_trigger IN ('scheduled_24h', 'forecast_readiness', 'readiness_backstop')
), forecast_readiness_score REAL CHECK (
  forecast_readiness_score IS NULL OR (forecast_readiness_score >= 0 AND forecast_readiness_score <= 1)
), forecast_readiness_version TEXT CHECK (
  forecast_readiness_version IS NULL OR length(trim(forecast_readiness_version)) > 0
), readiness_threshold REAL CHECK (
  readiness_threshold IS NULL OR (readiness_threshold >= 0 AND readiness_threshold <= 1)
), backstop_at INTEGER CHECK (
  backstop_at IS NULL OR backstop_at > 0
), backstop_delay_sec INTEGER CHECK (
  backstop_delay_sec IS NULL OR backstop_delay_sec >= 0
),
  CHECK (deferral_count >= 0),
  CHECK (first_eligible_seen_at IS NULL OR first_eligible_seen_at >= eligible_at),
  CHECK (last_attempted_at IS NULL OR last_attempted_at >= eligible_at)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_public_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_key TEXT NOT NULL UNIQUE CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL,
  assessment_id INTEGER NOT NULL UNIQUE,
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('prediction', 'no_call')),
  prediction_policy_version TEXT NOT NULL CHECK (length(trim(prediction_policy_version)) > 0),
  prediction_methodology_version TEXT NOT NULL CHECK (length(trim(prediction_methodology_version)) > 0),
  prediction_methodology_version_label TEXT NOT NULL CHECK (length(trim(prediction_methodology_version_label)) > 0),
  resolution_rubric_version TEXT NOT NULL CHECK (length(trim(resolution_rubric_version)) > 0),
  duration_model_version TEXT NOT NULL CHECK (length(trim(duration_model_version)) > 0),
  incident_grouping_version TEXT NOT NULL CHECK (length(trim(incident_grouping_version)) > 0),
  support_rules_version TEXT NOT NULL CHECK (length(trim(support_rules_version)) > 0),
  policy_delay_sec INTEGER NOT NULL CHECK (policy_delay_sec > 0),
  eligible_at INTEGER NOT NULL,
  locked_at INTEGER NOT NULL,
  event_age_at_lock_sec INTEGER NOT NULL,
  lock_timing TEXT NOT NULL CHECK (lock_timing IN ('on_time', 'late_confirmation', 'late_freeze', 'deferred')),
  sealed_payload_json TEXT NOT NULL CHECK (json_valid(sealed_payload_json)),
  row_hash TEXT NOT NULL CHECK (length(row_hash) = 64 AND row_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (created_at > 0), lock_trigger TEXT CHECK (
  lock_trigger IS NULL OR lock_trigger IN ('scheduled_24h', 'forecast_readiness', 'readiness_backstop')
), forecast_readiness_score REAL CHECK (
  forecast_readiness_score IS NULL OR (forecast_readiness_score >= 0 AND forecast_readiness_score <= 1)
), forecast_readiness_version TEXT CHECK (
  forecast_readiness_version IS NULL OR length(trim(forecast_readiness_version)) > 0
), readiness_threshold REAL CHECK (
  readiness_threshold IS NULL OR (readiness_threshold >= 0 AND readiness_threshold <= 1)
), backstop_at INTEGER CHECK (
  backstop_at IS NULL OR backstop_at > 0
), backstop_delay_sec INTEGER CHECK (
  backstop_delay_sec IS NULL OR backstop_delay_sec >= 0
),
  CHECK (locked_at >= eligible_at),
  CHECK (event_age_at_lock_sec >= 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshot_errata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_token TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN (
      'payload_hash_mismatch',
      'row_set_mismatch',
      'row_hash_mismatch',
      'schema_invalid',
      'operator_invalidation'
    )
  ),
  superseded_by_snapshot_token TEXT,
  operator_note TEXT NOT NULL CHECK (length(trim(operator_note)) > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshot_finalizations (
  snapshot_token TEXT PRIMARY KEY,
  finalized_at INTEGER NOT NULL CHECK (finalized_at > 0),
  validator_version TEXT NOT NULL CHECK (length(trim(validator_version)) > 0),
  validated_base_payload_hash TEXT NOT NULL CHECK (length(validated_base_payload_hash) = 64 AND validated_base_payload_hash NOT GLOB '*[^0-9a-f]*'),
  validated_public_prediction_ids_hash TEXT NOT NULL CHECK (length(validated_public_prediction_ids_hash) = 64 AND validated_public_prediction_ids_hash NOT GLOB '*[^0-9a-f]*'),
  validated_public_prediction_row_hashes_json TEXT NOT NULL CHECK (json_valid(validated_public_prediction_row_hashes_json)),
  validated_base_row_count INTEGER NOT NULL CHECK (validated_base_row_count >= 0),
  validated_public_prediction_count INTEGER NOT NULL CHECK (validated_public_prediction_count >= 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshot_rows (
  snapshot_token TEXT NOT NULL,
  public_prediction_id INTEGER NOT NULL,
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  first_published INTEGER NOT NULL CHECK (first_published IN (0, 1)),
  PRIMARY KEY (snapshot_token, public_prediction_id)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshots (
  snapshot_token TEXT PRIMARY KEY CHECK (length(trim(snapshot_token)) > 0),
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('ddr_public')),
  snapshot_sequence INTEGER NOT NULL,
  snapshot_generation INTEGER NOT NULL,
  published_at INTEGER NOT NULL CHECK (published_at > 0),
  base_payload_hash TEXT NOT NULL CHECK (length(base_payload_hash) = 64 AND base_payload_hash NOT GLOB '*[^0-9a-f]*'),
  public_prediction_ids_hash TEXT NOT NULL CHECK (length(public_prediction_ids_hash) = 64 AND public_prediction_ids_hash NOT GLOB '*[^0-9a-f]*'),
  public_prediction_ids_json TEXT NOT NULL CHECK (json_valid(public_prediction_ids_json)),
  public_prediction_row_hashes_json TEXT NOT NULL CHECK (json_valid(public_prediction_row_hashes_json)),
  base_payload_json TEXT NOT NULL CHECK (json_valid(base_payload_json)),
  base_row_count INTEGER NOT NULL CHECK (base_row_count >= 0),
  public_prediction_count INTEGER NOT NULL CHECK (public_prediction_count >= 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE TABLE IF NOT EXISTS detail_cache_write_generations (
  stablecoin_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  claim_owner TEXT NOT NULL,
  claimed_at_ms INTEGER NOT NULL,
  published_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dex_deployment_outcomes (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('observed_pools', 'verified_no_pools', 'provider_inaccessible')),
  provider_set_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  observed_pool_count INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL,
  waiver_owner TEXT,
  waiver_reason TEXT,
  waiver_expires_at INTEGER,
  PRIMARY KEY (stablecoin_id, chain, contract_address)
);

CREATE TABLE IF NOT EXISTS dex_discovery_meta (
  stablecoin_id TEXT PRIMARY KEY,
  consecutive_misses INTEGER NOT NULL DEFAULT 0,
  last_crawl_at INTEGER NOT NULL,
  last_hit_at INTEGER
);

CREATE TABLE IF NOT EXISTS dex_liquidity (
  stablecoin_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  total_tvl_usd REAL NOT NULL DEFAULT 0,
  total_volume_24h_usd REAL NOT NULL DEFAULT 0,
  total_volume_7d_usd REAL NOT NULL DEFAULT 0,
  pool_count INTEGER NOT NULL DEFAULT 0,
  pair_count INTEGER NOT NULL DEFAULT 0,
  chain_count INTEGER NOT NULL DEFAULT 0,
  protocol_tvl_json TEXT,
  chain_tvl_json TEXT,
  top_pools_json TEXT,
  liquidity_score INTEGER,
  updated_at INTEGER NOT NULL,
  concentration_hhi REAL,
  depth_stability REAL,
  avg_pool_stress REAL,
  weighted_balance_ratio REAL,
  organic_fraction REAL,
  effective_tvl_usd REAL NOT NULL DEFAULT 0,
  durability_score INTEGER,
  score_components_json TEXT,
  locked_liquidity_pct REAL,
  methodology_version TEXT NOT NULL DEFAULT '3.2',
  coverage_class TEXT NOT NULL DEFAULT 'unobserved',
  coverage_confidence REAL NOT NULL DEFAULT 0,
  source_mix_json TEXT,
  balance_measured_tvl_usd REAL NOT NULL DEFAULT 0,
  organic_measured_tvl_usd REAL NOT NULL DEFAULT 0
, publication_generation_id TEXT, publication_state TEXT);

CREATE TABLE IF NOT EXISTS dex_liquidity_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  total_tvl_usd REAL NOT NULL,
  total_volume_24h_usd REAL NOT NULL DEFAULT 0,
  liquidity_score INTEGER,
  snapshot_date INTEGER NOT NULL,  -- UTC midnight epoch seconds
  methodology_version TEXT NOT NULL DEFAULT '3.2',
  coverage_class TEXT NOT NULL DEFAULT 'unobserved',
  coverage_confidence REAL NOT NULL DEFAULT 0,
  source_mix_json TEXT
, exit_route_summary_json TEXT);

CREATE TABLE IF NOT EXISTS dex_liquidity_publication_generations (
  generation_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'published', 'failed')),
  expected_row_count INTEGER NOT NULL,
  written_row_count INTEGER NOT NULL DEFAULT 0,
  current_row_count INTEGER,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  failed_at INTEGER,
  failure_reason TEXT
);

CREATE TABLE IF NOT EXISTS dex_liquidity_run_rows (
  generation_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  total_tvl_usd REAL NOT NULL DEFAULT 0,
  total_volume_24h_usd REAL NOT NULL DEFAULT 0,
  total_volume_7d_usd REAL NOT NULL DEFAULT 0,
  pool_count INTEGER NOT NULL DEFAULT 0,
  pair_count INTEGER NOT NULL DEFAULT 0,
  chain_count INTEGER NOT NULL DEFAULT 0,
  protocol_tvl_json TEXT,
  chain_tvl_json TEXT,
  top_pools_json TEXT,
  liquidity_score INTEGER,
  concentration_hhi REAL,
  depth_stability REAL,
  avg_pool_stress REAL,
  weighted_balance_ratio REAL,
  organic_fraction REAL,
  effective_tvl_usd REAL NOT NULL DEFAULT 0,
  durability_score INTEGER,
  score_components_json TEXT,
  locked_liquidity_pct REAL,
  methodology_version TEXT NOT NULL DEFAULT '5.8',
  coverage_class TEXT NOT NULL DEFAULT 'unobserved',
  coverage_confidence REAL NOT NULL DEFAULT 0,
  source_mix_json TEXT,
  balance_measured_tvl_usd REAL NOT NULL DEFAULT 0,
  organic_measured_tvl_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (generation_id, stablecoin_id),
  FOREIGN KEY (generation_id) REFERENCES dex_liquidity_publication_generations(generation_id)
);

CREATE TABLE IF NOT EXISTS dex_liquidity_scoring_stage_chunks (
  generation_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0 AND payload_bytes <= 196608),
  record_count INTEGER NOT NULL CHECK (record_count > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (generation_id, chunk_index),
  FOREIGN KEY (generation_id)
    REFERENCES dex_liquidity_scoring_stages(generation_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dex_liquidity_scoring_stages (
  generation_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  state TEXT NOT NULL CHECK (state IN ('writing', 'ready', 'consumed', 'failed')),
  source_slot_started_at INTEGER NOT NULL CHECK (source_slot_started_at >= 0),
  sync_started_at INTEGER NOT NULL CHECK (sync_started_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  ready_at INTEGER,
  consumed_at INTEGER,
  expected_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_chunk_count >= 0),
  written_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (written_chunk_count >= 0),
  expected_record_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_record_count >= 0),
  payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
  failure_reason TEXT,
  UNIQUE (source_slot_started_at)
);

CREATE TABLE IF NOT EXISTS dex_measured_execution_quotes (
  generation_id TEXT NOT NULL,
  target_generation_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  adapter_profile_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  chain TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('measured', 'failed')),
  failure_reason TEXT,
  quoted_at INTEGER,
  block_number INTEGER,
  quote_profile_json TEXT,
  raw_quote_payload_json TEXT,
  PRIMARY KEY (generation_id, target_id)
);

CREATE TABLE IF NOT EXISTS dex_measured_execution_targets (
  generation_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  adapter_profile_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  chain TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  target_json TEXT NOT NULL,
  PRIMARY KEY (generation_id, target_id)
);

CREATE TABLE IF NOT EXISTS dex_pool_staging (
  pool_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  source TEXT NOT NULL,
  chain TEXT NOT NULL,
  protocol TEXT NOT NULL,
  symbol TEXT NOT NULL,
  tvl_usd REAL,
  volume_24h REAL,
  fee_tier REAL,
  balance_ratio REAL,
  is_stable INTEGER,
  base_token TEXT,
  quote_token TEXT,
  quote_symbol TEXT,
  price_usd REAL,
  locked_liq_pct REAL,
  raw_json TEXT,
  discovered_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  dex_id TEXT,
  quality_multiplier REAL,
  pool_type TEXT,
  PRIMARY KEY (pool_id, stablecoin_id)
);

CREATE TABLE IF NOT EXISTS dex_price_challenger_snapshots (
  stablecoin_id TEXT PRIMARY KEY,
  snapshot_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  has_rows INTEGER NOT NULL CHECK (has_rows IN (0, 1)),
  source_coverage_complete INTEGER NOT NULL CHECK (source_coverage_complete IN (0, 1))
);

CREATE TABLE IF NOT EXISTS dex_price_challengers (
  stablecoin_id TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  pool_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  protocol TEXT NOT NULL,
  source_family TEXT NOT NULL,
  price_usd REAL NOT NULL,
  tvl_usd REAL NOT NULL,
  PRIMARY KEY (stablecoin_id, snapshot_at, pool_id)
);

CREATE TABLE IF NOT EXISTS dex_price_run_rows (
  generation_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  dex_price_usd REAL NOT NULL,
  source_pool_count INTEGER NOT NULL,
  source_total_tvl REAL NOT NULL,
  deviation_from_primary_bps INTEGER,
  primary_price_at_calc REAL,
  price_sources_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (generation_id, stablecoin_id)
);

CREATE TABLE IF NOT EXISTS dex_prices (
  stablecoin_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  dex_price_usd REAL NOT NULL,
  source_pool_count INTEGER NOT NULL,
  source_total_tvl REAL NOT NULL,
  deviation_from_primary_bps INTEGER,
  primary_price_at_calc REAL,
  price_sources_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dex_source_pagination_state (
  source_key TEXT PRIMARY KEY,
  cursor TEXT,
  cycle_started_at INTEGER,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS feedback_rate_limit (
  ip_hash TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mint_burn_config_deferral (
  config_key TEXT PRIMARY KEY,
  deferred_until INTEGER NOT NULL,
  reason TEXT NOT NULL,
  api_errors INTEGER NOT NULL DEFAULT 0,
  coverage REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mint_burn_events (
  id TEXT PRIMARY KEY,                 -- "{chainId}-{txHash}-{logIndex}"
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  direction TEXT NOT NULL,             -- "mint" or "burn"
  amount REAL NOT NULL,
  amount_usd REAL,
  counterparty TEXT,
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,          -- Unix seconds
  explorer_tx_url TEXT NOT NULL,
  price_used REAL,
  price_timestamp INTEGER,
  price_source TEXT,
  burn_type TEXT,
  burn_review_reason TEXT,
  flow_type TEXT DEFAULT 'standard'
, price_repair_status TEXT
  CHECK (price_repair_status IN ('pending_aggregate', 'recovered', 'irreducible')), price_repair_reason TEXT, price_repair_attempted_at INTEGER, price_repair_run_id TEXT, price_repair_bookmark TEXT);

CREATE TABLE IF NOT EXISTS mint_burn_hourly (
  stablecoin_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,            -- Unix seconds, truncated to hour boundary
  mint_count INTEGER NOT NULL DEFAULT 0,
  burn_count INTEGER NOT NULL DEFAULT 0,
  mint_volume_usd REAL NOT NULL DEFAULT 0,
  burn_volume_usd REAL NOT NULL DEFAULT 0,
  net_flow_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (stablecoin_id, chain_id, hour_ts)
);

CREATE TABLE IF NOT EXISTS mint_burn_run_state (
  job TEXT PRIMARY KEY,
  next_config_index INTEGER NOT NULL DEFAULT 0,
  degraded_streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
, last_config_key TEXT);

CREATE TABLE IF NOT EXISTS mint_burn_sync_state (
  config_key TEXT PRIMARY KEY,         -- "{chainId}-{contractAddress}"
  last_block INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS onchain_supply (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  supply REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, chain)
);

CREATE TABLE IF NOT EXISTS price_cache (
  asset_id TEXT PRIMARY KEY,
  price REAL NOT NULL,
  updated_at INTEGER NOT NULL
, source TEXT, confidence TEXT, observed_at INTEGER, synced_at INTEGER, agree_sources_json TEXT, consensus_sources_json TEXT, observed_at_mode TEXT);

CREATE TABLE IF NOT EXISTS pricing_provider_negative_cache (
  provider_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  status INTEGER NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, target_key)
);

CREATE TABLE IF NOT EXISTS pricing_provider_runtime_state (
  provider_id TEXT PRIMARY KEY,
  availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'blocked')),
  blocked_status INTEGER,
  blocked_at INTEGER,
  next_probe_at INTEGER,
  last_probe_at INTEGER,
  consecutive_blocked INTEGER NOT NULL DEFAULT 0,
  target_cursor INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public_snapshots (
  snapshot_date TEXT PRIMARY KEY,        -- ISO 8601 UTC, e.g. "2026-05-16"
  payload_gz BLOB NOT NULL,              -- gzipped JSON payload (CompressionStream)
  methodology_versions TEXT NOT NULL,    -- JSON map of methodology version strings (small)
  content_hash TEXT NOT NULL,            -- sha256 hex of the uncompressed JSON
  byte_size INTEGER NOT NULL,            -- size of the uncompressed JSON in bytes
  created_at INTEGER NOT NULL            -- epoch seconds when the row was written
);

CREATE TABLE IF NOT EXISTS redemption_backstop (
  stablecoin_id TEXT PRIMARY KEY,
  score REAL,
  effective_exit_score REAL,
  dex_liquidity_score REAL,
  access_score REAL,
  settlement_score REAL,
  execution_certainty_score REAL,
  capacity_score REAL,
  output_asset_quality_score REAL,
  cost_score REAL,
  route_family TEXT NOT NULL,
  access_model TEXT NOT NULL,
  settlement_model TEXT NOT NULL,
  execution_model TEXT NOT NULL,
  output_asset_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  immediate_capacity_usd REAL,
  immediate_capacity_ratio REAL,
  fee_bps REAL,
  queue_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  methodology_version TEXT NOT NULL,
  details_json TEXT
, snapshot_run_id TEXT);

CREATE TABLE IF NOT EXISTS redemption_backstop_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,
  score REAL,
  effective_exit_score REAL,
  dex_liquidity_score REAL,
  updated_at INTEGER NOT NULL,
  methodology_version TEXT NOT NULL,
  details_json TEXT, snapshot_run_id TEXT,
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS redemption_backstop_run_rows (
  snapshot_run_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  score REAL,
  effective_exit_score REAL,
  dex_liquidity_score REAL,
  access_score REAL,
  settlement_score REAL,
  execution_certainty_score REAL,
  capacity_score REAL,
  output_asset_quality_score REAL,
  cost_score REAL,
  route_family TEXT NOT NULL,
  access_model TEXT NOT NULL,
  settlement_model TEXT NOT NULL,
  execution_model TEXT NOT NULL,
  output_asset_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  immediate_capacity_usd REAL,
  immediate_capacity_ratio REAL,
  fee_bps REAL,
  queue_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  methodology_version TEXT NOT NULL,
  details_json TEXT,
  PRIMARY KEY (snapshot_run_id, stablecoin_id)
);

CREATE TABLE IF NOT EXISTS redemption_backstop_runs (
  run_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  expected_count INTEGER NOT NULL,
  written_count INTEGER NOT NULL DEFAULT 0,
  methodology_version TEXT NOT NULL,
  min_updated_at INTEGER,
  max_updated_at INTEGER,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS report_card_evidence_journal (
  journal_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  lane TEXT NOT NULL CHECK (lane = 'reserve'),
  asset_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL CHECK (attempted_at >= 0),
  completed_at INTEGER NOT NULL CHECK (completed_at >= attempted_at),
  source_id TEXT NOT NULL,
  attempt_code TEXT NOT NULL CHECK (attempt_code IN (
    'reserve.collector.attempted',
    'reserve.collector.not-configured',
    'reserve.collector.deferred'
  )),
  admission_code TEXT NOT NULL CHECK (admission_code IN (
    'reserve.admission.accepted',
    'reserve.admission.not-evaluated',
    'reserve.admission.rejected-upstream',
    'reserve.admission.rejected-timeout',
    'reserve.admission.rejected-invalid-payload',
    'reserve.admission.rejected-schema-drift',
    'reserve.admission.rejected-stale',
    'reserve.admission.rejected-reconciliation',
    'reserve.admission.rejected-sidecar-mismatch'
  )),
  fallback_code TEXT NOT NULL CHECK (fallback_code IN (
    'reserve.fallback.not-used',
    'reserve.fallback.curated',
    'reserve.fallback.reviewed-sidecar',
    'reserve.fallback.last-known-good',
    'reserve.fallback.unavailable'
  )),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0 AND payload_bytes <= 1280),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= completed_at),
  UNIQUE (lane, asset_id, attempt_id)
);

CREATE TABLE IF NOT EXISTS reserve_composition (
  stablecoin_id TEXT NOT NULL PRIMARY KEY,
  slices TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  warning_count INTEGER NOT NULL DEFAULT 0,
  warnings TEXT,
  adapter_source_model TEXT,
  adapter_evidence_class TEXT
, attempt_id TEXT);

CREATE TABLE IF NOT EXISTS reserve_composition_history (
  id INTEGER PRIMARY KEY,
  stablecoin_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  adapter_key TEXT NOT NULL,
  slices TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  warnings TEXT,
  warning_count INTEGER NOT NULL DEFAULT 0,
  adapter_source_model TEXT,
  adapter_evidence_class TEXT
, attempt_id TEXT);

CREATE TABLE IF NOT EXISTS reserve_sync_attempt_history (
  id INTEGER PRIMARY KEY,
  stablecoin_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  adapter_key TEXT NOT NULL,
  breaker_key TEXT NOT NULL,
  status TEXT NOT NULL,
  warnings TEXT,
  warning_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
, attempt_id TEXT);

CREATE TABLE IF NOT EXISTS reserve_sync_state (
  stablecoin_id TEXT NOT NULL PRIMARY KEY,
  adapter_key TEXT NOT NULL,
  breaker_key TEXT NOT NULL,
  last_attempted_at INTEGER,
  last_success_at INTEGER,
  last_status TEXT NOT NULL,  -- ok | degraded | error | skipped
  warning_count INTEGER NOT NULL DEFAULT 0,
  warnings TEXT,
  last_error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
, last_attempt_id TEXT, pending_attempt_id TEXT, last_success_attempt_id TEXT);

CREATE TABLE IF NOT EXISTS safety_grade_history (
  stablecoin_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  grade TEXT NOT NULL,
  score REAL,
  prev_grade TEXT,
  prev_score REAL,
  methodology_version TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, recorded_at),
  CHECK (grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  CHECK (prev_grade IS NULL OR prev_grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  CHECK (prev_score IS NULL OR (prev_score >= 0 AND prev_score <= 100))
);

CREATE TABLE IF NOT EXISTS safety_score_history_v2 (
  history_id TEXT PRIMARY KEY NOT NULL CHECK (length(history_id) > 0),
  stablecoin_id TEXT NOT NULL CHECK (length(stablecoin_id) > 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  model TEXT NOT NULL CHECK (model IN ('v8', 'v9')),
  methodology_version TEXT NOT NULL CHECK (length(methodology_version) > 0),
  policy_id TEXT CHECK (policy_id IS NULL OR length(policy_id) > 0),
  policy_digest TEXT CHECK (policy_digest IS NULL OR length(policy_digest) = 64),
  evaluation_build_digest TEXT NOT NULL CHECK (length(evaluation_build_digest) = 64),
  base_input_generation_id TEXT NOT NULL CHECK (
    base_input_generation_id GLOB 'report-cards-input:v1:*'
    AND length(base_input_generation_id) = 86
  ),
  model_publication_generation_id TEXT NOT NULL CHECK (length(model_publication_generation_id) > 0),
  transition_kind TEXT NOT NULL CHECK (
    transition_kind IN (
      'initial-baseline',
      'organic-grade-change',
      'methodology-boundary-baseline',
      'rollback-baseline',
      'restoration-baseline'
    )
  ),
  grade TEXT NOT NULL CHECK (grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  prev_grade TEXT CHECK (
    prev_grade IS NULL OR prev_grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')
  ),
  prev_score REAL CHECK (prev_score IS NULL OR (prev_score >= 0 AND prev_score <= 100)),
  legacy_recorded_at INTEGER CHECK (legacy_recorded_at IS NULL OR legacy_recorded_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0), identity_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (identity_schema_version = 1),
  CHECK (
    (model = 'v8' AND policy_id IS NULL AND policy_digest IS NULL)
    OR
    (model = 'v9' AND policy_id IS NOT NULL AND policy_digest IS NOT NULL)
  ),
  CHECK (
    (transition_kind = 'organic-grade-change' AND prev_grade IS NOT NULL)
    OR
    (transition_kind != 'organic-grade-change' AND prev_grade IS NULL AND prev_score IS NULL)
  ),
  CHECK (legacy_recorded_at IS NULL OR legacy_recorded_at = recorded_at),
  CHECK (
    legacy_recorded_at IS NULL
    OR transition_kind IN ('initial-baseline', 'organic-grade-change')
  )
);

CREATE TABLE IF NOT EXISTS safety_score_v9_supply_attribution_journal (
  journal_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  lane TEXT NOT NULL CHECK (lane = 'supply-attribution'),
  asset_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL CHECK (attempted_at >= 0),
  completed_at INTEGER NOT NULL CHECK (completed_at >= attempted_at),
  source_id TEXT NOT NULL,
  admission_code TEXT NOT NULL CHECK (admission_code IN (
    'supply-attribution.admission.accepted',
    'supply-attribution.admission.rejected-upstream',
    'supply-attribution.admission.rejected-invalid-payload',
    'supply-attribution.admission.rejected-identity-drift',
    'supply-attribution.admission.rejected-route-inventory',
    'supply-attribution.admission.rejected-stale',
    'supply-attribution.admission.rejected-skew',
    'supply-attribution.admission.rejected-reconciliation'
  )),
  fallback_code TEXT NOT NULL CHECK (fallback_code IN (
    'supply-attribution.fallback.not-used',
    'supply-attribution.fallback.aggregate-only'
  )),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0 AND payload_bytes <= 1280),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= completed_at),
  UNIQUE (lane, asset_id, attempt_id)
);

CREATE TABLE IF NOT EXISTS selector_snapshot_daily_quota (
  quota_date TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (quota_date, ip_hash)
);

CREATE TABLE IF NOT EXISTS site_data_request_stats (
  bucket_start INTEGER NOT NULL,
  route_key TEXT NOT NULL,
  route_path TEXT NOT NULL,
  delivery_path TEXT NOT NULL CHECK (delivery_path IN (
    'pages-cache-hit',
    'pages-upstream-fetch',
    'pages-upstream-timeout',
    'pages-upstream-error'
  )),
  upstream_lane TEXT NOT NULL DEFAULT ''
    CHECK (upstream_lane IN ('', 'site-api', 'public-api-fallback')),
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, route_key, delivery_path, upstream_lane)
);

CREATE TABLE IF NOT EXISTS stability_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at INTEGER NOT NULL,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  components TEXT NOT NULL,
  input_snapshot TEXT NOT NULL,
  methodology_version TEXT NOT NULL DEFAULT '3.0'
);

CREATE TABLE IF NOT EXISTS stability_index_samples (
  stored_at INTEGER PRIMARY KEY,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  components TEXT NOT NULL,
  input_snapshot TEXT NOT NULL,
  methodology_version TEXT NOT NULL DEFAULT '3.0'
);

CREATE TABLE IF NOT EXISTS status_discrepancy_state (
  scope TEXT PRIMARY KEY,
  consecutive_divergent INTEGER NOT NULL DEFAULT 0,
  last_divergent_at INTEGER,
  last_alert_at INTEGER,
  updated_at INTEGER NOT NULL,
  consecutive_probe_failures INTEGER NOT NULL DEFAULT 0,
  last_probe_failure_at INTEGER,
  last_probe_alert_at INTEGER
);

CREATE TABLE IF NOT EXISTS status_probe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_count INTEGER NOT NULL,
  pass_count INTEGER NOT NULL,
  fail_count INTEGER NOT NULL,
  p95_latency_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'stale')),
  details_json TEXT,
  created_at INTEGER NOT NULL
, idempotency_key TEXT);

CREATE TABLE IF NOT EXISTS status_state (
  scope TEXT PRIMARY KEY,
  current_status TEXT NOT NULL CHECK (current_status IN ('healthy', 'degraded', 'stale')),
  raw_status TEXT NOT NULL CHECK (raw_status IN ('healthy', 'degraded', 'stale')),
  last_evaluated_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  consecutive_healthy INTEGER NOT NULL DEFAULT 0,
  consecutive_degraded INTEGER NOT NULL DEFAULT 0,
  consecutive_stale INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1,
  causes_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  previous_status TEXT CHECK (previous_status IN ('healthy', 'degraded', 'stale')),
  next_status TEXT NOT NULL CHECK (next_status IN ('healthy', 'degraded', 'stale')),
  raw_status TEXT NOT NULL CHECK (raw_status IN ('healthy', 'degraded', 'stale')),
  transition_type TEXT NOT NULL CHECK (transition_type IN ('degrade', 'recover', 'init')),
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  causes_json TEXT,
  created_at INTEGER NOT NULL
, idempotency_key TEXT);

CREATE TABLE IF NOT EXISTS stress_signal_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,    -- UTC midnight epoch seconds
  score REAL NOT NULL,
  band TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS stress_signals (
  stablecoin_id TEXT NOT NULL,
  computed_at INTEGER NOT NULL,    -- Unix seconds
  score REAL NOT NULL,             -- Composite DEWS 0-100
  band TEXT NOT NULL,              -- CALM | WATCH | ALERT | WARNING | DANGER
  signals_json TEXT NOT NULL,      -- JSON: per-signal breakdown
  PRIMARY KEY (stablecoin_id, computed_at)
);

CREATE TABLE IF NOT EXISTS stress_signals_latest (
  stablecoin_id TEXT PRIMARY KEY,
  computed_at INTEGER NOT NULL,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS supply_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,  -- UTC midnight epoch seconds
  circulating_usd REAL NOT NULL,   -- total mcap in USD
  price REAL,                      -- USD price at snapshot time
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS surface_publication_generations (
  surface TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  validated_at INTEGER,
  published_at INTEGER,
  state TEXT NOT NULL CHECK (
    state IN (
      'candidate',
      'validated',
      'published',
      'rejected',
      'superseded',
      'failed'
    )
  ),
  candidate_rows INTEGER,
  published_rows INTEGER,
  expected_rows INTEGER,
  previous_generation_id TEXT,
  input_watermarks_json TEXT,
  dependency_snapshot_json TEXT,
  validation_summary_json TEXT,
  artifact_checksum TEXT,
  artifact_cache_key TEXT,
  failure_reason TEXT, producer_schedule_key TEXT, producer_job TEXT, producer_path TEXT, producer_kind TEXT, invocation_id TEXT, worker_version TEXT,
  PRIMARY KEY (surface, generation_id)
);

CREATE TABLE IF NOT EXISTS tape_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,            -- wire id: "${ts_ms}-${type}-${hash8}"
  type TEXT NOT NULL,                -- dot-namespaced slug
  severity TEXT NOT NULL,            -- info | notice | warning | severe | critical
  ts INTEGER NOT NULL,               -- epoch ms
  ends_at INTEGER,                   -- epoch ms; NULL when N/A
  coin_id TEXT,                      -- canonical ticker-issuer; NULL for cross-cutting events
  issuer_id TEXT,                    -- derived at projection
  peg_currency TEXT,
  chain TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  transition TEXT NOT NULL,          -- opened | updated | resolved | snapshot
  source_url TEXT,
  methodology_version TEXT,
  created_at INTEGER NOT NULL,       -- epoch sec
  CONSTRAINT tape_events_severity_chk
    CHECK (severity IN ('info','notice','warning','severe','critical'))
);

CREATE TABLE IF NOT EXISTS telegram_adoption_client_quota (
  bucket_start INTEGER NOT NULL,
  ip_hash TEXT NOT NULL CHECK (length(ip_hash) = 32),
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bucket_start, ip_hash)
);

CREATE TABLE IF NOT EXISTS telegram_adoption_daily (
  day TEXT NOT NULL CHECK (length(day) = 10),
  campaign TEXT NOT NULL CHECK (campaign IN ('landing', 'organic')),
  placement TEXT NOT NULL CHECK (
    placement IN ('hero', 'setup', 'miniapp_setup', 'miniapp_home', 'miniapp_watchlist', 'menu', 'unknown')
  ),
  stage TEXT NOT NULL CHECK (
    stage IN ('cta_click', 'bot_start', 'setup_complete', 'first_follow', 'mini_app_session', 'first_mutation')
  ),
  feature TEXT NOT NULL DEFAULT '' CHECK (
    feature IN ('', 'direct', 'preset', 'global', 'recommended_setup', 'coin', 'settings',
      'quiet_hours', 'snooze', 'timezone', 'unsubscribe', 'forget', 'other')
  ),
  latency_bucket TEXT NOT NULL DEFAULT '' CHECK (
    latency_bucket IN ('', 'lt_30s', '30s_2m', '2m_5m', 'gte_5m', 'unknown')
  ),
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'readonly', 'failure')),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day, campaign, placement, stage, feature, latency_bucket, outcome)
);

CREATE TABLE IF NOT EXISTS telegram_adoption_ingress_quota (
  bucket_start INTEGER PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_adoption_retention_daily (
  cohort_day TEXT NOT NULL CHECK (length(cohort_day) = 10),
  measurement_day TEXT NOT NULL CHECK (length(measurement_day) = 10),
  window_days INTEGER NOT NULL CHECK (window_days IN (7, 30)),
  feature TEXT NOT NULL CHECK (feature IN ('any', 'direct', 'preset', 'global')),
  cohort_size INTEGER NOT NULL CHECK (cohort_size >= 0),
  retained_count INTEGER NOT NULL CHECK (retained_count >= 0 AND retained_count <= cohort_size),
  measured_at INTEGER NOT NULL,
  quality TEXT NOT NULL CHECK (
    quality IN ('on_time_snapshot', 'catchup_current_state', 'pre_rollout_unavailable')
  ),
  PRIMARY KEY (measurement_day, window_days, feature)
);

CREATE TABLE IF NOT EXISTS telegram_alert_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_id INTEGER,
  chat_id TEXT NOT NULL,
  message_html TEXT NOT NULL,
  source_type TEXT,
  alert_type TEXT,
  priority INTEGER,
  created_at INTEGER NOT NULL,
  expired_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_class TEXT,
  reason TEXT NOT NULL,
  dedupe_key TEXT,
  chunk_index INTEGER
, source_event_id TEXT
  CHECK (source_event_id IS NULL OR length(source_event_id) <= 200), alert_scope_json TEXT
  CHECK (alert_scope_json IS NULL OR length(alert_scope_json) <= 65536), preference_generation INTEGER
  CHECK (preference_generation IS NULL OR preference_generation >= 0), markup_policy_json TEXT
  CHECK (markup_policy_json IS NULL OR length(markup_policy_json) <= 16384), dead_letter_key TEXT
  CHECK (dead_letter_key IS NULL OR length(dead_letter_key) <= 200), delivery_state TEXT
  CHECK (delivery_state IS NULL OR delivery_state IN ('pending', 'sending', 'sent', 'execution_unknown')), delivery_owner TEXT
  CHECK (delivery_owner IS NULL OR length(delivery_owner) <= 200), delivery_generation INTEGER
  CHECK (delivery_generation IS NULL OR delivery_generation >= 0), delivery_started_at INTEGER
  CHECK (delivery_started_at IS NULL OR delivery_started_at >= 0), delivery_completed_at INTEGER
  CHECK (delivery_completed_at IS NULL OR delivery_completed_at >= 0), delivery_claim_expires_at INTEGER
  CHECK (delivery_claim_expires_at IS NULL OR delivery_claim_expires_at >= 0));

CREATE TABLE IF NOT EXISTS telegram_alert_job_target_items (
  job_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, target_key, item_key)
);

CREATE TABLE IF NOT EXISTS telegram_alert_job_targets (
  job_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  alert_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'queued', 'sent', 'failed', 'expired')),
  pending_dedupe_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  enqueued_at INTEGER,
  failed_at INTEGER,
  error_class TEXT, effect_state TEXT NOT NULL DEFAULT 'unstarted'
    CHECK (effect_state IN ('unstarted', 'claimed', 'sending', 'complete', 'execution_unknown')), effect_owner TEXT, effect_generation INTEGER NOT NULL DEFAULT 0, effect_claimed_at INTEGER, effect_started_at INTEGER, effect_completed_at INTEGER, effect_claim_expires_at INTEGER, cancelled_at INTEGER, cancellation_reason TEXT
  CHECK (cancellation_reason IS NULL OR length(cancellation_reason) <= 80), source_event_id TEXT
  CHECK (source_event_id IS NULL OR length(source_event_id) <= 200), plan_generation INTEGER
  CHECK (plan_generation IS NULL OR plan_generation >= 0), plan_key TEXT
  CHECK (plan_key IS NULL OR length(plan_key) <= 200), plan_ordinal INTEGER, target_ordinal INTEGER, target_schema_version INTEGER
  CHECK (target_schema_version IS NULL OR target_schema_version = 1), message_html TEXT
  CHECK (message_html IS NULL OR length(message_html) <= 16384), disable_notification INTEGER
  CHECK (disable_notification IS NULL OR disable_notification IN (0, 1)), alert_scope_json TEXT
  CHECK (alert_scope_json IS NULL OR length(alert_scope_json) <= 65536), preference_generation INTEGER
  CHECK (preference_generation IS NULL OR preference_generation >= 0), markup_policy_json TEXT
  CHECK (markup_policy_json IS NULL OR length(markup_policy_json) <= 16384), target_expires_at INTEGER, final_delivery_state TEXT
  CHECK (final_delivery_state IS NULL OR final_delivery_state IN (
    'accepted', 'failed', 'cancelled', 'expired', 'execution_unknown'
  )), final_delivery_at INTEGER, final_delivery_error TEXT
  CHECK (final_delivery_error IS NULL OR length(final_delivery_error) <= 80),
  PRIMARY KEY (job_id, target_key)
);

CREATE TABLE IF NOT EXISTS telegram_alert_jobs (
  job_id TEXT PRIMARY KEY,
  alert_type TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered', 'queued', 'sent', 'degraded', 'expired')),
  target_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  enqueued_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_cursor TEXT,
  metadata TEXT
, planned_count INTEGER NOT NULL DEFAULT 0
  CHECK (planned_count >= 0), accepted_count INTEGER NOT NULL DEFAULT 0
  CHECK (accepted_count >= 0), cancelled_count INTEGER NOT NULL DEFAULT 0
  CHECK (cancelled_count >= 0), expired_count INTEGER NOT NULL DEFAULT 0
  CHECK (expired_count >= 0), execution_unknown_count INTEGER NOT NULL DEFAULT 0
  CHECK (execution_unknown_count >= 0));

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

CREATE TABLE IF NOT EXISTS telegram_alert_source_events (
  source_event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'resolving'
    CHECK (status IN ('resolving', 'planned', 'baseline_committed', 'complete', 'expired')),
  detected_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  event_payload TEXT NOT NULL,
  baseline_payload TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_error_class TEXT,
  baseline_committed_at INTEGER,
  completed_at INTEGER
, target_plan_state TEXT NOT NULL DEFAULT 'unstarted'
  CHECK (target_plan_state IN (
    'unstarted', 'capturing', 'planning', 'materializing', 'ready',
    'delivery_open', 'degraded', 'expired'
  )), target_plan_generation INTEGER NOT NULL DEFAULT 0
  CHECK (target_plan_generation >= 0), target_plan_owner TEXT
  CHECK (target_plan_owner IS NULL OR length(target_plan_owner) <= 200), target_plan_claim_expires_at INTEGER, target_plan_started_at INTEGER, target_plan_completed_at INTEGER, target_delivery_opened_at INTEGER, subscriber_horizon_at INTEGER, subscriber_high_water_chat_id TEXT, subscriber_cursor_chat_id TEXT, planning_cursor_chat_id TEXT, target_plan_count INTEGER NOT NULL DEFAULT 0
  CHECK (target_plan_count >= 0), target_materialized_count INTEGER NOT NULL DEFAULT 0
  CHECK (target_materialized_count >= 0));

CREATE TABLE IF NOT EXISTS telegram_alert_source_resolution_memberships (
  source_event_id TEXT NOT NULL,
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('dews', 'depeg', 'safety')),
  preset_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_event_id, alert_type, preset_id, stablecoin_id)
);

CREATE TABLE IF NOT EXISTS telegram_alert_source_resolution_pages (
  source_event_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  alert_type TEXT NOT NULL
    CHECK (alert_type IN ('dews', 'depeg', 'safety')),
  page_index INTEGER NOT NULL,
  cursor_chat_id TEXT,
  cursor_preset_id TEXT,
  memberships_resolved INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'complete', 'expired')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error_class TEXT,
  PRIMARY KEY (source_event_id, page_key)
);

CREATE TABLE IF NOT EXISTS telegram_alert_source_resolution_targets (
  source_event_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_event_id, page_key, preset_id, chat_id)
);

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

CREATE TABLE IF NOT EXISTS telegram_alert_target_plan_items (
  source_event_id TEXT NOT NULL,
  plan_generation INTEGER NOT NULL,
  plan_key TEXT NOT NULL,
  item_key TEXT NOT NULL
    CHECK (length(item_key) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_event_id, plan_generation, plan_key, item_key)
);

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

CREATE TABLE IF NOT EXISTS telegram_chat_delivery_diagnostics (
  chat_id TEXT PRIMARY KEY,
  last_successful_delivery_at INTEGER,
  last_successful_reply_at INTEGER,
  last_delivery_attempt_at INTEGER,
  recent_failure_class TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_delivery_pauses (
  mode TEXT PRIMARY KEY CHECK (mode IN ('fresh', 'pending', 'admin')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  expires_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 320),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_digest_outbox (
  edition_key TEXT PRIMARY KEY,
  digest_kind TEXT NOT NULL CHECK (digest_kind IN ('daily', 'weekly')),
  digest_generated_at INTEGER NOT NULL,
  target_chat_id TEXT NOT NULL,
  payload_chunks_json TEXT NOT NULL CHECK (
    json_valid(payload_chunks_json) AND json_type(payload_chunks_json) = 'array'
  ),
  success_actions_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(success_actions_json) AND json_type(success_actions_json) = 'array'
  ),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'sending', 'sent', 'execution_unknown', 'failed_permanent')
  ),
  next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_index >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  delivery_owner TEXT,
  delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0),
  delivery_claimed_at INTEGER,
  delivery_started_at INTEGER,
  delivery_completed_at INTEGER,
  delivery_claim_expires_at INTEGER,
  last_error_class TEXT,
  last_status_code INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, safety_context_json TEXT NOT NULL
  DEFAULT '{"status":"unavailable","expectedModel":"v8","identity":null,"publishedAt":null,"reason":"legacy-unbound"}'
  CHECK (
    json_valid(safety_context_json)
    AND json_type(safety_context_json) = 'object'
  ));

CREATE TABLE IF NOT EXISTS telegram_freeze_alert_events (
  source_event_id TEXT PRIMARY KEY CHECK (length(source_event_id) BETWEEN 1 AND 200),
  tape_event_id TEXT NOT NULL UNIQUE CHECK (length(tape_event_id) BETWEEN 1 AND 200),
  blacklist_event_id TEXT NOT NULL CHECK (length(blacklist_event_id) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN ('blacklist', 'unblacklist', 'destroy')),
  detected_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 262144),
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'queued', 'complete', 'expired')),
  cohort_captured_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS telegram_freeze_alert_targets (
  source_event_id TEXT NOT NULL,
  target_key TEXT NOT NULL CHECK (length(target_key) BETWEEN 1 AND 200),
  chat_id TEXT NOT NULL,
  preference_generation INTEGER NOT NULL CHECK (preference_generation >= 0),
  pending_dedupe_key TEXT NOT NULL CHECK (length(pending_dedupe_key) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'queued', 'cancelled', 'expired')),
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  cancelled_at INTEGER,
  PRIMARY KEY (source_event_id, target_key),
  FOREIGN KEY (source_event_id) REFERENCES telegram_freeze_alert_events(source_event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS telegram_pending_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  message_html TEXT NOT NULL,
  disable_notification INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
, not_before_at INTEGER, last_error_class TEXT, retry_after_sec INTEGER, updated_at INTEGER, dedupe_key TEXT, chunk_index INTEGER, priority INTEGER NOT NULL DEFAULT 50, source_type TEXT NOT NULL DEFAULT 'risk_alert', alert_type TEXT, expires_at INTEGER, processing_owner TEXT, processing_started_at INTEGER, processing_expires_at INTEGER, delivery_state TEXT NOT NULL DEFAULT 'pending', delivery_started_at INTEGER, delivery_completed_at INTEGER, source_event_id TEXT
  CHECK (source_event_id IS NULL OR length(source_event_id) <= 200), alert_scope_json TEXT
  CHECK (alert_scope_json IS NULL OR length(alert_scope_json) <= 65536), preference_generation INTEGER
  CHECK (preference_generation IS NULL OR preference_generation >= 0), markup_policy_json TEXT
  CHECK (markup_policy_json IS NULL OR length(markup_policy_json) <= 16384), delivery_owner TEXT
  CHECK (delivery_owner IS NULL OR length(delivery_owner) <= 200), delivery_generation INTEGER NOT NULL DEFAULT 0
  CHECK (delivery_generation >= 0), delivery_claim_expires_at INTEGER
  CHECK (delivery_claim_expires_at IS NULL OR delivery_claim_expires_at >= 0));

CREATE TABLE IF NOT EXISTS telegram_pending_disambiguation (
  chat_id TEXT PRIMARY KEY,
  alert_types TEXT NOT NULL,
  resolved_ids TEXT NOT NULL,
  ambiguous_ticker TEXT NOT NULL,
  candidates TEXT NOT NULL,
  remaining_tickers TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'subscribe',
  action_payload TEXT NOT NULL DEFAULT '{}'
, initiator_user_id TEXT);

CREATE TABLE IF NOT EXISTS telegram_preset_subscriptions (
  chat_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  alert_dews INTEGER NOT NULL DEFAULT 0,
  alert_depeg INTEGER NOT NULL DEFAULT 0,
  alert_safety INTEGER NOT NULL DEFAULT 0,
  depeg_worsening_bps_step INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, preset_id)
);

CREATE TABLE IF NOT EXISTS telegram_processed_updates (
  update_id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  update_type TEXT,
  chat_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'processed', 'failed')),
  error_class TEXT
, effect_state TEXT NOT NULL DEFAULT 'unstarted', effect_key TEXT, effect_started_at INTEGER, claim_owner TEXT, claim_generation INTEGER NOT NULL DEFAULT 0, intent_version INTEGER CHECK (intent_version IS NULL OR intent_version BETWEEN 1 AND 65535), intent_kind TEXT CHECK (intent_kind IS NULL OR (length(intent_kind) BETWEEN 1 AND 128)), intent_mutates INTEGER NOT NULL DEFAULT 0 CHECK (intent_mutates IN (0, 1)), intent_payload TEXT CHECK (intent_payload IS NULL OR length(intent_payload) <= 65536), intent_recorded_at INTEGER CHECK (intent_recorded_at IS NULL OR intent_recorded_at >= 0), mutation_applied_at INTEGER CHECK (mutation_applied_at IS NULL OR mutation_applied_at >= 0), effect_completed_at INTEGER CHECK (effect_completed_at IS NULL OR effect_completed_at >= 0), effect_kind TEXT CHECK (effect_kind IS NULL OR (length(effect_kind) BETWEEN 1 AND 64)), effect_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (effect_ordinal >= 0));

CREATE TABLE IF NOT EXISTS telegram_recap_preferences (
  chat_id TEXT PRIMARY KEY,
  -- Captured by the private command/Mini App mutation; group chats cannot
  -- create recap preferences. Existing subscribers default to private for
  -- backward-compatible rollout because no prior durable chat-kind column
  -- exists.
  chat_kind TEXT NOT NULL DEFAULT 'private' CHECK (chat_kind = 'private'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence = 'daily'),
  delivery_hour_local INTEGER NOT NULL DEFAULT 9
    CHECK (delivery_hour_local BETWEEN 0 AND 23),
  next_due_at INTEGER,
  last_window_end_at INTEGER,
  last_delivered_local_date TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_recap_targets (
  recap_key TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  tape_high_water_id INTEGER,
  preference_generation INTEGER NOT NULL CHECK (preference_generation >= 0),
  watchlist_fingerprint TEXT NOT NULL,
  payload_hash TEXT,
  material_coin_count INTEGER NOT NULL DEFAULT 0 CHECK (material_coin_count >= 0),
  material_fact_count INTEGER NOT NULL DEFAULT 0 CHECK (material_fact_count >= 0),
  omitted_fact_count INTEGER NOT NULL DEFAULT 0 CHECK (omitted_fact_count >= 0),
  pending_dedupe_key TEXT,
  pending_id INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'skipped_no_changes', 'skipped_paused', 'skipped_stale',
    'planned', 'queued', 'sent', 'cancelled', 'expired',
    'execution_unknown', 'failed_permanent'
  )),
  terminal_reason TEXT,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id, local_date)
);

CREATE TABLE IF NOT EXISTS telegram_subscribers (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  alert_dews INTEGER NOT NULL DEFAULT 0,
  alert_depeg INTEGER NOT NULL DEFAULT 0,
  alert_safety INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  quiet_hours_start_utc INTEGER,
  quiet_hours_end_utc INTEGER,
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
  global_alert_dews INTEGER NOT NULL DEFAULT 0,
  global_alert_depeg INTEGER NOT NULL DEFAULT 0,
  global_alert_safety INTEGER NOT NULL DEFAULT 0
, alert_launch INTEGER NOT NULL DEFAULT 0, global_alert_launch INTEGER NOT NULL DEFAULT 0, alert_snooze_until_ts INTEGER, global_depeg_worsening_bps_step INTEGER, consecutive_block_count INTEGER NOT NULL DEFAULT 0, consecutive_block_first_at INTEGER, timezone TEXT, alert_reserve INTEGER NOT NULL DEFAULT 0, global_alert_reserve INTEGER NOT NULL DEFAULT 0, preference_generation INTEGER NOT NULL DEFAULT 0
  CHECK (preference_generation >= 0), first_follow_at INTEGER, first_setup_completed_at INTEGER, alert_freeze INTEGER NOT NULL DEFAULT 0 CHECK (alert_freeze IN (0, 1)), global_alert_freeze INTEGER NOT NULL DEFAULT 0 CHECK (global_alert_freeze IN (0, 1)));

CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  chat_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  alert_dews INTEGER NOT NULL DEFAULT 0,
  alert_depeg INTEGER NOT NULL DEFAULT 0,
  alert_safety INTEGER NOT NULL DEFAULT 0,
  dews_min_band TEXT,
  safety_mode TEXT,
  depeg_worsening_bps_step INTEGER, alert_launch INTEGER NOT NULL DEFAULT 0, alert_snooze_until_ts INTEGER, alert_reserve INTEGER NOT NULL DEFAULT 0, alert_dews_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_dews_override IN (0, 1)), alert_depeg_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_depeg_override IN (0, 1)), alert_safety_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_safety_override IN (0, 1)), alert_launch_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_launch_override IN (0, 1)), alert_reserve_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_reserve_override IN (0, 1)), alert_freeze INTEGER NOT NULL DEFAULT 0 CHECK (alert_freeze IN (0, 1)), alert_freeze_override INTEGER NOT NULL DEFAULT 0 CHECK (alert_freeze_override IN (0, 1)),
  PRIMARY KEY (chat_id, stablecoin_id)
);

CREATE TABLE IF NOT EXISTS telegram_transport_circuit (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  state TEXT NOT NULL DEFAULT 'closed'
    CHECK (state IN ('closed', 'open', 'half_open')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  cause_class TEXT,
  cause_scope TEXT
    CHECK (cause_scope IS NULL OR cause_scope IN ('fatal', 'transient', 'rate_limit')),
  distinct_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (distinct_failure_count >= 0),
  first_failure_at INTEGER,
  last_failure_at INTEGER,
  last_success_at INTEGER,
  opened_at INTEGER,
  next_probe_at INTEGER,
  probe_owner TEXT CHECK (probe_owner IS NULL OR length(probe_owner) BETWEEN 1 AND 200),
  probe_generation INTEGER CHECK (probe_generation IS NULL OR probe_generation >= 0),
  probe_expires_at INTEGER,
  probe_limit INTEGER CHECK (probe_limit IS NULL OR probe_limit BETWEEN 1 AND 4),
  probe_attempted INTEGER NOT NULL DEFAULT 0 CHECK (probe_attempted BETWEEN 0 AND 4),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_transport_failure_observations (
  failure_scope TEXT NOT NULL
    CHECK (failure_scope IN ('transient', 'rate_limit')),
  chat_id TEXT NOT NULL,
  error_class TEXT NOT NULL CHECK (length(error_class) BETWEEN 1 AND 80),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (failure_scope, chat_id)
);

CREATE TABLE IF NOT EXISTS telegram_usage_daily (
  day TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source_category TEXT NOT NULL DEFAULT 'unknown',
  action_detail TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'unknown',
  latency_bucket TEXT NOT NULL DEFAULT 'unknown',
  failure_class TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (
    day,
    event_type,
    source_category,
    action_detail,
    outcome,
    latency_bucket,
    failure_class
  )
);

CREATE TABLE IF NOT EXISTS telegram_watcher_lifecycle_daily (
  day TEXT PRIMARY KEY,
  snapshot_at INTEGER NOT NULL,
  active_watchers INTEGER NOT NULL DEFAULT 0,
  new_watchers INTEGER NOT NULL DEFAULT 0,
  churned_watchers INTEGER NOT NULL DEFAULT 0,
  reactivated_watchers INTEGER NOT NULL DEFAULT 0,
  explicit_coin_follows INTEGER NOT NULL DEFAULT 0,
  preset_implied_coin_follows INTEGER NOT NULL DEFAULT 0,
  active_preset_followers INTEGER NOT NULL DEFAULT 0,
  active_dews_opt_ins INTEGER NOT NULL DEFAULT 0,
  active_depeg_opt_ins INTEGER NOT NULL DEFAULT 0,
  active_safety_opt_ins INTEGER NOT NULL DEFAULT 0,
  active_launch_opt_ins INTEGER NOT NULL DEFAULT 0,
  quiet_hours_enabled_chats INTEGER NOT NULL DEFAULT 0,
  pending_deliveries INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS telegram_webhook_operation_mutations (
  update_id INTEGER PRIMARY KEY NOT NULL,
  claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
  FOREIGN KEY (update_id) REFERENCES telegram_processed_updates(update_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS worker_canary_runs (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'error', 'skipped')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  observed_at INTEGER NOT NULL,
  duration_ms INTEGER,
  metadata_json TEXT,
  error TEXT
, mode TEXT NOT NULL DEFAULT 'shadow');

CREATE TABLE IF NOT EXISTS worker_producer_heads (
  schedule_key TEXT NOT NULL,
  job TEXT NOT NULL,
  producer_path TEXT NOT NULL,
  producer_kind TEXT NOT NULL,
  last_invocation_id TEXT NOT NULL,
  last_worker_version TEXT,
  last_invoked_at INTEGER NOT NULL,
  last_completed_at INTEGER NOT NULL,
  last_outcome TEXT NOT NULL,
  last_error TEXT,
  last_productive_invocation_id TEXT,
  last_productive_at INTEGER,
  last_productive_item_count INTEGER,
  last_publication_at INTEGER,
  last_publications_json TEXT,
  invocation_count INTEGER NOT NULL DEFAULT 0,
  productive_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (schedule_key, job, producer_path, producer_kind)
);

CREATE TABLE IF NOT EXISTS worker_producer_history (
  idempotency_key TEXT PRIMARY KEY,
  schedule_key TEXT NOT NULL,
  job TEXT NOT NULL,
  producer_path TEXT NOT NULL,
  producer_kind TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  worker_version TEXT,
  slot_started_at INTEGER,
  invoked_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('ok', 'degraded', 'error', 'skipped_locked', 'skipped_neutral', 'not_started', 'abandoned')
  ),
  productive INTEGER NOT NULL DEFAULT 0 CHECK (productive IN (0, 1)),
  item_count INTEGER,
  publication_count INTEGER NOT NULL DEFAULT 0,
  publications_json TEXT,
  calendar_period TEXT,
  metadata_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(schedule_key, job, producer_path, producer_kind, invocation_id)
);

CREATE TABLE IF NOT EXISTS worker_repair_tasks (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  state TEXT NOT NULL CHECK (
    state IN (
      'open',
      'claimed',
      'deferred',
      'closed',
      'failed',
      'cancelled'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  locked_by TEXT,
  locked_until INTEGER,
  payload_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS worker_scheduled_checkpoints (
  schedule_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  job TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  execution_generation INTEGER NOT NULL DEFAULT 1,
  invocation_id TEXT NOT NULL,
  worker_version TEXT,
  queue_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'running',
      'ready',
      'recovering',
      'completed',
      'failed',
      'platform_abandoned'
    )
  ),
  next_item_key TEXT,
  current_item_key TEXT,
  current_domain_attempt_id TEXT,
  items_done INTEGER NOT NULL DEFAULT 0,
  items_total INTEGER NOT NULL DEFAULT 0,
  child_dispositions_json TEXT NOT NULL DEFAULT '{}',
  recovery_owner TEXT,
  recovery_lease_until INTEGER,
  source_attempt_no INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (schedule_key, slot_started_at, job, attempt_no)
);

CREATE TABLE IF NOT EXISTS yield_coverage_review_dispositions (
  queue_item_id TEXT PRIMARY KEY CHECK (length(queue_item_id) BETWEEN 1 AND 512),
  queue_item_kind TEXT NOT NULL DEFAULT 'unknown',
  evidence_fingerprint TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL DEFAULT 'watch'
    CHECK (disposition IN ('accept', 'dismiss', 'intentional-gap', 'watch')),
  evidence TEXT NOT NULL DEFAULT '',
  review_owner TEXT NOT NULL DEFAULT 'unassigned',
  reviewed_at INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_at >= 0),
  next_review_at INTEGER NOT NULL DEFAULT 0 CHECK (next_review_at >= 0),
  expires_at INTEGER NOT NULL DEFAULT 0 CHECK (expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)
);

CREATE TABLE IF NOT EXISTS yield_data (
  stablecoin_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  current_apy REAL NOT NULL,
  apy_base REAL,
  apy_reward REAL,
  apy_7d REAL NOT NULL,
  apy_30d REAL NOT NULL,
  yield_source TEXT NOT NULL,
  yield_type TEXT NOT NULL,
  source_pool TEXT,
  source_tvl_usd REAL,
  data_source TEXT NOT NULL,
  safety_score REAL,
  safety_grade TEXT,
  pharos_yield_score REAL,
  yield_to_risk REAL,
  excess_yield REAL,
  yield_stability REAL,
  apy_variance_30d REAL,
  apy_min_30d REAL,
  apy_max_30d REAL,
  exchange_rate REAL,
  exchange_rate_prev REAL,
  warning_signals TEXT,
  is_best INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, publication_generation_id TEXT, publication_state TEXT,
  PRIMARY KEY (stablecoin_id, source_key)
);

CREATE TABLE IF NOT EXISTS yield_history (
  stablecoin_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  is_best INTEGER NOT NULL DEFAULT 0,
  apy REAL NOT NULL,
  apy_base REAL,
  apy_reward REAL,
  exchange_rate REAL,
  source_tvl_usd REAL,
  data_source TEXT NOT NULL,
  warning_signals TEXT,
  yield_source TEXT,
  yield_type TEXT, publication_generation_id TEXT, publication_state TEXT, pys_at_publish REAL, safety_at_publish REAL, variance_at_publish REAL, pys_inputs_at_publish TEXT,
  PRIMARY KEY (stablecoin_id, source_key, recorded_at)
);

CREATE TABLE IF NOT EXISTS yield_publication_generations (
  generation_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'published', 'failed')),
  cache_key TEXT NOT NULL DEFAULT 'yield-rankings',
  ranking_updated_at INTEGER,
  ranking_count INTEGER,
  source_row_count INTEGER,
  best_row_count INTEGER,
  decision_count INTEGER,
  published_at INTEGER,
  failed_at INTEGER,
  failure_reason TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS yield_source_decision_alternatives (
  generation_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  alt_source_key TEXT NOT NULL,
  alt_yield_source TEXT NOT NULL,
  alt_apy30d_delta REAL,
  rejection_reason_code TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (generation_id, stablecoin_id, alt_source_key)
);

CREATE TABLE IF NOT EXISTS yield_source_decisions (
  generation_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  selected_source_key TEXT NOT NULL,
  selected_confidence_tier TEXT NOT NULL,
  selected_data_source TEXT NOT NULL,
  selected_apy_30d REAL NOT NULL,
  selected_score REAL,
  selected_reason TEXT NOT NULL,
  previous_best_source_key TEXT,
  source_switch INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  alternatives_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, retention_reason TEXT,
  PRIMARY KEY (generation_id, stablecoin_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_action_audit_action_intent
  ON admin_action_audit (action, intent_key)
  WHERE intent_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_action_audit_actor_action
  ON admin_action_audit (actor, action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_action_audit_created_at
  ON admin_action_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_idempotency_created_at ON admin_idempotency_keys(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_log_key
  ON api_key_audit_log(api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_log_recent
  ON api_key_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_rate_limit_bucket ON api_key_rate_limit(bucket_start);

CREATE INDEX IF NOT EXISTS idx_api_key_request_rate_limit_v2_bucket
  ON api_key_request_rate_limit_v2(bucket_start);

CREATE INDEX IF NOT EXISTS idx_api_key_request_stats_bucket
  ON api_key_request_stats(bucket_start);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_api_key
  ON api_key_requests(api_key_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_requests_api_key_unique
  ON api_key_requests(api_key_id)
  WHERE api_key_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_key_requests_email_status
  ON api_key_requests(email_hash, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_ip_created
  ON api_key_requests(ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_status_created
  ON api_key_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_verification_token
  ON api_key_requests(verification_token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_requests_verification_token_unique
  ON api_key_requests(verification_token_hash)
  WHERE verification_token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_self_serve_claim_api_key_unique
  ON api_key_self_serve_email_claims(api_key_id)
  WHERE api_key_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_key_self_serve_email_claims_status
  ON api_key_self_serve_email_claims(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_self_serve_issuance_limits_bucket
  ON api_key_self_serve_issuance_limits(bucket_start);

CREATE INDEX IF NOT EXISTS idx_api_key_self_serve_revocations_request
  ON api_key_self_serve_revocations(request_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_request_consumer_stats_bucket
  ON api_request_consumer_stats(bucket_start);

CREATE INDEX IF NOT EXISTS idx_api_request_consumer_stats_lane
  ON api_request_consumer_stats(lane, bucket_start);

CREATE INDEX IF NOT EXISTS idx_api_request_consumer_stats_route
  ON api_request_consumer_stats(route_key, bucket_start);

CREATE INDEX IF NOT EXISTS idx_be_chain_name ON blacklist_events(chain_name);

CREATE INDEX IF NOT EXISTS idx_be_event_type ON blacklist_events(event_type);

CREATE INDEX IF NOT EXISTS idx_be_stablecoin ON blacklist_events(stablecoin);

CREATE INDEX IF NOT EXISTS idx_be_timestamp ON blacklist_events(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_amount_repair_queue_due
  ON blacklist_amount_repair_queue(status, available_at, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_blacklist_amount_repair_queue_lease
  ON blacklist_amount_repair_queue(status, lease_expires_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_chain_stablecoin
  ON blacklist_current_balances(chain_id, stablecoin);

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_identity
  ON blacklist_current_balances(stablecoin, chain_id, config_key, contract_address, LOWER(address));

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_legacy_identity
  ON blacklist_current_balances(stablecoin, chain_id, LOWER(address))
  WHERE config_key IS NULL AND contract_address IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_status
  ON blacklist_current_balances(status);

CREATE INDEX IF NOT EXISTS idx_blacklist_current_balances_status_observed
  ON blacklist_current_balances(status, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_amount_status ON blacklist_events(amount_status);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_api_filter
  ON blacklist_events(stablecoin, chain_name, event_type, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_backfill
  ON blacklist_events(event_type, amount_status, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_chain_ts ON blacklist_events(chain_name, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_config_key ON blacklist_events(config_key);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_latest_identity
  ON blacklist_events(
    stablecoin,
    chain_id,
    LOWER(address),
    COALESCE(LOWER(config_key), ''),
    COALESCE(LOWER(contract_address), ''),
    timestamp DESC,
    id DESC
  )
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_latest_type_identity
  ON blacklist_events(
    event_type,
    stablecoin,
    chain_id,
    LOWER(address),
    COALESCE(LOWER(config_key), ''),
    COALESCE(LOWER(contract_address), ''),
    timestamp DESC,
    id DESC
  )
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_chain_id_page
  ON blacklist_events(chain_id, timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_chain_page
  ON blacklist_events(chain_name, timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_date_page
  ON blacklist_events(timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_event_page
  ON blacklist_events(event_type, timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_public_stablecoin_page
  ON blacklist_events(stablecoin, timestamp DESC, id DESC)
  WHERE suppression_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_reconciliation_manifest
  ON blacklist_events(reconciliation_manifest_id, id);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_suppression_reason
  ON blacklist_events(suppression_reason);

CREATE INDEX IF NOT EXISTS idx_blacklist_reconciliation_runs_latest
  ON blacklist_reconciliation_runs(started_at DESC, run_id DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_reconciliation_runs_manifest
  ON blacklist_reconciliation_runs(manifest_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_sync_state_fair_attempt
  ON blacklist_sync_state(cursor_kind, last_attempted_at, config_key);

CREATE INDEX IF NOT EXISTS idx_block_timestamp_cache_updated ON block_timestamp_cache(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_leases_until ON cron_leases(lease_until);

CREATE INDEX IF NOT EXISTS idx_cron_run_progress_updated_at ON cron_run_progress(updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_idempotency_key
  ON cron_runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cron_runs_invocation
  ON cron_runs(invocation_id)
  WHERE invocation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_slot_started
  ON cron_runs(job, slot_started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started ON cron_runs(job, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started_ok
  ON cron_runs(job, started_at DESC)
  WHERE status = 'ok';

CREATE INDEX IF NOT EXISTS idx_cron_runs_schedule_path_started
  ON cron_runs(schedule_key, producer_path, job, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_runs_started_job_id
  ON cron_runs(started_at DESC, job, id DESC);

CREATE INDEX IF NOT EXISTS idx_cron_slot_executions_state_updated
  ON cron_slot_executions(state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_d1_capacity_observations_observed
  ON d1_capacity_observations(observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_daily_digest_generated_at ON daily_digest(generated_at);

CREATE INDEX IF NOT EXISTS idx_ddr_assessments_event
  ON depeg_resolver_assessments(event_id);

CREATE INDEX IF NOT EXISTS idx_ddr_assessments_lookup
  ON depeg_resolver_assessments(stablecoin_id, assessed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_assessments_one_public_prediction
  ON depeg_resolver_assessments(event_id)
  WHERE checkpoint = 'public_prediction';

CREATE INDEX IF NOT EXISTS idx_ddr_assessments_public_prediction_review
  ON depeg_resolver_assessments(assessed_at DESC, event_id)
  WHERE checkpoint = 'public_prediction';

CREATE INDEX IF NOT EXISTS idx_ddr_assessments_review
  ON depeg_resolver_assessments(checkpoint, assessed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_incident_current_event
  ON depeg_resolver_incidents(current_event_id)
  WHERE incident_state = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_incident_event_single_incident
  ON depeg_resolver_incident_event_links(event_id);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_lineage_from
  ON depeg_resolver_incident_lineage(from_incident_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_lineage_to
  ON depeg_resolver_incident_lineage(to_incident_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_match
  ON depeg_resolver_incidents(stablecoin_id, peg_currency, direction, first_started_at);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_policy_lookup
  ON depeg_resolver_incident_policy_membership(prediction_policy_version, policy_universe_included, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_revisions_incident
  ON depeg_resolver_incident_revisions(incident_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_lock_opportunity_event
  ON depeg_resolver_lock_opportunity_audit(event_id, run_at);

CREATE INDEX IF NOT EXISTS idx_ddr_lock_opportunity_incident
  ON depeg_resolver_lock_opportunity_audit(incident_key, run_at);

CREATE INDEX IF NOT EXISTS idx_ddr_lock_state_state
  ON depeg_resolver_prediction_lock_state(last_state, eligible_at);

CREATE INDEX IF NOT EXISTS idx_ddr_prediction_errata_event
  ON depeg_resolver_prediction_errata(event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_prediction_errata_incident
  ON depeg_resolver_prediction_errata(incident_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_prediction_errata_prediction
  ON depeg_resolver_prediction_errata(public_prediction_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_public_predictions_assessment
  ON depeg_resolver_public_predictions(assessment_id);

CREATE INDEX IF NOT EXISTS idx_ddr_public_predictions_event
  ON depeg_resolver_public_predictions(event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_publication_first_prediction
  ON depeg_resolver_publication_snapshot_rows(public_prediction_id)
  WHERE first_published = 1;

CREATE INDEX IF NOT EXISTS idx_ddr_publication_snapshot_errata_token
  ON depeg_resolver_publication_snapshot_errata(snapshot_token, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_publication_snapshot_sequence
  ON depeg_resolver_publication_snapshots(snapshot_kind, snapshot_sequence);

CREATE INDEX IF NOT EXISTS idx_ddr_repair_auth_scope
  ON depeg_resolver_event_repair_authorizations(event_id, incident_key, operation, expires_at);

CREATE INDEX IF NOT EXISTS idx_depeg_backfill_runs_stablecoin
  ON depeg_backfill_runs(stablecoin_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_depeg_backfill_runs_status
  ON depeg_backfill_runs(status, started_at);

CREATE INDEX IF NOT EXISTS idx_depeg_coin_started_id
  ON depeg_events(stablecoin_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_depeg_event_provenance_audit
  ON depeg_event_provenance(audit_verdict, confidence_tier);

CREATE INDEX IF NOT EXISTS idx_depeg_event_provenance_run
  ON depeg_event_provenance(replay_run_id);

CREATE INDEX IF NOT EXISTS idx_depeg_open ON depeg_events(stablecoin_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_depeg_open_started_id
  ON depeg_events(started_at DESC, id DESC)
  WHERE ended_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_depeg_pending_coin ON depeg_pending(stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_depeg_pending_outcomes_pending_id
  ON depeg_pending_outcomes(pending_id);

CREATE INDEX IF NOT EXISTS idx_depeg_pending_outcomes_stablecoin_time
  ON depeg_pending_outcomes(stablecoin_id, outcome_at DESC);

CREATE INDEX IF NOT EXISTS idx_depeg_stablecoin ON depeg_events(stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_depeg_started ON depeg_events(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_depeg_started_id
  ON depeg_events(started_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_depeg_unique ON depeg_events(stablecoin_id, started_at, source);

CREATE INDEX IF NOT EXISTS idx_detail_cache_write_generations_updated
  ON detail_cache_write_generations(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dex_deployment_outcomes_outcome
  ON dex_deployment_outcomes(outcome, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dex_deployment_outcomes_stablecoin
  ON dex_deployment_outcomes(stablecoin_id, outcome);

CREATE INDEX IF NOT EXISTS idx_dex_hist_coin_date ON dex_liquidity_history(stablecoin_id, snapshot_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dex_hist_coin_date_unique
  ON dex_liquidity_history(stablecoin_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_dex_liq_score ON dex_liquidity(liquidity_score DESC);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_generations_state_started
  ON dex_liquidity_publication_generations(state, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_publication_state
  ON dex_liquidity(publication_generation_id, publication_state);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_run_rows_stablecoin
  ON dex_liquidity_run_rows(stablecoin_id, generation_id);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_scoring_stage_chunks_retention
  ON dex_liquidity_scoring_stage_chunks (created_at, generation_id);

CREATE INDEX IF NOT EXISTS idx_dex_liquidity_scoring_stages_slot
  ON dex_liquidity_scoring_stages (source_slot_started_at DESC);

CREATE INDEX IF NOT EXISTS idx_dex_measured_quotes_target_generation
  ON dex_measured_execution_quotes(target_generation_id, target_id);

CREATE INDEX IF NOT EXISTS idx_dex_measured_targets_generation_coin
  ON dex_measured_execution_targets(generation_id, stablecoin_id, target_id);

CREATE INDEX IF NOT EXISTS idx_dex_price_challengers_lookup ON dex_price_challengers(stablecoin_id, snapshot_at);

CREATE INDEX IF NOT EXISTS idx_dex_price_run_rows_retention
  ON dex_price_run_rows(updated_at, generation_id);

CREATE INDEX IF NOT EXISTS idx_dex_prices_updated ON dex_prices(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_rate_limit_ip ON feedback_rate_limit(ip_hash, submitted_at);

CREATE INDEX IF NOT EXISTS idx_mbcd_until ON mint_burn_config_deferral(deferred_until);

CREATE INDEX IF NOT EXISTS idx_mbe_coin_chain_ts ON mint_burn_events(stablecoin_id, chain_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_mbe_counted_coin_chain_ts
  ON mint_burn_events(stablecoin_id, chain_id, timestamp DESC)
  WHERE flow_type = 'standard'
    AND (direction = 'mint' OR burn_type = 'effective_burn');

CREATE INDEX IF NOT EXISTS idx_mbe_flow_type_ts
  ON mint_burn_events(flow_type, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_mbe_null_price_ts ON mint_burn_events(timestamp DESC) WHERE amount_usd IS NULL;

CREATE INDEX IF NOT EXISTS idx_mbe_symbol_ts ON mint_burn_events(symbol, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_mbe2_burn_type ON mint_burn_events(burn_type, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_mbe2_chain ON mint_burn_events(chain_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_mbe2_coin ON mint_burn_events(stablecoin_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_mbe2_ts ON mint_burn_events(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_mbh_chain_coin_hour
  ON mint_burn_hourly(chain_id, stablecoin_id, hour_ts);

CREATE INDEX IF NOT EXISTS idx_mbh_chain_hour_coin
  ON mint_burn_hourly(chain_id, hour_ts, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_mbh_coin ON mint_burn_hourly(stablecoin_id, hour_ts DESC);

CREATE INDEX IF NOT EXISTS idx_mbh_ts ON mint_burn_hourly(hour_ts DESC);

CREATE INDEX IF NOT EXISTS idx_onchain_supply_updated ON onchain_supply(updated_at);

CREATE INDEX IF NOT EXISTS idx_pricing_provider_negative_cache_expiry
  ON pricing_provider_negative_cache(provider_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_history_date ON redemption_backstop_history(snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_history_run_id
  ON redemption_backstop_history(snapshot_run_id);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_run_rows_run_id
  ON redemption_backstop_run_rows(snapshot_run_id);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_runs_status_completed
  ON redemption_backstop_runs(status, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_snapshot_run_id
  ON redemption_backstop(snapshot_run_id);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_updated_at ON redemption_backstop(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_report_card_evidence_journal_asset_latest
  ON report_card_evidence_journal (lane, asset_id, completed_at DESC, attempt_id DESC);

CREATE INDEX IF NOT EXISTS idx_report_card_evidence_journal_retention
  ON report_card_evidence_journal (recorded_at);

CREATE INDEX IF NOT EXISTS idx_reserve_composition_history_coin_attempt
  ON reserve_composition_history(stablecoin_id, attempt_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reserve_composition_history_coin_attempt_unique
  ON reserve_composition_history(stablecoin_id, attempt_id)
  WHERE attempt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reserve_composition_history_coin_time ON reserve_composition_history(stablecoin_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_reserve_sync_attempt_history_coin_attempt
  ON reserve_sync_attempt_history(stablecoin_id, attempt_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reserve_sync_attempt_history_coin_attempt_unique
  ON reserve_sync_attempt_history(stablecoin_id, attempt_id)
  WHERE attempt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reserve_sync_attempt_history_coin_time ON reserve_sync_attempt_history(stablecoin_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_reserve_sync_state_last_success_attempt
  ON reserve_sync_state(last_success_attempt_id);

CREATE INDEX IF NOT EXISTS idx_reserve_sync_state_pending_attempt
  ON reserve_sync_state(pending_attempt_id);

CREATE INDEX IF NOT EXISTS idx_safety_grade_history_coin ON safety_grade_history(stablecoin_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_safety_grade_history_recorded_at ON safety_grade_history(recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_safety_score_history_v2_coin
  ON safety_score_history_v2(stablecoin_id, recorded_at DESC, history_id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_safety_score_history_v2_legacy_row
  ON safety_score_history_v2(stablecoin_id, legacy_recorded_at)
  WHERE legacy_recorded_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_safety_score_history_v2_model_generation
  ON safety_score_history_v2(model, model_publication_generation_id, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_safety_score_history_v2_recorded_at
  ON safety_score_history_v2(recorded_at DESC, history_id DESC);

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_supply_attribution_journal_asset_latest
  ON safety_score_v9_supply_attribution_journal (
    lane,
    asset_id,
    completed_at DESC,
    attempt_id DESC
  );

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_supply_attribution_journal_retention
  ON safety_score_v9_supply_attribution_journal (recorded_at);

CREATE INDEX IF NOT EXISTS idx_selector_snapshot_daily_quota_last_seen
  ON selector_snapshot_daily_quota(last_seen_at);

CREATE INDEX IF NOT EXISTS idx_site_data_request_stats_bucket
  ON site_data_request_stats(bucket_start);

CREATE INDEX IF NOT EXISTS idx_site_data_request_stats_delivery
  ON site_data_request_stats(delivery_path, bucket_start);

CREATE INDEX IF NOT EXISTS idx_site_data_request_stats_route
  ON site_data_request_stats(route_key, bucket_start);

CREATE INDEX IF NOT EXISTS idx_stability_index_computed_at ON stability_index(computed_at);

CREATE INDEX IF NOT EXISTS idx_staging_coin ON dex_pool_staging(stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_staging_refreshed ON dex_pool_staging(refreshed_at);

CREATE INDEX IF NOT EXISTS idx_status_probe_runs_created_at ON status_probe_runs(created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_status_probe_runs_idempotency_key
  ON status_probe_runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_status_transitions_idempotency_key
  ON status_transitions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_status_transitions_scope_created_at ON status_transitions(scope, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stress_coin_date ON stress_signals(stablecoin_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_stress_computed ON stress_signals(computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_stress_hist_date ON stress_signal_history(snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_stress_latest_computed
  ON stress_signals_latest(computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_supply_hist_date ON supply_history(snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_surface_publication_generations_surface_started
  ON surface_publication_generations(surface, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_surface_publication_generations_surface_state_published
  ON surface_publication_generations(surface, state, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_surface_publication_generations_surface_state_started
  ON surface_publication_generations(surface, state, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_tadl_chat_expired
  ON telegram_alert_dead_letters(chat_id, expired_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tadl_dead_letter_key
  ON telegram_alert_dead_letters(dead_letter_key)
  WHERE dead_letter_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tadl_expired_at
  ON telegram_alert_dead_letters(expired_at DESC);

CREATE INDEX IF NOT EXISTS idx_taj_created_at
  ON telegram_alert_jobs(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_taj_source_alert
  ON telegram_alert_jobs(source_event_id, alert_type);

CREATE INDEX IF NOT EXISTS idx_taj_status_created
  ON telegram_alert_jobs(status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tajt_authoritative_pending_identity
  ON telegram_alert_job_targets(source_event_id, pending_dedupe_key)
  WHERE plan_generation IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tajt_authoritative_ready
  ON telegram_alert_job_targets(
    source_event_id, plan_generation, status, plan_ordinal, target_ordinal
  );

CREATE INDEX IF NOT EXISTS idx_tajt_chat_created
  ON telegram_alert_job_targets(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tajt_created_at
  ON telegram_alert_job_targets(created_at);

CREATE INDEX IF NOT EXISTS idx_tajt_effect_owner
  ON telegram_alert_job_targets(effect_owner, effect_generation)
  WHERE effect_owner IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tajt_effect_ready
  ON telegram_alert_job_targets(effect_state, effect_claim_expires_at, status, created_at);

CREATE INDEX IF NOT EXISTS idx_tajt_pending_dedupe
  ON telegram_alert_job_targets(pending_dedupe_key);

CREATE INDEX IF NOT EXISTS idx_tajt_pending_source_outcome
  ON telegram_alert_job_targets(pending_dedupe_key, source_event_id, final_delivery_state);

CREATE INDEX IF NOT EXISTS idx_tajt_pending_status
  ON telegram_alert_job_targets(pending_dedupe_key, status);

CREATE INDEX IF NOT EXISTS idx_tajt_status_created
  ON telegram_alert_job_targets(status, created_at);

CREATE INDEX IF NOT EXISTS idx_tajti_created_at
  ON telegram_alert_job_target_items(created_at);

CREATE INDEX IF NOT EXISTS idx_tajti_source_item
  ON telegram_alert_job_target_items(source_event_id, item_key, job_id, target_key);

CREATE INDEX IF NOT EXISTS idx_tape_coin_ts ON tape_events(coin_id, ts DESC, id DESC)
  WHERE coin_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tape_event_id ON tape_events(event_id);

CREATE INDEX IF NOT EXISTS idx_tape_issuer_ts ON tape_events(issuer_id, ts DESC, id DESC)
  WHERE issuer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tape_severity_ts ON tape_events(severity, ts DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tape_source_key
  ON tape_events(source_table, source_row_id, transition);

CREATE INDEX IF NOT EXISTS idx_tape_ts ON tape_events(ts DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tape_type_ts ON tape_events(type, ts DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_taps_scan
  ON telegram_alert_planning_subscribers(source_event_id, plan_generation, chat_id);

CREATE INDEX IF NOT EXISTS idx_tase_resume
  ON telegram_alert_source_events(status, detected_at)
  WHERE status IN ('resolving', 'planned', 'baseline_committed');

CREATE INDEX IF NOT EXISTS idx_tase_target_plan_resume
  ON telegram_alert_source_events(target_plan_state, detected_at)
  WHERE target_plan_state NOT IN ('delivery_open', 'expired');

CREATE INDEX IF NOT EXISTS idx_tase_terminal_completed
  ON telegram_alert_source_events(completed_at, source_event_id)
  WHERE status IN ('complete', 'expired');

CREATE INDEX IF NOT EXISTS idx_tasrm_source_preset
  ON telegram_alert_source_resolution_memberships(source_event_id, alert_type, preset_id);

CREATE INDEX IF NOT EXISTS idx_tasrp_resume
  ON telegram_alert_source_resolution_pages(source_event_id, status, alert_type, page_index);

CREATE INDEX IF NOT EXISTS idx_tasrt_chat
  ON telegram_alert_source_resolution_targets(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasrt_source_page
  ON telegram_alert_source_resolution_targets(source_event_id, page_key, preset_id);

CREATE INDEX IF NOT EXISTS idx_tatep_resume
  ON telegram_alert_target_expiry_progress(state, updated_at, source_event_id);

CREATE INDEX IF NOT EXISTS idx_tatp_resume
  ON telegram_alert_target_plans(
    source_event_id, plan_generation, status, page_index, plan_ordinal
  );

CREATE INDEX IF NOT EXISTS idx_tatpi_source_item
  ON telegram_alert_target_plan_items(source_event_id, item_key, plan_key);

CREATE INDEX IF NOT EXISTS idx_tatpp_resume
  ON telegram_alert_target_plan_pages(source_event_id, plan_generation, status, page_index);

CREATE INDEX IF NOT EXISTS idx_tcd_updated
  ON telegram_chat_delivery_diagnostics(updated_at);

CREATE INDEX IF NOT EXISTS idx_tdp_expiry
  ON telegram_delivery_pauses(expires_at);

CREATE INDEX IF NOT EXISTS idx_telegram_adoption_daily_stage_day
  ON telegram_adoption_daily(stage, day);

CREATE INDEX IF NOT EXISTS idx_telegram_adoption_retention_cohort
  ON telegram_adoption_retention_daily(cohort_day, window_days, feature);

CREATE INDEX IF NOT EXISTS idx_telegram_digest_outbox_due
  ON telegram_digest_outbox(state, next_attempt_at, created_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_telegram_digest_outbox_sending
  ON telegram_digest_outbox(state, delivery_claim_expires_at)
  WHERE state = 'sending';

CREATE INDEX IF NOT EXISTS idx_telegram_digest_outbox_terminal
  ON telegram_digest_outbox(state, updated_at DESC)
  WHERE state IN ('execution_unknown', 'failed_permanent');

CREATE INDEX IF NOT EXISTS idx_telegram_freeze_alert_targets_page
  ON telegram_freeze_alert_targets(source_event_id, status, target_key);

CREATE INDEX IF NOT EXISTS idx_telegram_freeze_alert_targets_resume
  ON telegram_freeze_alert_targets(source_event_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_telegram_pending_alerts_chat_id
  ON telegram_pending_alerts (chat_id);

CREATE INDEX IF NOT EXISTS idx_telegram_pending_disambiguation_expires_at
  ON telegram_pending_disambiguation (expires_at);

CREATE INDEX IF NOT EXISTS idx_telegram_preset_subscriptions_preset
  ON telegram_preset_subscriptions(preset_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_processed_updates_effect_key
  ON telegram_processed_updates(effect_key)
  WHERE effect_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_effect_state_received
  ON telegram_processed_updates(effect_state, received_at);

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_intent_kind_received
  ON telegram_processed_updates(intent_kind, received_at DESC)
  WHERE intent_kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_received_at
  ON telegram_processed_updates (received_at);

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_status_received_at
  ON telegram_processed_updates (status, received_at);

CREATE INDEX IF NOT EXISTS idx_telegram_recap_preferences_due
  ON telegram_recap_preferences(enabled, next_due_at, chat_id)
  WHERE enabled = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_recap_targets_chat
  ON telegram_recap_targets(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_recap_targets_status
  ON telegram_recap_targets(status, updated_at, recap_key);

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_depeg
  ON telegram_subscribers (chat_id) WHERE global_alert_depeg = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_dews
  ON telegram_subscribers (chat_id) WHERE global_alert_dews = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_freeze
  ON telegram_subscribers (chat_id) WHERE global_alert_freeze = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_launch
  ON telegram_subscribers (chat_id) WHERE global_alert_launch = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_reserve
  ON telegram_subscribers (chat_id) WHERE global_alert_reserve = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_global_alert_safety
  ON telegram_subscribers (chat_id) WHERE global_alert_safety = 1;

CREATE INDEX IF NOT EXISTS idx_telegram_subscribers_last_active_at
  ON telegram_subscribers(last_active_at);

CREATE INDEX IF NOT EXISTS idx_telegram_usage_daily_day_event
  ON telegram_usage_daily(day, event_type);

CREATE INDEX IF NOT EXISTS idx_telegram_watcher_lifecycle_daily_snapshot_at
  ON telegram_watcher_lifecycle_daily(snapshot_at);

CREATE INDEX IF NOT EXISTS idx_tg_sub_coin ON telegram_subscriptions(stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_tg_sub_depeg_coin_chat
  ON telegram_subscriptions(stablecoin_id, alert_snooze_until_ts, chat_id)
  WHERE alert_depeg = 1;

CREATE INDEX IF NOT EXISTS idx_tg_sub_dews_coin_chat
  ON telegram_subscriptions(stablecoin_id, alert_snooze_until_ts, chat_id)
  WHERE alert_dews = 1;

CREATE INDEX IF NOT EXISTS idx_tg_sub_safety_coin_chat
  ON telegram_subscriptions(stablecoin_id, alert_snooze_until_ts, chat_id)
  WHERE alert_safety = 1;

CREATE INDEX IF NOT EXISTS idx_tpa_claim_ready
  ON telegram_pending_alerts(processing_expires_at, priority, not_before_at, created_at);

CREATE INDEX IF NOT EXISTS idx_tpa_created ON telegram_pending_alerts(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tpa_dedupe_key
  ON telegram_pending_alerts(dedupe_key);

CREATE INDEX IF NOT EXISTS idx_tpa_delivery_claim_ready
  ON telegram_pending_alerts(delivery_state, processing_expires_at, priority, not_before_at, created_at);

CREATE INDEX IF NOT EXISTS idx_tpa_delivery_reconcile
  ON telegram_pending_alerts(delivery_state, delivery_claim_expires_at, delivery_started_at);

CREATE INDEX IF NOT EXISTS idx_tpa_expires_at
  ON telegram_pending_alerts(expires_at);

CREATE INDEX IF NOT EXISTS idx_tpa_not_before
  ON telegram_pending_alerts(not_before_at, created_at)
  WHERE not_before_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tpa_priority_ready
  ON telegram_pending_alerts(priority, not_before_at, created_at);

CREATE INDEX IF NOT EXISTS idx_tpa_ready
  ON telegram_pending_alerts(not_before_at, created_at)
  WHERE not_before_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ttfo_retention
  ON telegram_transport_failure_observations(observed_at);

CREATE INDEX IF NOT EXISTS idx_worker_canary_runs_check_observed
  ON worker_canary_runs(check_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_canary_runs_mode_check_observed
  ON worker_canary_runs(mode, check_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_canary_runs_observed_at
  ON worker_canary_runs(observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_canary_runs_status_observed
  ON worker_canary_runs(status, severity, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_producer_heads_job
  ON worker_producer_heads(job, producer_kind, last_completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_producer_heads_productive
  ON worker_producer_heads(producer_kind, last_productive_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_producer_history_calendar_period
  ON worker_producer_history(calendar_period, completed_at DESC)
  WHERE calendar_period IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_worker_producer_history_identity_invoked
  ON worker_producer_history(schedule_key, job, producer_path, producer_kind, invoked_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_producer_history_kind_completed
  ON worker_producer_history(producer_kind, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_producer_history_productive
  ON worker_producer_history(schedule_key, job, producer_path, producer_kind, productive, completed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_repair_tasks_active_identity
  ON worker_repair_tasks(kind, subject_id)
  WHERE state IN ('open', 'claimed', 'deferred', 'failed');

CREATE INDEX IF NOT EXISTS idx_worker_repair_tasks_claim
  ON worker_repair_tasks(state, next_attempt_at, priority, updated_at)
  WHERE state IN ('open', 'deferred');

CREATE INDEX IF NOT EXISTS idx_worker_repair_tasks_kind_state_updated
  ON worker_repair_tasks(kind, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_repair_tasks_stuck_claim
  ON worker_repair_tasks(locked_until, state)
  WHERE state = 'claimed';

CREATE INDEX IF NOT EXISTS idx_worker_repair_tasks_terminal_updated
  ON worker_repair_tasks(state, updated_at)
  WHERE state IN ('closed', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_worker_scheduled_checkpoints_job_updated
  ON worker_scheduled_checkpoints(job, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_worker_scheduled_checkpoints_recovery_ready
  ON worker_scheduled_checkpoints(state, recovery_lease_until, updated_at)
  WHERE state IN ('ready', 'recovering');

CREATE INDEX IF NOT EXISTS idx_worker_scheduled_checkpoints_slot
  ON worker_scheduled_checkpoints(schedule_key, slot_started_at, job, attempt_no DESC);

CREATE INDEX IF NOT EXISTS idx_yield_apy ON yield_data(apy_30d DESC);

CREATE INDEX IF NOT EXISTS idx_yield_best ON yield_data(stablecoin_id, is_best);

CREATE INDEX IF NOT EXISTS idx_yield_coverage_review_dispositions_review_window
  ON yield_coverage_review_dispositions(next_review_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_yield_data_publication_generation
  ON yield_data(publication_generation_id, publication_state);

CREATE INDEX IF NOT EXISTS idx_yield_decision_alternatives_coin
  ON yield_source_decision_alternatives (stablecoin_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_yield_hist_best ON yield_history(stablecoin_id, is_best, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_yield_hist_coin ON yield_history(stablecoin_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_yield_hist_coin_source ON yield_history(stablecoin_id, source_key, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_yield_history_best_recorded_coin
  ON yield_history(is_best, recorded_at DESC, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_yield_history_publication_generation
  ON yield_history(publication_generation_id, publication_state, stablecoin_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_yield_history_recorded_coin
  ON yield_history(recorded_at DESC, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_yield_publication_generations_state_started
  ON yield_publication_generations(state, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_yield_pys ON yield_data(pharos_yield_score DESC);

CREATE INDEX IF NOT EXISTS idx_yield_source_decisions_coin_created
  ON yield_source_decisions(stablecoin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_yield_source_decisions_created_coin
  ON yield_source_decisions(created_at ASC, stablecoin_id ASC);

CREATE INDEX IF NOT EXISTS idx_yield_source_decisions_generation
  ON yield_source_decisions(generation_id, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_yield_source_decisions_retention
  ON yield_source_decisions (retention_reason, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_ddr_depeg_events_delete_repair_use
AFTER DELETE ON depeg_events
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = p.incident_key
   AND l.event_id = OLD.id
)
BEGIN
  INSERT INTO depeg_resolver_event_repair_authorization_uses
   (authorization_id, event_id, incident_key, operation, used_at, target_table, target_key)
  SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(),
         'depeg_events',
         CAST(OLD.id AS TEXT)
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = a.incident_key
   AND l.event_id = OLD.id
  WHERE a.event_id = OLD.id
    AND a.operation = 'delete'
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_depeg_events_identity_update_repair_use
AFTER UPDATE OF stablecoin_id, symbol, peg_type, direction, started_at, start_price, peg_reference, source
ON depeg_events
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = p.incident_key
   AND l.event_id = OLD.id
)
BEGIN
  INSERT INTO depeg_resolver_event_repair_authorization_uses
   (authorization_id, event_id, incident_key, operation, used_at, target_table, target_key)
  SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(),
         'depeg_events',
         CAST(OLD.id AS TEXT)
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = a.incident_key
   AND l.event_id = OLD.id
  WHERE a.event_id = OLD.id
    AND a.operation = 'identity_update'
    AND (OLD.stablecoin_id = NEW.stablecoin_id OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'stablecoin_id'))
    AND (OLD.symbol = NEW.symbol OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'symbol'))
    AND (OLD.peg_type = NEW.peg_type OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'peg_type'))
    AND (OLD.direction = NEW.direction OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'direction'))
    AND (OLD.started_at = NEW.started_at OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'started_at'))
    AND (OLD.start_price = NEW.start_price OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'start_price'))
    AND (OLD.peg_reference = NEW.peg_reference OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'peg_reference'))
    AND (OLD.source = NEW.source OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'source'))
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_depeg_events_no_delete_when_sealed
BEFORE DELETE ON depeg_events
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = p.incident_key
   AND l.event_id = OLD.id
)
AND NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = a.incident_key
   AND l.event_id = OLD.id
  WHERE a.event_id = OLD.id
    AND a.operation = 'delete'
    AND a.expires_at >= unixepoch()
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'sealed depeg event deletes require incident repair authorization');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_depeg_events_no_identity_update_when_sealed
BEFORE UPDATE OF stablecoin_id, symbol, peg_type, direction, started_at, start_price, peg_reference, source
ON depeg_events
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = p.incident_key
   AND l.event_id = OLD.id
)
AND NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = a.incident_key
   AND l.event_id = OLD.id
  WHERE a.event_id = OLD.id
    AND a.operation = 'identity_update'
    AND a.expires_at >= unixepoch()
    AND (OLD.stablecoin_id = NEW.stablecoin_id OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'stablecoin_id'))
    AND (OLD.symbol = NEW.symbol OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'symbol'))
    AND (OLD.peg_type = NEW.peg_type OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'peg_type'))
    AND (OLD.direction = NEW.direction OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'direction'))
    AND (OLD.started_at = NEW.started_at OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'started_at'))
    AND (OLD.start_price = NEW.start_price OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'start_price'))
    AND (OLD.peg_reference = NEW.peg_reference OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'peg_reference'))
    AND (OLD.source = NEW.source OR EXISTS (SELECT 1 FROM json_each(a.columns_json) WHERE value = 'source'))
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'sealed depeg event identity updates require incident repair authorization');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_depeg_provenance_insert_invalidation_guard
BEFORE INSERT ON depeg_event_provenance
WHEN NEW.audit_verdict IN ('false_positive', 'disputed', 'no_data')
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    JOIN depeg_resolver_incident_event_links l
      ON l.incident_key = p.incident_key
     AND l.event_id = NEW.event_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
    JOIN depeg_resolver_prediction_errata er
      ON er.id = a.required_erratum_id
     AND er.incident_key = a.incident_key
    WHERE a.event_id = NEW.event_id
      AND a.operation = 'provenance_invalidation'
      AND a.expires_at >= unixepoch()
      AND NOT EXISTS (
        SELECT 1
        FROM depeg_resolver_event_repair_authorization_uses u
        WHERE u.authorization_id = a.id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'sealed provenance invalidation inserts require repair authorization and erratum');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_depeg_provenance_insert_invalidation_repair_use
AFTER INSERT ON depeg_event_provenance
WHEN NEW.audit_verdict IN ('false_positive', 'disputed', 'no_data')
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    JOIN depeg_resolver_incident_event_links l
      ON l.incident_key = p.incident_key
     AND l.event_id = NEW.event_id
  )
BEGIN
  INSERT INTO depeg_resolver_event_repair_authorization_uses
   (authorization_id, event_id, incident_key, operation, used_at, target_table, target_key)
  SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(),
         'depeg_event_provenance',
         CAST(NEW.event_id AS TEXT)
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  JOIN depeg_resolver_prediction_errata er
    ON er.id = a.required_erratum_id
   AND er.incident_key = a.incident_key
  WHERE a.event_id = NEW.event_id
    AND a.operation = 'provenance_invalidation'
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_depeg_provenance_invalidation_guard
BEFORE UPDATE OF audit_verdict ON depeg_event_provenance
WHEN NEW.audit_verdict IN ('false_positive', 'disputed', 'no_data')
  AND COALESCE(OLD.audit_verdict, '') != COALESCE(NEW.audit_verdict, '')
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    JOIN depeg_resolver_incident_event_links l
      ON l.incident_key = p.incident_key
     AND l.event_id = OLD.event_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
    JOIN depeg_resolver_prediction_errata er
      ON er.id = a.required_erratum_id
     AND er.incident_key = a.incident_key
    WHERE a.event_id = OLD.event_id
      AND a.operation = 'provenance_invalidation'
      AND a.expires_at >= unixepoch()
      AND NOT EXISTS (
        SELECT 1
        FROM depeg_resolver_event_repair_authorization_uses u
        WHERE u.authorization_id = a.id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'sealed provenance invalidations require repair authorization and erratum');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_depeg_provenance_invalidation_repair_use
AFTER UPDATE OF audit_verdict ON depeg_event_provenance
WHEN NEW.audit_verdict IN ('false_positive', 'disputed', 'no_data')
  AND COALESCE(OLD.audit_verdict, '') != COALESCE(NEW.audit_verdict, '')
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    JOIN depeg_resolver_incident_event_links l
      ON l.incident_key = p.incident_key
     AND l.event_id = OLD.event_id
  )
BEGIN
  INSERT INTO depeg_resolver_event_repair_authorization_uses
   (authorization_id, event_id, incident_key, operation, used_at, target_table, target_key)
  SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(),
         'depeg_event_provenance',
         CAST(OLD.event_id AS TEXT)
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  JOIN depeg_resolver_prediction_errata er
    ON er.id = a.required_erratum_id
   AND er.incident_key = a.incident_key
  WHERE a.event_id = OLD.event_id
    AND a.operation = 'provenance_invalidation'
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_lineage_no_delete
BEFORE DELETE ON depeg_resolver_incident_lineage
BEGIN
  SELECT RAISE(ABORT, 'incident lineage is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_lineage_no_update
BEFORE UPDATE ON depeg_resolver_incident_lineage
BEGIN
  SELECT RAISE(ABORT, 'incident lineage is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_link_sealed_repair_guard
BEFORE INSERT ON depeg_resolver_incident_event_links
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = NEW.incident_key
)
AND NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  WHERE a.id = NEW.repair_authorization_id
    AND a.event_id = NEW.event_id
    AND a.incident_key = NEW.incident_key
    AND a.operation = 'incident_link'
    AND a.expires_at >= unixepoch()
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'sealed incident links require consumed repair authorization');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_link_sealed_repair_use
AFTER INSERT ON depeg_resolver_incident_event_links
WHEN NEW.repair_authorization_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = NEW.incident_key
  )
BEGIN
  INSERT INTO depeg_resolver_event_repair_authorization_uses
   (authorization_id, event_id, incident_key, operation, used_at, target_table, target_key)
  SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(),
         'depeg_resolver_incident_event_links',
         NEW.incident_key || ':' || NEW.event_id
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  WHERE a.id = NEW.repair_authorization_id
    AND a.event_id = NEW.event_id
    AND a.incident_key = NEW.incident_key
    AND a.operation = 'incident_link'
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_links_no_delete
BEFORE DELETE ON depeg_resolver_incident_event_links
BEGIN
  SELECT RAISE(ABORT, 'incident event links are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_links_no_update
BEFORE UPDATE ON depeg_resolver_incident_event_links
BEGIN
  SELECT RAISE(ABORT, 'incident event links are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_policy_membership_no_delete
BEFORE DELETE ON depeg_resolver_incident_policy_membership
BEGIN
  SELECT RAISE(ABORT, 'incident policy membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_policy_membership_no_update
BEFORE UPDATE ON depeg_resolver_incident_policy_membership
BEGIN
  SELECT RAISE(ABORT, 'incident policy membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_revisions_no_delete
BEFORE DELETE ON depeg_resolver_incident_revisions
BEGIN
  SELECT RAISE(ABORT, 'incident revisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_revisions_no_update
BEFORE UPDATE ON depeg_resolver_incident_revisions
BEGIN
  SELECT RAISE(ABORT, 'incident revisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incidents_current_link_guard
BEFORE INSERT ON depeg_resolver_incidents
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_incident_event_links l
  WHERE l.incident_key = NEW.incident_key
    AND l.event_id = NEW.current_event_id
)
BEGIN
  SELECT RAISE(ABORT, 'incident current_event_id must have an incident link');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incidents_current_update_guard
BEFORE UPDATE OF current_event_id ON depeg_resolver_incidents
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_incident_event_links l
  WHERE l.incident_key = NEW.incident_key
    AND l.event_id = NEW.current_event_id
)
BEGIN
  SELECT RAISE(ABORT, 'incident current_event_id update must have an incident link');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incidents_identity_no_update
BEFORE UPDATE OF incident_key, stablecoin_id, peg_currency, direction, first_event_id, first_started_at, first_observed_peak_bucket_bps, source_fingerprint, created_at
ON depeg_resolver_incidents
BEGIN
  SELECT RAISE(ABORT, 'incident identity fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incidents_no_delete_when_sealed
BEFORE DELETE ON depeg_resolver_incidents
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
BEGIN
  SELECT RAISE(ABORT, 'sealed incidents cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incidents_sealed_current_update_guard
BEFORE UPDATE OF current_event_id, current_started_at, incident_state, superseded_by_incident_key
ON depeg_resolver_incidents
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
AND NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  JOIN depeg_resolver_incident_revisions r
    ON r.repair_authorization_id = a.id
   AND r.incident_key = OLD.incident_key
   AND r.previous_event_id = OLD.current_event_id
   AND r.current_event_id = NEW.current_event_id
  WHERE a.event_id = NEW.current_event_id
    AND a.incident_key = OLD.incident_key
    AND a.operation = 'incident_current_update'
    AND a.expires_at >= unixepoch()
    AND (a.required_revision_id IS NULL OR a.required_revision_id = r.id)
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'sealed incident current pointers/state require authorized revision');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incidents_sealed_current_update_use
AFTER UPDATE OF current_event_id, current_started_at, incident_state, superseded_by_incident_key
ON depeg_resolver_incidents
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
BEGIN
  INSERT INTO depeg_resolver_event_repair_authorization_uses
   (authorization_id, event_id, incident_key, operation, used_at, target_table, target_key)
  SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(),
         'depeg_resolver_incidents',
         OLD.incident_key
  FROM depeg_resolver_event_repair_authorizations a
  JOIN depeg_resolver_event_repair_authorization_consumptions c
    ON c.authorization_id = a.id
   AND c.event_id = a.event_id
   AND c.incident_key = a.incident_key
   AND c.operation = a.operation
  JOIN depeg_resolver_incident_revisions r
    ON r.repair_authorization_id = a.id
   AND r.incident_key = OLD.incident_key
   AND r.previous_event_id = OLD.current_event_id
   AND r.current_event_id = NEW.current_event_id
  WHERE a.event_id = NEW.current_event_id
    AND a.incident_key = OLD.incident_key
    AND a.operation = 'incident_current_update'
    AND (a.required_revision_id IS NULL OR a.required_revision_id = r.id)
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_event_repair_authorization_uses u
      WHERE u.authorization_id = a.id
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_opportunity_no_delete
BEFORE DELETE ON depeg_resolver_lock_opportunity_audit
BEGIN
  SELECT RAISE(ABORT, 'lock opportunity audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_opportunity_no_update
BEFORE UPDATE ON depeg_resolver_lock_opportunity_audit
BEGIN
  SELECT RAISE(ABORT, 'lock opportunity audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_no_delete
BEFORE DELETE ON depeg_resolver_prediction_lock_state
BEGIN
  SELECT RAISE(ABORT, 'lock state is durable and cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_preseal_transition_guard
BEFORE UPDATE OF incident_key, event_id, prediction_policy_version, eligible_at, first_eligible_seen_at, deferral_count, last_state, created_at
ON depeg_resolver_prediction_lock_state
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
AND NOT (
  NEW.incident_key = OLD.incident_key
  AND NEW.event_id = OLD.event_id
  AND NEW.prediction_policy_version = OLD.prediction_policy_version
  AND NEW.eligible_at = OLD.eligible_at
  AND (OLD.first_eligible_seen_at IS NULL OR NEW.first_eligible_seen_at = OLD.first_eligible_seen_at)
  AND (OLD.last_attempted_at IS NULL OR NEW.last_attempted_at IS NULL OR NEW.last_attempted_at >= OLD.last_attempted_at)
  AND NEW.deferral_count >= OLD.deferral_count
  AND (
    (OLD.last_state = 'pending_lock' AND NEW.last_state IN ('pending_lock', 'lock_deferred', 'frozen', 'no_call'))
    OR (OLD.last_state = 'lock_deferred' AND NEW.last_state IN ('lock_deferred', 'frozen', 'no_call'))
    OR (OLD.last_state = 'frozen' AND NEW.last_state IN ('frozen', 'publication_retry_pending', 'published'))
    OR (OLD.last_state = 'no_call' AND NEW.last_state IN ('no_call', 'publication_retry_pending', 'published'))
    OR (OLD.last_state = 'publication_retry_pending' AND NEW.last_state IN ('publication_retry_pending', 'published', 'publication_failed'))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'pre-seal lock-state transition is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_sealed_fields_no_update
BEFORE UPDATE OF incident_key, prediction_policy_version, eligible_at, created_at
ON depeg_resolver_prediction_lock_state
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
BEGIN
  SELECT RAISE(ABORT, 'sealed lock-state identity fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_sealed_policy_metadata_no_update
BEFORE UPDATE OF lock_trigger, forecast_readiness_score, forecast_readiness_version, readiness_threshold, backstop_at, backstop_delay_sec
ON depeg_resolver_prediction_lock_state
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
AND NOT (
  NEW.lock_trigger IS OLD.lock_trigger
  AND NEW.forecast_readiness_score IS OLD.forecast_readiness_score
  AND NEW.forecast_readiness_version IS OLD.forecast_readiness_version
  AND NEW.readiness_threshold IS OLD.readiness_threshold
  AND NEW.backstop_at IS OLD.backstop_at
  AND NEW.backstop_delay_sec IS OLD.backstop_delay_sec
)
BEGIN
  SELECT RAISE(ABORT, 'sealed lock-state policy metadata is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_sealed_transition_guard
BEFORE UPDATE OF event_id, last_state, deferral_count, last_deferral_reason
ON depeg_resolver_prediction_lock_state
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
AND NOT (
  NEW.event_id = OLD.event_id
  AND NEW.deferral_count = OLD.deferral_count
  AND COALESCE(NEW.last_deferral_reason, '') = COALESCE(OLD.last_deferral_reason, '')
  AND OLD.last_state IN ('frozen', 'no_call', 'publication_retry_pending', 'publication_failed')
  AND NEW.last_state IN ('publication_retry_pending', 'publication_failed', 'published')
  AND NOT (OLD.last_state = 'publication_failed' AND NEW.last_state != 'publication_failed')
)
BEGIN
  SELECT RAISE(ABORT, 'sealed lock-state may only transition through retry, final failure, or published');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_assessment_guard
BEFORE INSERT ON depeg_resolver_prediction_errata
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.id = NEW.public_prediction_id
    AND p.assessment_id = NEW.assessment_id
    AND p.incident_key = NEW.incident_key
    AND p.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'errata must reference a matching sealed public prediction');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_no_delete
BEFORE DELETE ON depeg_resolver_prediction_errata
BEGIN
  SELECT RAISE(ABORT, 'prediction errata are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_no_self_replacement
BEFORE INSERT ON depeg_resolver_prediction_errata
WHEN NEW.replacement_assessment_id IS NOT NULL
  AND NEW.replacement_assessment_id = NEW.assessment_id
BEGIN
  SELECT RAISE(ABORT, 'replacement_assessment_id cannot self-reference');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_no_update
BEFORE UPDATE ON depeg_resolver_prediction_errata
BEGIN
  SELECT RAISE(ABORT, 'prediction errata are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_replacement_guard
BEFORE INSERT ON depeg_resolver_prediction_errata
WHEN NEW.replacement_assessment_id IS NOT NULL
  AND (
    NEW.replacement_row_hash IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_assessments a
      WHERE a.id = NEW.replacement_assessment_id
        AND a.checkpoint != 'latest'
        AND json_valid(a.row_json)
        AND (
          a.checkpoint != 'public_prediction'
          OR EXISTS (
            SELECT 1
            FROM depeg_resolver_public_predictions replacement
            WHERE replacement.assessment_id = NEW.replacement_assessment_id
              AND replacement.incident_key != NEW.incident_key
          )
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'replacement_assessment_id must reference immutable evidence or a different sealed incident and carry replacement_row_hash');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_prediction_no_delete
BEFORE DELETE ON depeg_resolver_assessments
WHEN OLD.checkpoint = 'public_prediction'
BEGIN
  SELECT RAISE(ABORT, 'public_prediction assessments are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_prediction_no_update
BEFORE UPDATE ON depeg_resolver_assessments
WHEN OLD.checkpoint = 'public_prediction' OR NEW.checkpoint = 'public_prediction'
BEGIN
  SELECT RAISE(ABORT, 'public_prediction assessments are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_lock_policy_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_events e
  WHERE e.id = NEW.event_id
    AND (
      (
        (NEW.lock_trigger IS NULL OR NEW.lock_trigger = 'scheduled_24h')
        AND NEW.eligible_at = e.started_at + NEW.policy_delay_sec
      )
      OR (
        NEW.lock_trigger = 'forecast_readiness'
        AND NEW.forecast_readiness_score IS NOT NULL
        AND NEW.forecast_readiness_version IS NOT NULL
        AND NEW.readiness_threshold IS NOT NULL
        AND NEW.eligible_at = e.started_at + NEW.policy_delay_sec
        AND (
          NEW.backstop_at IS NULL
          OR (
            NEW.backstop_delay_sec IS NOT NULL
            AND NEW.backstop_delay_sec = 259200
            AND NEW.backstop_at = e.started_at + NEW.backstop_delay_sec
          )
        )
      )
      OR (
        NEW.lock_trigger = 'readiness_backstop'
        AND NEW.backstop_at IS NOT NULL
        AND NEW.backstop_delay_sec IS NOT NULL
        AND NEW.backstop_delay_sec = 259200
        AND NEW.backstop_at = e.started_at + NEW.backstop_delay_sec
        AND NEW.eligible_at = NEW.backstop_at
        AND NEW.policy_delay_sec = NEW.backstop_delay_sec
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction lock policy metadata is inconsistent');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_no_call_kind_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NEW.outcome_kind = 'no_call'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_assessments a
    WHERE a.id = NEW.assessment_id
      AND json_extract(a.row_json, '$.kind') = 'no_call'
      AND a.resolution_tier = 'insufficient_signal'
      AND a.duration_suppressed = 1
      AND a.duration_suppressed_reason = 'insufficient_signal'
      AND a.median_remaining_sec IS NULL
      AND a.iqr_low_remaining_sec IS NULL
      AND a.iqr_high_remaining_sec IS NULL
      AND a.stratum IS NULL
      AND a.horizons_json = '[]'
      AND a.factors_json = '[]'
  )
BEGIN
  SELECT RAISE(ABORT, 'sealed no-call payload kind must match insufficient-signal assessment');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_no_delete
BEFORE DELETE ON depeg_resolver_public_predictions
BEGIN
  SELECT RAISE(ABORT, 'sealed public predictions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_no_update
BEFORE UPDATE ON depeg_resolver_public_predictions
BEGIN
  SELECT RAISE(ABORT, 'sealed public predictions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_payload_identity_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_assessments a
  JOIN depeg_resolver_incidents i
    ON i.incident_key = NEW.incident_key
  WHERE a.id = NEW.assessment_id
    AND json_extract(a.row_json, '$.eventId') = NEW.event_id
    AND json_extract(a.row_json, '$.incidentKey') = NEW.incident_key
    AND json_extract(a.row_json, '$.stablecoinId') = i.stablecoin_id
    AND json_extract(a.row_json, '$.pegCurrency') = i.peg_currency
    AND json_extract(a.row_json, '$.direction') = i.direction
    AND json_extract(a.row_json, '$.startedAt') = i.current_started_at
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction payload identity must match incident identity');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_payload_lock_metadata_match
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT (
  (
    NEW.lock_trigger IS json_extract(NEW.sealed_payload_json, '$.prediction.lockTrigger')
    OR (
      (NEW.lock_trigger IS NULL OR NEW.lock_trigger = 'scheduled_24h')
      AND json_extract(NEW.sealed_payload_json, '$.prediction.lockTrigger') IS NULL
    )
    OR (
      NEW.lock_trigger IS NULL
      AND json_extract(NEW.sealed_payload_json, '$.prediction.lockTrigger') = 'scheduled_24h'
    )
  )
  AND NEW.forecast_readiness_score IS json_extract(NEW.sealed_payload_json, '$.prediction.readiness.score')
  AND NEW.forecast_readiness_version IS json_extract(NEW.sealed_payload_json, '$.prediction.readiness.version')
  AND NEW.readiness_threshold IS json_extract(NEW.sealed_payload_json, '$.prediction.readiness.threshold')
  AND NEW.backstop_at IS json_extract(NEW.sealed_payload_json, '$.prediction.backstop.backstopAt')
  AND NEW.backstop_delay_sec IS json_extract(NEW.sealed_payload_json, '$.prediction.backstop.delaySec')
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction lock metadata does not match payload');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_payload_prediction_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_assessments a
  WHERE a.id = NEW.assessment_id
    AND json_extract(a.row_json, '$.prediction.eligibleAt') = NEW.eligible_at
    AND json_extract(a.row_json, '$.prediction.lockedAt') = NEW.locked_at
    AND json_extract(a.row_json, '$.prediction.eventAgeAtLockSec') = NEW.event_age_at_lock_sec
    AND json_extract(a.row_json, '$.prediction.lockTiming') = NEW.lock_timing
    AND json_extract(a.row_json, '$.prediction.policyDelaySec') = NEW.policy_delay_sec
    AND json_extract(a.row_json, '$.prediction.predictionPolicyVersion') = NEW.prediction_policy_version
    AND json_extract(a.row_json, '$.prediction.predictionMethodologyVersion') = NEW.prediction_methodology_version
    AND json_extract(a.row_json, '$.prediction.resolutionRubricVersion') = NEW.resolution_rubric_version
    AND json_extract(a.row_json, '$.prediction.durationModelVersion') = NEW.duration_model_version
    AND json_extract(a.row_json, '$.prediction.incidentGroupingVersion') = NEW.incident_grouping_version
    AND json_extract(a.row_json, '$.prediction.supportRulesVersion') = NEW.support_rules_version
    AND json_extract(a.row_json, '$.prediction.rowHash') = NEW.row_hash
    AND NEW.sealed_payload_json = a.row_json
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction payload prediction fields must match public prediction fields');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_prediction_kind_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NEW.outcome_kind = 'prediction'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_assessments a
    WHERE a.id = NEW.assessment_id
      AND json_extract(a.row_json, '$.kind') = 'prediction'
  )
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction payload kind must match prediction outcome');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_relational_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_assessments a
  JOIN depeg_events e
    ON e.id = NEW.event_id
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = NEW.incident_key
   AND l.event_id = NEW.event_id
  JOIN depeg_resolver_incidents i
    ON i.incident_key = NEW.incident_key
  JOIN depeg_resolver_incident_policy_membership m
    ON m.incident_key = NEW.incident_key
  WHERE a.id = NEW.assessment_id
    AND a.event_id = NEW.event_id
    AND a.checkpoint = 'public_prediction'
    AND json_valid(a.row_json)
    AND json_valid(a.horizons_json)
    AND json_valid(a.factors_json)
    AND a.assessed_at = NEW.locked_at
    AND a.stablecoin_id = e.stablecoin_id
    AND a.peg_currency = CASE WHEN e.peg_type LIKE 'pegged%' THEN substr(e.peg_type, 7) ELSE 'USD' END
    AND a.direction = e.direction
    AND a.started_at = e.started_at
    AND a.event_age_sec = NEW.event_age_at_lock_sec
    AND e.ended_at IS NULL
    AND i.current_event_id = NEW.event_id
    AND l.relation IN ('observed', 'repair_replacement')
    AND m.policy_universe_included = 1
    AND m.prediction_policy_version = NEW.prediction_policy_version
    AND NEW.event_age_at_lock_sec = NEW.locked_at - e.started_at
    AND NEW.eligible_at = e.started_at + NEW.policy_delay_sec
    AND i.stablecoin_id = e.stablecoin_id
    AND i.peg_currency = CASE WHEN e.peg_type LIKE 'pegged%' THEN substr(e.peg_type, 7) ELSE 'USD' END
    AND i.direction = e.direction
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction must reference a linked public_prediction assessment');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_version_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_assessments a
  WHERE a.id = NEW.assessment_id
    AND a.methodology_version = NEW.prediction_methodology_version
    AND a.methodology_version_label = NEW.prediction_methodology_version_label
    AND a.resolution_rubric_version = NEW.resolution_rubric_version
    AND a.duration_model_version = NEW.duration_model_version
    AND a.incident_grouping_version = NEW.incident_grouping_version
    AND a.support_rules_version = NEW.support_rules_version
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction assessment versions must match public prediction versions');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_finalization_guard
BEFORE INSERT ON depeg_resolver_publication_snapshot_finalizations
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_publication_snapshots s
  WHERE s.snapshot_token = NEW.snapshot_token
    AND s.public_prediction_count = (
      SELECT COUNT(*)
      FROM depeg_resolver_publication_snapshot_rows r
      WHERE r.snapshot_token = NEW.snapshot_token
    )
    AND s.base_row_count = json_array_length(json_extract(s.base_payload_json, '$.rows'))
    AND s.base_payload_hash = NEW.validated_base_payload_hash
    AND s.public_prediction_ids_hash = NEW.validated_public_prediction_ids_hash
    AND s.public_prediction_row_hashes_json = NEW.validated_public_prediction_row_hashes_json
    AND s.base_row_count = NEW.validated_base_row_count
    AND s.public_prediction_count = NEW.validated_public_prediction_count
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(s.public_prediction_ids_json) expected
      WHERE NOT EXISTS (
        SELECT 1
        FROM depeg_resolver_publication_snapshot_rows r
        WHERE r.snapshot_token = s.snapshot_token
          AND r.public_prediction_id = CAST(expected.value AS INTEGER)
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_publication_snapshot_rows r
      WHERE r.snapshot_token = s.snapshot_token
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(s.public_prediction_ids_json) expected
          WHERE CAST(expected.value AS INTEGER) = r.public_prediction_id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_public_predictions p
      JOIN depeg_resolver_publication_snapshot_rows r
        ON r.public_prediction_id = p.id
       AND r.snapshot_token = s.snapshot_token
      WHERE json_extract(s.public_prediction_row_hashes_json, '$."' || p.id || '"') IS NULL
         OR json_extract(s.public_prediction_row_hashes_json, '$."' || p.id || '"') != p.row_hash
    )
)
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot cannot finalize until declared ids, rows, and row hashes match');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_finalizations_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshot_finalizations
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot finalizations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_finalizations_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshot_finalizations
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot finalizations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_declared_set_guard
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_publication_snapshots s,
       json_each(s.public_prediction_ids_json) j
  WHERE s.snapshot_token = NEW.snapshot_token
    AND CAST(j.value AS INTEGER) = NEW.public_prediction_id
)
BEGIN
  SELECT RAISE(ABORT, 'publication row must be declared in snapshot id set');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_first_required
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NEW.first_published = 0
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_publication_snapshot_rows r
    WHERE r.public_prediction_id = NEW.public_prediction_id
  )
BEGIN
  SELECT RAISE(ABORT, 'first appearance must use first_published = 1');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshot_rows
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot rows are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_no_insert_after_finalize
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_publication_snapshot_finalizations f
  WHERE f.snapshot_token = NEW.snapshot_token
)
BEGIN
  SELECT RAISE(ABORT, 'cannot add rows to a finalized publication snapshot');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_no_second_first
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NEW.first_published = 1
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_publication_snapshot_rows r
    WHERE r.public_prediction_id = NEW.public_prediction_id
  )
BEGIN
  SELECT RAISE(ABORT, 'already-published prediction cannot be first-published again');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshot_rows
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot rows are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_prediction_guard
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.id = NEW.public_prediction_id
    AND p.incident_key = NEW.incident_key
)
BEGIN
  SELECT RAISE(ABORT, 'publication row must reference a sealed public prediction with matching incident_key');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_snapshot_guard
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_publication_snapshots s
  WHERE s.snapshot_token = NEW.snapshot_token
)
BEGIN
  SELECT RAISE(ABORT, 'publication row must reference an existing publication snapshot');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshot_errata_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshot_errata
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot errata are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshot_errata_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshot_errata
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot errata are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshots_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshots
BEGIN
  SELECT RAISE(ABORT, 'publication snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshots_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshots
BEGIN
  SELECT RAISE(ABORT, 'publication snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_authorization_uses_no_delete
BEFORE DELETE ON depeg_resolver_event_repair_authorization_uses
BEGIN
  SELECT RAISE(ABORT, 'repair authorization uses are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_authorization_uses_no_update
BEFORE UPDATE ON depeg_resolver_event_repair_authorization_uses
BEGIN
  SELECT RAISE(ABORT, 'repair authorization uses are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_authorizations_no_delete
BEFORE DELETE ON depeg_resolver_event_repair_authorizations
BEGIN
  SELECT RAISE(ABORT, 'repair authorizations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_authorizations_no_update
BEFORE UPDATE ON depeg_resolver_event_repair_authorizations
BEGIN
  SELECT RAISE(ABORT, 'repair authorizations are immutable; consume through the consumption ledger');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_consumptions_no_delete
BEFORE DELETE ON depeg_resolver_event_repair_authorization_consumptions
BEGIN
  SELECT RAISE(ABORT, 'repair authorization consumptions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_consumptions_no_update
BEFORE UPDATE ON depeg_resolver_event_repair_authorization_consumptions
BEGIN
  SELECT RAISE(ABORT, 'repair authorization consumptions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_close_reason_insert
BEFORE INSERT ON depeg_events
FOR EACH ROW
WHEN NEW.close_reason IS NOT NULL
 AND NEW.close_reason NOT IN (
   'recovered-primary',
   'recovered-dex',
   'recovered-native',
   'coverage-lost-supply',
   'superseded-direction',
   'orphan-tracking-removed'
 )
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.close_reason is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_close_reason_update
BEFORE UPDATE OF close_reason ON depeg_events
FOR EACH ROW
WHEN NEW.close_reason IS NOT NULL
 AND NEW.close_reason NOT IN (
   'recovered-primary',
   'recovered-dex',
   'recovered-native',
   'coverage-lost-supply',
   'superseded-direction',
   'orphan-tracking-removed'
 )
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.close_reason is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_direction_insert
BEFORE INSERT ON depeg_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_direction_update
BEFORE UPDATE OF direction ON depeg_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_source_insert
BEFORE INSERT ON depeg_events
FOR EACH ROW
WHEN NEW.source NOT IN ('live', 'backfill')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.source must be live|backfill');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_source_update
BEFORE UPDATE OF source ON depeg_events
FOR EACH ROW
WHEN NEW.source NOT IN ('live', 'backfill')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.source must be live|backfill');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_pending_direction_insert
BEFORE INSERT ON depeg_pending
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_pending.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_pending_direction_update
BEFORE UPDATE OF direction ON depeg_pending
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_pending.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_amount_insert
BEFORE INSERT ON mint_burn_events
FOR EACH ROW
WHEN NEW.amount < 0 OR (NEW.amount_usd IS NOT NULL AND NEW.amount_usd < 0)
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events amounts must be non-negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_amount_update
BEFORE UPDATE OF amount, amount_usd ON mint_burn_events
FOR EACH ROW
WHEN NEW.amount < 0 OR (NEW.amount_usd IS NOT NULL AND NEW.amount_usd < 0)
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events amounts must be non-negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_direction_insert
BEFORE INSERT ON mint_burn_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('mint', 'burn')
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events.direction must be mint|burn');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_direction_update
BEFORE UPDATE OF direction ON mint_burn_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('mint', 'burn')
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events.direction must be mint|burn');
END;

CREATE TRIGGER IF NOT EXISTS trg_tadl_assign_dead_letter_key
AFTER INSERT ON telegram_alert_dead_letters
WHEN NEW.dead_letter_key IS NULL
BEGIN
  UPDATE telegram_alert_dead_letters
     SET dead_letter_key = 'legacy:' || NEW.id
   WHERE id = NEW.id
     AND NEW.pending_id IS NULL;

  UPDATE telegram_alert_dead_letters
     SET dead_letter_key = 'pending:' || NEW.pending_id || ':delivery:0'
   WHERE id = NEW.id
     AND NEW.pending_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM telegram_alert_dead_letters existing
        WHERE existing.id <> NEW.id
          AND existing.dead_letter_key = 'pending:' || NEW.pending_id || ':delivery:0'
     );

  UPDATE telegram_alert_dead_letters
     SET dead_letter_key = 'legacy-duplicate:' || NEW.id
   WHERE id = NEW.id
     AND dead_letter_key IS NULL;
END;

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

CREATE TRIGGER IF NOT EXISTS trg_telegram_webhook_operation_mutation_applied
AFTER INSERT ON telegram_webhook_operation_mutations
BEGIN
  UPDATE telegram_processed_updates
     SET mutation_applied_at = NEW.applied_at
   WHERE update_id = NEW.update_id
     AND claim_generation = NEW.claim_generation;
END;

CREATE TRIGGER IF NOT EXISTS trg_telegram_webhook_operation_mutation_guard
BEFORE INSERT ON telegram_webhook_operation_mutations
WHEN NOT EXISTS (
  SELECT 1
    FROM telegram_processed_updates
   WHERE update_id = NEW.update_id
     AND status = 'processing'
     AND effect_state = 'planned'
     AND intent_mutates = 1
     AND claim_generation = NEW.claim_generation
)
BEGIN
  SELECT RAISE(ABORT, 'invalid telegram webhook mutation claim');
END;

CREATE VIEW IF NOT EXISTS depeg_events_with_provenance AS
SELECT
  e.*,
  p.public_json AS provenance_json,
  p.confidence_tier AS provenance_confidence_tier,
  p.audit_verdict AS provenance_audit_verdict,
  p.replay_run_id AS provenance_replay_run_id,
  p.replay_version AS provenance_replay_version
FROM depeg_events e
LEFT JOIN depeg_event_provenance p ON p.event_id = e.id;

-- Required fresh-database seed rows from the original replay.
INSERT OR IGNORE INTO blacklist_sync_state VALUES('gnosis-0x0a06c8354a6cc1a07549a38701eac205942e3ac6',33257602,'evm_block',33257602,0,NULL,NULL,NULL,NULL,0,0,NULL,NULL,NULL);
INSERT OR IGNORE INTO telegram_transport_circuit VALUES(1,'closed',0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0);
