-- rollout-safety: backward-compatible
-- 0104: Align existing EURC mirror-zero rows with new code semantics so they
-- exit the recoverable-pending backfill pool.
-- (Renumbered from planned 0103; slot 0099 was taken by admin_action_audit_log.)

UPDATE blacklist_events
SET amount_status = 'permanently_unavailable'
WHERE suppression_reason = 'circle_mirror_zero_balance'
  AND amount_status != 'permanently_unavailable';
