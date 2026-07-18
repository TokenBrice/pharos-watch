export const NON_WEEKLY_DIGEST_SQL_FILTER =
  "digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly'";

// Rows flagged digest_meta.internal (sentinel/guard artifacts such as the
// __bluechip_replay_guard__ weekly row) are hidden from public read output but
// still counted for edition numbering, so published edition numbers stay stable.
export const NON_INTERNAL_DIGEST_SQL_FILTER =
  "digest_meta IS NULL OR json_extract(digest_meta, '$.internal') IS NULL OR json_extract(digest_meta, '$.internal') NOT IN (1, 'true')";

// Rows that failed the quality gate with hard issues are stored for operator
// inspection (digest_meta.qualityGate = "blocked") but never published: they
// are excluded from public reads, edition numbering, recent-copy variety
// context, and lead-streak history — a blocked edition never reached readers.
export const NON_BLOCKED_DIGEST_SQL_FILTER =
  "digest_meta IS NULL OR json_extract(digest_meta, '$.qualityGate') IS NULL OR json_extract(digest_meta, '$.qualityGate') != 'blocked'";
