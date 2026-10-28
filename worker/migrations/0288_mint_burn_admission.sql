-- rollout-safety: backward-compatible
CREATE TABLE IF NOT EXISTS mint_burn_admission (
  config_key TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  baseline_from INTEGER NOT NULL,
  baseline_to INTEGER NOT NULL,
  PRIMARY KEY (config_key, config_fingerprint)
);

CREATE TABLE IF NOT EXISTS mint_burn_publication_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  disabled_keys TEXT NOT NULL,
  paused_keys TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
