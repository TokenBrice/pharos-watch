-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS treasury_stable_exposure_history (
  snapshot_at INTEGER NOT NULL,
  protocol_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  denominator_status TEXT NOT NULL CHECK (denominator_status IN (
    'direct-only',
    'adjusted-with-defi',
    'partial',
    'invalid'
  )),
  direct_wallet_usd REAL NOT NULL,
  treasury_usd REAL,
  stablecoin_sleeve_usd REAL NOT NULL,
  tracked_stable_usd REAL NOT NULL,
  decentralized_stable_usd REAL NOT NULL,
  coverage_json TEXT NOT NULL,
  holdings_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_at, slug)
);

CREATE INDEX IF NOT EXISTS idx_treasury_stable_exposure_history_slug_snapshot
  ON treasury_stable_exposure_history(slug, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_treasury_stable_exposure_history_snapshot
  ON treasury_stable_exposure_history(snapshot_at DESC);
