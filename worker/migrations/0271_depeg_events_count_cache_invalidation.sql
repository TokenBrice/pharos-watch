-- rollout-safety: backward-compatible
-- data-migration: reviewed
-- No backfill or business-row changes. Old Workers remain compatible.
-- D1 uses SQLite CREATE TRIGGER IF NOT EXISTS, as do the existing DDR guards.
-- The cache key must match DEPEG_EVENTS_COUNT_CACHE_KEY in depeg-events-count-cache.ts.

CREATE TRIGGER IF NOT EXISTS trg_depeg_count_events_insert
AFTER INSERT ON depeg_events
BEGIN
  DELETE FROM cache WHERE key = 'depeg-events:counts:v1';
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_count_events_delete
AFTER DELETE ON depeg_events
BEGIN
  DELETE FROM cache WHERE key = 'depeg-events:counts:v1';
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_count_events_update
AFTER UPDATE OF id, stablecoin_id, ended_at ON depeg_events
WHEN OLD.id IS NOT NEW.id OR OLD.stablecoin_id IS NOT NEW.stablecoin_id
  OR (OLD.ended_at IS NULL) != (NEW.ended_at IS NULL)
BEGIN
  DELETE FROM cache WHERE key = 'depeg-events:counts:v1';
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_count_incidents_insert
AFTER INSERT ON depeg_resolver_incidents
BEGIN
  DELETE FROM cache WHERE key = 'depeg-events:counts:v1';
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_count_incidents_delete
AFTER DELETE ON depeg_resolver_incidents
BEGIN
  DELETE FROM cache WHERE key = 'depeg-events:counts:v1';
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_count_incidents_update
AFTER UPDATE OF incident_key, current_event_id, incident_state, superseded_by_incident_key
ON depeg_resolver_incidents
WHEN OLD.incident_key IS NOT NEW.incident_key OR OLD.current_event_id IS NOT NEW.current_event_id
  OR OLD.incident_state IS NOT NEW.incident_state
  OR OLD.superseded_by_incident_key IS NOT NEW.superseded_by_incident_key
BEGIN
  DELETE FROM cache WHERE key = 'depeg-events:counts:v1';
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_count_links_insert
AFTER INSERT ON depeg_resolver_incident_event_links
BEGIN
  DELETE FROM cache WHERE key = 'depeg-events:counts:v1';
END;

-- Existing append-only guards reject link UPDATE/DELETE. These invalidators
-- also cover an explicitly authorized future maintenance path without weakening guards.
CREATE TRIGGER IF NOT EXISTS trg_depeg_count_links_delete
AFTER DELETE ON depeg_resolver_incident_event_links
BEGIN
  DELETE FROM cache WHERE key = 'depeg-events:counts:v1';
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_count_links_update
AFTER UPDATE OF incident_key, event_id ON depeg_resolver_incident_event_links
WHEN OLD.incident_key IS NOT NEW.incident_key OR OLD.event_id IS NOT NEW.event_id
BEGIN
  DELETE FROM cache WHERE key = 'depeg-events:counts:v1';
END;
