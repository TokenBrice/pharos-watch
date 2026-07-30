-- rollout-safety: backward-compatible
-- DDRv2 canonical incident identity, lineage, policy membership, and repair authorization ledgers.
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

CREATE TABLE IF NOT EXISTS depeg_resolver_incident_event_links (
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('observed', 'superseded', 'merged', 'split_from', 'repair_replacement')),
  repair_authorization_id INTEGER,
  linked_at INTEGER NOT NULL CHECK (linked_at > 0),
  note TEXT,
  PRIMARY KEY (incident_key, event_id)
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_incident_event_single_incident
  ON depeg_resolver_incident_event_links(event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_incident_current_event
  ON depeg_resolver_incidents(current_event_id);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_match
  ON depeg_resolver_incidents(stablecoin_id, peg_currency, direction, first_started_at);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_policy_lookup
  ON depeg_resolver_incident_policy_membership(prediction_policy_version, policy_universe_included, stablecoin_id);

CREATE INDEX IF NOT EXISTS idx_ddr_repair_auth_scope
  ON depeg_resolver_event_repair_authorizations(event_id, incident_key, operation, expires_at);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_revisions_incident
  ON depeg_resolver_incident_revisions(incident_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_lineage_from
  ON depeg_resolver_incident_lineage(from_incident_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_lineage_to
  ON depeg_resolver_incident_lineage(to_incident_key, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_links_no_update
BEFORE UPDATE ON depeg_resolver_incident_event_links
BEGIN
  SELECT RAISE(ABORT, 'incident event links are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_links_no_delete
BEFORE DELETE ON depeg_resolver_incident_event_links
BEGIN
  SELECT RAISE(ABORT, 'incident event links are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_revisions_no_update
BEFORE UPDATE ON depeg_resolver_incident_revisions
BEGIN
  SELECT RAISE(ABORT, 'incident revisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_revisions_no_delete
BEFORE DELETE ON depeg_resolver_incident_revisions
BEGIN
  SELECT RAISE(ABORT, 'incident revisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_lineage_no_update
BEFORE UPDATE ON depeg_resolver_incident_lineage
BEGIN
  SELECT RAISE(ABORT, 'incident lineage is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_lineage_no_delete
BEFORE DELETE ON depeg_resolver_incident_lineage
BEGIN
  SELECT RAISE(ABORT, 'incident lineage is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_policy_membership_no_update
BEFORE UPDATE ON depeg_resolver_incident_policy_membership
BEGIN
  SELECT RAISE(ABORT, 'incident policy membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_policy_membership_no_delete
BEFORE DELETE ON depeg_resolver_incident_policy_membership
BEGIN
  SELECT RAISE(ABORT, 'incident policy membership is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_authorizations_no_update
BEFORE UPDATE ON depeg_resolver_event_repair_authorizations
BEGIN
  SELECT RAISE(ABORT, 'repair authorizations are immutable; consume through the consumption ledger');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_authorizations_no_delete
BEFORE DELETE ON depeg_resolver_event_repair_authorizations
BEGIN
  SELECT RAISE(ABORT, 'repair authorizations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_consumptions_no_update
BEFORE UPDATE ON depeg_resolver_event_repair_authorization_consumptions
BEGIN
  SELECT RAISE(ABORT, 'repair authorization consumptions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_consumptions_no_delete
BEFORE DELETE ON depeg_resolver_event_repair_authorization_consumptions
BEGIN
  SELECT RAISE(ABORT, 'repair authorization consumptions are append-only');
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
