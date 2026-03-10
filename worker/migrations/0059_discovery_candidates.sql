-- Migration 0059: discovery_candidates table
CREATE TABLE IF NOT EXISTS discovery_candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  gecko_id        TEXT,
  llama_id        INTEGER,
  name            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  market_cap      REAL,
  source          TEXT NOT NULL CHECK (source IN ('defillama', 'coingecko', 'both')),
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  dismissed       INTEGER DEFAULT 0,
  dismissed_at    INTEGER,
  dismissed_mcap  REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_disc_gecko ON discovery_candidates(gecko_id) WHERE gecko_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_disc_llama ON discovery_candidates(llama_id) WHERE llama_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_disc_name  ON discovery_candidates(name, symbol) WHERE gecko_id IS NULL AND llama_id IS NULL;
