import { TapeEventSchema, type TapeEvent, type TapeEventSeverity } from "@shared/types/tape-event";
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
  // An unrecovered amount may be arbitrarily large; keep it below the
  // highest known tier rather than treating the unknown as zero.
  if (amountUsd == null) return "warning";
  if (amountUsd >= 10_000_000) return "severe";
  if (amountUsd >= 1_000_000) return "warning";
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
 * Parse an exact "YYYY-MM-DD" or "YYYY-MM" date string to epoch-seconds
 * (UTC). Missing days default to the first of the month. Invalid or absent
 * curated dates return null.
 */
export function parseDateStringToEpochSec(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3] ?? "1");
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  const timestampMs = parsed.getTime();
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(timestampMs / 1000);
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

/** Named reasons a persisted row is quarantined at the D1 read boundary (rule R8). */
export type TapeEventQuarantineReason = "payload-json-invalid" | "wire-schema-invalid";

/** Quarantine record for a stored row that cannot be emitted as a wire event. */
export interface TapeEventQuarantine {
  reason: TapeEventQuarantineReason;
  /** Wire-field paths that failed validation; empty when the stored JSON itself is unreadable. */
  fields: string[];
}

/** Result of mapping one D1 row: either the wire event or the reason it is quarantined. */
export type TapeEventRowMapping =
  | { event: TapeEvent; quarantine: null }
  | { event: null; quarantine: TapeEventQuarantine };

/** Parse stored `payload_json`; unparsable or non-object JSON is never coerced into `{}`. */
function parsePayload(payloadJson: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function isScoreTapeEventType(type: string): boolean {
  return type === "score.upgraded" || type === "score.downgraded";
}

/**
 * Rows written before V9 score provenance existed carry no `safetyScore`
 * object. Synthesize the documented legacy provenance for the v8 history table
 * so those rows stay readable; the wire schema still validates the result.
 */
function withLegacyScoreProvenance(row: TapeEventRow, payload: Record<string, unknown>): Record<string, unknown> {
  if (!isScoreTapeEventType(row.type)) return payload;
  if (row.source_table !== "safety_grade_history") return payload;
  if (Object.prototype.hasOwnProperty.call(payload, "safetyScore")) return payload;
  return {
    ...payload,
    safetyScore: {
      identityStatus: "legacy-v8-unidentified",
      identity: null,
    },
  };
}

/**
 * Map a persisted D1 row to the wire event, validating the complete event
 * against `TapeEventSchema` — the schema this endpoint publishes. A row that
 * fails is quarantined with a named reason so callers drop only that row and
 * keep serving the remainder (rule R8); it is never emitted as an empty event.
 */
export function mapTapeEventRow(row: TapeEventRow): TapeEventRowMapping {
  const parsedPayload = parsePayload(row.payload_json);
  if (parsedPayload == null) {
    return { event: null, quarantine: { reason: "payload-json-invalid", fields: [] } };
  }

  const parsed = TapeEventSchema.safeParse({
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
    payload: withLegacyScoreProvenance(row, parsedPayload),
    sourceTable: row.source_table,
    sourceRowId: row.source_row_id,
    transition: row.transition,
    sourceUrl: row.source_url,
    methodologyVersion: row.methodology_version,
  });
  if (!parsed.success) {
    return {
      event: null,
      quarantine: {
        reason: "wire-schema-invalid",
        fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "root"))].sort(),
      },
    };
  }

  return { event: parsed.data, quarantine: null };
}
