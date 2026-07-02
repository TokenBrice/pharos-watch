import type { RedemptionRouteStatus, RedemptionRouteStatusSource } from "@shared/types/redemption";
import { formatIsoDate } from "@shared/lib/format";
import { REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS } from "@shared/lib/report-card-active-depeg";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getRedemptionBackstopConfig, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { StablecoinMeta } from "@shared/types";

export { formatIsoDate as formatUtcDate } from "@shared/lib/format";

export interface ActiveDepegAvailabilityRow {
  stablecoin_id: string;
  peak_deviation_bps: number;
  direction?: "above" | "below" | string | null;
  started_at: number;
}

export interface RedemptionRouteAvailability {
  routeStatus: Extract<RedemptionRouteStatus, "degraded">;
  routeStatusSource: Extract<RedemptionRouteStatusSource, "market-implied">;
  routeStatusReason: string;
  routeStatusReviewedAt: string;
  activeDepegBps: number;
  activeDepegStartedAt: number;
  activeDepegDirection: "below";
  outputImpairedShare?: number;
  outputImpairedDependencyId?: string;
}

function isSevereDownsideDepeg(row: ActiveDepegAvailabilityRow): boolean {
  if (!Number.isFinite(row.peak_deviation_bps)) return false;
  const activeDepegBps = Math.abs(row.peak_deviation_bps);
  if (activeDepegBps < REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS) return false;

  if (row.direction === "below") return true;
  if (row.direction === "above") return false;

  return row.peak_deviation_bps < 0;
}

function getTrackedSymbol(stablecoinId: string): string {
  return TRACKED_META_BY_ID.get(stablecoinId)?.symbol ?? stablecoinId;
}

function addDependencyWeight(
  weights: Map<string, number>,
  stablecoinId: string | null | undefined,
  weight: number,
  selfId: string,
): void {
  if (!stablecoinId || stablecoinId === selfId || weight <= 0 || !Number.isFinite(weight)) return;
  weights.set(stablecoinId, Math.max(weights.get(stablecoinId) ?? 0, Math.min(1, weight)));
}

function resolveOutputDependencyWeights(
  meta: StablecoinMeta,
  config: RedemptionBackstopConfig,
): { weights: Map<string, number>; reserveDerived: boolean } {
  const weights = new Map<string, number>();

  if (meta.variantOf) {
    addDependencyWeight(weights, meta.variantOf, 1, meta.id);
  }
  if (meta.pegReferenceId && meta.pegReferenceId !== meta.variantOf) {
    addDependencyWeight(weights, meta.pegReferenceId, 1, meta.id);
  }

  if (weights.size > 0) return { weights, reserveDerived: false };
  if (config.routeFamily === "offchain-issuer") return { weights, reserveDerived: false };

  for (const reserve of meta.reserves ?? []) {
    addDependencyWeight(weights, reserve.coinId, reserve.pct / 100, meta.id);
  }

  for (const dependency of meta.dependencies ?? []) {
    addDependencyWeight(weights, dependency.id, dependency.weight, meta.id);
  }

  return { weights, reserveDerived: true };
}

export interface OutputDependencyImpairmentEvaluation {
  impairedRow: ActiveDepegAvailabilityRow;
  impairedDependencyId: string;
  outputImpairedShare: number;
  /** True when the configured output dependency weights sum above 1.0 (over-leveraged composition). */
  overLeveragedComposition: boolean;
}

