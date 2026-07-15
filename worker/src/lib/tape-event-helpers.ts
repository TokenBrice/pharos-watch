import { ScoreTapeEventPayloadSchema, type TapeEvent, type TapeEventSeverity } from "@shared/types/tape-event";
import { getReportCardGradeRank, UNKNOWN_REPORT_CARD_GRADE_RANK } from "@shared/lib/report-card-core";
import type { TapeEventRow } from "./tape-event-types";

/** Stable per-row hash for the wire `event_id`. djb2 → 8 hex chars. */
function tapeEventHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(-8);
}

/**
 * Build the wire id: `${ts_ms}-${type}-${hash8}` where hash8 derives from a
 * stable per-source key. Re-running the projector for the same source row
 * therefore produces the same id, which we rely on for the unique index.
 */
export function buildTapeEventId(args: {
  tsMs: number;
  type: string;
  sourceTable: string;
  sourceRowId: string;
  transition: string;
}): string {
  const hash = tapeEventHash(`${args.sourceTable}|${args.sourceRowId}|${args.transition}`);
  return `${args.tsMs}-${args.type}-${hash}`;
}

/**
 * Best-effort issuer derivation. Canonical ids in this repo are
 * `<ticker>-<issuer-slug>` so the suffix after the first dash is a usable
 * identifier until curated issuer metadata exists.
 */
export function deriveIssuerId(stablecoinId: string | null): string | null {
  if (!stablecoinId) return null;
  const dash = stablecoinId.indexOf("-");
  if (dash < 0 || dash >= stablecoinId.length - 1) return null;
  return stablecoinId.slice(dash + 1);
}

// --- Severity mapping -------------------------------------------------------

export function severityForDepegOpened(absBps: number): TapeEventSeverity {
  if (absBps >= 2500) return "critical";
  if (absBps >= 1000) return "severe";
  if (absBps >= 300) return "warning";
  return "notice";
}

export function severityForFreezeBlocked(amountUsd: number | null): TapeEventSeverity {
  const usd = amountUsd ?? 0;
  if (usd >= 10_000_000) return "severe";
  if (usd >= 1_000_000) return "warning";
  return "notice";
}

export function severityForFreezeDestroyed(amountUsd: number | null): TapeEventSeverity {
  const usd = amountUsd ?? 0;
  if (usd >= 100_000_000) return "critical";
  if (usd >= 10_000_000) return "severe";
  return "warning";
}

export function gradeRank(grade: string): number {
  return getReportCardGradeRank(grade, UNKNOWN_REPORT_CARD_GRADE_RANK) ?? UNKNOWN_REPORT_CARD_GRADE_RANK;
}

export function severityForScoreDowngrade(prevGrade: string, newGrade: string): TapeEventSeverity {
  if (newGrade === "F") return "critical";
  const delta = gradeRank(prevGrade) - gradeRank(newGrade);
  if (delta >= 3) return "severe";
  if (delta >= 2) return "warning";
  return "notice";
}

/**
 * Parse a "YYYY-MM-DD" or "YYYY-MM" date string to epoch-seconds (UTC).
 * Missing day defaults to 1, missing month defaults to January.
 * Returns Math.floor(Date.now() / 1000) on invalid input.
 */
export function parseDateStringToEpochSec(value: string | undefined | null): number {
  if (!value) return Math.floor(Date.now() / 1000);
  const segments = value.split("-");
  const year = Number(segments[0]);
  const month = Number(segments[1] ?? "1");
  const day = Number(segments[2] ?? "1");
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(Date.UTC(year, Math.max(0, month - 1), Math.max(1, day)) / 1000);
}

export function truncateSummary(summary: string): string {
  return summary.length > 180 ? `${summary.slice(0, 177)}…` : summary;
}

/**
 * Methodology bumps: major X.0 → warning; everything else (X.Y, X.YZ, ...) → info.
 * "Major" is defined as a single-segment version (e.g. "6") or a version whose
 * non-leading segments are all zero (e.g. "6.0", "6.0.0").
 */
export function severityForMethodologyBump(version: string): TapeEventSeverity {
  const segments = version.split(".");
  if (segments.length <= 1) return "warning";
  const trailing = segments.slice(1);
  const allZero = trailing.every((segment) => segment === "0");
  return allZero ? "warning" : "info";
}

// --- Row → wire -------------------------------------------------------------

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isScoreTapeEventType(type: string): boolean {
  return type === "score.upgraded" || type === "score.downgraded";
}

function normalizeScoreTapePayload(row: TapeEventRow, payload: Record<string, unknown>): Record<string, unknown> {
  if (!isScoreTapeEventType(row.type)) return payload;

  const parsed = ScoreTapeEventPayloadSchema.safeParse(payload);
  if (
    parsed.success &&
    (parsed.data.safetyScore.identityStatus === "complete" || row.source_table === "safety_grade_history")
  ) {
    return parsed.data;
  }

  const hasSafetyScore = Object.prototype.hasOwnProperty.call(payload, "safetyScore");
  if (row.source_table === "safety_grade_history" && !hasSafetyScore) {
    const legacyPayload = {
      ...payload,
      safetyScore: {
        identityStatus: "legacy-v8-unidentified",
        identity: null,
      },
    };
    const legacy = ScoreTapeEventPayloadSchema.safeParse(legacyPayload);
    if (legacy.success) return legacy.data;
  }

  throw new Error(`Invalid score tape event payload: ${row.source_table}:${row.source_row_id}`);
}

export function rowToTapeEvent(row: TapeEventRow): TapeEvent {
  return {
    id: row.event_id,
    type: row.type,
    severity: row.severity,
    ts: row.ts,
    endsAt: row.ends_at,
    coinId: row.coin_id,
    issuerId: row.issuer_id,
    pegCurrency: row.peg_currency,
    chain: row.chain,
    title: row.title,
    summary: row.summary,
    payload: normalizeScoreTapePayload(row, parsePayload(row.payload_json)),
    sourceTable: row.source_table,
    sourceRowId: row.source_row_id,
    transition: row.transition,
    sourceUrl: row.source_url,
    methodologyVersion: row.methodology_version,
  };
}
