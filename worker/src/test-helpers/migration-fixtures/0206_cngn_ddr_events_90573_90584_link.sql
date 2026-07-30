-- rollout-safety: backward-compatible
-- Link the three reviewed cNGN recovered live flaps to the active, unsealed
-- canonical incident and advance its source pointer through each event in order.

-- Create all three link authorizations only when the complete reviewed source
-- fingerprint and the post-0203 canonical state still match production.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  target.event_id,
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  'incident_link',
  '["event_id","incident_key"]',
  NULL,
  NULL,
  target.reason,
  unixepoch(),
  4102444800,
  'migration-0206'
FROM (
  SELECT
    90573 AS event_id,
    'cNGN recovered live flap 90573 belongs to the unsealed event 90511 canonical incident' AS reason
  UNION ALL
  SELECT
    90576,
    'cNGN recovered live flap 90576 belongs to the unsealed event 90511 canonical incident'
  UNION ALL
  SELECT
    90584,
    'cNGN recovered live flap 90584 belongs to the unsealed event 90511 canonical incident'
) target
WHERE 3 = (
    SELECT COUNT(*)
    FROM depeg_events e
    WHERE (
        e.id = 90573
        AND e.stablecoin_id = 'cngn-compliant-naira'
        AND e.symbol = 'cNGN'
        AND e.peg_type = 'peggedNGN'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -151
        AND e.started_at = 1784085475
        AND e.ended_at = 1784089078
        AND e.start_price = 0.985015
        AND e.peak_price = 0.984898
        AND e.recovery_price = 0.985054
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
      OR (
        e.id = 90576
        AND e.stablecoin_id = 'cngn-compliant-naira'
        AND e.symbol = 'cNGN'
        AND e.peg_type = 'peggedNGN'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -151
        AND e.started_at = 1784089988
        AND e.ended_at = 1784098070
        AND e.start_price = 0.984992
        AND e.peak_price = 0.984903
        AND e.recovery_price = 0.985182
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
      OR (
        e.id = 90584
        AND e.stablecoin_id = 'cngn-compliant-naira'
        AND e.symbol = 'cNGN'
        AND e.peg_type = 'peggedNGN'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -150
        AND e.started_at = 1784108016
        AND e.ended_at = 1784108885
        AND e.start_price = 0.98504
        AND e.peak_price = 0.98504
        AND e.recovery_price = 0.985101
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.stablecoin_id = 'cngn-compliant-naira'
      AND i.peg_currency = 'NGN'
      AND i.direction = 'below'
      AND i.first_event_id = 90511
      AND i.current_event_id = 90548
      AND i.first_started_at = 1783650896
      AND i.current_started_at = 1783946864
      AND i.first_observed_peak_bucket_bps = 150
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
      AND i.source_fingerprint = 'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links first_link
    WHERE first_link.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND first_link.event_id = 90511
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links current_link
    JOIN depeg_resolver_event_repair_authorizations prior_auth
      ON prior_auth.id = current_link.repair_authorization_id
     AND prior_auth.event_id = current_link.event_id
     AND prior_auth.incident_key = current_link.incident_key
     AND prior_auth.operation = 'incident_link'
     AND prior_auth.created_by = 'migration-0203'
    JOIN depeg_resolver_event_repair_authorization_consumptions prior_consumption
      ON prior_consumption.authorization_id = prior_auth.id
     AND prior_consumption.event_id = prior_auth.event_id
     AND prior_consumption.incident_key = prior_auth.incident_key
     AND prior_consumption.operation = prior_auth.operation
    WHERE current_link.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND current_link.event_id = 90548
  )
  AND 3 = (
    SELECT COUNT(*)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90573', '90576', '90584')
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id IN (90573, 90576, 90584)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = target.event_id
      AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0206'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0206'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90573, 90576, 90584)
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0206'
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    WHERE complete.event_id IN (90573, 90576, 90584)
      AND complete.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND complete.operation = 'incident_link'
      AND complete.created_by = 'migration-0206'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  a.incident_key,
  a.event_id,
  'repair_replacement',
  a.id,
  unixepoch(),
  'recovered cNGN live flap linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE a.event_id IN (90573, 90576, 90584)
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0206'
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    JOIN depeg_resolver_event_repair_authorization_consumptions consumed
      ON consumed.authorization_id = complete.id
     AND consumed.event_id = complete.event_id
     AND consumed.incident_key = complete.incident_key
     AND consumed.operation = complete.operation
    WHERE complete.event_id IN (90573, 90576, 90584)
      AND complete.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND complete.operation = 'incident_link'
      AND complete.created_by = 'migration-0206'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = a.event_id
  );

-- Advance 90548 -> 90573.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  90573,
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  'reviewed cNGN live flap 90573 follows event 90548 as the canonical current source',
  unixepoch(),
  4102444800,
  'migration-0206'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90548
      AND i.current_started_at = 1783946864
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0206'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id IN (90573, 90576, 90584)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90573
      AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0206'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0206'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90573
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0206'
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
   erratum_id, created_at, created_by)
SELECT
  a.incident_key,
  90548,
  90573,
  'reviewed cNGN live flap 90573 adopted after event 90548',
  a.id,
  NULL,
  unixepoch(),
  'migration-0206'
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE a.event_id = 90573
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0206'
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = a.incident_key
      AND i.current_event_id = 90548
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = a.incident_key
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = a.incident_key
      AND r.previous_event_id = 90548
      AND r.current_event_id = 90573
      AND r.created_by = 'migration-0206'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90573,
    current_started_at = 1784085475,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND current_event_id = 90548
  AND current_started_at = 1783946864
  AND incident_state = 'active'
  AND superseded_by_incident_key IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = r.repair_authorization_id
     AND a.operation = 'incident_current_update'
     AND a.created_by = 'migration-0206'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90548
      AND r.current_event_id = 90573
      AND r.created_by = 'migration-0206'
  );

