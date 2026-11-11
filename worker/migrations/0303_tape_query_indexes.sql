-- rollout-safety: backward-compatible

CREATE INDEX IF NOT EXISTS idx_mbe2_tape_large_ts
  ON mint_burn_events(timestamp) WHERE amount_usd >= 10000000;

CREATE INDEX IF NOT EXISTS idx_blacklist_events_attempted_type
  ON blacklist_events(event_type, amount_last_attempted_at)
  WHERE amount_last_attempted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_retry_error
  ON telegram_deliveries(error_class)
  WHERE state = 'retry' AND error_class IS NOT NULL AND error_class <> '';

CREATE INDEX IF NOT EXISTS idx_reserve_sync_attempt_history_time
  ON reserve_sync_attempt_history(attempted_at);
