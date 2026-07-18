-- rollout-safety: backward-compatible
-- Link reviewed cNGN live flaps 90664 and 90666 after the 0212 repair, then
-- advance the active, unsealed canonical pointer without mutating source rows.

-- Authorize both links only when the complete reviewed batch, predecessor,
-- repair tasks, and canonical incident still match production.
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
  'migration-0215'
FROM (
  SELECT 90664 AS event_id,
         'cNGN live flap 90664 belongs to the unsealed event 90511 canonical incident' AS reason
  UNION ALL
  SELECT 90666,
         'cNGN live flap 90666 belongs to the unsealed event 90511 canonical incident'
) target
WHERE 2 = (
    SELECT COUNT(*)
    FROM depeg_events e
    WHERE (
        e.id = 90664
        AND e.stablecoin_id = 'cngn-compliant-naira'
        AND e.symbol = 'cNGN'
        AND e.peg_type = 'peggedNGN'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -151
        AND e.started_at = 1784380665
        AND e.ended_at = 1784381584
        AND e.start_price = 0.984936
        AND e.peak_price = 0.984936
        AND e.recovery_price = 0.985057
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
      OR (
        e.id = 90666
        AND e.stablecoin_id = 'cngn-compliant-naira'
        AND e.symbol = 'cNGN'
        AND e.peg_type = 'peggedNGN'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -150
        AND e.started_at = 1784383381
        AND e.ended_at = 1784384266
        AND e.start_price = 0.985047
        AND e.peak_price = 0.985047
        AND e.recovery_price = 0.985088
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_events e
    WHERE e.id = 90658
      AND e.stablecoin_id = 'cngn-compliant-naira'
      AND e.symbol = 'cNGN'
      AND e.peg_type = 'peggedNGN'
      AND e.direction = 'below'
      AND e.peak_deviation_bps = -156
      AND e.started_at = 1784375257
      AND e.ended_at = 1784379776
      AND e.start_price = 0.984406
      AND e.peak_price = 0.984406
      AND e.recovery_price = 0.985062
      AND e.peg_reference = 1
      AND e.source = 'live'
      AND e.confirmation_sources IS NULL
      AND e.pending_reason IS NULL
      AND e.close_reason = 'recovered-native'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.stablecoin_id = 'cngn-compliant-naira'
      AND i.peg_currency = 'NGN'
      AND i.direction = 'below'
      AND i.first_event_id = 90511
      AND i.current_event_id = 90658
      AND i.first_started_at = 1783650896
      AND i.current_started_at = 1784375257
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
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_prediction_lock_state ls
    WHERE ls.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id = 90511
      AND l.relation = 'observed'
      AND l.repair_authorization_id IS NULL
  )
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.event_id = l.event_id
     AND a.incident_key = l.incident_key
     AND a.operation = 'incident_link'
     AND a.columns_json = '["event_id","incident_key"]'
     AND a.required_revision_id IS NULL
     AND a.required_erratum_id IS NULL
     AND a.expires_at = 4102444800
     AND a.created_by = 'migration-0212'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
     AND c.consumer = 'migration-0212'
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id IN (90638, 90658)
      AND l.relation = 'repair_replacement'
      AND l.note = 'reviewed cNGN live flap linked through explicit repair authorization'
      AND (
        (l.event_id = 90638
         AND a.reason = 'cNGN live flap 90638 belongs to the unsealed event 90511 canonical incident')
        OR
        (l.event_id = 90658
         AND a.reason = 'cNGN live flap 90658 belongs to the unsealed event 90511 canonical incident')
      )
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = r.repair_authorization_id
     AND a.event_id = r.current_event_id
     AND a.incident_key = r.incident_key
     AND a.operation = 'incident_current_update'
     AND a.columns_json = '["current_event_id","current_started_at"]'
     AND a.required_revision_id IS NULL
     AND a.required_erratum_id IS NULL
     AND a.expires_at = 4102444800
     AND a.created_by = 'migration-0212'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
     AND c.consumer = 'migration-0212'
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.created_by = 'migration-0212'
      AND r.erratum_id IS NULL
      AND r.id IN (
        SELECT latest.id
        FROM depeg_resolver_incident_revisions latest
        WHERE latest.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 2
      )
      AND (
        (r.previous_event_id = 90608
         AND r.current_event_id = 90638
         AND r.reason = 'reviewed cNGN live flap 90638 adopted after event 90608'
         AND a.reason = 'reviewed cNGN live flap 90638 follows event 90608 as the canonical current source')
        OR
        (r.previous_event_id = 90638
         AND r.current_event_id = 90658
         AND r.reason = 'reviewed cNGN live flap 90658 adopted after event 90638'
         AND a.reason = 'reviewed cNGN live flap 90658 follows event 90638 as the canonical current source')
      )
    GROUP BY r.incident_key
    HAVING COUNT(*) = 2
       AND COUNT(DISTINCT r.current_event_id) = 2
  )
  AND 2 = (
    SELECT COUNT(*)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90664', '90666')
      AND t.priority = 50
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
      AND t.payload_json = '{"eventId":' || t.subject_id || ',"reason":"Unlinked depeg event ' || t.subject_id || ' overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id IN (90664, 90666)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id IN (90664, 90666)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = target.event_id
      AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0215'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0215'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90664, 90666)
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0215'
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    WHERE complete.event_id IN (90664, 90666)
      AND complete.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND complete.operation = 'incident_link'
      AND complete.created_by = 'migration-0215'
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
  'reviewed cNGN live flap linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE a.event_id IN (90664, 90666)
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0215'
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    JOIN depeg_resolver_event_repair_authorization_consumptions consumed
      ON consumed.authorization_id = complete.id
     AND consumed.event_id = complete.event_id
     AND consumed.incident_key = complete.incident_key
     AND consumed.operation = complete.operation
    WHERE complete.event_id IN (90664, 90666)
      AND complete.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND complete.operation = 'incident_link'
      AND complete.created_by = 'migration-0215'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = a.event_id
  );

