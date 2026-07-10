-- rollout-safety: backward-compatible

ALTER TABLE admin_action_audit ADD COLUMN intent_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_action_audit_action_intent
  ON admin_action_audit (action, intent_key)
  WHERE intent_key IS NOT NULL;
