-- rollout-safety: backward-compatible
-- Persist the score identity schema version so V2 history consumers never
-- infer it from the currently deployed parser.

ALTER TABLE safety_score_history_v2
  ADD COLUMN identity_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (identity_schema_version = 1);
