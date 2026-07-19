-- Baseline schema: consolidates migrations 0001 through 0071.
--
-- IMPORTANT: This migration is ONLY for fresh database setup.
-- Existing databases that have applied 0001+ must skip this migration.
-- D1's migration runner handles this automatically via its applied-migrations table.
--
-- Generated: 2026-03-25

-- ---------------------------------------------------------------------------
-- cache: JSON blob cache (stablecoin list, logos, per-coin detail data)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- blacklist_events: Normalized blacklist events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blacklist_events (
  id TEXT PRIMARY KEY,
  stablecoin TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  chain_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  address TEXT NOT NULL,
  amount REAL,
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  explorer_tx_url TEXT NOT NULL,
  explorer_address_url TEXT NOT NULL,
  methodology_version TEXT NOT NULL DEFAULT '3.1'
);

CREATE INDEX IF NOT EXISTS idx_be_timestamp ON blacklist_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_be_stablecoin ON blacklist_events(stablecoin);
CREATE INDEX IF NOT EXISTS idx_be_chain_name ON blacklist_events(chain_name);
CREATE INDEX IF NOT EXISTS idx_be_event_type ON blacklist_events(event_type);
CREATE INDEX IF NOT EXISTS idx_blacklist_events_chain_ts ON blacklist_events(chain_name, timestamp DESC);

-- ---------------------------------------------------------------------------
-- blacklist_sync_state: Tracks last-fetched block per chain+contract
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blacklist_sync_state (
  config_key TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- depeg_events: One row per depeg episode
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS depeg_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,              -- "above" | "below"
  peak_deviation_bps INTEGER NOT NULL,
  started_at INTEGER NOT NULL,          -- unix seconds
  ended_at INTEGER,                     -- NULL = ongoing
  start_price REAL NOT NULL,
  peak_price REAL,
  recovery_price REAL,
  peg_reference REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'live'   -- "live" | "backfill"
);