-- Authorize and record the complete ordered pointer history as one batch. The
-- incident row itself can then move directly to the latest source event.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  transition.current_event_id,
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  transition.reason,
  unixepoch(),
  4102444800,
  'migration-0215'
FROM (
  SELECT 90664 AS current_event_id,
         'reviewed cNGN live flap 90664 follows event 90658 as the canonical current source' AS reason
  UNION ALL
  SELECT 90666,
         'reviewed cNGN live flap 90666 follows event 90664 as the canonical current source'
) transition
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90658
      AND i.current_started_at = 1784375257
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_prediction_lock_state ls
    WHERE ls.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0215'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id IN (90664, 90666)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = transition.current_event_id
      AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0215'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0215'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90664, 90666)
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0215'
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    WHERE complete.event_id IN (90664, 90666)
      AND complete.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND complete.operation = 'incident_current_update'
      AND complete.created_by = 'migration-0215'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
   erratum_id, created_at, created_by)
SELECT
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  transition.previous_event_id,
  transition.current_event_id,
  transition.reason,
  a.id,
  NULL,
  unixepoch(),
  'migration-0215'
FROM (
  SELECT 90658 AS previous_event_id, 90664 AS current_event_id,
         'reviewed cNGN live flap 90664 adopted after event 90658' AS reason
  UNION ALL
  SELECT 90664, 90666,
         'reviewed cNGN live flap 90666 adopted after event 90664'
) transition
JOIN depeg_resolver_event_repair_authorizations a
  ON a.event_id = transition.current_event_id
 AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
 AND a.operation = 'incident_current_update'
 AND a.created_by = 'migration-0215'
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90658
      AND i.current_started_at = 1784375257
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_prediction_lock_state ls
    WHERE ls.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    JOIN depeg_resolver_event_repair_authorization_consumptions consumed
      ON consumed.authorization_id = complete.id
     AND consumed.event_id = complete.event_id
     AND consumed.incident_key = complete.incident_key
     AND consumed.operation = complete.operation
    WHERE complete.event_id IN (90664, 90666)
      AND complete.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND complete.operation = 'incident_current_update'
      AND complete.created_by = 'migration-0215'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = transition.previous_event_id
      AND r.current_event_id = transition.current_event_id
      AND r.created_by = 'migration-0215'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90666,
    current_started_at = 1784383381,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND current_event_id = 90658
  AND current_started_at = 1784375257
  AND incident_state = 'active'
  AND superseded_by_incident_key IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_prediction_lock_state ls
    WHERE ls.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_revisions r
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = r.repair_authorization_id
     AND a.operation = 'incident_current_update'
     AND a.created_by = 'migration-0215'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.created_by = 'migration-0215'
      AND (
        (r.previous_event_id = 90658 AND r.current_event_id = 90664)
        OR (r.previous_event_id = 90664 AND r.current_event_id = 90666)
      )
  );

UPDATE worker_repair_tasks
SET state = 'closed',
    locked_by = NULL,
    locked_until = NULL,
    last_error = NULL,
    updated_at = unixepoch(),
    closed_at = unixepoch()
WHERE kind = 'ddr-repair-required-event'
  AND subject_id IN ('90664', '90666')
  AND priority = 50
  AND state IN ('open', 'claimed', 'deferred', 'failed')
  AND payload_json = '{"eventId":' || subject_id || ',"reason":"Unlinked depeg event ' || subject_id || ' overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}'
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0215'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id IN (90664, 90666)
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90666
      AND i.current_started_at = 1784383381
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_prediction_lock_state ls
    WHERE ls.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  );

-- Force both projections to regenerate from the repaired canonical lineage.
UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-cngn-ddr-repair-0215","payload":{}}',
    updated_at = unixepoch()
WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
  AND 2 = (
    SELECT COUNT(DISTINCT t.subject_id)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90664', '90666')
      AND t.state = 'closed'
  )
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.created_by = 'migration-0215'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90666
      AND i.current_started_at = 1784383381
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  );

DELETE FROM cache
WHERE key = 'ddr:repair-debt:v1'
  AND json_valid(value)
  AND json_type(value, '$.events') = 'array'
  AND json_array_length(value, '$.events') = 2
  AND json_type(value, '$.count') = 'integer'
  AND json_extract(value, '$.count') = 2
  AND json_extract(value, '$.eventsTruncated') = 0
  AND 2 = (
    SELECT COUNT(DISTINCT CAST(json_extract(event.value, '$.eventId') AS INTEGER))
    FROM json_each(cache.value, '$.events') event
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(cache.value, '$.events') event
    WHERE json_type(event.value, '$.eventId') IS NOT 'integer'
       OR CAST(json_extract(event.value, '$.eventId') AS INTEGER) NOT IN (90664, 90666)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
  )
  AND 2 = (
    SELECT COUNT(DISTINCT t.subject_id)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90664', '90666')
      AND t.state = 'closed'
  )
  AND 2 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0215'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id IN (90664, 90666)
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90666
      AND i.current_started_at = 1784383381
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  );
