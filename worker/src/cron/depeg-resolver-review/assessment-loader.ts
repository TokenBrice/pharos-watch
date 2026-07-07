import { DDR_METHODOLOGY_VERSION } from "@shared/lib/depeg-resolver-version";
import { DdrrAssessmentSchema, type DdrrAssessment } from "@shared/types/depeg-resolver-review";

export const DDRR_ASSESSMENT_ROW_CAP = 20_000;

interface AssessmentDbRow {
  event_id: number;
  stablecoin_id: string;
  symbol: string;
  name: string;
  peg_currency: string;
  governance: string;
  direction: "above" | "below";
  started_at: number;
  assessed_at: number;
  event_age_sec: number;
  checkpoint: DdrrAssessment["checkpoint"];
  methodology_version: string;
  resolution_tier: DdrrAssessment["resolutionTier"];
  duration_suppressed: number;
  duration_suppressed_reason: string | null;
  median_remaining_sec: number | null;
  iqr_low_remaining_sec: number | null;
  iqr_high_remaining_sec: number | null;
  stratum: string | null;
  horizons_json: string;
  factors_json: string;
}

function toIqrRemainingSec(row: AssessmentDbRow): DdrrAssessment["iqrRemainingSec"] {
  if (row.iqr_low_remaining_sec == null || row.iqr_high_remaining_sec == null) return null;
  return [row.iqr_low_remaining_sec, row.iqr_high_remaining_sec];
}

function parseAssessmentRow(row: AssessmentDbRow): DdrrAssessment | null {
  const parsed = DdrrAssessmentSchema.safeParse({
    eventId: row.event_id,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    name: row.name,
    pegCurrency: row.peg_currency,
    governance: row.governance,
    direction: row.direction,
    startedAt: row.started_at,
    assessedAt: row.assessed_at,
    eventAgeSec: row.event_age_sec,
    checkpoint: row.checkpoint,
    methodologyVersion: row.methodology_version,
    resolutionTier: row.resolution_tier,
    durationSuppressed: row.duration_suppressed === 1,
    durationSuppressedReason: row.duration_suppressed_reason,
    predictedRemainingSec: row.median_remaining_sec,
    iqrRemainingSec: toIqrRemainingSec(row),
    horizonCells: JSON.parse(row.horizons_json),
    stratum: row.stratum,
    factors: JSON.parse(row.factors_json),
  });

  return parsed.success ? parsed.data : null;
}

export async function loadAssessments(
  db: D1Database,
): Promise<{ assessments: DdrrAssessment[]; parseIssueCount: number; truncated: boolean }> {
  const result = await db
    .prepare(
      `SELECT event_id, stablecoin_id, symbol, name, peg_currency, governance, direction,
              started_at, assessed_at, event_age_sec, checkpoint, methodology_version,
              resolution_tier, duration_suppressed, duration_suppressed_reason,
              median_remaining_sec, iqr_low_remaining_sec, iqr_high_remaining_sec,
              stratum, horizons_json, factors_json
       FROM depeg_resolver_assessments
       WHERE checkpoint = 'first' AND methodology_version = ?
       ORDER BY started_at DESC, event_id DESC, assessed_at ASC, checkpoint ASC
       LIMIT ?`,
    )
    .bind(DDR_METHODOLOGY_VERSION, DDRR_ASSESSMENT_ROW_CAP + 1)
    .all<AssessmentDbRow>();

  const sourceRows = result.results ?? [];
  const truncated = sourceRows.length > DDRR_ASSESSMENT_ROW_CAP;
  const assessments: DdrrAssessment[] = [];
  let parseIssueCount = 0;
  for (const row of sourceRows.slice(0, DDRR_ASSESSMENT_ROW_CAP)) {
    try {
      const assessment = parseAssessmentRow(row);
      if (assessment) assessments.push(assessment);
      else parseIssueCount += 1;
    } catch {
      parseIssueCount += 1;
    }
  }
  return { assessments, parseIssueCount, truncated };
}
