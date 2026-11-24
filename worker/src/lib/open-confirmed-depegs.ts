import { isPegScoreExcludedAuditVerdict } from "@shared/lib/depeg-audit";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { DepegDirection } from "@shared/types/peg";
import { MAX_OPEN_DEPEG_EVENTS } from "./depeg-threshold-policy";
import { logWorkerEvent } from "./structured-log";

export interface OpenConfirmedDepegReference {
  direction: DepegDirection;
}

export type OpenConfirmedDepegsUnavailableReason =
  | "open-depeg-read-failed"
  | "open-depeg-limit-reached"
  | "open-depeg-row-invalid";

export type OpenConfirmedDepegsSnapshot =
  | {
      status: "ok";
      byId: Map<string, OpenConfirmedDepegReference>;
      openEventCount: number;
    }
  | {
      status: "unavailable";
      reason: OpenConfirmedDepegsUnavailableReason;
      byId: Map<string, OpenConfirmedDepegReference>;
      openEventCount: null;
    };

export interface OpenDepegContinuitySummary {
  status: "ok" | "unavailable";
  unavailableReason?: OpenConfirmedDepegsUnavailableReason;
  openEventCount: number | null;
  publishedCount: number;
  publishedAssetIds?: string[];
}

interface RawOpenConfirmedDepegRow {
  id: unknown;
  stablecoin_id: unknown;
  direction: unknown;
  started_at: unknown;
  audit_verdict: unknown;
}

interface ValidatedOpenConfirmedDepegRow {
  id: number;
  stablecoinId: string;
  direction: DepegDirection;
  startedAt: number;
  auditVerdict: string | null;
}

const MAX_CONTINUITY_SUMMARY_IDS = 20;

const OPEN_CONFIRMED_DEPEGS_SQL = `
  SELECT open_event.id, open_event.stablecoin_id, open_event.direction, open_event.started_at, provenance.audit_verdict
  FROM (
    SELECT id, stablecoin_id, direction, started_at
    FROM depeg_events
    WHERE ended_at IS NULL
    LIMIT ?
  ) AS open_event
  LEFT JOIN depeg_event_provenance AS provenance ON provenance.event_id = open_event.id
`;

function validateOpenRow(row: RawOpenConfirmedDepegRow): ValidatedOpenConfirmedDepegRow | null {
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    typeof row.stablecoin_id !== "string" ||
    row.stablecoin_id.trim().length === 0 ||
    (row.direction !== "above" && row.direction !== "below") ||
    typeof row.started_at !== "number" ||
    !Number.isSafeInteger(row.started_at) ||
    (row.audit_verdict != null && typeof row.audit_verdict !== "string")
  ) {
    return null;
  }

  return {
    id: row.id,
    stablecoinId: row.stablecoin_id,
    direction: row.direction,
    startedAt: row.started_at,
    auditVerdict: row.audit_verdict ?? null,
  };
}

function unavailableSnapshot(reason: OpenConfirmedDepegsUnavailableReason): OpenConfirmedDepegsSnapshot {
  return {
    status: "unavailable",
    reason,
    byId: new Map(),
    openEventCount: null,
  };
}

/**
 * Bounded, fail-closed read of currently open confirmed depeg events from
 * `depeg_events` (`ended_at IS NULL`, excluding reviewed disputes and pending
 * candidates). Any read failure, truncation at `MAX_OPEN_DEPEG_EVENTS`, or
 * malformed row disables open-depeg continuity so publication falls back to
 * standard rules (R2/R4).
 */
export async function loadOpenConfirmedDepegs(db: D1Database): Promise<OpenConfirmedDepegsSnapshot> {
  try {
    const result = await db
      .prepare(OPEN_CONFIRMED_DEPEGS_SQL)
      .bind(MAX_OPEN_DEPEG_EVENTS)
      .all<RawOpenConfirmedDepegRow>();
    const rawRows = result.results ?? [];

    if (rawRows.length >= MAX_OPEN_DEPEG_EVENTS) {
      logWorkerEvent({
        scope: "lib",
        job: "sync-stablecoins",
        level: "warn",
        event: "open-confirmed-depegs-unavailable",
        message: "Open confirmed depeg read reached row limit; disabling open-depeg display continuity",
        metadata: { reason: "open-depeg-limit-reached", limit: MAX_OPEN_DEPEG_EVENTS },
      });
      return unavailableSnapshot("open-depeg-limit-reached");
    }

    const eligibleRows: ValidatedOpenConfirmedDepegRow[] = [];
    for (const rawRow of rawRows) {
      const validated = validateOpenRow(rawRow);
      if (!validated) {
        logWorkerEvent({
          scope: "lib",
          job: "sync-stablecoins",
          level: "warn",
          event: "open-confirmed-depegs-unavailable",
          message: "Open confirmed depeg read contained an invalid row; disabling open-depeg display continuity",
          metadata: { reason: "open-depeg-row-invalid" },
        });
        return unavailableSnapshot("open-depeg-row-invalid");
      }
      if (isPegScoreExcludedAuditVerdict(validated.auditVerdict)) continue;
      eligibleRows.push(validated);
    }

    // Match depeg-detection repair precedence if opposite-direction open rows
    // temporarily coexist before detection closes the older row.
    eligibleRows.sort((a, b) => b.startedAt - a.startedAt || b.id - a.id);

    const byId = new Map<string, OpenConfirmedDepegReference>();
    for (const row of eligibleRows) {
      if (!byId.has(row.stablecoinId)) {
        byId.set(row.stablecoinId, { direction: row.direction });
      }
    }

    return {
      status: "ok",
      byId,
      openEventCount: eligibleRows.length,
    };
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "open-confirmed-depegs-unavailable",
      message: "Failed to read open confirmed depeg events; disabling open-depeg display continuity",
      metadata: { reason: "open-depeg-read-failed", error: toErrorMessage(error) },
    });
    return unavailableSnapshot("open-depeg-read-failed");
  }
}

export function summarizeOpenDepegContinuity(
  snapshot: OpenConfirmedDepegsSnapshot,
  publishedAssetIds: readonly string[],
): OpenDepegContinuitySummary {
  const sortedIds = [...new Set(publishedAssetIds)].sort();
  return {
    status: snapshot.status,
    ...(snapshot.status === "unavailable" ? { unavailableReason: snapshot.reason } : {}),
    openEventCount: snapshot.openEventCount,
    publishedCount: sortedIds.length,
    ...(sortedIds.length > 0 ? { publishedAssetIds: sortedIds.slice(0, MAX_CONTINUITY_SUMMARY_IDS) } : {}),
  };
}
