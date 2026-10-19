-- rollout-safety: backward-compatible
-- 0275 is reserved by the independently integrated request-source attribution slice.
-- Queue events never create cron_slot_executions or scheduler-delivery evidence.
CREATE TABLE reserve_continuation_executions (
  delivery_id TEXT PRIMARY KEY,
  schedule_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL,
  checkpoint_generation INTEGER NOT NULL,
  queue_hash TEXT NOT NULL,
  next_item_key TEXT,
  items_done INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('reserve', 'tail')),
  source_invocation_id TEXT NOT NULL,
  execution_owner TEXT NOT NULL,
  execution_generation INTEGER NOT NULL,
  invocation_id TEXT NOT NULL,
  worker_version TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'reconciling', 'finished')),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  finished_at INTEGER,
  result_status TEXT,
  metadata TEXT
);
CREATE INDEX idx_reserve_continuation_executions_recovery
  ON reserve_continuation_executions (state, updated_at);
CREATE INDEX idx_reserve_continuation_executions_retention
  ON reserve_continuation_executions (finished_at);

-- Keep the existing cron child's foreign key and old-Worker writes intact.
-- Shared terminal arbitration selects this table only for an explicit Queue fence.
CREATE TABLE reserve_continuation_child_attempts (
  attempt_key TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES reserve_continuation_executions(delivery_id) ON DELETE CASCADE,
  schedule_key TEXT NOT NULL,
  slot_started_at INTEGER NOT NULL,
  job TEXT NOT NULL,
  producer_path TEXT NOT NULL,
  producer_kind TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  execution_schedule_key TEXT NOT NULL,
  execution_slot_started_at INTEGER NOT NULL,
  execution_invocation_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL,
  execution_owner TEXT NOT NULL,
  worker_version TEXT,
  started_at INTEGER,
  lease_owner TEXT,
  terminal_source TEXT CHECK (terminal_source IN ('real', 'preflight', 'synthetic')),
  terminal_token TEXT,
  terminal_at INTEGER
);
CREATE INDEX idx_reserve_continuation_children_execution
  ON reserve_continuation_child_attempts (delivery_id, execution_generation);
CREATE INDEX idx_reserve_continuation_executions_root
  ON reserve_continuation_executions (schedule_key, slot_started_at, started_at DESC, delivery_id DESC);
CREATE UNIQUE INDEX idx_reserve_continuation_executions_invocation
  ON reserve_continuation_executions (invocation_id);
