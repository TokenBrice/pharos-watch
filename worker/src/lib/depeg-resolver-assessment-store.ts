import type { DdrResponse, DdrRow } from "@shared/types/depeg-resolver";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/depeg-resolver-version";
import { batchExecute } from "./db";

export type DdrAssessmentCheckpoint = "first" | "age_1h" | "age_6h" | "age_24h" | "age_7d" | "latest";

const AGE_CHECKPOINTS: Array<{ checkpoint: DdrAssessmentCheckpoint; minAgeSec: number }> = [
  { checkpoint: "age_1h", minAgeSec: 3600 },
  { checkpoint: "age_6h", minAgeSec: 6 * 3600 },
  { checkpoint: "age_24h", minAgeSec: 24 * 3600 },
  { checkpoint: "age_7d", minAgeSec: 7 * 86400 },
];

interface DdrAssessmentRecord {
  eventId: number;
  stablecoinId: string;
  symbol: string;
  name: string;
  pegCurrency: string;
  governance: string;
  direction: DdrRow["direction"];
  startedAt: number;
  assessedAt: number;
  eventAgeSec: number;
  checkpoint: DdrAssessmentCheckpoint;
  methodologyVersion: string;
  methodologyVersionLabel: string;
  resolutionRubricVersion: string;
  durationModelVersion: string;
  incidentGroupingVersion: string;
  supportRulesVersion: string;
  resolutionTier: DdrRow["resolution"]["tier"];
  durationSuppressed: number;
  durationSuppressedReason: string | null;
  medianRemainingSec: number | null;
  iqrLowRemainingSec: number | null;
  iqrHighRemainingSec: number | null;
  stratum: string | null;
  horizonsJson: string;
  factorsJson: string;
  rowJson: string;
  createdAt: number;
  updatedAt: number;
}

