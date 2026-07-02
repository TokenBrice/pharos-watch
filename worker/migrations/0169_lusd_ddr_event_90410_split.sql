-- rollout-safety: backward-compatible
-- Ledger LUSD event 90410 as a fresh DDR incident.
--
-- The earlier LUSD above-peg chain recovered before its DDRv3 72h public
-- backstop. Event 90410 is a later short flap, not another source row for
-- that pre-lock chain, so give it its own canonical incident and clear the
-- repair-debt marker once the link exists.

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:c14884852abe024faa4d4b9fc1f84742',
  90410,
  'observed',
  NULL,
  unixepoch(),
  'fresh LUSD flap split from earlier recovered pre-lock chain'
FROM depeg_events e
WHERE e.id = 90410
  AND e.stablecoin_id = 'lusd-liquity'
  AND e.symbol = 'LUSD'
  AND e.peg_type = 'peggedUSD'
  AND e.direction = 'above'
  AND e.source = 'live'
  AND e.started_at = 1782970434
  AND e.ended_at = 1782973127
  AND e.peak_deviation_bps = 100
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links existing
    WHERE existing.event_id = 90410
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents existing
    WHERE existing.incident_key = 'ddr2:c14884852abe024faa4d4b9fc1f84742'
  );

INSERT INTO depeg_resolver_incidents
  (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
   first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
   superseded_by_incident_key, source_fingerprint, created_at, updated_at)
SELECT
  'ddr2:c14884852abe024faa4d4b9fc1f84742',
  'lusd-liquity',
  'USD',
  'above',
  90410,
  90410,
  1782970434,
  1782970434,
  100,
  'active',
  NULL,
  '09da1784f586d5bbfba3762fa54d4c3c1d47f1660fd5c315616a3187b480f687',
  unixepoch(),
  unixepoch()
FROM depeg_events e
WHERE e.id = 90410
  AND e.stablecoin_id = 'lusd-liquity'
  AND e.symbol = 'LUSD'
  AND e.peg_type = 'peggedUSD'
  AND e.direction = 'above'
  AND e.source = 'live'
  AND e.started_at = 1782970434
  AND e.ended_at = 1782973127
  AND e.peak_deviation_bps = 100
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:c14884852abe024faa4d4b9fc1f84742'
      AND l.event_id = 90410
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents existing
    WHERE existing.incident_key = 'ddr2:c14884852abe024faa4d4b9fc1f84742'
  );

INSERT OR IGNORE INTO depeg_resolver_incident_policy_membership
  (incident_key, stablecoin_id, prediction_policy_version, public_tracked_at_first_seen,
   psi_shadow_at_first_seen, rollout_active_at_enablement, policy_universe_included,
   policy_universe_reason, registry_snapshot_json, created_at)
SELECT
  'ddr2:c14884852abe024faa4d4b9fc1f84742',
  'lusd-liquity',
  'sticky-24h-v1',
  1,
  0,
  0,
  1,
  'post_effective_public_tracked',
  '{"publicTracked":true,"id":"lusd-liquity","symbol":"LUSD","status":null,"pegCurrency":"USD","governance":"decentralized","navToken":false}',
  unixepoch()
FROM depeg_resolver_incidents i
WHERE i.incident_key = 'ddr2:c14884852abe024faa4d4b9fc1f84742'
  AND i.first_event_id = 90410;

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:c14884852abe024faa4d4b9fc1f84742',
  NULL,
  90410,
  'initial canonical incident split from earlier recovered LUSD flap chain',
  NULL,
  NULL,
  unixepoch(),
  'migration-0169'
FROM depeg_resolver_incidents i
WHERE i.incident_key = 'ddr2:c14884852abe024faa4d4b9fc1f84742'
  AND i.first_event_id = 90410
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:c14884852abe024faa4d4b9fc1f84742'
      AND existing.current_event_id = 90410
      AND existing.reason = 'initial canonical incident split from earlier recovered LUSD flap chain'
  );

UPDATE worker_repair_tasks
SET state = 'closed',
    locked_by = NULL,
    locked_until = NULL,
    last_error = NULL,
    updated_at = unixepoch(),
    closed_at = unixepoch()
WHERE kind = 'ddr-repair-required-event'
  AND subject_id = '90410'
  AND state IN ('open', 'claimed', 'deferred', 'failed')
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = 90410
  );

DELETE FROM cache
WHERE key = 'ddr:repair-debt:v1'
  AND NOT EXISTS (
    SELECT 1
    FROM worker_repair_tasks task
    WHERE task.kind = 'ddr-repair-required-event'
      AND task.state IN ('open', 'claimed', 'deferred', 'failed')
  );
