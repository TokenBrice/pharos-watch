CREATE TABLE IF NOT EXISTS mint_burn_run_state (
  job TEXT PRIMARY KEY,
  next_config_index INTEGER NOT NULL DEFAULT 0,
  degraded_streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

