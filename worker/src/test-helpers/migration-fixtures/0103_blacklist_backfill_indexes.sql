-- rollout-safety: backward-compatible
-- 0103: Composite indexes for the hot paths:
--   backfill selector: event_type + amount_status + timestamp DESC
--   public API filter: stablecoin + chain_name + event_type + timestamp DESC
-- (Renumbered from planned 0102; slot 0099 was taken by admin_action_audit_log.)

CREATE INDEX IF NOT EXISTS idx_blacklist_events_backfill
  ON blacklist_events(event_type, amount_status, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_blacklist_events_api_filter
  ON blacklist_events(stablecoin, chain_name, event_type, timestamp DESC);
