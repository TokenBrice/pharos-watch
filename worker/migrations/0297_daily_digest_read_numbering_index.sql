-- rollout-safety: backward-compatible
-- The public digest reads (archive, promo and the daily edition count) filter
-- every daily_digest row on digest_meta before numbering it. digest_meta is the
-- table's last column, so each pass re-read every wide digest_text/input_data/
-- digest_extended row just to test that metadata. The read passes now project
-- only generated_at/rowid/digest_meta and join the wide body by rowid for the
-- returned page; this index serves that projection and its
-- ORDER BY generated_at, rowid (`id` is the rowid alias). No row mutation.
CREATE INDEX IF NOT EXISTS idx_daily_digest_generated_at_id_meta
  ON daily_digest(generated_at, id, digest_meta);
