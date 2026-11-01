-- rollout-safety: backward-compatible
-- The public depeg page resolves each event's effective incident onset from the
-- incident that owns the event and from the canonical incident's chosen
-- superseded alias. Both are per-row lookups; without these access paths the
-- page scans the incident table once per event row and again per canonical.
CREATE INDEX IF NOT EXISTS idx_ddr_incident_current_event_all
  ON depeg_resolver_incidents(current_event_id);

CREATE INDEX IF NOT EXISTS idx_ddr_incident_superseded_alias
  ON depeg_resolver_incidents(
    superseded_by_incident_key,
    incident_state,
    current_started_at DESC,
    current_event_id DESC
  );
