import { formatIsoDate } from "@shared/lib/format";
import { REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS } from "@shared/lib/report-card-active-depeg";
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getRedemptionBackstopConfig, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { StablecoinMeta } from "@shared/types";
import type { StablecoinData } from "@shared/types/market";
import type { RedemptionRouteStatus, RedemptionRouteStatusSource } from "@shared/types/redemption";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "../constants";
import { classifyPrimaryDepegTrust } from "../depeg-trust-policy";
import { deriveCurrentPegObservationMap } from "../peg-analytics";

export { formatIsoDate as formatUtcDate } from "@shared/lib/format";

export interface ActiveDepegAvailabilityRow {
  stablecoin_id: string;
  direction: "below";
  started_at: number;
}

export interface RedemptionCurrentDepegObservation {
  currentDeviationBps: number;
}

export interface RedemptionRouteAvailability {
  routeStatus: Extract<RedemptionRouteStatus, "degraded" | "unknown">;
  routeStatusSource: Extract<RedemptionRouteStatusSource, "market-implied">;
  routeStatusReason: string;
  routeStatusReviewedAt: string;
  activeDepegBps?: number;
  activeDepegStartedAt: number;
  activeDepegDirection: "below";
  outputImpairedShare?: number;
  outputImpairedDependencyId?: string;
}

export interface EvaluatedOpenIncident {
  row: ActiveDepegAvailabilityRow;
  state: "severe" | "non-severe" | "uncertain";
  currentDeviationBps?: number;
}

export function buildRedemptionCurrentDepegObservationMap(options: {
  peggedAssets: StablecoinData[];
  fxFallbackRates?: Record<string, number>;
  stablecoinsGenerationAt: number | null;
  now: number;
}): Map<string, RedemptionCurrentDepegObservation> {
  const { peggedAssets, fxFallbackRates, stablecoinsGenerationAt, now } = options;
  const result = new Map<string, RedemptionCurrentDepegObservation>();
  if (
    stablecoinsGenerationAt == null ||
    !Number.isFinite(stablecoinsGenerationAt) ||
    stablecoinsGenerationAt > now ||
    now - stablecoinsGenerationAt > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) {
    return result;
  }

  const currentPegObservationById = deriveCurrentPegObservationMap({
    peggedAssets,
    fxFallbackRates,
    asOf: stablecoinsGenerationAt,
  });

  for (const asset of peggedAssets) {
    const quoteObservedAt = asset.priceObservedAt ?? asset.priceUpdatedAt;
    if (
      typeof quoteObservedAt !== "number" ||
      !Number.isFinite(quoteObservedAt) ||
      quoteObservedAt > now ||
      now - quoteObservedAt > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC ||
      asset.priceSource === "cached" ||
      classifyPrimaryDepegTrust(asset, now) !== "authoritative"
    ) {
      continue;
    }

    const pegObservation = currentPegObservationById.get(asset.id);
    const currentDeviationBps = pegObservation?.currentDeviationBps;
    if (
      pegObservation?.pegReferenceUnavailable ||
      typeof currentDeviationBps !== "number" ||
      !Number.isFinite(currentDeviationBps)
    ) {
      continue;
    }

    result.set(asset.id, { currentDeviationBps });
  }

  return result;
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

  if (meta.variantOf) addDependencyWeight(weights, meta.variantOf, 1, meta.id);
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
  evidenceState: "severe" | "uncertain";
  incidentRow: ActiveDepegAvailabilityRow;
  dependencyId: string;
  currentDeviationBps?: number;
  outputImpairedShare?: number;
  /** True when the configured output dependency weights sum above 1.0 (over-leveraged composition). */
  overLeveragedComposition: boolean;
}

export function evaluateOutputDependencyImpairment(
  weights: ReadonlyMap<string, number>,
  incidentsById: ReadonlyMap<string, EvaluatedOpenIncident>,
): OutputDependencyImpairmentEvaluation | null {
  let severeIncident: EvaluatedOpenIncident | null = null;
  let severeDependencyId: string | null = null;
  let uncertainIncident: EvaluatedOpenIncident | null = null;
  let uncertainDependencyId: string | null = null;
  let uncertainWeight = 0;
  let impairedShare = 0;
  let totalWeight = 0;

  for (const [dependencyId, weight] of weights) {
    totalWeight += weight;
    const incident = incidentsById.get(dependencyId);
    if (!incident || incident.state === "non-severe") continue;
    if (incident.state === "uncertain") {
      if (uncertainIncident == null || weight > uncertainWeight) {
        uncertainIncident = incident;
        uncertainDependencyId = dependencyId;
        uncertainWeight = weight;
      }
      continue;
    }

    impairedShare += weight;
    if (
      severeIncident == null ||
      Math.abs(incident.currentDeviationBps ?? 0) > Math.abs(severeIncident.currentDeviationBps ?? 0)
    ) {
      severeIncident = incident;
      severeDependencyId = dependencyId;
    }
  }

  const overLeveragedComposition = totalWeight > 1 + 1e-9;
  if (severeIncident && severeDependencyId) {
    return {
      evidenceState: "severe",
      incidentRow: severeIncident.row,
      dependencyId: severeDependencyId,
      currentDeviationBps: severeIncident.currentDeviationBps,
      outputImpairedShare: Math.min(1, Math.max(0, impairedShare)),
      overLeveragedComposition,
    };
  }
  if (uncertainIncident && uncertainDependencyId) {
    return {
      evidenceState: "uncertain",
      incidentRow: uncertainIncident.row,
      dependencyId: uncertainDependencyId,
      overLeveragedComposition,
    };
  }
  return null;
}

