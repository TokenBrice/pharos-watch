-- rollout-safety: backward-compatible
-- Link the reviewed EURQ live flap chain to its active, unsealed canonical
-- incident and advance the current source pointer without mutating source rows.

-- Authorize all links only when the complete reviewed batch, predecessor, and
-- canonical incident still match production. Event 90595 may remain open or
-- close naturally; its terminal observations are not part of its identity.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  target.event_id,
  'ddr2:3a67bd822a7230458da31c0078ef2b4f',
  'incident_link',
  '["event_id","incident_key"]',
  NULL,
  NULL,
  target.reason,
  unixepoch(),
  4102444800,
  'migration-0208'
FROM (
  SELECT 90589 AS event_id,
         'EURQ live flap 90589 belongs to the unsealed event 90527 canonical incident' AS reason
  UNION ALL
  SELECT 90591,
         'EURQ live flap 90591 belongs to the unsealed event 90527 canonical incident'
  UNION ALL
  SELECT 90594,
         'EURQ live flap 90594 belongs to the unsealed event 90527 canonical incident'
  UNION ALL
  SELECT 90595,
         'EURQ live tail 90595 belongs to the unsealed event 90527 canonical incident'
) target
WHERE 4 = (
    SELECT COUNT(*)
    FROM depeg_events e
    WHERE (
        e.id = 90589
        AND e.stablecoin_id = 'eurq-quantoz'
        AND e.symbol = 'EURQ'
        AND e.peg_type = 'peggedEUR'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -156
        AND e.started_at = 1784126070
        AND e.ended_at = 1784126921
        AND e.start_price = 0.984392
        AND e.peak_price = 0.984392
        AND e.recovery_price = 0.988565
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
      OR (
        e.id = 90591
        AND e.stablecoin_id = 'eurq-quantoz'
        AND e.symbol = 'EURQ'
        AND e.peg_type = 'peggedEUR'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -150
        AND e.started_at = 1784127861
        AND e.ended_at = 1784128727
        AND e.start_price = 0.985
        AND e.peak_price = 0.985
        AND e.recovery_price = 0.985431
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
      OR (
        e.id = 90594
        AND e.stablecoin_id = 'eurq-quantoz'
        AND e.symbol = 'EURQ'
        AND e.peg_type = 'peggedEUR'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -170
        AND e.started_at = 1784133252
        AND e.ended_at = 1784135051
        AND e.start_price = 0.984206
        AND e.peak_price = 0.982973
        AND e.recovery_price = 0.985345
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
      OR (
        e.id = 90595
        AND e.stablecoin_id = 'eurq-quantoz'
        AND e.symbol = 'EURQ'
        AND e.peg_type = 'peggedEUR'
        AND e.direction = 'below'
        AND e.started_at = 1784135928
        AND e.start_price = 0.984513
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
      )
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_events e
    WHERE e.id = 90560
      AND e.stablecoin_id = 'eurq-quantoz'
      AND e.symbol = 'EURQ'
      AND e.peg_type = 'peggedEUR'
      AND e.direction = 'below'
      AND e.peak_deviation_bps = -166
      AND e.started_at = 1784033283
      AND e.ended_at = 1784044075
      AND e.start_price = 0.983396
      AND e.peak_price = 0.983396
      AND e.recovery_price = 0.985613
      AND e.peg_reference = 1
      AND e.source = 'live'
      AND e.close_reason = 'recovered-native'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND i.stablecoin_id = 'eurq-quantoz'
      AND i.peg_currency = 'EUR'
      AND i.direction = 'below'
      AND i.first_event_id = 90527
      AND i.current_event_id = 90560
      AND i.first_started_at = 1783798508
      AND i.current_started_at = 1784033283
      AND i.first_observed_peak_bucket_bps = 150
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
      AND i.source_fingerprint = '5067fbaa1421beab51c1807d3e913d3e6b49a6b4b016b5015ce6f748ce44ae1d'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND l.event_id = 90527
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND l.event_id = 90560
  )
  AND 4 = (
    SELECT COUNT(*)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90589', '90591', '90594', '90595')
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id IN (90589, 90591, 90594, 90595)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = target.event_id
      AND a.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0208'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0208'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90589, 90591, 90594, 90595)
  AND a.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0208'
  AND 4 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    WHERE complete.event_id IN (90589, 90591, 90594, 90595)
      AND complete.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND complete.operation = 'incident_link'
      AND complete.created_by = 'migration-0208'
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
  'reviewed EURQ live flap linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE a.event_id IN (90589, 90591, 90594, 90595)
  AND a.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0208'
  AND 4 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    JOIN depeg_resolver_event_repair_authorization_consumptions consumed
      ON consumed.authorization_id = complete.id
     AND consumed.event_id = complete.event_id
     AND consumed.incident_key = complete.incident_key
     AND consumed.operation = complete.operation
    WHERE complete.event_id IN (90589, 90591, 90594, 90595)
      AND complete.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND complete.operation = 'incident_link'
      AND complete.created_by = 'migration-0208'
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
  'ddr2:3a67bd822a7230458da31c0078ef2b4f',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  transition.reason,
  unixepoch(),
  4102444800,
  'migration-0208'
FROM (
  SELECT 90589 AS current_event_id,
         'reviewed EURQ live flap 90589 follows event 90560 as the canonical current source' AS reason
  UNION ALL
  SELECT 90591,
         'reviewed EURQ live flap 90591 follows event 90589 as the canonical current source'
  UNION ALL
  SELECT 90594,
         'reviewed EURQ live flap 90594 follows event 90591 as the canonical current source'
  UNION ALL
  SELECT 90595,
         'reviewed EURQ live tail 90595 follows event 90594 as the canonical current source'
) transition
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND i.current_event_id = 90560
      AND i.current_started_at = 1784033283
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
  )
  AND 4 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0208'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND l.event_id IN (90589, 90591, 90594, 90595)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = transition.current_event_id
      AND a.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0208'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0208'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90589, 90591, 90594, 90595)
  AND a.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0208'
  AND 4 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    WHERE complete.event_id IN (90589, 90591, 90594, 90595)
      AND complete.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND complete.operation = 'incident_current_update'
      AND complete.created_by = 'migration-0208'
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
  'ddr2:3a67bd822a7230458da31c0078ef2b4f',
  transition.previous_event_id,
  transition.current_event_id,
  transition.reason,
  a.id,
  NULL,
  unixepoch(),
  'migration-0208'
FROM (
  SELECT 90560 AS previous_event_id, 90589 AS current_event_id,
         'reviewed EURQ live flap 90589 adopted after event 90560' AS reason
  UNION ALL
  SELECT 90589, 90591,
         'reviewed EURQ live flap 90591 adopted after event 90589'
  UNION ALL
  SELECT 90591, 90594,
         'reviewed EURQ live flap 90594 adopted after event 90591'
  UNION ALL
  SELECT 90594, 90595,
         'reviewed EURQ live tail 90595 adopted after event 90594'
) transition
JOIN depeg_resolver_event_repair_authorizations a
  ON a.event_id = transition.current_event_id
 AND a.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
 AND a.operation = 'incident_current_update'
 AND a.created_by = 'migration-0208'
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND i.current_event_id = 90560
      AND i.current_started_at = 1784033283
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
  )
  AND 4 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    JOIN depeg_resolver_event_repair_authorization_consumptions consumed
      ON consumed.authorization_id = complete.id
     AND consumed.event_id = complete.event_id
     AND consumed.incident_key = complete.incident_key
     AND consumed.operation = complete.operation
    WHERE complete.event_id IN (90589, 90591, 90594, 90595)
      AND complete.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND complete.operation = 'incident_current_update'
      AND complete.created_by = 'migration-0208'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND r.previous_event_id = transition.previous_event_id
      AND r.current_event_id = transition.current_event_id
      AND r.created_by = 'migration-0208'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90595,
    current_started_at = 1784135928,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
  AND current_event_id = 90560
  AND current_started_at = 1784033283
  AND incident_state = 'active'
  AND superseded_by_incident_key IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
  )
  AND 4 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_revisions r
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = r.repair_authorization_id
     AND a.operation = 'incident_current_update'
     AND a.created_by = 'migration-0208'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
    WHERE r.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND r.created_by = 'migration-0208'
      AND (
        (r.previous_event_id = 90560 AND r.current_event_id = 90589)
        OR (r.previous_event_id = 90589 AND r.current_event_id = 90591)
        OR (r.previous_event_id = 90591 AND r.current_event_id = 90594)
        OR (r.previous_event_id = 90594 AND r.current_event_id = 90595)
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
  AND subject_id IN ('90589', '90591', '90594', '90595')
  AND state IN ('open', 'claimed', 'deferred', 'failed')
  AND 4 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0208'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND l.event_id IN (90589, 90591, 90594, 90595)
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND i.current_event_id = 90595
      AND i.current_started_at = 1784135928
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
  );

