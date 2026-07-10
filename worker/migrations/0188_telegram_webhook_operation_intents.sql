-- rollout-safety: backward-compatible
-- Persist normalized Telegram webhook operation intent separately from the
-- irreversible Bot API effect fence. Planned work remains reclaimable; work
-- that crossed the outbound fence remains operator-reconcilable and is never
-- replayed automatically.

ALTER TABLE telegram_processed_updates
  ADD COLUMN intent_version INTEGER CHECK (intent_version IS NULL OR intent_version BETWEEN 1 AND 65535);

ALTER TABLE telegram_processed_updates
  ADD COLUMN intent_kind TEXT CHECK (intent_kind IS NULL OR (length(intent_kind) BETWEEN 1 AND 128));

ALTER TABLE telegram_processed_updates
  ADD COLUMN intent_mutates INTEGER NOT NULL DEFAULT 0 CHECK (intent_mutates IN (0, 1));

ALTER TABLE telegram_processed_updates
  ADD COLUMN intent_payload TEXT CHECK (intent_payload IS NULL OR length(intent_payload) <= 65536);

ALTER TABLE telegram_processed_updates
  ADD COLUMN intent_recorded_at INTEGER CHECK (intent_recorded_at IS NULL OR intent_recorded_at >= 0);

ALTER TABLE telegram_processed_updates
  ADD COLUMN mutation_applied_at INTEGER CHECK (mutation_applied_at IS NULL OR mutation_applied_at >= 0);

ALTER TABLE telegram_processed_updates
  ADD COLUMN effect_completed_at INTEGER CHECK (effect_completed_at IS NULL OR effect_completed_at >= 0);

ALTER TABLE telegram_processed_updates
  ADD COLUMN effect_kind TEXT CHECK (effect_kind IS NULL OR (length(effect_kind) BETWEEN 1 AND 64));

ALTER TABLE telegram_processed_updates
  ADD COLUMN effect_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (effect_ordinal >= 0);

CREATE TABLE IF NOT EXISTS telegram_webhook_operation_mutations (
  update_id INTEGER PRIMARY KEY NOT NULL,
  claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
  FOREIGN KEY (update_id) REFERENCES telegram_processed_updates(update_id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_telegram_webhook_operation_mutation_guard
BEFORE INSERT ON telegram_webhook_operation_mutations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM telegram_processed_updates
     WHERE update_id = NEW.update_id
       AND status = 'processing'
       AND effect_state = 'planned'
       AND intent_mutates = 1
       AND claim_generation = NEW.claim_generation
  ) THEN RAISE(ABORT, 'invalid telegram webhook mutation claim') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_telegram_webhook_operation_mutation_applied
AFTER INSERT ON telegram_webhook_operation_mutations
BEGIN
  UPDATE telegram_processed_updates
     SET mutation_applied_at = NEW.applied_at
   WHERE update_id = NEW.update_id
     AND claim_generation = NEW.claim_generation;
END;

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_effect_state_received
  ON telegram_processed_updates(effect_state, received_at);

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_intent_kind_received
  ON telegram_processed_updates(intent_kind, received_at DESC)
  WHERE intent_kind IS NOT NULL;