export async function loadSevereActiveDepegAvailabilityMap(
  db: D1Database,
  routeStatusReviewedAt: string,
  currentObservationsById: ReadonlyMap<string, RedemptionCurrentDepegObservation>,
): Promise<Map<string, RedemptionRouteAvailability>> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, direction, started_at
         FROM depeg_events
        WHERE ended_at IS NULL
          AND source = 'live'`,
    )
    .all<ActiveDepegAvailabilityRow>();

  const result = new Map<string, RedemptionRouteAvailability>();
  const incidentsById = new Map<string, EvaluatedOpenIncident>();
  for (const row of rows.results ?? []) {
    if (row.direction !== "below") continue;

    const currentObservation = currentObservationsById.get(row.stablecoin_id);
    const state = currentObservation == null
      ? "uncertain"
      : currentObservation.currentDeviationBps <= -REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS
        ? "severe"
        : "non-severe";
    const incident: EvaluatedOpenIncident = {
      row,
      state,
      ...(currentObservation ? { currentDeviationBps: currentObservation.currentDeviationBps } : {}),
    };
    incidentsById.set(row.stablecoin_id, incident);

    if (state === "non-severe") continue;
    if (state === "severe") {
      const activeDepegBps = Math.abs(currentObservation!.currentDeviationBps);
      result.set(row.stablecoin_id, {
        routeStatus: "degraded",
        routeStatusSource: "market-implied",
        routeStatusReason:
          `Open downside depeg incident started ${formatIsoDate(row.started_at)}; fresh authoritative current deviation is ${currentObservation!.currentDeviationBps} bps, so static redemption availability cannot score.`,
        routeStatusReviewedAt,
        activeDepegBps,
        activeDepegStartedAt: row.started_at,
        activeDepegDirection: "below",
      });
      continue;
    }

    result.set(row.stablecoin_id, {
      routeStatus: "unknown",
      routeStatusSource: "market-implied",
      routeStatusReason:
        `Open downside depeg incident started ${formatIsoDate(row.started_at)}, but no authoritative current deviation within ${DEPEG_PRIMARY_PRICE_MAX_AGE_SEC} seconds establishes present route availability; redemption score withheld.`,
      routeStatusReviewedAt,
      activeDepegStartedAt: row.started_at,
      activeDepegDirection: "below",
    });
  }

  for (const meta of ACTIVE_STABLECOINS) {
    if (result.has(meta.id)) continue;
    const config = getRedemptionBackstopConfig(meta.id);
    if (!config) continue;

    const { weights: outputDependencyWeights, reserveDerived } = resolveOutputDependencyWeights(meta, config);
    const evaluation = evaluateOutputDependencyImpairment(outputDependencyWeights, incidentsById);
    if (!evaluation) continue;

    const { incidentRow, dependencyId } = evaluation;
    const dependencySymbol = getTrackedSymbol(dependencyId);
    const isParentImpairment = meta.variantOf === dependencyId || meta.pegReferenceId === dependencyId;
    if (evaluation.evidenceState === "uncertain") {
      result.set(meta.id, {
        routeStatus: "unknown",
        routeStatusSource: "market-implied",
        routeStatusReason:
          `Output asset uncertainty: ${isParentImpairment ? "parent " : ""}${dependencySymbol} has an open downside depeg incident started ${formatIsoDate(incidentRow.started_at)}, but no authoritative current deviation within ${DEPEG_PRIMARY_PRICE_MAX_AGE_SEC} seconds establishes output availability; redemption score withheld.`,
        routeStatusReviewedAt,
        activeDepegStartedAt: incidentRow.started_at,
        activeDepegDirection: "below",
        outputImpairedDependencyId: dependencyId,
      });
      continue;
    }

    const activeDepegBps = Math.abs(evaluation.currentDeviationBps!);
    const outputImpairedShare = evaluation.outputImpairedShare!;
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
          ? `Output asset impairment: parent ${dependencySymbol} has a fresh authoritative current downside deviation of ${activeDepegBps} bps on an incident started ${formatIsoDate(incidentRow.started_at)}; wrapper redemption requires current live-open evidence before it can score.`
          : `Output asset impairment: ${dependencySymbol} has a fresh authoritative current downside deviation of ${activeDepegBps} bps on an incident started ${formatIsoDate(incidentRow.started_at)}; ${outputImpairedSharePct}% of modeled route output is impaired until current live-open evidence is available.`) +
        overLeveragedMarker,
      routeStatusReviewedAt,
      activeDepegBps,
      activeDepegStartedAt: incidentRow.started_at,
      activeDepegDirection: "below",
      outputImpairedShare,
      outputImpairedDependencyId: dependencyId,
    });
  }

  return result;
}
