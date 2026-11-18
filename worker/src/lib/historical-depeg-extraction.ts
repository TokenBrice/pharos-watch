import {
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
  DEPEG_EVENT_MIN_SUPPLY_USD,
  DEPEG_EXTREME_MOVE_BPS,
  DEPEG_SEVERITY_BPS,
} from "@shared/lib/depeg-config";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { admitSupplyBuckets } from "@shared/lib/supply";
import { findAsOfSnapshot, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import { binarySearchNearest } from "./binary-search";

import { deriveDepegSignal, signalCrossesThreshold, type DepegSignal } from "@shared/lib/depeg-signals";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { getReferenceMarket, getReferenceSessionState, isReferenceDeviationHeld, type ReferenceMarket } from "@shared/lib/reference-market-hours";
import type { DepegAdmittedCoverage, DepegEventQuoteDomain } from "@shared/types/peg";
import {
  buildPriceValidationContext,
  FIAT_UPPER_BAND_REQUIRES_CORROBORATION,
  type PriceReasonablenessOptions,
  validatePriceCandidateAgainstReference,
} from "./price-validation";
import { getDepegRecoveryThresholdBps, getDepegThresholdBps, isWithinRecoveryBand } from "./depeg-threshold-policy";
import type { PricePoint } from "./historical-market-prices";
import { isAdmittedHistoricalNativeQuote } from "./historical-market-prices";
import { HISTORICAL_INTRADAY_PAIRING_SEC } from "./backfill-fx";
import { resolveDepegSourceFamily } from "./depeg-trust-policy";

export const BACKFILL_MIN_CONFIRM_POINTS = 2;
const BACKFILL_PENDING_MAX_GAP_SEC = 6 * 3600;
// An episode peak (including the opening print) is published only when another
// sample of the same episode comes within this distance: one wick between par
// readings is feed noise, not an observation the event should adopt (USDC
// 2018-10-04, sUSD 2019-06-24). Extreme crashes keep their single print.
const PEAK_CORROBORATION_TOLERANCE_BPS = 1000;
const PEAK_CORROBORATION_SAMPLE_WINDOW = 2;

export interface SupplyPoint {
  date: string;
  circulating?: Record<string, number>;
  totalCirculatingUSD?: Record<string, number>;
  totalCirculating?: Record<string, number>;
}

export interface BackfillEvent {
  pegType: string;
  direction: string;
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  startPrice: number;
  peakPrice: number;
  recoveryPrice: number | null;
  pegRef: number;
  peakPegReference?: number;
  peakObservedAt?: number;
  peakQuoteDomain?: DepegEventQuoteDomain;
  recoveryPegReference?: number;
  admittedCoverage?: DepegAdmittedCoverage;
}

export interface SupplySnapshot {
  ts: number;
  supply: number | null;
}

export interface BackfillEventExtractionOptions {
  forceConfirmation?: boolean;
  confirmationMinPoints?: number;
  confirmationMaxGapSec?: number;
  extremeSinglePointBps?: number | null;
  quoteDomain?: DepegEventQuoteDomain;
  maxObservationGapSec?: number;
  admitReference?: (timestamp: number, rawBps: number) => boolean;
  /** Independent traded native evidence, when a replay has a separately identified source. */
  fiatCorroborationAt?: (timestamp: number) => PricePoint | null;
  onEvaluated?: (timestamp: number, state: string | null, severeClosure: boolean) => void;
}

export function parseSupplyData(
  tokens: SupplyPoint[],
  getNativeUsdRate?: (timestamp: number) => number | null,
): SupplySnapshot[] {
  const map = new Map<number, number | null>();
  for (const point of tokens) {
    const ts = Number.parseInt(point.date, 10);
    if (!Number.isFinite(ts)) continue;
    const usd = admitSupplyBuckets(point.totalCirculatingUSD);
    if (usd.status === "observed") {
      map.set(ts, usd.total);
      continue;
    }
    // An invalid USD record is not permission to publish a different number.
    if (usd.status === "invalid") {
      if (!map.has(ts)) map.set(ts, null);
      continue;
    }
    const buckets = point.totalCirculating ?? point.circulating;
    const native = admitSupplyBuckets(buckets);
    if (native.status !== "observed") {
      if (native.status === "invalid" && !map.has(ts)) map.set(ts, null);
      continue;
    }
    // Without a conversion reference only explicitly USD buckets are usable.
    const rate = getNativeUsdRate?.(ts) ??
      (Object.keys(buckets!).every((key) => key === "peggedUSD") ? 1 : null);
    if (rate == null || !Number.isFinite(rate) || rate <= 0) {
      if (!map.has(ts)) map.set(ts, null);
      continue;
    }
    const supply = native.total * rate;
    if (Number.isFinite(supply)) map.set(ts, supply);
  }
  return Array.from(map.entries())
    .map(([ts, supply]) => ({ ts, supply }))
    .sort((a, b) => a.ts - b.ts);
}

export function findNearestSupply(
  supplyByDate: SupplySnapshot[],
  timestamp: number,
  maxDistanceSec: number = MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC,
): number | null {
  if (supplyByDate.length === 0) return null;
  const nearest = binarySearchNearest(supplyByDate, timestamp, (snapshot) => snapshot.ts);
  if (!nearest || Math.abs(nearest.ts - timestamp) > maxDistanceSec) return null;
  return nearest.supply;
}

/** True when another same-direction sample lands within tolerance of the stored peak. */
function isCorroboratedBySample(bps: number, peakBps: number): boolean {
  return Math.abs(bps - peakBps) <= PEAK_CORROBORATION_TOLERANCE_BPS;
}

/** True when a nearby sample of the same episode lands within tolerance of the candidate peak. */
type EvaluatedPoint = PricePoint & DepegSignal & { pegRef: number; supply: number; severeClosureStart: number | null };

function sharesSevereClosure(left: EvaluatedPoint, right: EvaluatedPoint): boolean {
  return left.severeClosureStart !== null && left.severeClosureStart === right.severeClosureStart;
}

function isCorroboratedPeak(
  points: readonly (EvaluatedPoint | null)[],
  index: number,
  candidate: EvaluatedPoint,
  threshold: number,
  maxGapSec: number,
  market: ReferenceMarket | null,
): boolean {
  for (const step of [-1, 1]) {
    for (let offset = 1; offset <= PEAK_CORROBORATION_SAMPLE_WINDOW; offset++) {
      const neighbour = points[index + offset * step];
      if (!neighbour || neighbour.direction !== candidate.direction || !signalCrossesThreshold(neighbour, threshold)) break;
      const gap = Math.abs(neighbour.timestamp - candidate.timestamp);
      if (gap > maxGapSec || (!sharesSevereClosure(candidate, neighbour) &&
        openMarketSeconds(market, Math.min(neighbour.timestamp, candidate.timestamp),
          Math.max(neighbour.timestamp, candidate.timestamp)) !== gap)) break;
      if (gap > 0 && isCorroboratedBySample(neighbour.rawBps, candidate.rawBps)) return true;
    }
  }
  return false;
}

function openMarketSeconds(market: ReferenceMarket | null, fromSec: number, toSec: number): number {
  if (!market) return toSec - fromSec;
  let seconds = 0;
  let cursor = toSec;
  while (cursor > fromSec) {
    const session = getReferenceSessionState(market, cursor - 1);
    const boundary = Math.max(fromSec, session.open ? session.sessionOpenedAtSec : session.closureStartSec);
    if (session.open) seconds += cursor - boundary;
    cursor = boundary;
  }
  return seconds;
}

function addCoverage(coverage: DepegAdmittedCoverage, fromSec: number, toSec: number): void {
  const last = coverage[coverage.length - 1];
  if (last?.toSec === fromSec) last.toSec = toSec;
  else coverage.push({ fromSec, toSec });
}

export function extractDepegEvents(
  prices: PricePoint[],
  getPegRef: (timestamp: number) => number | null,
  pegType: string,
  supplyByDate: SupplySnapshot[],
  fxRates?: Record<string, number>,
  priceValidationOpts?: PriceReasonablenessOptions,
  options?: BackfillEventExtractionOptions,
): BackfillEvent[] {
  const threshold = getDepegThresholdBps(pegType);
  const recoveryThreshold = getDepegRecoveryThresholdBps(pegType);
  const pegCurrency = getPegTaxonomyByType(pegType)?.currency;
  const referenceMarket = getReferenceMarket(pegCurrency);
  const confirmationMinPoints = Math.max(1, options?.confirmationMinPoints ?? BACKFILL_MIN_CONFIRM_POINTS);
  const confirmationMaxGapSec = Math.max(1, options?.confirmationMaxGapSec ?? BACKFILL_PENDING_MAX_GAP_SEC);
  const extremeSinglePointBps = options?.extremeSinglePointBps ?? null;
  const maxObservationGapSec = options?.maxObservationGapSec ?? confirmationMaxGapSec;
  const events: BackfillEvent[] = [];
  let current: BackfillEvent | null = null;
  // An opening print is the published peak only once another same-episode
  // sample corroborates it; otherwise the episode is withheld at close.
  let currentPeakCorroborated = false;
  let currentPeakRawBps = 0;
  let previous: EvaluatedPoint | null = null;
  let continuousFrom = Infinity;
  const validationContext = buildPriceValidationContext({
    pegType,
    navToken: priceValidationOpts?.navToken,
    commodityOunces: priceValidationOpts?.commodityOunces,
  });
  let pending: {
    direction: string;
    count: number;
    /** First corroborated (or extreme) sample, used as the published start. */
    startTs: number;
    lastTs: number;
    peakBps: number;
    peakTs: number;
    startPrice: number;
    peakPrice: number;
    pegRef: number;
    peakRef: number;
    coverage: DepegAdmittedCoverage;
    peakCorroborated: boolean;
  } | null = null;

  function promotePending(): void {
    if (!pending) return;
    current = {
      pegType,
      direction: pending.direction,
      peakDeviationBps: Math.round(pending.peakBps),
      startedAt: pending.startTs,
      endedAt: null,
      startPrice: pending.startPrice,
      peakPrice: pending.peakPrice,
      recoveryPrice: null,
      pegRef: pending.pegRef,
      peakPegReference: pending.peakRef,
      peakObservedAt: pending.peakTs,
      peakQuoteDomain: options?.quoteDomain ?? "usd",
      admittedCoverage: pending.coverage,
    };
    currentPeakRawBps = pending.peakBps;
    currentPeakCorroborated = pending.peakCorroborated;
    pending = null;
  }

  const evaluated = prices.map((point): EvaluatedPoint | null => {
    const { timestamp, price } = point;
    if (price <= 0) return null;

    const supply = findAsOfSnapshot(supplyByDate, timestamp, (snapshot) => snapshot.ts, MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC)?.supply;
    if (supply == null || !Number.isFinite(supply) || supply < DEPEG_EVENT_MIN_SUPPLY_USD) return null;

    const pegRef = getPegRef(timestamp);
    if (pegRef == null || !Number.isFinite(pegRef) || pegRef <= 0) return null;
    const decision = validatePriceCandidateAgainstReference(price, validationContext, "historical_backfill", {
      price: pegRef,
      type: fxRates ? "fresh" : "none",
    });
    if (!decision.accepted) {
      if (decision.reasonCode !== FIAT_UPPER_BAND_REQUIRES_CORROBORATION || !pegCurrency) return null;
      const evidence = options?.fiatCorroborationAt?.(timestamp);
      if (!evidence || !Number.isSafeInteger(evidence.timestamp) || evidence.timestamp <= 0 ||
          evidence.timestamp > timestamp || timestamp - evidence.timestamp > HISTORICAL_INTRADAY_PAIRING_SEC ||
          evidence.nativeQuote?.derivation.kind !== "traded-pair" || !isAdmittedHistoricalNativeQuote(evidence, pegCurrency) ||
          !isCorroboratedBySample((evidence.price - 1) * 10_000, (price / pegRef - 1) * 10_000)) return null;
      const primaryVenue = resolveDepegSourceFamily(point.nativeQuote?.derivation.lineage.venue);
      if (primaryVenue && primaryVenue === resolveDepegSourceFamily(evidence.nativeQuote.derivation.lineage.venue)) return null;
      const confirmation = deriveDepegSignal(evidence.price, 1);
      if (confirmation?.direction !== "above" || !signalCrossesThreshold(confirmation, threshold)) return null;
    }

    const depegSignal = deriveDepegSignal(price, pegRef);
    if (!depegSignal) return null;
    if (options?.admitReference
      ? !options.admitReference(timestamp, depegSignal.rawBps)
      : isReferenceDeviationHeld(pegCurrency, timestamp, Math.abs(depegSignal.rawBps))) return null;
    const session = options?.admitReference && referenceMarket && depegSignal.absRawBps >= DEPEG_SEVERITY_BPS.severe
      ? getReferenceSessionState(referenceMarket, timestamp) : null;
    return { ...point, ...depegSignal, pegRef, supply, severeClosureStart: session?.closureStartSec ?? null };
  });

  for (let index = 0; index < evaluated.length; index++) {
    const point = evaluated[index];
    const offPeg = signalCrossesThreshold(point, threshold);
    const recovered = point != null && isWithinRecoveryBand(point.absRawBps, recoveryThreshold);
    options?.onEvaluated?.(prices[index]!.timestamp,
      point == null ? null : offPeg ? point.direction : recovered ? "in-band" : "intermediate",
      point?.severeClosureStart != null);
    const preceding = previous;
    previous = point ?? null;
    if (!point) continue;
    const { timestamp, price, pegRef, supply } = point;
    const wallGap = preceding ? timestamp - preceding.timestamp : Infinity;
    const withinGap = preceding && wallGap > 0 && wallGap <= maxObservationGapSec;
    const hasCoverage = withinGap && openMarketSeconds(referenceMarket, preceding.timestamp, timestamp) === wallGap;
    // Severe closure samples can corroborate a peak without proving duration across the closure.
    const canCorroborate = hasCoverage || (withinGap && sharesSevereClosure(preceding, point));
    const { bps, rawBps, absRawBps, direction } = point;
    const sameEpisode = canCorroborate && preceding.direction === direction
      && signalCrossesThreshold(preceding, threshold) && offPeg;
    if (!sameEpisode) continuousFrom = timestamp;
    if (hasCoverage && current?.admittedCoverage && current.direction === direction && preceding.direction === direction
      && preceding.timestamp >= current.startedAt && !isWithinRecoveryBand(preceding.absRawBps, recoveryThreshold) && !recovered) {
      addCoverage(current.admittedCoverage, preceding.timestamp, timestamp);
    }
    const isLargeCap = supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD;

    if (offPeg) {
      if (current) {
        if (current.direction !== direction) {
          current.endedAt = timestamp;
          if (currentPeakCorroborated) events.push(current);
          current = null;
          currentPeakCorroborated = false;
        } else {
          const peakClock = current.peakObservedAt!;
          const corroboratesStoredPeak = continuousFrom <= peakClock && timestamp > peakClock
            && timestamp - peakClock <= maxObservationGapSec
            && isCorroboratedBySample(rawBps, currentPeakRawBps);
          if (corroboratesStoredPeak) currentPeakCorroborated = true;
          const corroboratesCandidate = isCorroboratedPeak(evaluated, index, point, threshold, maxObservationGapSec, referenceMarket);
          if (!corroboratesStoredPeak && !currentPeakCorroborated && corroboratesCandidate) {
            // The opening print never gained support: publish this first
            // corroborated sample instead of an unverified start/peak pair.
            current.startedAt = timestamp;
            current.startPrice = price;
            current.pegRef = pegRef;
            current.peakDeviationBps = bps;
            currentPeakRawBps = rawBps;
            current.peakPrice = price;
            current.peakPegReference = pegRef;
            current.peakObservedAt = timestamp;
            current.admittedCoverage = [];
            currentPeakCorroborated = true;
          } else if (absRawBps > Math.abs(currentPeakRawBps) && corroboratesCandidate) {
            current.peakDeviationBps = bps;
            currentPeakRawBps = rawBps;
            current.peakPrice = price;
            current.peakPegReference = pegRef;
            current.peakObservedAt = timestamp;
            currentPeakCorroborated = true;
          }
          continue;
        }
      }

      const requiresConfirmation = options?.forceConfirmation === true || isLargeCap;
      // Extreme crashes are already published as single prints by policy
      // (native-peg `extremeSinglePointBps`, or the shared 50% band), so they
      // need no separate corroborating sample.
      const admittedAsExtreme = signalCrossesThreshold(point, DEPEG_EXTREME_MOVE_BPS) ||
        (extremeSinglePointBps != null && signalCrossesThreshold(point, extremeSinglePointBps));
      const bypassesConfirmation = !requiresConfirmation ||
        (extremeSinglePointBps != null && signalCrossesThreshold(point, extremeSinglePointBps));
      if (bypassesConfirmation) {
        current = {
          pegType,
          direction,
          peakDeviationBps: bps,
          startedAt: timestamp,
          endedAt: null,
          startPrice: price,
          peakPrice: price,
          recoveryPrice: null,
          pegRef,
          peakPegReference: pegRef,
          peakObservedAt: timestamp,
          peakQuoteDomain: options?.quoteDomain ?? "usd",
          admittedCoverage: [],
        };
        currentPeakRawBps = rawBps;
        currentPeakCorroborated = admittedAsExtreme || isCorroboratedPeak(evaluated, index, point, threshold, maxObservationGapSec, referenceMarket);
        pending = null;
      } else if (!pending || pending.direction !== direction || timestamp <= pending.lastTs
        || (timestamp - pending.lastTs > confirmationMaxGapSec
          && (timestamp - pending.lastTs > confirmationMaxGapSec + 7 * DAY_SECONDS
            || openMarketSeconds(referenceMarket, pending.lastTs, timestamp) > confirmationMaxGapSec))) {
        pending = {
          direction,
          count: 1,
          startTs: timestamp,
          lastTs: timestamp,
          peakBps: rawBps,
          peakTs: timestamp,
          startPrice: price,
          peakPrice: price,
          pegRef,
          peakRef: pegRef,
          coverage: [],
          peakCorroborated: admittedAsExtreme || isCorroboratedPeak(evaluated, index, point, threshold, maxObservationGapSec, referenceMarket),
        };
      } else {
        pending.count++;
        pending.lastTs = timestamp;
        if (hasCoverage && preceding.timestamp >= pending.startTs && preceding.direction === direction && signalCrossesThreshold(preceding, threshold)) {
          addCoverage(pending.coverage, preceding.timestamp, timestamp);
        }
        const corroboratesStoredPeak = isCorroboratedBySample(rawBps, pending.peakBps)
          && preceding?.timestamp === pending.peakTs
          && (options?.maxObservationGapSec == null
            ? timestamp - pending.peakTs <= confirmationMaxGapSec + 7 * DAY_SECONDS
              && openMarketSeconds(referenceMarket, pending.peakTs, timestamp) <= confirmationMaxGapSec
            : canCorroborate);
        if (corroboratesStoredPeak) pending.peakCorroborated = true;
        const corroboratesCandidate = isCorroboratedPeak(evaluated, index, point, threshold, maxObservationGapSec, referenceMarket);
        if (!corroboratesStoredPeak && !pending.peakCorroborated && corroboratesCandidate) {
          pending.startTs = timestamp;
          pending.startPrice = price;
          pending.pegRef = pegRef;
          pending.peakBps = rawBps;
          pending.peakTs = timestamp;
          pending.peakPrice = price;
          pending.peakRef = pegRef;
          pending.coverage = [];
          pending.peakCorroborated = true;
        } else if (absRawBps > Math.abs(pending.peakBps) && corroboratesCandidate) {
          pending.peakBps = rawBps;
          pending.peakTs = timestamp;
          pending.peakPrice = price;
          pending.peakRef = pegRef;
          pending.peakCorroborated = true;
        }
        if (pending.count >= confirmationMinPoints) {
          promotePending();
        }
      }
    } else {
      if (current && recovered) {
        current.endedAt = timestamp;
        current.recoveryPrice = price;
        current.recoveryPegReference = pegRef;
        if (currentPeakCorroborated) events.push(current);
        current = null;
        currentPeakCorroborated = false;
      }
      pending = null;
    }
  }

  if (current && currentPeakCorroborated) events.push(current);

  return events;
}
