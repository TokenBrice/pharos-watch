-- Pending depeg events awaiting multi-source confirmation (>$1B coins only)
CREATE TABLE IF NOT EXISTS depeg_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  first_seen_bps INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_price REAL NOT NULL,
  peg_reference REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_depeg_pending_coin ON depeg_pending(stablecoin_id);
