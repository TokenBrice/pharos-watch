-- rollout-safety: backward-compatible
-- Fence pending Telegram effects by owner/generation and give terminal audit
-- rows a deterministic identity so cleanup retries are idempotent.

ALTER TABLE telegram_pending_alerts
  ADD COLUMN delivery_owner TEXT
  CHECK (delivery_owner IS NULL OR length(delivery_owner) <= 200);

ALTER TABLE telegram_pending_alerts
  ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0
  CHECK (delivery_generation >= 0);

ALTER TABLE telegram_pending_alerts
  ADD COLUMN delivery_claim_expires_at INTEGER
  CHECK (delivery_claim_expires_at IS NULL OR delivery_claim_expires_at >= 0);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN dead_letter_key TEXT
  CHECK (dead_letter_key IS NULL OR length(dead_letter_key) <= 200);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN delivery_state TEXT
  CHECK (delivery_state IS NULL OR delivery_state IN ('pending', 'sending', 'sent', 'execution_unknown'));

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN delivery_owner TEXT
  CHECK (delivery_owner IS NULL OR length(delivery_owner) <= 200);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN delivery_generation INTEGER
  CHECK (delivery_generation IS NULL OR delivery_generation >= 0);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN delivery_started_at INTEGER
  CHECK (delivery_started_at IS NULL OR delivery_started_at >= 0);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN delivery_completed_at INTEGER
  CHECK (delivery_completed_at IS NULL OR delivery_completed_at >= 0);

ALTER TABLE telegram_alert_dead_letters
  ADD COLUMN delivery_claim_expires_at INTEGER
  CHECK (delivery_claim_expires_at IS NULL OR delivery_claim_expires_at >= 0);

-- Preserve historical duplicates rather than deleting audit evidence. The
-- oldest row for a pending identity becomes canonical; any prior duplicates
-- retain distinct legacy keys and remain queryable.
UPDATE telegram_alert_dead_letters
   SET dead_letter_key = CASE
     WHEN pending_id IS NULL THEN 'legacy:' || id
     WHEN id = (
       SELECT MIN(candidate.id)
         FROM telegram_alert_dead_letters candidate
        WHERE candidate.pending_id = telegram_alert_dead_letters.pending_id
     ) THEN 'pending:' || pending_id || ':delivery:0'
     ELSE 'legacy-duplicate:' || id
   END
 WHERE dead_letter_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tadl_dead_letter_key
  ON telegram_alert_dead_letters(dead_letter_key)
  WHERE dead_letter_key IS NOT NULL;

-- The previous Worker remains live while this migration applies and omits the
-- new column. Adopt those inserts after the fact without rejecting them: the
-- first row for a pending identity becomes canonical and any overlap duplicate
-- remains explicit forensic evidence under its own bounded key.
CREATE TRIGGER IF NOT EXISTS trg_tadl_assign_dead_letter_key
AFTER INSERT ON telegram_alert_dead_letters
WHEN NEW.dead_letter_key IS NULL
BEGIN
  UPDATE telegram_alert_dead_letters
     SET dead_letter_key = CASE
       WHEN NEW.pending_id IS NULL THEN 'legacy:' || NEW.id
       WHEN NOT EXISTS (
         SELECT 1
           FROM telegram_alert_dead_letters existing
          WHERE existing.id <> NEW.id
            AND existing.dead_letter_key = 'pending:' || NEW.pending_id || ':delivery:0'
       ) THEN 'pending:' || NEW.pending_id || ':delivery:0'
       ELSE 'legacy-duplicate:' || NEW.id
     END
   WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_tpa_delivery_reconcile
  ON telegram_pending_alerts(delivery_state, delivery_claim_expires_at, delivery_started_at);
