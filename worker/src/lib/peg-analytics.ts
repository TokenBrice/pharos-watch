import { DEPEG_EVENT_MIN_SUPPLY_USD } from "@shared/lib/depeg-config";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  computePegScore,
  computeRecentPegStats,
  coinTrackingStart,
  NULL_PEG_SCORE_RESULT,
  PEG_SCORE_LOOKBACK_SEC,
} from "@shared/lib/peg-score";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { fuzzyDateRange } from "@shared/lib/classification/resolve-implementation-launch-date";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import type { DepegEvent } from "@shared/types/peg";
import type { FxReferenceEvidenceMap } from "@shared/types/fx-reference";
import type { StablecoinData } from "@shared/types/supply";
import type { PegSummaryCoin } from "@shared/types/peg";
import { isValidIsoDateOnly, parseIsoDateOrUtcInstantSec } from "@shared/types/date-primitives";
import { getReferenceMarket } from "@shared/lib/reference-market-hours";
import { PegReferenceHoldSchema, type PegScoreEvent } from "@shared/lib/peg-utils";
import { AdmittedDeviationBpsSchema, ReferenceAdmissionSchema, type ReferenceAdmission } from "@shared/types/reference-admission";

import { matchesDepegReferenceHoldRow, type DepegRow } from "./depeg-helpers";
import {
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  IncidentProjectionUnavailableError,
  loadActiveIncidentProjections,
  rowToPublicDepegEvent,
} from "./depeg-event-projection";
import { getFirstSeenDates } from "./supply-history-db";
import { deriveCurrentPegObservationMap, hasUsableCurrentPrice } from "./current-peg-observations";
import { parseJson } from "./json-parse";

export interface DerivePegAnalyticsOptions {
  peggedAssets: StablecoinData[];
  missingPriceObservedAtIds?: ReadonlySet<string>;
  fxFallbackRates?: Record<string, number>;
  fxReferenceObservations?: FxReferenceEvidenceMap;
  methodologyAsOf: number;
  includeNavTokens?: boolean;
}

export interface PegAnalyticsSnapshot {
  nowSec: number;
  allEvents: DepegEvent[];
  eventsByCoin: Map<string, DepegEvent[]>;
  pegDataById: Map<string, PegSummaryCoin>;
  legacyFxReferenceIds?: ReadonlySet<string>;
  admittedPegById: Map<string, { admission: ReferenceAdmission; deviationBps: number | null; reference: PegSummaryCoin["pegReference"] }>;
  lastAffectedAtById: Map<string, number | null>;
  lastUncertainAffectedAtById?: Map<string, number>;
}

/**
 * Audited replay coverage is a strict day-precision contract; an invalid value
 * is unavailable rather than falling back to a fuzzy interpretation.
 */
function parseAuditedCoverageStartSec(dateText: string | undefined): number | null {
  if (!isValidIsoDateOnly(dateText)) return null;
  const parsedSec = parseIsoDateOrUtcInstantSec(dateText);
  return Number.isFinite(parsedSec) ? parsedSec : null;
}

/**
 * Curated launch dates may be fuzzy (`YYYY`, `YYYY-MM`, `YYYY-Qn`, `YYYY-Hn`).
 * Anchor at the latest day of the stated period so the inferred history window
 * is conservative rather than claiming months the source does not establish.
 */
function parseLaunchDateSec(dateText: string | undefined): number | null {
  if (!dateText) return null;
  const range = fuzzyDateRange(dateText);
  if (!range) return null;
  const parsedSec = parseIsoDateOrUtcInstantSec(range.end);
  return Number.isFinite(parsedSec) ? parsedSec : null;
}

type PegHistoryCoverage = NonNullable<PegSummaryCoin["historyCoverage"]>;

function resolveTrackingAnchor(
  meta: (typeof WORKER_ACTIVE_STABLECOINS)[number],
  events: DepegEvent[],
  firstObservedAtSec: number | undefined,
  fourYearsAgoSec: number,
): { trackingStart: number | null; coverage: PegHistoryCoverage | null } {
  const auditedCoverageStart = parseAuditedCoverageStartSec(meta.pegScoreCoverage?.startDate);
  const launchStart = parseLaunchDateSec(meta.launchDate);
  const anchor = auditedCoverageStart ?? launchStart ?? firstObservedAtSec ?? null;
  const trackingStart = coinTrackingStart(events, fourYearsAgoSec, anchor);
  if (trackingStart == null) return { trackingStart: null, coverage: null };

  const source: PegHistoryCoverage["source"] = auditedCoverageStart != null
    ? "audited-replay"
    : launchStart != null
      ? "asset-age"
      : firstObservedAtSec != null
        ? "first-observation"
        : "first-event";

  return {
    trackingStart,
    coverage: {
      startedAt: trackingStart,
      source,
      status: auditedCoverageStart != null ? "verified" : "assumed",
    },
  };
}

