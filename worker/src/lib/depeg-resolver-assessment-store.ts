import { logWorkerEventArgs } from "./structured-log";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-resolver";
import type { DdrAssessmentCheckpoint } from "@shared/types/depeg-resolver";
import { batchExecute } from "./db";

export type { DdrAssessmentCheckpoint };

const AGE_CHECKPOINTS: Array<{ checkpoint: DdrAssessmentCheckpoint; minAgeSec: number }> = [
  { checkpoint: "age_1h", minAgeSec: 3600 },
  { checkpoint: "age_6h", minAgeSec: 6 * 3600 },
  { checkpoint: "age_24h", minAgeSec: 24 * 3600 },
  { checkpoint: "age_7d", minAgeSec: 7 * 86400 },
];

export interface DdrDiagnosticAssessmentRow {
  stablecoinId: string;
  symbol: string;
  name: string;
  pegCurrency: string;
  governance: string;
  eventId: number;
  startedAt: number;
  ageSec: number;
  direction: "above" | "below";
  resolution: {
    tier: string;
    factors: unknown[];
  };
  duration: {
    suppressed: boolean;
    suppressedReason?: string | null;
    medianSec?: number | null;
    iqrSec?: [number, number] | null;
    stratum?: string | null;
    horizons: unknown[];
  };
}

export interface DdrDiagnosticAssessmentSnapshot {
  _meta: {
    computedAt: number;
    degraded: boolean;
    resolutionRubricVersion: string;
    durationModelVersion: string;
    incidentGroupingVersion: string;
    supportRulesVersion: string;
    [key: string]: unknown;
  };
  rows: unknown[];
  methodology: {
    version: string;
    versionLabel: string;
    [key: string]: unknown;
  };
}

interface DdrAssessmentRecord {
  eventId: number;
  stablecoinId: string;
  symbol: string;
  name: string;
  pegCurrency: string;
  governance: string;
  direction: DdrDiagnosticAssessmentRow["direction"];
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
  resolutionTier: string;
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

const DDR_ASSESSMENT_INSERT_COLUMNS = [
  "event_id",
  "stablecoin_id",
  "symbol",
  "name",
  "peg_currency",
  "governance",
  "direction",
  "started_at",
  "assessed_at",
  "event_age_sec",
  "checkpoint",
  "methodology_version",
  "methodology_version_label",
  "resolution_rubric_version",
  "duration_model_version",
  "incident_grouping_version",
  "support_rules_version",
  "resolution_tier",
  "duration_suppressed",
  "duration_suppressed_reason",
  "median_remaining_sec",
  "iqr_low_remaining_sec",
  "iqr_high_remaining_sec",
  "stratum",
  "horizons_json",
  "factors_json",
  "row_json",
  "created_at",
  "updated_at",
] as const;

const DDR_ASSESSMENT_INSERT_COLUMNS_SQL = DDR_ASSESSMENT_INSERT_COLUMNS.join(", ");
const DDR_ASSESSMENT_INSERT_PLACEHOLDERS_SQL = DDR_ASSESSMENT_INSERT_COLUMNS.map(() => "?").join(", ");

export function ddrAssessmentInsertSql(verb: "INSERT INTO" | "INSERT OR IGNORE INTO"): string {
  return `${verb} depeg_resolver_assessments
     (${DDR_ASSESSMENT_INSERT_COLUMNS_SQL})
     VALUES (${DDR_ASSESSMENT_INSERT_PLACEHOLDERS_SQL})`;
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

function formatNonConformingAssessmentSample(row: unknown): string {
  try {
    return JSON.stringify(row);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    try {
      if (row != null && typeof row === "object") {
        const allKeys = Object.keys(row);
        const keys = allKeys.slice(0, 10);
        const suffix = allKeys.length > keys.length ? ",…" : "";
        return `[unserializable ${Object.prototype.toString.call(row)} keys=${keys.join(",")}${suffix}; ${errorMessage}]`;
      }
    } catch {
      // Fall through to the generic formatter when even object introspection is unsafe.
    }
    return `[unserializable ${typeof row}; ${errorMessage}]`;
  }
}

function isDiagnosticAssessmentRow(row: unknown): row is DdrDiagnosticAssessmentRow {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Partial<DdrDiagnosticAssessmentRow>;
  return (
    typeof candidate.stablecoinId === "string" &&
    typeof candidate.symbol === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.pegCurrency === "string" &&
    typeof candidate.governance === "string" &&
    typeof candidate.eventId === "number" &&
    typeof candidate.startedAt === "number" &&
    typeof candidate.ageSec === "number" &&
    (candidate.direction === "above" || candidate.direction === "below") &&
    !!candidate.resolution &&
    typeof candidate.resolution === "object" &&
    typeof candidate.resolution.tier === "string" &&
    Array.isArray(candidate.resolution.factors) &&
    !!candidate.duration &&
    typeof candidate.duration === "object" &&
    typeof candidate.duration.suppressed === "boolean" &&
    Array.isArray(candidate.duration.horizons)
  );
}

function buildAssessmentRecord(
  row: DdrDiagnosticAssessmentRow,
  snapshot: DdrDiagnosticAssessmentSnapshot,
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

export function bindDdrAssessmentInsert(stmt: D1PreparedStatement, record: DdrAssessmentRecord): D1PreparedStatement {
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

export async function writeDepegResolverAssessments(
  db: D1Database,
  snapshot: DdrDiagnosticAssessmentSnapshot,
): Promise<number> {
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
  const insertImmutable = db.prepare(ddrAssessmentInsertSql("INSERT OR IGNORE INTO"));
  const upsertLatest = db.prepare(
    `${ddrAssessmentInsertSql("INSERT INTO")}
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
  const diagnosticRows = snapshot.rows.filter(isDiagnosticAssessmentRow);
  if (diagnosticRows.length < snapshot.rows.length) {
    const droppedCount = snapshot.rows.length - diagnosticRows.length;
    const sampleRow = snapshot.rows.find((row) => !isDiagnosticAssessmentRow(row));
    logWorkerEventArgs("lib", "warn",
      `[ddr-assessment-store] Dropped ${droppedCount}/${snapshot.rows.length} non-conforming assessment rows (failed isDiagnosticAssessmentRow); sample shape: ${formatNonConformingAssessmentSample(sampleRow)}`,
    );
  }
  if (diagnosticRows.length === 0) return 0;
  for (const row of diagnosticRows) {
    for (const checkpoint of checkpointsForAge(row.ageSec)) {
      const record = buildAssessmentRecord(row, snapshot, checkpoint, nowSec);
      statements.push(bindDdrAssessmentInsert(checkpoint === "latest" ? upsertLatest : insertImmutable, record));
    }
  }

  return batchExecute(db, statements);
}
