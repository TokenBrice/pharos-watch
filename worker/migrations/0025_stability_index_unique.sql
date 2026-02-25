-- Deduplicate: keep only the row with the highest id for each computed_at value.
-- This handles any existing duplicates from double-fires.
DELETE FROM stability_index WHERE id NOT IN (
  SELECT MAX(id) FROM stability_index GROUP BY computed_at
);

-- Replace the non-unique index with a unique one.
DROP INDEX IF EXISTS idx_stability_index_computed_at;
CREATE UNIQUE INDEX idx_stability_index_computed_at ON stability_index(computed_at);
