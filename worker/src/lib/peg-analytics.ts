import {
  DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
  DEPEG_EVENT_MIN_SUPPLY_USD,
} from "@shared/lib/depeg-config";
import { classifyOpenIncidentTier } from "@shared/lib/active-depegs";
import type { OpenIncidentTier } from "@shared/lib/classification/depeg";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getListingClass } from "@shared/lib/stablecoins/listing-governance";
import {
  computePegScore,
  computeRecentPegStats,
  coinTrackingStart,
  getPegIncidentCoverage,
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
import { isScoredPegEvent, PegReferenceHoldSchema, type PegScoreEvent } from "@shared/lib/peg-utils";
import { AdmittedDeviationBpsSchema, ReferenceAdmissionSchema, type ReferenceAdmission } from "@shared/types/reference-admission";
import { toErrorMessage } from "@shared/lib/error-utils";

import {
  OPEN_EVENT_ESCALATION_METADATA_SELECT,
  isValidOptionalEscalationTimestamp,
  maxNullableInt,
  resolveOpenIncidentEscalationMetadata,
  type OpenEventEscalationMetadataRow,
} from "./depeg-escalation-metadata";
import { MAX_OPEN_DEPEG_EVENTS } from "./depeg-threshold-policy";
import { matchesDepegReferenceHoldRow, type DepegRow } from "./depeg-helpers";
import {
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  IncidentProjectionUnavailableError,
  decodeActiveIncidentProjections,
  prepareActiveIncidentProjections,
  rowToPublicDepegEvent,
} from "./depeg-event-projection";
import { logWorkerEventArgs } from "./structured-log";
import { getFirstSeenDates } from "./supply-history-db";
import { deriveCurrentPegObservationMap, hasUsableCurrentPrice } from "./current-peg-observations";
import { parseJson } from "./json-parse";
import { PegAnalyticsOpenIncidentSchema, type PegAnalyticsOpenIncident } from "./peg-analytics-cache-decode";

export type { PegAnalyticsOpenIncident };

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
  /** Open confirmed incident metadata keyed by stablecoin ID, sidecar to `pegDataById` for V9 isolation. */
  openIncidents?: Record<string, PegAnalyticsOpenIncident>;
  /**
   * Internal-cache-only scored open candidates for coins with multiple open scored rows,
   * allowing cached `/api/peg-summary` reads to re-apply `pickPrimaryOpenIncidentAtClock`
   * at request clock across 30d/7d horizon boundaries (never emitted on the wire).
   */
  openIncidentCandidates?: Record<string, PegAnalyticsOpenIncident[]>;
  legacyFxReferenceIds?: ReadonlySet<string>;
  admittedPegById: Map<string, { admission: ReferenceAdmission; deviationBps: number | null; reference: PegSummaryCoin["pegReference"] }>;
  lastAffectedAtById: Map<string, number | null>;
  lastUncertainAffectedAtById?: Map<string, number>;
}

function openIncidentPriority(tier: OpenIncidentTier | null): number {
  if (tier === "recent" || tier === "escalating") return 2;
  if (tier === "long_running") return 1;
  return 0;
}

interface OpenEscalationMetadataEntry {
  startedAt: number;
  escalatedAt: number | null;
  indeterminate: boolean;
  escalationInvalid: boolean;
}

/**
 * Single authority for selecting one representative open confirmed incident per coin at `nowSec`:
 * 1. Winning tier priority (`recent`/`escalating` ahead of `long_running`)
 * 2. Earliest canonical onset `startedAt` asc
 * 3. Lowest `eventId` asc
 */
export function pickPrimaryOpenIncidentAtClock(
  candidates: readonly PegAnalyticsOpenIncident[],
  nowSec: number,
): PegAnalyticsOpenIncident | null {
  let best: { entry: PegAnalyticsOpenIncident; priority: number } | null = null;
  for (const entry of candidates) {
    const tier = classifyOpenIncidentTier(entry, nowSec);
    if (tier === null) return null;
    const priority = openIncidentPriority(tier);
    const beatsBest =
      best === null ||
      priority > best.priority ||
      (priority === best.priority && entry.startedAt < best.entry.startedAt) ||
      (priority === best.priority &&
        entry.startedAt === best.entry.startedAt &&
        entry.eventId < best.entry.eventId);
    if (beatsBest) {
      best = { entry, priority };
    }
  }
  return best?.entry ?? null;
}

