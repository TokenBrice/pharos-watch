import type { RedemptionRouteStatus, RedemptionRouteStatusSource } from "@shared/types/redemption";
import { REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS } from "@shared/lib/report-card-active-depeg";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

interface ActiveDepegAvailabilityRow {
  stablecoin_id: string;
  peak_deviation_bps: number;
  started_at: number;
}

export interface RedemptionRouteAvailability {
  routeStatus: Extract<RedemptionRouteStatus, "degraded">;
  routeStatusSource: Extract<RedemptionRouteStatusSource, "market-implied">;
  routeStatusReason: string;
  routeStatusReviewedAt: string;
  activeDepegBps: number;
  activeDepegStartedAt: number;
}

function formatUtcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function formatRouteAvailabilityReviewedAt(nowSec = Math.floor(Date.now() / 1000)): string {
  return formatUtcDate(nowSec);
}

export async function loadSevereActiveDepegAvailabilityMap(
  db: D1Database,
  routeStatusReviewedAt: string,
): Promise<Map<string, RedemptionRouteAvailability>> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, peak_deviation_bps, started_at
         FROM depeg_events
        WHERE ended_at IS NULL`,
    )
    .all<ActiveDepegAvailabilityRow>();

  const result = new Map<string, RedemptionRouteAvailability>();
  const directRowsById = new Map<string, ActiveDepegAvailabilityRow>();
  for (const row of rows.results ?? []) {
    const activeDepegBps = Math.abs(row.peak_deviation_bps);
    if (activeDepegBps < REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS) continue;

    directRowsById.set(row.stablecoin_id, row);
    result.set(row.stablecoin_id, {
      routeStatus: "degraded",
      routeStatusSource: "market-implied",
      routeStatusReason:
        `Active severe depeg of ${activeDepegBps} bps started ${formatUtcDate(row.started_at)}; static redemption route requires current live-open evidence before it can score.`,
      routeStatusReviewedAt,
      activeDepegBps,
      activeDepegStartedAt: row.started_at,
    });
  }

  for (const meta of ACTIVE_STABLECOINS) {
    if (!meta.variantOf || meta.pegReferenceId !== meta.variantOf) continue;
    if (result.has(meta.id)) continue;

    const parentRow = directRowsById.get(meta.variantOf);
    if (!parentRow) continue;

    const activeDepegBps = Math.abs(parentRow.peak_deviation_bps);
    if (activeDepegBps < REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS) continue;

    const parentSymbol = TRACKED_META_BY_ID.get(meta.variantOf)?.symbol ?? meta.variantOf;
    result.set(meta.id, {
      routeStatus: "degraded",
      routeStatusSource: "market-implied",
      routeStatusReason:
        `Parent ${parentSymbol} has an active severe depeg of ${activeDepegBps} bps started ${formatUtcDate(parentRow.started_at)}; wrapper redemption requires current live-open evidence before it can score.`,
      routeStatusReviewedAt,
      activeDepegBps,
      activeDepegStartedAt: parentRow.started_at,
    });
  }

  return result;
}
