-- Live reserve composition synced hourly from protocol data APIs.
-- One row per coin (latest snapshot only).
CREATE TABLE IF NOT EXISTS reserve_composition (
  stablecoin_id TEXT NOT NULL PRIMARY KEY,
  slices        TEXT NOT NULL,     -- JSON: ReserveSlice[]
  fetched_at    INTEGER NOT NULL,  -- Unix seconds
  source        TEXT NOT NULL      -- adapter key (e.g., "infinifi")
);
