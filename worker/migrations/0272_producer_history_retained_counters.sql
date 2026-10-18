-- rollout-safety: backward-compatible
-- data-migration: reviewed
-- Read the existing identity/productive covering index once (~183k retained rows)
-- and write only one small counter row per identity, not one row per invocation.
-- D1 has no read-row cap; this aggregate is subject to its 30-second query cap.
-- The migration transaction completes initialization before readers activate.
CREATE TABLE IF NOT EXISTS worker_producer_retained_counts (
  schedule_key TEXT NOT NULL,
  job TEXT NOT NULL,
  producer_path TEXT NOT NULL,
  producer_kind TEXT NOT NULL,
  invocation_count INTEGER NOT NULL DEFAULT 0,
  productive_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (schedule_key, job, producer_path, producer_kind)
) WITHOUT ROWID;

-- Reapplying is safe: existing counters already reflect intervening mutations.
INSERT OR IGNORE INTO worker_producer_retained_counts (
  schedule_key, job, producer_path, producer_kind, invocation_count, productive_count
)
SELECT schedule_key, job, producer_path, producer_kind, COUNT(*), SUM(productive)
  FROM worker_producer_history INDEXED BY idx_worker_producer_history_productive
 GROUP BY schedule_key, job, producer_path, producer_kind;

CREATE TRIGGER IF NOT EXISTS trg_producer_retained_counts_insert
AFTER INSERT ON worker_producer_history
BEGIN
  INSERT INTO worker_producer_retained_counts (
    schedule_key, job, producer_path, producer_kind, invocation_count, productive_count
  ) VALUES (NEW.schedule_key, NEW.job, NEW.producer_path, NEW.producer_kind, 1, NEW.productive)
  ON CONFLICT(schedule_key, job, producer_path, producer_kind) DO UPDATE SET
    invocation_count = invocation_count + 1,
    productive_count = productive_count + NEW.productive;
END;

CREATE TRIGGER IF NOT EXISTS trg_producer_retained_counts_delete
AFTER DELETE ON worker_producer_history
BEGIN
  UPDATE worker_producer_retained_counts
     SET invocation_count = invocation_count - 1,
         productive_count = productive_count - OLD.productive
   WHERE schedule_key = OLD.schedule_key AND job = OLD.job
     AND producer_path = OLD.producer_path AND producer_kind = OLD.producer_kind;
END;

CREATE TRIGGER IF NOT EXISTS trg_producer_retained_counts_productivity
AFTER UPDATE OF productive ON worker_producer_history
WHEN OLD.schedule_key = NEW.schedule_key AND OLD.job = NEW.job
 AND OLD.producer_path = NEW.producer_path AND OLD.producer_kind = NEW.producer_kind
 AND OLD.productive != NEW.productive
BEGIN
  UPDATE worker_producer_retained_counts
     SET productive_count = productive_count + NEW.productive - OLD.productive
   WHERE schedule_key = NEW.schedule_key AND job = NEW.job
     AND producer_path = NEW.producer_path AND producer_kind = NEW.producer_kind;
END;

CREATE TRIGGER IF NOT EXISTS trg_producer_retained_counts_identity
AFTER UPDATE OF schedule_key, job, producer_path, producer_kind ON worker_producer_history
WHEN OLD.schedule_key != NEW.schedule_key OR OLD.job != NEW.job
 OR OLD.producer_path != NEW.producer_path OR OLD.producer_kind != NEW.producer_kind
BEGIN
  UPDATE worker_producer_retained_counts
     SET invocation_count = invocation_count - 1,
         productive_count = productive_count - OLD.productive
   WHERE schedule_key = OLD.schedule_key AND job = OLD.job
     AND producer_path = OLD.producer_path AND producer_kind = OLD.producer_kind;
  INSERT INTO worker_producer_retained_counts (
    schedule_key, job, producer_path, producer_kind, invocation_count, productive_count
  ) VALUES (NEW.schedule_key, NEW.job, NEW.producer_path, NEW.producer_kind, 1, NEW.productive)
  ON CONFLICT(schedule_key, job, producer_path, producer_kind) DO UPDATE SET
    invocation_count = invocation_count + 1,
    productive_count = productive_count + NEW.productive;
END;
