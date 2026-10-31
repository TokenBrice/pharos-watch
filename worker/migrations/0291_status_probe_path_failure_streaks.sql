-- rollout-safety: backward-compatible
-- Per-path probe-failure streaks for the status self-check. The JSON object is
-- keyed by the probe identity (`plane|lane|origin|path`) and records each
-- endpoint's consecutive failed observations and last observation clock, so
-- one rotating deep path that keeps failing degrades the probe plane after
-- STATUS_PROBE_THRESHOLDS.persistentFailSweeps sweeps. NULL means no per-path
-- evidence yet; the older Worker ignores the column and keeps updating the
-- live divergence/probe-failure counters on the same row.
ALTER TABLE status_discrepancy_state ADD COLUMN probe_path_failure_streaks_json TEXT;