function selectPrimaryOpenIncident(
  openScoredEvents: readonly DepegEvent[],
  rawEscalatedAtByEventId: ReadonlyMap<number, number | null>,
  invalidRawEscalatedEventIds: ReadonlySet<number>,
  openEscalationByEventId: ReadonlyMap<number, OpenEscalationMetadataEntry>,
  nowSec: number,
): { primary: PegAnalyticsOpenIncident; candidates?: PegAnalyticsOpenIncident[] } | null {
  const candidates: PegAnalyticsOpenIncident[] = [];
  for (const event of openScoredEvents) {
    if (!Number.isSafeInteger(event.id) || event.id <= 0) continue;
    if (!Number.isSafeInteger(event.startedAt) || event.startedAt < 0) continue;
    const escalationMeta = openEscalationByEventId.get(event.id);
    // Fail closed when open-incident metadata is missing for a scored open row,
    // canonical onset is indeterminate, or a stored peak_escalated_at is malformed.
    if (!escalationMeta || escalationMeta.indeterminate || escalationMeta.escalationInvalid || invalidRawEscalatedEventIds.has(event.id)) {
      logWorkerEventArgs(
        "lib",
        "warn",
        `[peg-analytics] omitting open-incident sidecar entry for ${event.stablecoinId}:`,
        !escalationMeta
          ? "metadata-missing"
          : escalationMeta.escalationInvalid || invalidRawEscalatedEventIds.has(event.id)
            ? "invalid-escalation-timestamp"
            : "onset-indeterminate",
      );
      return null;
    }
    // `resolveOpenIncidentEscalationMetadata` already guarantees `startedAt <= event.startedAt`.
    const startedAt =
      Number.isSafeInteger(escalationMeta.startedAt) && escalationMeta.startedAt > 0
        ? escalationMeta.startedAt
        : event.startedAt;
    const escalatedAt = maxNullableInt(
      rawEscalatedAtByEventId.get(event.id) ?? null,
      escalationMeta.escalatedAt,
    );
    const candidate: PegAnalyticsOpenIncident = {
      eventId: event.id,
      startedAt,
      escalatedAt,
    };
    if (!PegAnalyticsOpenIncidentSchema.safeParse(candidate).success) {
      logWorkerEventArgs(
        "lib",
        "warn",
        `[peg-analytics] omitting open-incident sidecar entry for ${event.stablecoinId}:`,
        "invalid-entry",
      );
      return null;
    }
    candidates.push(candidate);
  }
  const primary = pickPrimaryOpenIncidentAtClock(candidates, nowSec);
  if (!primary) return null;
  return candidates.length > 1
    ? { primary, candidates: [primary, ...candidates.filter((entry) => entry.eventId !== primary.eventId)] }
    : { primary };
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

  const activeIncidentCondition = ` AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL}`;
  const recentEventsSql = `SELECT /* pharos:peg-analytics:recent-depeg-events */
           * FROM depeg_events_with_provenance WHERE (ended_at IS NULL OR ended_at > ?)${activeIncidentCondition} ORDER BY started_at DESC`;
  let snapshot: D1Result<unknown>[];
  let openIncidentsMetadataAvailable = true;
  try {
    snapshot = await db.batch([
      prepareActiveIncidentProjections(db, null),
      db.prepare(recentEventsSql).bind(fourYearsAgoSec),
      db.prepare(OPEN_EVENT_ESCALATION_METADATA_SELECT).bind(
        DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
        DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
        MAX_OPEN_DEPEG_EVENTS + 1,
      ),
    ]);
  } catch (enrichedError) {
    logWorkerEventArgs(
      "lib",
      "warn",
      "[peg-analytics] Enriched open-incident metadata batch failed; retrying core snapshot without split sidecar:",
      toErrorMessage(enrichedError),
    );
    openIncidentsMetadataAvailable = false;
    try {
      snapshot = await db.batch([
        prepareActiveIncidentProjections(db, null),
        db.prepare(recentEventsSql).bind(fourYearsAgoSec),
      ]);
    } catch (error) {
      logWorkerEventArgs("lib", "error", "[peg-analytics] Canonical incident snapshot read failed:", toErrorMessage(error));
      throw new IncidentProjectionUnavailableError();
    }
  }
  const [projectionResult, eventsResultRaw, escalationResultRaw] = snapshot;
  const eventsResult = eventsResultRaw as D1Result<DepegRow> | undefined;
  const escalationResult = escalationResultRaw as D1Result<OpenEventEscalationMetadataRow> | undefined;
  if (!projectionResult || !eventsResult?.success || !Array.isArray(eventsResult.results)) {
    throw new IncidentProjectionUnavailableError();
  }
  const activeIncidentProjectionLoad = decodeActiveIncidentProjections(projectionResult);
  if (!activeIncidentProjectionLoad.available) throw new IncidentProjectionUnavailableError(activeIncidentProjectionLoad.reason);
  const openEscalationByEventId = new Map<number, OpenEscalationMetadataEntry>();
  if (openIncidentsMetadataAvailable) {
    if (!escalationResult?.success || !Array.isArray(escalationResult.results)) {
      openIncidentsMetadataAvailable = false;
    } else if (escalationResult.results.length > MAX_OPEN_DEPEG_EVENTS) {
      logWorkerEventArgs(
        "lib",
        "warn",
        "[peg-analytics] Open-incident escalation metadata query truncated; omitting split sidecar",
      );
      openIncidentsMetadataAvailable = false;
    } else {
      for (const row of escalationResult.results) {
        if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0) continue;
        if (typeof row.started_at !== "number" || !Number.isSafeInteger(row.started_at) || row.started_at <= 0) continue;
        const resolved = resolveOpenIncidentEscalationMetadata(row);
        openEscalationByEventId.set(row.id, {
          startedAt: resolved.incidentStartedAt,
          escalatedAt: resolved.effectiveEscalatedAt,
          indeterminate: resolved.onsetIndeterminate,
          escalationInvalid: resolved.escalationInvalid,
        });
      }
    }
  }
  const firstSeenMap = await getFirstSeenDates(
    db,
    buildPriceFirstSeenObservations(options.peggedAssets, options.methodologyAsOf),
  );
  const rawEscalatedAtByEventId = new Map<number, number | null>();
  const invalidRawEscalatedEventIds = new Set<number>();
  for (const row of eventsResult.results) {
    if (typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > 0) {
      const rawEsc = (row as { peak_escalated_at?: unknown }).peak_escalated_at;
      if (!isValidOptionalEscalationTimestamp(rawEsc)) {
        invalidRawEscalatedEventIds.add(row.id);
      } else {
        rawEscalatedAtByEventId.set(row.id, rawEsc == null ? null : (rawEsc as number));
      }
    }
  }
  const allEvents = eventsResult.results.map((row): PegScoreEvent => {
    let eventRow = row;
    let admittedHold: PegScoreEvent["referenceHold"];
    if (row.ended_at === null && row.price_coverage_json?.includes('"referenceHold"')) {
      const decoded = parseJson(row.price_coverage_json);
      if (decoded.ok && decoded.value && typeof decoded.value === "object" && "referenceHold" in decoded.value) {
        const { referenceHold, ...coverage } = decoded.value;
        const hold = PegReferenceHoldSchema.safeParse(referenceHold);
        eventRow = { ...row, price_coverage_json: JSON.stringify(coverage) };
        if (hold.success && matchesDepegReferenceHoldRow(row, hold.data)) admittedHold = hold.data;
      }
    }
    const event = rowToPublicDepegEvent(eventRow, activeIncidentProjectionLoad.projections);
    return admittedHold ? { ...event, referenceHold: admittedHold } : event;
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
  const openIncidents: Record<string, PegAnalyticsOpenIncident> = {};
  const openIncidentCandidates: Record<string, PegAnalyticsOpenIncident[]> = {};
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

    if (openIncidentsMetadataAvailable && !meta.flags.navToken && scoreResult.activeDepeg) {
      const earliestEvent =
        trackingStart == null && events.length > 0
          ? events.reduce((min, event) => Math.min(min, event.startedAt), Infinity)
          : null;
      const effectiveTrackingStart = trackingStart ?? earliestEvent;
      if (effectiveTrackingStart !== null) {
        const openScoredEvents = getPegIncidentCoverage(
          events,
          effectiveTrackingStart,
          nowSec,
          meta.flags.pegCurrency,
        ).eligibleEvents.filter((event) => event.endedAt === null && isScoredPegEvent(event));
        const selected = selectPrimaryOpenIncident(
          openScoredEvents,
          rawEscalatedAtByEventId,
          invalidRawEscalatedEventIds,
          openEscalationByEventId,
          nowSec,
        );
        if (selected) {
          openIncidents[meta.id] = selected.primary;
          if (selected.candidates) {
            openIncidentCandidates[meta.id] = selected.candidates;
          }
        }
      }
    }

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
      listingClass: getListingClass(meta.id),
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
    ...(openIncidentsMetadataAvailable ? { openIncidents } : {}),
    ...(openIncidentsMetadataAvailable && Object.keys(openIncidentCandidates).length > 0
      ? { openIncidentCandidates }
      : {}),
    admittedPegById,
    legacyFxReferenceIds,
    lastAffectedAtById,
    lastUncertainAffectedAtById,
  };
}
