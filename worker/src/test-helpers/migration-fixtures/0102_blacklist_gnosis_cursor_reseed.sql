-- rollout-safety: backward-compatible
-- 0102: After migration 0100 removes duplicate mixed-case sync_state rows and
-- Task 1.1 shrinks Gnosis scan windows to ≤9k blocks, ensure the Gnosis BRZ
-- cursor points at startBlock-1 so the next hourly sync picks up the 2 missed
-- events (Gnosis blocks 45229172 and 45229396).
-- (Renumbered from planned 0101; slot 0099 was taken by admin_action_audit_log.)

INSERT INTO blacklist_sync_state (config_key, last_block)
VALUES ('gnosis-0x0a06c8354a6cc1a07549a38701eac205942e3ac6', 33257602)
ON CONFLICT(config_key) DO UPDATE SET last_block = MIN(
  blacklist_sync_state.last_block,
  excluded.last_block
);
