import { getConditionBand } from "@shared/lib/psi-policy";
import { DAY_SECONDS } from "@shared/lib/time-constants";

// The repair records exact replacement scores by sample second in the daily marker.
// A daily delta alone cannot establish what changed at any individual timestamp.
export const PSI_DAILY_HAS_REPAIR_SQL = `CASE WHEN json_valid(input_snapshot)
  THEN json_type(input_snapshot, '$.referenceMarketRepair') = 'object' ELSE 0 END`;
const projectionFrom = `stability_index_samples AS s LEFT JOIN stability_index AS d
  ON d.id = (
    SELECT id FROM stability_index WHERE computed_at = s.stored_at - (s.stored_at % ${DAY_SECONDS})
    ORDER BY COALESCE(${PSI_DAILY_HAS_REPAIR_SQL}, 0) DESC, id DESC LIMIT 1
  )`;
const correctedScore = `CASE WHEN json_valid(d.input_snapshot) THEN
  CASE WHEN json_extract(d.input_snapshot, '$.referenceMarketRepair.method') = 'samples'
    AND json_type(d.input_snapshot, '$.referenceMarketRepair.sampleScores."' || s.stored_at || '"') IN ('integer', 'real')
    THEN json_extract(d.input_snapshot, '$.referenceMarketRepair.sampleScores."' || s.stored_at || '"')
  END
END`;
const projectedScore = `CASE WHEN (${correctedScore}) BETWEEN 0 AND 100 THEN (${correctedScore}) END`;

export async function loadPsiSampleAverage(
  db: D1Database,
  fromSec: number,
  throughSec: number,
  includeStart = false,
): Promise<{ avg: number | null } | null> {
  // SAFETY: SQL fragments and comparison operators are fixed. Bind both clock values.
  return db.prepare(`SELECT AVG(COALESCE(${projectedScore}, s.score)) AS avg FROM ${projectionFrom}
    WHERE s.stored_at ${includeStart ? ">=" : ">"} ? AND s.stored_at <= ?`).bind(fromSec, throughSec).first<{ avg: number | null }>();
}

interface PsiSampleProjectionRow {
  stored_at: number;
  band: string;
  score: number;
  methodology_version: string | null;
  corrected_score?: number | null;
}

// SAFETY: Both interpolations are fixed projection fragments.
export const PSI_SAMPLE_PROJECTION_SQL = `SELECT s.stored_at, s.score, s.band, s.methodology_version,
  ${projectedScore} AS corrected_score FROM ${projectionFrom}`;

export function projectPsiSample(row: PsiSampleProjectionRow) {
  return row.corrected_score == null ? row : {
    ...row, original_band: row.band, score: row.corrected_score, band: getConditionBand(row.corrected_score),
  };
}
