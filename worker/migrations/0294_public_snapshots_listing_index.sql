-- rollout-safety: backward-compatible
-- The snapshot index route, the public-dataset canary and the writer precheck
-- read only metadata columns, but payload_gz is declared before them, so every
-- table-backed read walked each row's multi-megabyte overflow chain (~2.4 s per
-- listing on 2026-11-03). Cover those reads; no row mutation.
CREATE INDEX IF NOT EXISTS idx_public_snapshots_listing
  ON public_snapshots(snapshot_date, methodology_versions, content_hash, byte_size, created_at);
