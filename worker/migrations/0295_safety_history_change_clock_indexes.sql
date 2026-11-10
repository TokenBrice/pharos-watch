-- rollout-safety: backward-compatible
-- The tape-class liveness canary reads the newest Safety grade change every 15
-- minutes. The recorded_at indexes cannot skip non-change rows, so each MAX
-- walked thousands of table rows; these partial indexes make both clocks one
-- seek. No row mutation.
CREATE INDEX IF NOT EXISTS idx_safety_grade_history_prev_grade_recorded_at
  ON safety_grade_history(recorded_at DESC)
  WHERE prev_grade IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_safety_score_history_v2_organic_recorded_at
  ON safety_score_history_v2(recorded_at DESC)
  WHERE transition_kind = 'organic-grade-change' AND prev_grade IS NOT NULL;
