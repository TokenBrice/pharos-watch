-- rollout-safety: backward-compatible
--
-- Every column is nullable or defaulted, so the currently-live Worker keeps
-- inserting and draining `telegram_digest_outbox` rows unchanged while this
-- migration is applied ahead of the new Worker becoming active.

ALTER TABLE telegram_digest_outbox
  ADD COLUMN map_image_url TEXT;

ALTER TABLE telegram_digest_outbox
  ADD COLUMN map_date TEXT;

ALTER TABLE telegram_digest_outbox
  ADD COLUMN media_state TEXT NOT NULL DEFAULT 'none'
  CHECK (media_state IN ('none', 'pending', 'sent'));