function buildPriceFirstSeenObservations(
  assets: readonly StablecoinData[],
  fallbackObservedAtSec: number,
): Array<{ id: string; observedAtSec: number }> {
  const observations: Array<{ id: string; observedAtSec: number }> = [];
  for (const asset of assets) {
    if (!hasUsableCurrentPrice(asset)) continue;
    const observedAtSec =
      asset.priceSyncedAt ??
      asset.priceUpdatedAt ??
      asset.priceObservedAt ??
      fallbackObservedAtSec;
    if (typeof observedAtSec === "number" && Number.isFinite(observedAtSec) && observedAtSec > 0) {
      observations.push({ id: asset.id, observedAtSec });
    }
  }
  return observations;
}

export async function derivePegAnalyticsSnapshot(
  db: D1Database,
  options: DerivePegAnalyticsOptions,
): Promise<PegAnalyticsSnapshot> {
  const includeNavTokens = options.includeNavTokens ?? false;
  const nowSec = Math.floor(Date.now() / 1000);
  const fourYearsAgoSec = nowSec - PEG_SCORE_LOOKBACK_SEC;

  const activeIncidentProjectionLoad = await loadActiveIncidentProjections(db, null);
  if (!activeIncidentProjectionLoad.available) throw new IncidentProjectionUnavailableError(activeIncidentProjectionLoad.reason);
  const firstSeenMap = await getFirstSeenDates(
    db,
    buildPriceFirstSeenObservations(options.peggedAssets, options.methodologyAsOf),
  );
  const activeIncidentCondition = ` AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL}`;
  const eventsResult = await db.prepare(
    `SELECT /* pharos:peg-analytics:recent-depeg-events */
       * FROM depeg_events_with_provenance WHERE (ended_at IS NULL OR ended_at > ?)${activeIncidentCondition} ORDER BY started_at DESC`,
  )
    .bind(fourYearsAgoSec)
    .all<DepegRow>();

  const allEvents = (eventsResult.results ?? []).map((row): PegScoreEvent => {
    const projection = activeIncidentProjectionLoad.projections;
    if (row.ended_at === null && row.price_coverage_json?.includes('"referenceHold"')) {
      const decoded = parseJson(row.price_coverage_json);
      if (decoded.ok && decoded.value && typeof decoded.value === "object" && "referenceHold" in decoded.value) {
        const { referenceHold, ...coverage } = decoded.value;
        const hold = PegReferenceHoldSchema.safeParse(referenceHold);
        const event = rowToPublicDepegEvent({ ...row, price_coverage_json: JSON.stringify(coverage) }, projection);
        return hold.success && matchesDepegReferenceHoldRow(row, hold.data) ? { ...event, referenceHold: hold.data } : event;
      }
    }
    return rowToPublicDepegEvent(row, projection);
  });
  const eventsByCoin = new Map<string, DepegEvent[]>();
  for (const event of allEvents) {
    const list = eventsByCoin.get(event.stablecoinId) ?? [];
    list.push(event);
    eventsByCoin.set(event.stablecoinId, list);
  }

  // The public list may alias a missing clock to priceUpdatedAt. Such an alias is never a quote observation.
  const missingPriceObservedAtIds = options.missingPriceObservedAtIds;
  const peggedAssets = missingPriceObservedAtIds ? options.peggedAssets.map((asset) =>
    missingPriceObservedAtIds.has(asset.id) ? { ...asset, priceObservedAt: null } : asset
  ) : options.peggedAssets;
  const priceById = new Map(peggedAssets.map((asset) => [asset.id, asset]));
  const currentPegObservationById = deriveCurrentPegObservationMap({
    peggedAssets,
    fxFallbackRates: options.fxFallbackRates,
    fxReferenceObservations: options.fxReferenceObservations,
    generation: `stablecoins:${options.methodologyAsOf}`,
    asOf: options.methodologyAsOf,
    now: nowSec,
  });
  const methodologyVersion = getMethodologyVersionAt("depeg-dews", options.methodologyAsOf);
  const trackingFallbackStart = nowSec - PEG_SCORE_LOOKBACK_SEC;

  const pegDataById = new Map<string, PegSummaryCoin>();
  const legacyFxReferenceIds = new Set<string>();
  const admittedPegById: PegAnalyticsSnapshot["admittedPegById"] = new Map();
  const lastAffectedAtById = new Map<string, number | null>();
  const lastUncertainAffectedAtById = new Map<string, number>();
  for (const meta of WORKER_ACTIVE_STABLECOINS) {
    if (!includeNavTokens && meta.flags.navToken) continue;

    const asset = priceById.get(meta.id);
    const events = eventsByCoin.get(meta.id) ?? [];
    // Unknown supply is neither above nor below the floor: it is flagged
    // `currentSupplyUnavailable`, never counted as coverage-limited.
    const supply = getCirculatingRawOrNull(asset);
    const depegEventCoverageLimited =
      !meta.flags.navToken &&
      supply !== null &&
      supply > 0 &&
      supply < DEPEG_EVENT_MIN_SUPPLY_USD;

    // Price availability is a distinct fact from peg-reference authority: a coin
    // with no usable price observation has an UNOBSERVED deviation, not a
    // withheld or quiet one. Downstream scoring must be able to tell the two
    // apart instead of reading the shared null as "at peg".
    const observation = currentPegObservationById.get(meta.id);
    const currentPegObservation = observation ?? {
      currentDeviationBps: null,
      pegReference: null,
      pegReferenceUnavailable: false,
      currentPriceUnavailable: !meta.flags.navToken,
      currentSupplyUnavailable: !meta.flags.navToken,
    };

    const { trackingStart, coverage: historyCoverage } = resolveTrackingAnchor(
      meta,
      events,
      firstSeenMap.get(meta.id),
      trackingFallbackStart,
    );
    const scoreResult = meta.flags.navToken
      ? { ...NULL_PEG_SCORE_RESULT }
      : computePegScore(events, trackingStart, nowSec, meta.flags.pegCurrency);
    const recent90d = meta.flags.navToken ? null : computeRecentPegStats(events, trackingStart, nowSec, meta.flags.pegCurrency);
    lastAffectedAtById.set(meta.id, scoreResult.lastAffectedAtSec ?? null);
    if (scoreResult.lastUncertainAffectedAtSec != null) lastUncertainAffectedAtById.set(meta.id, scoreResult.lastUncertainAffectedAtSec);

    const clocked = options.fxReferenceObservations !== undefined;
    const capturedPeg = asset?.currentPeg;
    if (observation?.legacyFxReference === true) legacyFxReferenceIds.add(meta.id);
    const needsAdmission = observation?.legacyFxReference !== true && getReferenceMarket(meta.flags.pegCurrency) !== null &&
      (clocked || capturedPeg?.referenceAdmission !== undefined || capturedPeg?.admittedDeviationBps !== undefined);
    const packet = needsAdmission && !clocked && capturedPeg ? capturedPeg : currentPegObservation;
    const admission = ReferenceAdmissionSchema.safeParse("referenceAdmission" in packet ? packet.referenceAdmission : undefined);
    const admittedDeviation = AdmittedDeviationBpsSchema.safeParse("admittedDeviationBps" in packet ? packet.admittedDeviationBps : undefined);
    if (needsAdmission && admission.success && admission.data.decisionAtSec <= nowSec &&
        (admission.data.status !== "admitted" || admission.data.quoteObservedAtSec === asset?.priceObservedAt)) admittedPegById.set(meta.id, {
      admission: admission.data,
      deviationBps: admission.data.status === "admitted" && admission.data.kind === packet.pegReference?.source && asset && isObservedPrice(asset)
        ? admittedDeviation.data ?? null : null,
      reference: packet.pegReference,
    });

    const projected = admittedPegById.get(meta.id);
    pegDataById.set(meta.id, {
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      pegType: asset?.pegType ?? "",
      pegCurrency: meta.flags.pegCurrency,
      governance: meta.flags.governance,
      ...(asset ? {
        priceSource: asset?.priceSource ?? undefined,
        priceObservedAtMode: asset?.priceObservedAtMode,
        ...(asset.priceObservedAt === undefined || missingPriceObservedAtIds?.has(meta.id) ? {} : { priceObservedAt: asset.priceObservedAt }),
      } : {}),
      ...(asset?.nominalPriceReference ? { nominalPriceReference: asset.nominalPriceReference } : {}),
      currentDeviationBps: needsAdmission ? projected?.deviationBps ?? null : packet.currentDeviationBps,
      ...(needsAdmission ? { admittedDeviationBps: projected?.deviationBps ?? null } : {}),
      ...(projected ? { referenceAdmission: projected.admission } : {}),
      pegReference: packet.pegReference,
      ...(currentPegObservation.pegReferenceUnavailable ? { pegReferenceUnavailable: true } : {}),
      ...(currentPegObservation.currentPriceUnavailable ? { currentPriceUnavailable: true } : {}),
      ...(currentPegObservation.currentSupplyUnavailable ? { currentSupplyUnavailable: true } : {}),
      depegEventCoverageLimited,
      pegScore: scoreResult.pegScore,
      unknownCoverageSeconds: scoreResult.unknownCoverageSeconds,
      pegPct: scoreResult.pegPct,
      severityScore: scoreResult.severityScore,
      spreadPenalty: scoreResult.spreadPenalty,
      eventCount: scoreResult.eventCount,
      worstDeviationBps: scoreResult.worstDeviationBps,
      activeDepeg: scoreResult.activeDepeg,
      lastEventAt: scoreResult.lastEventAt,
      trackingSpanDays: scoreResult.trackingSpanDays,
      observationStartedAt: firstSeenMap.get(meta.id) ?? null,
      historyCoverage: meta.flags.navToken ? null : historyCoverage,
      recent90d,
      methodologyVersion,
    });
  }

  return {
    nowSec,
    allEvents,
    eventsByCoin,
    pegDataById,
    admittedPegById,
    legacyFxReferenceIds,
    lastAffectedAtById,
    lastUncertainAffectedAtById,
  };
}
