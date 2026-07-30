-- rollout-safety: backward-compatible
-- 0100: Delete legacy mixed-case sync_state rows. The canonical write path
-- lowercases config_key; any mixed-case row is unreachable by current code.
-- (Renumbered from planned 0099; slot 0099 was taken by admin_action_audit_log
--  after the collision-fix commit landed on main.)

DELETE FROM blacklist_sync_state
WHERE config_key != LOWER(config_key)
  AND EXISTS (
    SELECT 1 FROM blacklist_sync_state b2
    WHERE b2.config_key = LOWER(blacklist_sync_state.config_key)
  );