-- Advance 90573 -> 90576.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  90576,
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  'reviewed cNGN live flap 90576 follows event 90573 as the canonical current source',
  unixepoch(),
  4102444800,
  'migration-0206'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90573
      AND i.current_started_at = 1784085475
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90548
      AND r.current_event_id = 90573
      AND r.created_by = 'migration-0206'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90576
      AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0206'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0206'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90576
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0206'
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
   erratum_id, created_at, created_by)
SELECT
  a.incident_key,
  90573,
  90576,
  'reviewed cNGN live flap 90576 adopted after event 90573',
  a.id,
  NULL,
  unixepoch(),
  'migration-0206'
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE a.event_id = 90576
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0206'
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = a.incident_key
      AND i.current_event_id = 90573
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = a.incident_key
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = a.incident_key
      AND r.previous_event_id = 90573
      AND r.current_event_id = 90576
      AND r.created_by = 'migration-0206'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90576,
    current_started_at = 1784089988,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND current_event_id = 90573
  AND current_started_at = 1784085475
  AND incident_state = 'active'
  AND superseded_by_incident_key IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = r.repair_authorization_id
     AND a.operation = 'incident_current_update'
     AND a.created_by = 'migration-0206'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90573
      AND r.current_event_id = 90576
      AND r.created_by = 'migration-0206'
  );

-- Advance 90576 -> 90584.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  90584,
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  'reviewed cNGN live flap 90584 follows event 90576 as the canonical current source',
  unixepoch(),
  4102444800,
  'migration-0206'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90576
      AND i.current_started_at = 1784089988
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90573
      AND r.current_event_id = 90576
      AND r.created_by = 'migration-0206'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90584
      AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0206'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0206'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90584
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0206'
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
   erratum_id, created_at, created_by)
SELECT
  a.incident_key,
  90576,
  90584,
  'reviewed cNGN live flap 90584 adopted after event 90576',
  a.id,
  NULL,
  unixepoch(),
  'migration-0206'
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE a.event_id = 90584
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0206'
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = a.incident_key
      AND i.current_event_id = 90576
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = a.incident_key
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = a.incident_key
      AND r.previous_event_id = 90576
      AND r.current_event_id = 90584
      AND r.created_by = 'migration-0206'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90584,
    current_started_at = 1784108016,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND current_event_id = 90576
  AND current_started_at = 1784089988
  AND incident_state = 'active'
  AND superseded_by_incident_key IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = r.repair_authorization_id
     AND a.operation = 'incident_current_update'
     AND a.created_by = 'migration-0206'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90576
      AND r.current_event_id = 90584
      AND r.created_by = 'migration-0206'
  );

UPDATE worker_repair_tasks
SET state = 'closed',
    locked_by = NULL,
    locked_until = NULL,
    last_error = NULL,
    updated_at = unixepoch(),
    closed_at = unixepoch()
WHERE kind = 'ddr-repair-required-event'
  AND subject_id IN ('90573', '90576', '90584')
  AND state IN ('open', 'claimed', 'deferred', 'failed')
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0206'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id IN (90573, 90576, 90584)
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90584
      AND i.current_started_at = 1784108016
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  );

-- Force both projections to regenerate only after every task and lineage step
-- has reached the reviewed final state.
UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-cngn-ddr-repair-0206","payload":{}}',
    updated_at = unixepoch()
WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
  AND 3 = (
    SELECT COUNT(DISTINCT t.subject_id)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90573', '90576', '90584')
      AND t.state = 'closed'
  )
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.created_by = 'migration-0206'
      AND (
        (r.previous_event_id = 90548 AND r.current_event_id = 90573)
        OR (r.previous_event_id = 90573 AND r.current_event_id = 90576)
        OR (r.previous_event_id = 90576 AND r.current_event_id = 90584)
      )
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90584
      AND i.current_started_at = 1784108016
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  );

DELETE FROM cache
WHERE key = 'ddr:repair-debt:v1'
  AND json_valid(value)
  AND json_type(value, '$.events') = 'array'
  AND json_array_length(value, '$.events') = 3
  AND json_type(value, '$.count') = 'integer'
  AND json_extract(value, '$.count') = 3
  AND json_extract(value, '$.eventsTruncated') = 0
  AND 3 = (
    SELECT COUNT(DISTINCT CAST(json_extract(event.value, '$.eventId') AS INTEGER))
    FROM json_each(cache.value, '$.events') event
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(cache.value, '$.events') event
    WHERE json_type(event.value, '$.eventId') IS NOT 'integer'
       OR CAST(json_extract(event.value, '$.eventId') AS INTEGER) NOT IN (90573, 90576, 90584)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
  )
  AND 3 = (
    SELECT COUNT(DISTINCT t.subject_id)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90573', '90576', '90584')
      AND t.state = 'closed'
  )
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0206'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id IN (90573, 90576, 90584)
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90584
      AND i.current_started_at = 1784108016
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  );