export function evaluateOutputDependencyImpairment(
  weights: ReadonlyMap<string, number>,
  directRowsById: ReadonlyMap<string, ActiveDepegAvailabilityRow>,
): OutputDependencyImpairmentEvaluation | null {
  let impairedRow: ActiveDepegAvailabilityRow | null = null;
  let impairedDependencyId: string | null = null;
  let impairedShare = 0;
  let totalWeight = 0;

  for (const [dependencyId, weight] of weights) {
    totalWeight += weight;
    const dependencyRow = directRowsById.get(dependencyId);
    if (!dependencyRow) continue;
    impairedShare += weight;
    if (
      impairedRow == null ||
      Math.abs(dependencyRow.peak_deviation_bps) > Math.abs(impairedRow.peak_deviation_bps)
    ) {
      impairedRow = dependencyRow;
      impairedDependencyId = dependencyId;
    }
  }

  if (!impairedRow || !impairedDependencyId) return null;

  return {
    impairedRow,
    impairedDependencyId,
    outputImpairedShare: Math.min(1, Math.max(0, impairedShare)),
    overLeveragedComposition: totalWeight > 1 + 1e-9,
  };
}

export async function loadSevereActiveDepegAvailabilityMap(
  db: D1Database,
  routeStatusReviewedAt: string,
): Promise<Map<string, RedemptionRouteAvailability>> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, peak_deviation_bps, direction, started_at
         FROM depeg_events
        WHERE ended_at IS NULL`,
    )
    .all<ActiveDepegAvailabilityRow>();

  const result = new Map<string, RedemptionRouteAvailability>();
  const directRowsById = new Map<string, ActiveDepegAvailabilityRow>();
  for (const row of rows.results ?? []) {
    if (!isSevereDownsideDepeg(row)) continue;

    const activeDepegBps = Math.abs(row.peak_deviation_bps);

    directRowsById.set(row.stablecoin_id, row);
    result.set(row.stablecoin_id, {
      routeStatus: "degraded",
      routeStatusSource: "market-implied",
      routeStatusReason:
        `Active severe downside depeg of ${activeDepegBps} bps started ${formatIsoDate(row.started_at)}; static redemption route requires current live-open evidence before it can score.`,
      routeStatusReviewedAt,
      activeDepegBps,
      activeDepegStartedAt: row.started_at,
      activeDepegDirection: "below",
    });
  }

  for (const meta of ACTIVE_STABLECOINS) {
    if (result.has(meta.id)) continue;

    const config = getRedemptionBackstopConfig(meta.id);
    if (!config) continue;

    const { weights: outputDependencyWeights, reserveDerived } = resolveOutputDependencyWeights(meta, config);
    const evaluation = evaluateOutputDependencyImpairment(outputDependencyWeights, directRowsById);
    if (!evaluation) continue;

    const { impairedRow, impairedDependencyId, outputImpairedShare } = evaluation;
    const activeDepegBps = Math.abs(impairedRow.peak_deviation_bps);
    const dependencySymbol = getTrackedSymbol(impairedDependencyId);
    const isParentImpairment = meta.variantOf === impairedDependencyId || meta.pegReferenceId === impairedDependencyId;
    const outputImpairedSharePct = Math.round(outputImpairedShare * 100);
    const overLeveragedMarker =
      reserveDerived && evaluation.overLeveragedComposition
        ? " Modeled output dependency weights sum above 100% of supply (over-leveraged composition); the impaired output share is clamped at 100%."
        : "";
    result.set(meta.id, {
      routeStatus: "degraded",
      routeStatusSource: "market-implied",
      routeStatusReason:
        (isParentImpairment
          ? `Output asset impairment: parent ${dependencySymbol} has an active severe downside depeg of ${activeDepegBps} bps started ${formatIsoDate(impairedRow.started_at)}; wrapper redemption requires current live-open evidence before it can score.`
          : `Output asset impairment: ${dependencySymbol} has an active severe downside depeg of ${activeDepegBps} bps started ${formatIsoDate(impairedRow.started_at)}; ${outputImpairedSharePct}% of modeled route output is impaired until current live-open evidence is available.`) +
        overLeveragedMarker,
      routeStatusReviewedAt,
      activeDepegBps,
      activeDepegStartedAt: impairedRow.started_at,
      activeDepegDirection: "below",
      outputImpairedShare,
      outputImpairedDependencyId: impairedDependencyId,
    });
  }

  return result;
}
