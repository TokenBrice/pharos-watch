-- rollout-safety: backward-compatible
-- Disposition carry for V8-to-V9 movement reviews. The exact review key stays the immutable
-- record of what a reviewer actually saw; the class key plus the reviewed score anchors let a
-- recorded disposition carry forward across runs while the movement's class is unchanged and
-- its score has not drifted past the ratified cap. A class change expires the carry.
--
-- The table holds zero rows at the time of this migration, so the new columns are introduced as
-- NOT NULL-by-convention without a backfill; the store rejects rows that cannot be projected.

ALTER TABLE safety_score_v9_movement_reviews
  ADD COLUMN review_class_key TEXT NOT NULL DEFAULT '' CHECK (length(review_class_key) IN (0, 64));

ALTER TABLE safety_score_v9_movement_reviews
  ADD COLUMN reviewed_v8_score REAL;

ALTER TABLE safety_score_v9_movement_reviews
  ADD COLUMN reviewed_v9_score REAL;

-- Carry resolution reads by class key across every recorded review of the frozen candidate.
CREATE INDEX IF NOT EXISTS idx_safety_score_v9_movement_reviews_class
  ON safety_score_v9_movement_reviews(review_class_key, reviewed_at_sec DESC);
