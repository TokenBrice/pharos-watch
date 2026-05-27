-- rollout-safety: backward-compatible
-- DDRv2 guarded repairs for sealed incidents and source event identity.
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

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_authorization_uses_no_update
BEFORE UPDATE ON depeg_resolver_event_repair_authorization_uses
BEGIN
  SELECT RAISE(ABORT, 'repair authorization uses are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_repair_authorization_uses_no_delete
BEFORE DELETE ON depeg_resolver_event_repair_authorization_uses
BEGIN
  SELECT RAISE(ABORT, 'repair authorization uses are append-only');
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
