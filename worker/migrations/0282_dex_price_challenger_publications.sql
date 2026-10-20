-- rollout-safety: backward-compatible
-- Isolated v2 storage leaves old-Worker named-column reads/writes untouched.
-- Publication sequence identifies membership, never the quote observation clock.
CREATE TABLE IF NOT EXISTS dex_price_challenger_publications_v2 (
  publication_id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1))
);

CREATE TABLE IF NOT EXISTS dex_price_challenger_payloads_v2 (
  publication_id INTEGER NOT NULL REFERENCES dex_price_challenger_publications_v2(publication_id),
  stablecoin_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  protocol TEXT NOT NULL,
  source_family TEXT NOT NULL,
  price_usd REAL NOT NULL,
  tvl_usd REAL NOT NULL,
  price_observed_at INTEGER,
  PRIMARY KEY (publication_id, stablecoin_id, pool_id)
);

CREATE TABLE IF NOT EXISTS dex_price_challenger_heads_v2 (
  stablecoin_id TEXT PRIMARY KEY,
  publication_id INTEGER NOT NULL REFERENCES dex_price_challenger_publications_v2(publication_id),
  has_rows INTEGER NOT NULL DEFAULT 0 CHECK (has_rows IN (0, 1)),
  source_coverage_complete INTEGER NOT NULL DEFAULT 1 CHECK (source_coverage_complete IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_dex_price_challenger_heads_v2_publication
  ON dex_price_challenger_heads_v2(publication_id);