function roundedSec(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function checkpointsForAge(ageSec: number): DdrAssessmentCheckpoint[] {
  const checkpoints: DdrAssessmentCheckpoint[] = ["first", "latest"];
  for (const { checkpoint, minAgeSec } of AGE_CHECKPOINTS) {
    if (ageSec >= minAgeSec) checkpoints.push(checkpoint);
  }
  return checkpoints;
}

function buildAssessmentRecord(
  row: DdrRow,
  snapshot: DdrResponse,
  checkpoint: DdrAssessmentCheckpoint,
  nowSec: number,
): DdrAssessmentRecord {
  const iqr = row.duration.iqrSec ?? null;
  return {
    eventId: row.eventId,
    stablecoinId: row.stablecoinId,
    symbol: row.symbol,
    name: row.name,
    pegCurrency: row.pegCurrency,
    governance: row.governance,
    direction: row.direction,
    startedAt: row.startedAt,
    assessedAt: snapshot._meta.computedAt,
    eventAgeSec: row.ageSec,
    checkpoint,
    methodologyVersion: snapshot.methodology.version,
    methodologyVersionLabel: snapshot.methodology.versionLabel,
    resolutionRubricVersion: snapshot._meta.resolutionRubricVersion,
    durationModelVersion: snapshot._meta.durationModelVersion,
    incidentGroupingVersion: snapshot._meta.incidentGroupingVersion,
    supportRulesVersion: snapshot._meta.supportRulesVersion,
    resolutionTier: row.resolution.tier,
    durationSuppressed: row.duration.suppressed ? 1 : 0,
    durationSuppressedReason: row.duration.suppressedReason ?? null,
    medianRemainingSec: roundedSec(row.duration.medianSec),
    iqrLowRemainingSec: roundedSec(iqr?.[0]),
    iqrHighRemainingSec: roundedSec(iqr?.[1]),
    stratum: row.duration.stratum ?? null,
    horizonsJson: JSON.stringify(row.duration.horizons),
    factorsJson: JSON.stringify(row.resolution.factors),
    rowJson: JSON.stringify(row),
    createdAt: nowSec,
    updatedAt: nowSec,
  };
}

function bindAssessment(stmt: D1PreparedStatement, record: DdrAssessmentRecord): D1PreparedStatement {
  return stmt.bind(
    record.eventId,
    record.stablecoinId,
    record.symbol,
    record.name,
    record.pegCurrency,
    record.governance,
    record.direction,
    record.startedAt,
    record.assessedAt,
    record.eventAgeSec,
    record.checkpoint,
    record.methodologyVersion,
    record.methodologyVersionLabel,
    record.resolutionRubricVersion,
    record.durationModelVersion,
    record.incidentGroupingVersion,
    record.supportRulesVersion,
    record.resolutionTier,
    record.durationSuppressed,
    record.durationSuppressedReason,
    record.medianRemainingSec,
    record.iqrLowRemainingSec,
    record.iqrHighRemainingSec,
    record.stratum,
    record.horizonsJson,
    record.factorsJson,
    record.rowJson,
    record.createdAt,
    record.updatedAt,
  );
}

export async function writeDepegResolverAssessments(db: D1Database, snapshot: DdrResponse): Promise<number> {
  if (snapshot._meta.degraded || snapshot.rows.length === 0) return 0;
  if (snapshot.methodology.version !== DDR_METHODOLOGY_VERSION) {
    throw new Error(
      `Cannot persist DDR assessments for methodology ${snapshot.methodology.version}; expected ${DDR_METHODOLOGY_VERSION}`,
    );
  }
  if (snapshot.methodology.versionLabel !== DDR_METHODOLOGY_VERSION_LABEL) {
    throw new Error(
      `Cannot persist DDR assessments for label ${snapshot.methodology.versionLabel}; expected ${DDR_METHODOLOGY_VERSION_LABEL}`,
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const insertImmutable = db.prepare(
    `INSERT OR IGNORE INTO depeg_resolver_assessments
     (event_id, stablecoin_id, symbol, name, peg_currency, governance, direction,
      started_at, assessed_at, event_age_sec, checkpoint, methodology_version,
      methodology_version_label, resolution_rubric_version, duration_model_version,
      incident_grouping_version, support_rules_version, resolution_tier,
      duration_suppressed, duration_suppressed_reason, median_remaining_sec,
      iqr_low_remaining_sec, iqr_high_remaining_sec, stratum, horizons_json,
      factors_json, row_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertLatest = db.prepare(
    `INSERT INTO depeg_resolver_assessments
     (event_id, stablecoin_id, symbol, name, peg_currency, governance, direction,
      started_at, assessed_at, event_age_sec, checkpoint, methodology_version,
      methodology_version_label, resolution_rubric_version, duration_model_version,
      incident_grouping_version, support_rules_version, resolution_tier,
      duration_suppressed, duration_suppressed_reason, median_remaining_sec,
      iqr_low_remaining_sec, iqr_high_remaining_sec, stratum, horizons_json,
      factors_json, row_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, checkpoint, methodology_version) DO UPDATE SET
       stablecoin_id = excluded.stablecoin_id,
       symbol = excluded.symbol,
       name = excluded.name,
       peg_currency = excluded.peg_currency,
       governance = excluded.governance,
       direction = excluded.direction,
       started_at = excluded.started_at,
       assessed_at = excluded.assessed_at,
       event_age_sec = excluded.event_age_sec,
       methodology_version_label = excluded.methodology_version_label,
       resolution_rubric_version = excluded.resolution_rubric_version,
       duration_model_version = excluded.duration_model_version,
       incident_grouping_version = excluded.incident_grouping_version,
       support_rules_version = excluded.support_rules_version,
       resolution_tier = excluded.resolution_tier,
       duration_suppressed = excluded.duration_suppressed,
       duration_suppressed_reason = excluded.duration_suppressed_reason,
       median_remaining_sec = excluded.median_remaining_sec,
       iqr_low_remaining_sec = excluded.iqr_low_remaining_sec,
       iqr_high_remaining_sec = excluded.iqr_high_remaining_sec,
       stratum = excluded.stratum,
       horizons_json = excluded.horizons_json,
       factors_json = excluded.factors_json,
       row_json = excluded.row_json,
       updated_at = excluded.updated_at`,
  );

  const statements: D1PreparedStatement[] = [];
  for (const row of snapshot.rows) {
    for (const checkpoint of checkpointsForAge(row.ageSec)) {
      const record = buildAssessmentRecord(row, snapshot, checkpoint, nowSec);
      statements.push(bindAssessment(checkpoint === "latest" ? upsertLatest : insertImmutable, record));
    }
  }

  return batchExecute(db, statements);
}
