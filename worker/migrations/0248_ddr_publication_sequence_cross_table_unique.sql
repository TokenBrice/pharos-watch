-- rollout-safety: backward-compatible
-- Enforce global uniqueness of ddr_public snapshot_sequence across the legacy,
-- compressed-v2, and payload-reference publication tables. Each table's local
-- UNIQUE constraint cannot see a sequence claimed by another table, so a
-- Worker rolled back to a reference-unaware allocator (which computes
-- MAX(snapshot_sequence) over fewer tables) could silently reuse sequences
-- already claimed by reference rows and permanently duplicate publication
-- ordering. The guard aborts such an insert loudly instead; the current
-- three-table allocator never trips it, and existing rows are not touched.

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshots_sequence_unique
BEFORE INSERT ON depeg_resolver_publication_snapshots
WHEN NEW.snapshot_kind = 'ddr_public'
BEGIN
  SELECT RAISE(ABORT, 'ddr publication snapshot_sequence is already claimed by another publication table')
  WHERE EXISTS (
    SELECT 1 FROM depeg_resolver_publication_snapshots_v2
    WHERE snapshot_kind = 'ddr_public' AND snapshot_sequence = NEW.snapshot_sequence
  )
  OR EXISTS (
    SELECT 1 FROM depeg_resolver_publication_snapshot_refs
    WHERE snapshot_kind = 'ddr_public' AND snapshot_sequence = NEW.snapshot_sequence
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshots_v2_sequence_unique
BEFORE INSERT ON depeg_resolver_publication_snapshots_v2
WHEN NEW.snapshot_kind = 'ddr_public'
BEGIN
  SELECT RAISE(ABORT, 'ddr publication snapshot_sequence is already claimed by another publication table')
  WHERE EXISTS (
    SELECT 1 FROM depeg_resolver_publication_snapshots
    WHERE snapshot_kind = 'ddr_public' AND snapshot_sequence = NEW.snapshot_sequence
  )
  OR EXISTS (
    SELECT 1 FROM depeg_resolver_publication_snapshot_refs
    WHERE snapshot_kind = 'ddr_public' AND snapshot_sequence = NEW.snapshot_sequence
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshot_refs_sequence_unique
BEFORE INSERT ON depeg_resolver_publication_snapshot_refs
WHEN NEW.snapshot_kind = 'ddr_public'
BEGIN
  SELECT RAISE(ABORT, 'ddr publication snapshot_sequence is already claimed by another publication table')
  WHERE EXISTS (
    SELECT 1 FROM depeg_resolver_publication_snapshots
    WHERE snapshot_kind = 'ddr_public' AND snapshot_sequence = NEW.snapshot_sequence
  )
  OR EXISTS (
    SELECT 1 FROM depeg_resolver_publication_snapshots_v2
    WHERE snapshot_kind = 'ddr_public' AND snapshot_sequence = NEW.snapshot_sequence
  );
END;
