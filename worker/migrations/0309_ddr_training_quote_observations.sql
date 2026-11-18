-- rollout-safety: backward-compatible
-- Replace the projection inside this migration transaction. The six columns and
-- trigger names stay compatible with earlier writers. Existing rollups refresh in pages.
DROP VIEW depeg_resolver_training_observations;
CREATE VIEW depeg_resolver_training_observations AS
SELECT e.id AS event_id, e.stablecoin_id, e.direction, e.started_at, e.ended_at,
  (SELECT json_group_array(json_object('observedAt', a.assessed_at, 'deviationBps',
    CASE WHEN json_valid(a.row_json) THEN json_extract(a.row_json, '$.currentDeviationBps') END,
    'quoteObservedAt', CASE WHEN json_valid(a.row_json) THEN json_extract(a.row_json, '$.currentDeviationObservedAtSec') END))
   FROM depeg_resolver_assessments a
   WHERE a.event_id = e.id AND a.stablecoin_id = e.stablecoin_id
     AND a.direction = e.direction AND a.started_at = e.started_at
     AND a.assessed_at >= e.started_at AND a.assessed_at <= e.ended_at
  ) AS severity_observations_json
FROM depeg_events e WHERE e.ended_at IS NOT NULL;
