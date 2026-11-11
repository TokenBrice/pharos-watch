// digest_meta is unconstrained TEXT: json_extract() raises "malformed JSON" and
// aborts the whole statement. A malformed row degrades to "no metadata" (the row
// decoder names json-parse-failed) instead of hiding every readable edition.
export const DIGEST_META_TYPE_SQL =
  "CASE WHEN json_valid(digest_meta) THEN json_extract(digest_meta, '$.type') END";
const DIGEST_META_INTERNAL_SQL =
  "CASE WHEN json_valid(digest_meta) THEN json_extract(digest_meta, '$.internal') END";
const DIGEST_META_QUALITY_GATE_SQL =
  "CASE WHEN json_valid(digest_meta) THEN json_extract(digest_meta, '$.qualityGate') END";

export const NON_WEEKLY_DIGEST_SQL_FILTER =
  `digest_meta IS NULL OR ${DIGEST_META_TYPE_SQL} IS NULL OR ${DIGEST_META_TYPE_SQL} != 'weekly'`;

// Rows flagged digest_meta.internal (sentinel/guard artifacts such as the
// __bluechip_replay_guard__ weekly row) are hidden from public read output but
// still counted for edition numbering, so published edition numbers stay stable.
export const NON_INTERNAL_DIGEST_SQL_FILTER =
  `digest_meta IS NULL OR ${DIGEST_META_INTERNAL_SQL} IS NULL OR ${DIGEST_META_INTERNAL_SQL} NOT IN (1, 'true')`;

// Rows that failed the quality gate with hard issues are stored for operator
// inspection (digest_meta.qualityGate = "blocked") but never published: they
// are excluded from public reads, edition numbering, recent-copy variety
// context, and lead-streak history — a blocked edition never reached readers.
export const NON_BLOCKED_DIGEST_SQL_FILTER =
  `digest_meta IS NULL OR ${DIGEST_META_QUALITY_GATE_SQL} IS NULL OR ${DIGEST_META_QUALITY_GATE_SQL} != 'blocked'`;