CREATE INDEX IF NOT EXISTS idx_depeg_stablecoin ON depeg_events(stablecoin_id);
CREATE INDEX IF NOT EXISTS idx_depeg_started ON depeg_events(started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_depeg_unique ON depeg_events(stablecoin_id, started_at, source);
CREATE INDEX IF NOT EXISTS idx_depeg_open ON depeg_events(stablecoin_id) WHERE ended_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_direction_insert
BEFORE INSERT ON depeg_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_direction_update
BEFORE UPDATE OF direction ON depeg_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_source_insert
BEFORE INSERT ON depeg_events
FOR EACH ROW
WHEN NEW.source NOT IN ('live', 'backfill')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.source must be live|backfill');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_source_update
BEFORE UPDATE OF source ON depeg_events
FOR EACH ROW
WHEN NEW.source NOT IN ('live', 'backfill')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.source must be live|backfill');
END;

-- ---------------------------------------------------------------------------
-- depeg_pending: Pending depeg events awaiting multi-source confirmation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS depeg_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  peg_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  first_seen_bps INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_price REAL NOT NULL,
  peg_reference REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT 'large-cap'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_depeg_pending_coin ON depeg_pending(stablecoin_id);

CREATE TRIGGER IF NOT EXISTS trg_depeg_pending_direction_insert
BEFORE INSERT ON depeg_pending
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_pending.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_pending_direction_update
BEFORE UPDATE OF direction ON depeg_pending
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_pending.direction must be above|below');
END;

-- ---------------------------------------------------------------------------
-- price_cache: DEX/oracle price cache
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_cache (
  asset_id TEXT PRIMARY KEY,
  price REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- dex_liquidity: Per-stablecoin DEX liquidity snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dex_liquidity (
  stablecoin_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  total_tvl_usd REAL NOT NULL DEFAULT 0,
  total_volume_24h_usd REAL NOT NULL DEFAULT 0,
  total_volume_7d_usd REAL NOT NULL DEFAULT 0,
  pool_count INTEGER NOT NULL DEFAULT 0,
  pair_count INTEGER NOT NULL DEFAULT 0,
  chain_count INTEGER NOT NULL DEFAULT 0,
  protocol_tvl_json TEXT,
  chain_tvl_json TEXT,
  top_pools_json TEXT,
  liquidity_score INTEGER,
  updated_at INTEGER NOT NULL,
  concentration_hhi REAL,
  depth_stability REAL,
  avg_pool_stress REAL,
  weighted_balance_ratio REAL,
  organic_fraction REAL,
  effective_tvl_usd REAL NOT NULL DEFAULT 0,
  durability_score INTEGER,
  score_components_json TEXT,
  locked_liquidity_pct REAL,
  methodology_version TEXT NOT NULL DEFAULT '3.2',
  coverage_class TEXT NOT NULL DEFAULT 'unobserved',
  coverage_confidence REAL NOT NULL DEFAULT 0,
  source_mix_json TEXT,
  balance_measured_tvl_usd REAL NOT NULL DEFAULT 0,
  organic_measured_tvl_usd REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dex_liq_score ON dex_liquidity(liquidity_score DESC);

-- ---------------------------------------------------------------------------
-- dex_liquidity_history: Daily snapshots for liquidity trend tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dex_liquidity_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  total_tvl_usd REAL NOT NULL,
  total_volume_24h_usd REAL NOT NULL DEFAULT 0,
  liquidity_score INTEGER,
  snapshot_date INTEGER NOT NULL,  -- UTC midnight epoch seconds
  methodology_version TEXT NOT NULL DEFAULT '3.2',
  coverage_class TEXT NOT NULL DEFAULT 'unobserved',
  coverage_confidence REAL NOT NULL DEFAULT 0,
  source_mix_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_dex_hist_coin_date ON dex_liquidity_history(stablecoin_id, snapshot_date DESC);

-- ---------------------------------------------------------------------------
-- dex_prices: DEX-implied prices extracted from Curve StableSwap pools
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dex_prices (
  stablecoin_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  dex_price_usd REAL NOT NULL,
  source_pool_count INTEGER NOT NULL,
  source_total_tvl REAL NOT NULL,
  deviation_from_primary_bps INTEGER,
  primary_price_at_calc REAL,
  price_sources_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dex_prices_updated ON dex_prices(updated_at DESC);

-- ---------------------------------------------------------------------------
-- dex_pool_staging: Pool discovery staging table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dex_pool_staging (
  pool_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  source TEXT NOT NULL,
  chain TEXT NOT NULL,
  protocol TEXT NOT NULL,
  symbol TEXT NOT NULL,
  tvl_usd REAL,
  volume_24h REAL,
  fee_tier REAL,
  balance_ratio REAL,
  is_stable INTEGER,
  base_token TEXT,
  quote_token TEXT,
  quote_symbol TEXT,
  price_usd REAL,
  locked_liq_pct REAL,
  raw_json TEXT,
  discovered_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  dex_id TEXT,
  quality_multiplier REAL,
  pool_type TEXT,
  PRIMARY KEY (pool_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_staging_coin ON dex_pool_staging(stablecoin_id);
CREATE INDEX IF NOT EXISTS idx_staging_refreshed ON dex_pool_staging(refreshed_at);

-- ---------------------------------------------------------------------------
-- dex_discovery_meta: Discovery backoff tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dex_discovery_meta (
  stablecoin_id TEXT PRIMARY KEY,
  consecutive_misses INTEGER NOT NULL DEFAULT 0,
  last_crawl_at INTEGER NOT NULL,
  last_hit_at INTEGER
);

-- ---------------------------------------------------------------------------
-- dex_price_challengers: Published DEX challenger snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dex_price_challengers (
  stablecoin_id TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  pool_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  protocol TEXT NOT NULL,
  source_family TEXT NOT NULL,
  price_usd REAL NOT NULL,
  tvl_usd REAL NOT NULL,
  PRIMARY KEY (stablecoin_id, snapshot_at, pool_id)
);

CREATE INDEX IF NOT EXISTS idx_dex_price_challengers_lookup ON dex_price_challengers(stablecoin_id, snapshot_at);

CREATE TABLE IF NOT EXISTS dex_price_challenger_snapshots (
  stablecoin_id TEXT PRIMARY KEY,
  snapshot_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  has_rows INTEGER NOT NULL CHECK (has_rows IN (0, 1)),
  source_coverage_complete INTEGER NOT NULL CHECK (source_coverage_complete IN (0, 1))
);

-- ---------------------------------------------------------------------------
-- onchain_supply: On-chain supply per stablecoin per chain
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onchain_supply (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  supply REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, chain)
);

CREATE INDEX IF NOT EXISTS idx_onchain_supply_updated ON onchain_supply(updated_at);

-- ---------------------------------------------------------------------------
-- cron_runs: Cron job execution history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  item_count INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started ON cron_runs(job, started_at DESC);

-- ---------------------------------------------------------------------------
-- cron_leases: Single-writer execution fencing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_leases (
  job TEXT PRIMARY KEY,
  lease_owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_leases_until ON cron_leases(lease_until);

-- ---------------------------------------------------------------------------
-- cron_run_progress: Per-job progress tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_run_progress (
  job TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stage TEXT,
  items_done INTEGER,
  items_total INTEGER,
  message TEXT,
  lease_owner TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_run_progress_updated_at ON cron_run_progress(updated_at DESC);

-- ---------------------------------------------------------------------------
-- supply_history: Daily snapshots of total market cap per stablecoin
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supply_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,  -- UTC midnight epoch seconds
  circulating_usd REAL NOT NULL,   -- total mcap in USD
  price REAL,                      -- USD price at snapshot time
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_supply_hist_date ON supply_history(snapshot_date DESC);

-- ---------------------------------------------------------------------------
-- chain_supply_history: Daily snapshots of per-chain supply totals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chain_supply_history (
  chain_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,
  total_usd REAL NOT NULL,
  stablecoin_count INTEGER NOT NULL,
  PRIMARY KEY (chain_id, snapshot_date)
);

-- ---------------------------------------------------------------------------
-- daily_digest: LLM editorial digest
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_digest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at INTEGER NOT NULL,
  digest_text TEXT NOT NULL,
  input_data TEXT NOT NULL,
  digest_title TEXT,
  digest_extended TEXT,
  digest_meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_daily_digest_generated_at ON daily_digest(generated_at);

-- ---------------------------------------------------------------------------
-- stability_index: Pharos Stability Index daily score snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stability_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at INTEGER NOT NULL,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  components TEXT NOT NULL,
  input_snapshot TEXT NOT NULL,
  methodology_version TEXT NOT NULL DEFAULT '3.0'
);

CREATE INDEX IF NOT EXISTS idx_stability_index_computed_at ON stability_index(computed_at);

-- ---------------------------------------------------------------------------
-- stability_index_samples: High-frequency PSI samples (15-min)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stability_index_samples (
  stored_at INTEGER PRIMARY KEY,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  components TEXT NOT NULL,
  input_snapshot TEXT NOT NULL,
  methodology_version TEXT NOT NULL DEFAULT '3.0'
);

-- ---------------------------------------------------------------------------
-- stress_signals: DEWS 15-minute rolling samples
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stress_signals (
  stablecoin_id TEXT NOT NULL,
  computed_at INTEGER NOT NULL,    -- Unix seconds
  score REAL NOT NULL,             -- Composite DEWS 0-100
  band TEXT NOT NULL,              -- CALM | WATCH | ALERT | WARNING | DANGER
  signals_json TEXT NOT NULL,      -- JSON: per-signal breakdown
  PRIMARY KEY (stablecoin_id, computed_at)
);

CREATE INDEX IF NOT EXISTS idx_stress_computed ON stress_signals(computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_stress_coin_date ON stress_signals(stablecoin_id, computed_at DESC);

-- ---------------------------------------------------------------------------
-- stress_signal_history: Daily DEWS snapshots (365-day retention)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stress_signal_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,    -- UTC midnight epoch seconds
  score REAL NOT NULL,
  band TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_stress_hist_date ON stress_signal_history(snapshot_date DESC);

-- ---------------------------------------------------------------------------
-- yield_data: Yield intelligence current snapshots (multi-source)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS yield_data (
  stablecoin_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  current_apy REAL NOT NULL,
  apy_base REAL,
  apy_reward REAL,
  apy_7d REAL NOT NULL,
  apy_30d REAL NOT NULL,
  yield_source TEXT NOT NULL,
  yield_type TEXT NOT NULL,
  source_pool TEXT,
  source_tvl_usd REAL,
  data_source TEXT NOT NULL,
  safety_score REAL,
  safety_grade TEXT,
  pharos_yield_score REAL,
  yield_to_risk REAL,
  excess_yield REAL,
  yield_stability REAL,
  apy_variance_30d REAL,
  apy_min_30d REAL,
  apy_max_30d REAL,
  exchange_rate REAL,
  exchange_rate_prev REAL,
  warning_signals TEXT,
  is_best INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_yield_pys ON yield_data(pharos_yield_score DESC);
CREATE INDEX IF NOT EXISTS idx_yield_apy ON yield_data(apy_30d DESC);
CREATE INDEX IF NOT EXISTS idx_yield_best ON yield_data(stablecoin_id, is_best);

-- ---------------------------------------------------------------------------
-- yield_history: Per-source yield history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS yield_history (
  stablecoin_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  is_best INTEGER NOT NULL DEFAULT 0,
  apy REAL NOT NULL,
  apy_base REAL,
  apy_reward REAL,
  exchange_rate REAL,
  source_tvl_usd REAL,
  data_source TEXT NOT NULL,
  warning_signals TEXT,
  yield_source TEXT,
  yield_type TEXT,
  PRIMARY KEY (stablecoin_id, source_key, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_yield_hist_coin ON yield_history(stablecoin_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_yield_hist_coin_source ON yield_history(stablecoin_id, source_key, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_yield_hist_best ON yield_history(stablecoin_id, is_best, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- mint_burn_events: Individual mint/burn events (Ethereum-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mint_burn_events (
  id TEXT PRIMARY KEY,                 -- "{chainId}-{txHash}-{logIndex}"
  stablecoin_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  direction TEXT NOT NULL,             -- "mint" or "burn"
  amount REAL NOT NULL,
  amount_usd REAL,
  counterparty TEXT,
  tx_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,          -- Unix seconds
  explorer_tx_url TEXT NOT NULL,
  price_used REAL,
  price_timestamp INTEGER,
  price_source TEXT,
  burn_type TEXT,
  burn_review_reason TEXT,
  flow_type TEXT DEFAULT 'standard'
);

CREATE INDEX IF NOT EXISTS idx_mbe2_ts ON mint_burn_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mbe2_coin ON mint_burn_events(stablecoin_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mbe2_chain ON mint_burn_events(chain_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mbe2_burn_type ON mint_burn_events(burn_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mbe_coin_chain_ts ON mint_burn_events(stablecoin_id, chain_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mbe_symbol_ts ON mint_burn_events(symbol, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mbe_null_price_ts ON mint_burn_events(timestamp DESC) WHERE amount_usd IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_direction_insert
BEFORE INSERT ON mint_burn_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('mint', 'burn')
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events.direction must be mint|burn');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_direction_update
BEFORE UPDATE OF direction ON mint_burn_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('mint', 'burn')
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events.direction must be mint|burn');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_amount_insert
BEFORE INSERT ON mint_burn_events
FOR EACH ROW
WHEN NEW.amount < 0 OR (NEW.amount_usd IS NOT NULL AND NEW.amount_usd < 0)
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events amounts must be non-negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_amount_update
BEFORE UPDATE OF amount, amount_usd ON mint_burn_events
FOR EACH ROW
WHEN NEW.amount < 0 OR (NEW.amount_usd IS NOT NULL AND NEW.amount_usd < 0)
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events amounts must be non-negative');
END;

-- ---------------------------------------------------------------------------
-- mint_burn_hourly: Pre-aggregated hourly flow buckets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mint_burn_hourly (
  stablecoin_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  hour_ts INTEGER NOT NULL,            -- Unix seconds, truncated to hour boundary
  mint_count INTEGER NOT NULL DEFAULT 0,
  burn_count INTEGER NOT NULL DEFAULT 0,
  mint_volume_usd REAL NOT NULL DEFAULT 0,
  burn_volume_usd REAL NOT NULL DEFAULT 0,
  net_flow_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (stablecoin_id, chain_id, hour_ts)
);

CREATE INDEX IF NOT EXISTS idx_mbh_ts ON mint_burn_hourly(hour_ts DESC);
CREATE INDEX IF NOT EXISTS idx_mbh_coin ON mint_burn_hourly(stablecoin_id, hour_ts DESC);

-- ---------------------------------------------------------------------------
-- mint_burn_sync_state: Incremental block tracking for mint/burn scanning
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mint_burn_sync_state (
  config_key TEXT PRIMARY KEY,         -- "{chainId}-{contractAddress}"
  last_block INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- mint_burn_run_state: Round-robin scheduling state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mint_burn_run_state (
  job TEXT PRIMARY KEY,
  next_config_index INTEGER NOT NULL DEFAULT 0,
  degraded_streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- block_timestamp_cache: Cache of block number → timestamp mappings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS block_timestamp_cache (
  chain_id TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE INDEX IF NOT EXISTS idx_block_timestamp_cache_updated ON block_timestamp_cache(updated_at DESC);

-- ---------------------------------------------------------------------------
-- feedback_rate_limit: Rate limiting for /api/feedback endpoint
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback_rate_limit (
  ip_hash TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_rate_limit_ip ON feedback_rate_limit(ip_hash, submitted_at);

-- ---------------------------------------------------------------------------
-- admin_idempotency_keys: Admin operation deduplication
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_idempotency_keys (
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (action, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_admin_idempotency_created_at ON admin_idempotency_keys(created_at DESC);

-- ---------------------------------------------------------------------------
-- safety_grade_history: Safety grade history per stablecoin
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS safety_grade_history (
  stablecoin_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  grade TEXT NOT NULL,
  score REAL,
  prev_grade TEXT,
  prev_score REAL,
  methodology_version TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, recorded_at),
  CHECK (grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  CHECK (prev_grade IS NULL OR prev_grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  CHECK (prev_score IS NULL OR (prev_score >= 0 AND prev_score <= 100))
);

CREATE INDEX IF NOT EXISTS idx_safety_grade_history_coin ON safety_grade_history(stablecoin_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_grade_history_recorded_at ON safety_grade_history(recorded_at DESC);

-- ---------------------------------------------------------------------------
-- status_state: Current system health state per scope
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS status_state (
  scope TEXT PRIMARY KEY,
  current_status TEXT NOT NULL CHECK (current_status IN ('healthy', 'degraded', 'stale')),
  raw_status TEXT NOT NULL CHECK (raw_status IN ('healthy', 'degraded', 'stale')),
  last_evaluated_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  consecutive_healthy INTEGER NOT NULL DEFAULT 0,
  consecutive_degraded INTEGER NOT NULL DEFAULT 0,
  consecutive_stale INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1,
  causes_json TEXT,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- status_transitions: Audit log of status changes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS status_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  previous_status TEXT CHECK (previous_status IN ('healthy', 'degraded', 'stale')),
  next_status TEXT NOT NULL CHECK (next_status IN ('healthy', 'degraded', 'stale')),
  raw_status TEXT NOT NULL CHECK (raw_status IN ('healthy', 'degraded', 'stale')),
  transition_type TEXT NOT NULL CHECK (transition_type IN ('degrade', 'recover', 'init')),
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  causes_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_transitions_scope_created_at ON status_transitions(scope, created_at DESC);

-- ---------------------------------------------------------------------------
-- status_probe_runs: API probe execution history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS status_probe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_count INTEGER NOT NULL,
  pass_count INTEGER NOT NULL,
  fail_count INTEGER NOT NULL,
  p95_latency_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'stale')),
  details_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_probe_runs_created_at ON status_probe_runs(created_at DESC);

-- ---------------------------------------------------------------------------
-- status_discrepancy_state: Divergence tracking between status signals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS status_discrepancy_state (
  scope TEXT PRIMARY KEY,
  consecutive_divergent INTEGER NOT NULL DEFAULT 0,
  last_divergent_at INTEGER,
  last_alert_at INTEGER,
  updated_at INTEGER NOT NULL,
  consecutive_probe_failures INTEGER NOT NULL DEFAULT 0,
  last_probe_failure_at INTEGER,
  last_probe_alert_at INTEGER
);

-- ---------------------------------------------------------------------------
-- telegram_subscribers: Telegram bot subscribers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_subscribers (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  alert_dews INTEGER NOT NULL DEFAULT 0,
  alert_depeg INTEGER NOT NULL DEFAULT 0,
  alert_safety INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  quiet_hours_start_utc INTEGER,
  quiet_hours_end_utc INTEGER,
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
  global_alert_dews INTEGER NOT NULL DEFAULT 0,
  global_alert_depeg INTEGER NOT NULL DEFAULT 0,
  global_alert_safety INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- telegram_subscriptions: Per-coin alert subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  chat_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  alert_dews INTEGER NOT NULL DEFAULT 0,
  alert_depeg INTEGER NOT NULL DEFAULT 0,
  alert_safety INTEGER NOT NULL DEFAULT 0,
  dews_min_band TEXT,
  safety_mode TEXT,
  depeg_worsening_bps_step INTEGER,
  PRIMARY KEY (chat_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_sub_coin ON telegram_subscriptions(stablecoin_id);

-- ---------------------------------------------------------------------------
-- telegram_pending_disambiguation: Pending command disambiguation state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_pending_disambiguation (
  chat_id TEXT PRIMARY KEY,
  alert_types TEXT NOT NULL,
  resolved_ids TEXT NOT NULL,
  ambiguous_ticker TEXT NOT NULL,
  candidates TEXT NOT NULL,
  remaining_tickers TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'subscribe',
  action_payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_telegram_pending_disambiguation_expires_at
  ON telegram_pending_disambiguation (expires_at);

-- ---------------------------------------------------------------------------
-- telegram_pending_alerts: Overflow delivery queue for telegram alerts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_pending_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  message_html TEXT NOT NULL,
  disable_notification INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tpa_created ON telegram_pending_alerts(created_at);

-- ---------------------------------------------------------------------------
-- reserve_composition: Live reserve composition (latest snapshot per coin)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserve_composition (
  stablecoin_id TEXT NOT NULL PRIMARY KEY,
  slices TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  warning_count INTEGER NOT NULL DEFAULT 0,
  warnings TEXT,
  adapter_source_model TEXT,
  adapter_evidence_class TEXT
);

-- ---------------------------------------------------------------------------
-- reserve_composition_history: Historical reserve composition snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserve_composition_history (
  id INTEGER PRIMARY KEY,
  stablecoin_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  adapter_key TEXT NOT NULL,
  slices TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  warnings TEXT,
  warning_count INTEGER NOT NULL DEFAULT 0,
  adapter_source_model TEXT,
  adapter_evidence_class TEXT
);

CREATE INDEX IF NOT EXISTS idx_reserve_composition_history_coin_time ON reserve_composition_history(stablecoin_id, fetched_at DESC);

-- ---------------------------------------------------------------------------
-- reserve_sync_state: Latest state of each live reserve sync target
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserve_sync_state (
  stablecoin_id TEXT NOT NULL PRIMARY KEY,
  adapter_key TEXT NOT NULL,
  breaker_key TEXT NOT NULL,
  last_attempted_at INTEGER,
  last_success_at INTEGER,
  last_status TEXT NOT NULL,  -- ok | degraded | error | skipped
  warning_count INTEGER NOT NULL DEFAULT 0,
  warnings TEXT,
  last_error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- reserve_sync_attempt_history: Per-attempt history for reserve syncs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reserve_sync_attempt_history (
  id INTEGER PRIMARY KEY,
  stablecoin_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  adapter_key TEXT NOT NULL,
  breaker_key TEXT NOT NULL,
  status TEXT NOT NULL,
  warnings TEXT,
  warning_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_reserve_sync_attempt_history_coin_time ON reserve_sync_attempt_history(stablecoin_id, attempted_at DESC);

-- ---------------------------------------------------------------------------
-- redemption_backstop: Redemption backstop scores (latest per coin)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS redemption_backstop (
  stablecoin_id TEXT PRIMARY KEY,
  score REAL,
  effective_exit_score REAL,
  dex_liquidity_score REAL,
  access_score REAL,
  settlement_score REAL,
  execution_certainty_score REAL,
  capacity_score REAL,
  output_asset_quality_score REAL,
  cost_score REAL,
  route_family TEXT NOT NULL,
  access_model TEXT NOT NULL,
  settlement_model TEXT NOT NULL,
  execution_model TEXT NOT NULL,
  output_asset_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  immediate_capacity_usd REAL,
  immediate_capacity_ratio REAL,
  fee_bps REAL,
  queue_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  methodology_version TEXT NOT NULL,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_updated_at ON redemption_backstop(updated_at DESC);

-- ---------------------------------------------------------------------------
-- redemption_backstop_history: Historical backstop score snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS redemption_backstop_history (
  stablecoin_id TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,
  score REAL,
  effective_exit_score REAL,
  dex_liquidity_score REAL,
  updated_at INTEGER NOT NULL,
  methodology_version TEXT NOT NULL,
  details_json TEXT,
  PRIMARY KEY (stablecoin_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_redemption_backstop_history_date ON redemption_backstop_history(snapshot_date DESC);

-- ---------------------------------------------------------------------------
-- public_api_rate_limit: Rate limiting for public API endpoints
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public_api_rate_limit (
  ip_hash TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_public_api_rate_limit_bucket_start ON public_api_rate_limit(bucket_start);

-- ---------------------------------------------------------------------------
-- kv_config: Key-value config store
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kv_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
