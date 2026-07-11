-- rollout-safety: backward-compatible
-- Retain bounded hourly storage samples for thresholding and exhaustion forecasts.

CREATE TABLE IF NOT EXISTS d1_capacity_observations (
  observed_hour INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  database_size_bytes INTEGER NOT NULL CHECK (database_size_bytes >= 0),
  maximum_size_bytes INTEGER NOT NULL CHECK (maximum_size_bytes > 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_d1_capacity_observations_observed
  ON d1_capacity_observations(observed_at DESC);
