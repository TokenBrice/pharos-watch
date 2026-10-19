-- rollout-safety: backward-compatible
-- Match latest-publication ordering without scanning and sorting the immutable
-- payload archives. Existing sequence indexes and all readers/writers remain valid.
CREATE INDEX IF NOT EXISTS idx_ddr_publication_snapshots_v2_published
  ON depeg_resolver_publication_snapshots_v2
    (snapshot_kind, published_at DESC, snapshot_sequence DESC, snapshot_token);

CREATE INDEX IF NOT EXISTS idx_ddr_publication_snapshot_refs_published
  ON depeg_resolver_publication_snapshot_refs
    (snapshot_kind, published_at DESC, snapshot_sequence DESC, snapshot_token);