-- Force both projections to regenerate from the repaired canonical lineage.
UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-eurq-ddr-repair-0208","payload":{}}',
    updated_at = unixepoch()
WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
  AND 4 = (
    SELECT COUNT(DISTINCT t.subject_id)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90589', '90591', '90594', '90595')
      AND t.state = 'closed'
  )
  AND 4 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND r.created_by = 'migration-0208'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND i.current_event_id = 90595
      AND i.current_started_at = 1784135928
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  );

DELETE FROM cache
WHERE key = 'ddr:repair-debt:v1'
  AND json_valid(value)
  AND json_type(value, '$.events') = 'array'
  AND json_array_length(value, '$.events') = 4
  AND json_type(value, '$.count') = 'integer'
  AND json_extract(value, '$.count') = 4
  AND json_extract(value, '$.eventsTruncated') = 0
  AND 4 = (
    SELECT COUNT(DISTINCT CAST(json_extract(event.value, '$.eventId') AS INTEGER))
    FROM json_each(cache.value, '$.events') event
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(cache.value, '$.events') event
    WHERE json_type(event.value, '$.eventId') IS NOT 'integer'
       OR CAST(json_extract(event.value, '$.eventId') AS INTEGER) NOT IN (90589, 90591, 90594, 90595)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
  )
  AND 4 = (
    SELECT COUNT(DISTINCT t.subject_id)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90589', '90591', '90594', '90595')
      AND t.state = 'closed'
  )
  AND 4 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0208'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND l.event_id IN (90589, 90591, 90594, 90595)
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:3a67bd822a7230458da31c0078ef2b4f'
      AND i.current_event_id = 90595
      AND i.current_started_at = 1784135928
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  );
