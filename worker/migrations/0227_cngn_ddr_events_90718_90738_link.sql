-- rollout-safety: backward-compatible
-- Link reviewed cNGN live flaps 90718, 90729, and the still-live tail 90738
-- to the active, unsealed canonical incident without mutating source rows.

-- Authorize all links only while the complete reviewed batch, predecessor
-- lineage, repair tasks, and canonical incident still match production.
-- Event 90738 may close naturally; its mutable peak and terminal fields are
-- deliberately excluded from the identity guard.
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
  'migration-0227'
FROM (
  SELECT 90718 AS event_id,
         'cNGN live flap 90718 belongs to the unsealed event 90511 canonical incident' AS reason
  UNION ALL
  SELECT 90729,
         'cNGN live flap 90729 belongs to the unsealed event 90511 canonical incident'
  UNION ALL
  SELECT 90738,
         'cNGN live tail 90738 belongs to the unsealed event 90511 canonical incident'
) target
WHERE 3 = (
    SELECT COUNT(*)
    FROM depeg_events e
    WHERE (
        e.id = 90718
        AND e.stablecoin_id = 'cngn-compliant-naira'
        AND e.symbol = 'cNGN'
        AND e.peg_type = 'peggedNGN'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -153
        AND e.started_at = 1784486946
        AND e.ended_at = 1784487834
        AND e.start_price = 0.984714
        AND e.peak_price = 0.984714
        AND e.recovery_price = 0.985124
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
      OR (
        e.id = 90729
        AND e.stablecoin_id = 'cngn-compliant-naira'
        AND e.symbol = 'cNGN'
        AND e.peg_type = 'peggedNGN'
        AND e.direction = 'below'
        AND e.peak_deviation_bps = -150
        AND e.started_at = 1784521129
        AND e.ended_at = 1784522926
        AND e.start_price = 0.984981
        AND e.peak_price = 0.984981
        AND e.recovery_price = 0.985662
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources IS NULL
        AND e.pending_reason IS NULL
        AND e.close_reason = 'recovered-native'
      )
      OR (
        e.id = 90738
        AND e.stablecoin_id = 'cngn-compliant-naira'
        AND e.symbol = 'cNGN'
        AND e.peg_type = 'peggedNGN'
        AND e.direction = 'below'
        AND e.started_at = 1784641668
        AND e.start_price = 0.9830659719443444
        AND e.peg_reference = 1
        AND e.source = 'live'
        AND e.confirmation_sources = 'temporal:15m'
        AND e.pending_reason = 'confirmation-window+native-origin'
      )
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_events e
    WHERE e.id = 90666
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
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.stablecoin_id = 'cngn-compliant-naira'
      AND i.peg_currency = 'NGN'
      AND i.direction = 'below'
      AND i.first_event_id = 90511
      AND i.current_event_id = 90666
      AND i.first_started_at = 1783650896
      AND i.current_started_at = 1784383381
      AND i.first_observed_peak_bucket_bps = 150
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
      AND i.source_fingerprint = 'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_prediction_lock_state ls
    WHERE ls.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.event_id = 90666
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0215'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
     AND c.consumer = 'migration-0215'
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id = 90666
      AND l.relation = 'repair_replacement'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = r.repair_authorization_id
     AND a.event_id = 90666
     AND a.operation = 'incident_current_update'
     AND a.created_by = 'migration-0215'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
     AND c.consumer = 'migration-0215'
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90664
      AND r.current_event_id = 90666
      AND r.created_by = 'migration-0215'
  )
  AND 3 = (
    SELECT COUNT(*)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90718', '90729', '90738')
      AND t.priority = 50
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
      AND t.payload_json = '{"eventId":' || t.subject_id || ',"reason":"Unlinked depeg event ' || t.subject_id || ' overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_incident_event_links l
    WHERE l.event_id IN (90718, 90729, 90738)
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id IN (90718, 90729, 90738)
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0227'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90718, 90729, 90738)
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0227'
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    WHERE complete.event_id IN (90718, 90729, 90738)
      AND complete.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND complete.operation = 'incident_link'
      AND complete.created_by = 'migration-0227'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT a.incident_key, a.event_id, 'repair_replacement', a.id, unixepoch(),
       'reviewed cNGN live flap linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE a.event_id IN (90718, 90729, 90738)
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0227'
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    JOIN depeg_resolver_event_repair_authorization_consumptions consumed
      ON consumed.authorization_id = complete.id
     AND consumed.event_id = complete.event_id
     AND consumed.incident_key = complete.incident_key
     AND consumed.operation = complete.operation
    WHERE complete.event_id IN (90718, 90729, 90738)
      AND complete.operation = 'incident_link'
      AND complete.created_by = 'migration-0227'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = a.event_id
  );

-- Append the complete ordered pointer history, then advance the incident row
-- directly to the reviewed live tail.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT transition.current_event_id,
       'ddr2:d71d5088a08922584d989cfe03ae8388',
       'incident_current_update',
       '["current_event_id","current_started_at"]',
       NULL, NULL, transition.reason, unixepoch(), 4102444800, 'migration-0227'
FROM (
  SELECT 90718 AS current_event_id,
         'reviewed cNGN live flap 90718 follows event 90666 as the canonical current source' AS reason
  UNION ALL
  SELECT 90729,
         'reviewed cNGN live flap 90729 follows event 90718 as the canonical current source'
  UNION ALL
  SELECT 90738,
         'reviewed cNGN live tail 90738 follows event 90729 as the canonical current source'
) transition
WHERE EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90666
      AND i.current_started_at = 1784383381
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_prediction_lock_state ls
    WHERE ls.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0227'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.event_id IN (90718, 90729, 90738)
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = transition.current_event_id
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0227'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0227'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90718, 90729, 90738)
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0227'
  AND 3 = (
    SELECT COUNT(*) FROM depeg_resolver_event_repair_authorizations complete
    WHERE complete.event_id IN (90718, 90729, 90738)
      AND complete.operation = 'incident_current_update'
      AND complete.created_by = 'migration-0227'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_event_repair_authorization_consumptions c
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
  'migration-0227'
FROM (
  SELECT 90666 AS previous_event_id, 90718 AS current_event_id,
         'reviewed cNGN live flap 90718 adopted after event 90666' AS reason
  UNION ALL
  SELECT 90718, 90729,
         'reviewed cNGN live flap 90729 adopted after event 90718'
  UNION ALL
  SELECT 90729, 90738,
         'reviewed cNGN live tail 90738 adopted after event 90729'
) transition
JOIN depeg_resolver_event_repair_authorizations a
  ON a.event_id = transition.current_event_id
 AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
 AND a.operation = 'incident_current_update'
 AND a.created_by = 'migration-0227'
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90666
      AND i.current_started_at = 1784383381
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_prediction_lock_state ls
    WHERE ls.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_event_repair_authorizations complete
    JOIN depeg_resolver_event_repair_authorization_consumptions consumed
      ON consumed.authorization_id = complete.id
    WHERE complete.event_id IN (90718, 90729, 90738)
      AND complete.operation = 'incident_current_update'
      AND complete.created_by = 'migration-0227'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = transition.previous_event_id
      AND r.current_event_id = transition.current_event_id
      AND r.created_by = 'migration-0227'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90738,
    current_started_at = 1784641668,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND stablecoin_id = 'cngn-compliant-naira'
  AND peg_currency = 'NGN'
  AND direction = 'below'
  AND first_event_id = 90511
  AND current_event_id = 90666
  AND first_started_at = 1783650896
  AND current_started_at = 1784383381
  AND first_observed_peak_bucket_bps = 150
  AND incident_state = 'active'
  AND superseded_by_incident_key IS NULL
  AND source_fingerprint = 'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15'
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_prediction_lock_state ls
    WHERE ls.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND 3 = (
    SELECT COUNT(*)
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.created_by = 'migration-0227'
  );

UPDATE worker_repair_tasks
SET state = 'closed',
    locked_by = NULL,
    locked_until = NULL,
    last_error = NULL,
    updated_at = unixepoch(),
    closed_at = unixepoch()
WHERE kind = 'ddr-repair-required-event'
  AND subject_id IN ('90718', '90729', '90738')
  AND priority = 50
  AND state IN ('open', 'claimed', 'deferred', 'failed')
  AND payload_json = '{"eventId":' || subject_id || ',"reason":"Unlinked depeg event ' || subject_id || ' overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}'
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90738
      AND i.current_started_at = 1784641668
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND 3 = (
    SELECT COUNT(*) FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.created_by = 'migration-0227'
     AND a.operation = 'incident_link'
    WHERE l.event_id IN (90718, 90729, 90738)
  )
  AND 3 = (
    SELECT COUNT(*) FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.created_by = 'migration-0227'
  );

-- Force both projections to regenerate from the repaired canonical lineage.
UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-cngn-ddr-repair-0227","payload":{}}',
    updated_at = unixepoch()
WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
  AND 3 = (
    SELECT COUNT(DISTINCT t.subject_id)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90718', '90729', '90738')
      AND t.state = 'closed'
  )
  AND 3 = (
    SELECT COUNT(*) FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.created_by = 'migration-0227'
  )
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90738
      AND i.current_started_at = 1784641668
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
    SELECT 1 FROM json_each(cache.value, '$.events') event
    WHERE json_type(event.value, '$.eventId') IS NOT 'integer'
       OR CAST(json_extract(event.value, '$.eventId') AS INTEGER) NOT IN (90718, 90729, 90738)
  )
  AND NOT EXISTS (
    SELECT 1 FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
  )
  AND 3 = (
    SELECT COUNT(DISTINCT t.subject_id)
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90718', '90729', '90738')
      AND t.state = 'closed'
  )
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90738
      AND i.current_started_at = 1784641668
  );
