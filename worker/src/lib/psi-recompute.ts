import {
  buildPsiHistoricalSupplySnapshotMap,
  getPsiHistoricalUniverseForDay,
  findNearestSupplySnapshot,
  PSI_HISTORICAL_REFERENCE_CARRY_MAX_AGE_SEC,
  type SupplySnapshotMap,
  type SupplySnapshot,
  type PsiSupplyRow,
  type PsiUniverseCache,
} from "./psi-history-universe";
import { isAmbiguousSupplyPerimeterDay, isEarlierSupplyPerimeter } from "@shared/lib/supply-perimeter-changes";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { canonicalizePsiStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCommodityOuncesAtQuote } from "@shared/lib/commodity-median";
import { evaluateReferenceAdmission, admittedDeviationBps } from "@shared/lib/reference-admission";
import { asRawDeviationBps } from "@shared/types/reference-admission";
import { hasPeerDeviationReceipt, readBenchmarkOnset, readPeerDeviationMarks } from "./depeg-observation-marks";
import { getReferenceMarket, getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { isNativePegEvent, type NativeEventPriceEvidence } from "@shared/lib/depeg-quote-domain";
import type { DepegAdmittedCoverage } from "@shared/types/peg";
import { readAdmittedNativeEventObservation } from "./psi-reference";
import type { ReplayHistoricalReferenceLookup } from "./backfill-fx";

export function includePsiEventDeviation(
  aggregate: { worstBps: number; earliestStart: number },
  bps: number,
  startedAt: number,
): void {
  if (Math.abs(bps) > Math.abs(aggregate.worstBps)) aggregate.worstBps = bps;
  if (startedAt < aggregate.earliestStart) aggregate.earliestStart = startedAt;
}

export interface PsiDepegEventRow extends NativeEventPriceEvidence {
  stablecoin_id: string;
  peak_deviation_bps: number;
  peak_price?: number | null;
  peak_peg_reference?: number | null;
  peak_quote_domain?: string | null;
  peg_reference: number;
  started_at: number;
  ended_at: number | null;
  counted_from?: number;
  pending_reason?: string | null;
  peer_basis_json?: string | null;
  direction?: string;
  admittedCoverage?: DepegAdmittedCoverage;
  coverageUnavailable?: true;
  disposition?: string | null;
}

export type { PsiSupplyRow } from "./psi-history-universe";

export interface StabilityInputForDay {
  depegs: Array<{ bps: number; mcapUsd: number; depegAgeDays: number }>;
  activity: Array<{
    id: string;
    mcapUsd: number;
    intervals: Array<{ fromSec: number; toSec: number; bps: number; startedAt: number }>;
  }>;
  totalMcapUsd: number;
  mcap7dChangePct: number | null;
  trendUnavailableIds: string[];
  nativeQuantityMomentum?: Record<string, number>;
  depegCount: number;
  eligibleUniverseCount: number;
  coveredUniverseCount: number;
  historicalAssetCoverageCount: number;
  historicalPriceCoverageCount: number;
  peakDeviationFallbackCount: number;
  openDepegsWithoutPrice: number;
  openDepegsWithoutWeight: number;
}

export function buildSupplySnapshotMap(rows: PsiSupplyRow[]): SupplySnapshotMap {
  return buildPsiHistoricalSupplySnapshotMap(rows);
}

function historicalEventMarks(
  event: PsiDepegEventRow,
  snapshots: SupplySnapshot[] | undefined,
  day: number,
  interval: DepegAdmittedCoverage[number],
  references: ReplayHistoricalReferenceLookup | undefined,
  lastSlot: number | undefined,
): (at: number) => number | null {
  if (event.coverageUnavailable) return () => null;
  const isCovered = (at: number) => event.admittedCoverage == null ||
    event.admittedCoverage.some(({ fromSec, toSec }) => at >= fromSec && at < toSec);
  const start = event.counted_from ?? event.started_at;
  if (hasPeerDeviationReceipt(event)) {
    if (!event.peg_type) return () => null;
    const row = { ...event, peg_type: event.peg_type };
    const marks = readPeerDeviationMarks(row);
    const opening = readBenchmarkOnset(row);
    if (opening?.admission) {
      marks.push({ observedAt: event.started_at, availableAt: Math.max(event.started_at, opening.admission.decisionAtSec),
        quoteObservedAt: opening.admission.quoteObservedAtSec, rawBps: opening.signal.rawBps });
    }
    const admitted = marks.filter((mark) => isCovered(mark.observedAt))
      .sort((a, b) => b.quoteObservedAt - a.quoteObservedAt || b.availableAt - a.availableAt);
    return (at) => admitted.find((mark) => mark.availableAt <= at &&
      at - mark.quoteObservedAt <= PSI_HISTORICAL_REFERENCE_CARRY_MAX_AGE_SEC)?.rawBps ?? null;
  }
  if (isNativePegEvent(event)) {
    return (at) => {
      const quote = readAdmittedNativeEventObservation(event, at);
      if (!quote || quote.observedAt < start || !isCovered(quote.observedAt)) return null;
      const reference = getCommodityOuncesAtQuote(event.peg_reference, {
        assetId: event.stablecoin_id, quoteObservedAtSec: quote.observedAt,
        commodityEntitlement: references?.entitlementAt?.(event.stablecoin_id, quote.observedAt),
      });
      return reference != null ? deriveDepegSignal(quote.value, reference)?.bps ?? null : null;
    };
  }

  const coinId = canonicalizePsiStablecoinId(event.stablecoin_id);
  const meta = TRACKED_META_BY_ID.get(coinId) ?? PSI_ELIGIBLE_META_BY_ID.get(coinId);
  const currency = getPegTaxonomyByType(event.peg_type)?.currency ?? meta?.flags.pegCurrency;
  if (currency == null || (event.quote_mode !== "usd" && (event.quote_mode != null || currency !== "USD"))) return () => null;
  const market = getReferenceMarket(currency);
  if (lastSlot == null && currency === "USD" && event.started_at < day &&
      interval.fromSec === day && interval.toSec === day + DAY_SECONDS) {
    const mark = findNearestSupplySnapshot(snapshots, day);
    if (mark?.price != null && mark.priceObservedAt == null && mark.date === day) {
      const bps = deriveDepegSignal(mark.price, event.peg_reference)?.bps ?? null;
      return () => bps;
    }
  }
  // Timed FX/metal marks stay eligible for carry after reopening. Eligibility
  // belongs to the quote's session and coverage, not the scoring clock.
  const maxCarry = PSI_HISTORICAL_REFERENCE_CARRY_MAX_AGE_SEC;
  const firstSnapshotDay = day - maxCarry;
  const earliest = Math.max(start, market == null ? day : interval.fromSec - maxCarry);
  const cutoff = lastSlot ?? interval.toSec - 1;
  const candidates: Array<{ price: number; at: number }> = [];
  const consider = (price: number | null | undefined, at: number | undefined) => {
    if (price == null || at == null || at < earliest || at > cutoff || !isCovered(at)) return;
    candidates.push({ price, at });
  };
  for (
    let snapshot = findNearestSupplySnapshot(snapshots, day);
    snapshot && snapshot.date >= firstSnapshotDay;
    snapshot = findNearestSupplySnapshot(snapshots, snapshot.date - 1)
  ) {
    consider(snapshot.price, snapshot.priceObservedAt);
  }
  consider(event.start_price, event.started_at);
  const marks = candidates.sort((left, right) => right.at - left.at).flatMap((quote) => {
    if (currency === "USD" || (coinId !== "xagm-matrixdock" && event.disposition === "restored-evidenced" &&
        quote.at === event.started_at && quote.price === event.start_price)) {
      const signal = deriveDepegSignal(quote.price, event.peg_reference);
      return signal && Number.isFinite(signal.bps) ? [{ at: quote.at, bps: signal.bps }] : [];
    }
    const reference = references?.referenceAt(currency, quote.at, coinId);
    if (!reference || !Number.isSafeInteger(reference.observedAtSec) || reference.observedAtSec <= 0 ||
        reference.observedAtSec > quote.at) return [];
    const pegKey = `pegged${currency}`;
    const pegRef = getPegReference(pegKey, { [pegKey]: reference.usdPerUnit }, meta?.commodityOunces, {
      assetId: coinId, quoteObservedAtSec: quote.at, commodityEntitlement: references?.entitlementAt?.(coinId, quote.at),
    });
    const signal = pegRef != null ? deriveDepegSignal(quote.price, pegRef) : null;
    if (!signal || !Number.isFinite(signal.rawBps)) return [];
    const raw = asRawDeviationBps(signal.rawBps);
    const observation = reference.observation;
    const session = market == null ? null : getReferenceSessionState(market, quote.at);
    const anchors = observation?.repricing;
    const repricing = session?.open && anchors?.sessionOpenedAtSec === session.sessionOpenedAtSec &&
      anchors.source === observation?.source ? anchors : undefined;
    const selection = reference.kind === "median" ? {
      kind: "median" as const, pegKey, contributors: reference.contributorEvidence ?? [],
    } : observation && observation.pegKey === pegKey && observation.source === reference.source &&
        observation.usdPerUnit === reference.usdPerUnit && observation.observedAtSec === reference.observedAtSec
      ? { kind: reference.kind, observation, ...repricing } : { kind: "none" as const };
    if (reference.contributors?.some((id) => canonicalizePsiStablecoinId(id) === coinId) ||
        (session && !session.open && !event.admittedCoverage)) return [];
    const admission = evaluateReferenceAdmission({ ...selection,
      quoteObservedAtSec: quote.at, decisionAtSec: quote.at, rawDeviationBps: raw,
    });
    const bps = admittedDeviationBps(raw, admission);
    return bps == null ? [] : [{ at: quote.at, bps }];
  });
  return (at) => marks.find((mark) => mark.at <= at && (market == null || at - mark.at <= maxCarry))?.bps ?? null;
}

export function buildStabilityInputForDay(
  day: number,
  now: number,
  depegEvents: PsiDepegEventRow[],
  supplyByCoin: SupplySnapshotMap,
  universeCache?: PsiUniverseCache,
  references?: ReplayHistoricalReferenceLookup,
  sampleSlots: readonly number[] = [],
): StabilityInputForDay {
  const dayEnd = Math.min(day + DAY_SECONDS, now + 1);
  const universe = getPsiHistoricalUniverseForDay(supplyByCoin, day, universeCache);
  const grouped = new Map<string, Array<{ event: PsiDepegEventRow; interval: DepegAdmittedCoverage[number] }>>();
  for (const event of depegEvents) {
    const coinId = canonicalizePsiStablecoinId(event.stablecoin_id);
    if (!universe.eligibleIds.has(coinId)) continue;
    const start = event.counted_from ?? event.started_at;
    const end = Math.min(event.ended_at ?? dayEnd, dayEnd);
    for (const covered of event.admittedCoverage ?? [{ fromSec: start, toSec: end }]) {
      const interval = { fromSec: Math.max(day, start, covered.fromSec), toSec: Math.min(end, covered.toSec) };
      if (interval.fromSec >= interval.toSec) continue;
      const list = grouped.get(coinId) ?? [];
      list.push({ event, interval });
      grouped.set(coinId, list);
    }
  }

  const depegs: StabilityInputForDay["depegs"] = [];
  const activity: StabilityInputForDay["activity"] = [];
  let historicalPriceCoverageCount = 0;
  let openDepegsWithoutPrice = 0;
  let openDepegsWithoutWeight = 0;
  for (const [coinId, events] of grouped) {
    const mcapUsd = universe.mcapById.get(coinId);
    const aggregate = { worstBps: 0, earliestStart: Infinity };
    const priced: StabilityInputForDay["activity"][number]["intervals"] = [];
    let assessed = 0;
    for (const { event, interval } of events) {
      const slots = sampleSlots.filter((at) => at >= interval.fromSec && at < interval.toSec);
      if (sampleSlots.length > 0 && slots.length === 0) continue;
      const markAt = historicalEventMarks(event, supplyByCoin.get(coinId), day, interval, references, slots[slots.length - 1]);
      const startedAt = event.admittedCoverage?.[0]?.fromSec ?? event.counted_from ?? event.started_at;
      const slices = slots.length > 0 ? slots.map((at) => ({ fromSec: at, toSec: at + 1 })) : [interval];
      for (const slice of slices) {
        assessed++;
        const bps = markAt(slice.toSec - 1);
        if (bps == null) continue;
        priced.push({ ...slice, bps, startedAt });
        includePsiEventDeviation(aggregate, bps, startedAt);
      }
    }
    if (assessed === 0) continue;
    if (priced.length !== assessed) openDepegsWithoutPrice++;
    else historicalPriceCoverageCount++;
    if (mcapUsd == null) openDepegsWithoutWeight++;
    if (priced.length !== assessed || mcapUsd == null) continue;
    const { worstBps, earliestStart } = aggregate;
    activity.push({ id: coinId, mcapUsd, intervals: priced });
    depegs.push({
      bps: worstBps,
      mcapUsd,
      depegAgeDays: Math.max(0, (day - earliestStart) / DAY_SECONDS),
    });
  }

  const priorDay = day - 7 * DAY_SECONDS;
  const universe7dAgo = getPsiHistoricalUniverseForDay(supplyByCoin, priorDay, universeCache);
  const totalMcapUsd = universe.totalMcapUsd;
  let pairedCurrentMcapUsd = 0;
  let pairedPriorMcapUsd = 0;
  const trendUnavailableIds: string[] = [];
  const nativeQuantityMomentum: Record<string, number> = {};
  for (const coinId of universe.eligibleIds) {
    const current = universe.mcapById.get(coinId);
    const prior = universe7dAgo.mcapById.get(coinId);
    const currentSnapshot = findNearestSupplySnapshot(supplyByCoin.get(coinId), day);
    const priorSnapshot = findNearestSupplySnapshot(supplyByCoin.get(coinId), priorDay);
    const currentDate = currentSnapshot?.date;
    const priorDate = priorSnapshot?.date;
    if (current == null || prior == null || currentDate !== day || priorDate !== priorDay ||
      currentSnapshot?.coverage === "partial" || priorSnapshot?.coverage === "partial" ||
      isAmbiguousSupplyPerimeterDay(coinId, currentDate) || isAmbiguousSupplyPerimeterDay(coinId, priorDate) ||
      (!isEarlierSupplyPerimeter(coinId, currentDate) && isEarlierSupplyPerimeter(coinId, priorDate))) {
      trendUnavailableIds.push(coinId);
      continue;
    }
    pairedCurrentMcapUsd += current;
    pairedPriorMcapUsd += prior;
    const currentNative = currentSnapshot?.nativeQuantity;
    const priorNative = priorSnapshot?.nativeQuantity;
    if (currentNative && priorNative && priorNative.value > 0 &&
        Math.abs(currentNative.observedAt - priorNative.observedAt - 7 * DAY_SECONDS) <= 2 * 3600 &&
        isEarlierSupplyPerimeter(coinId, currentNative.observedAt) === isEarlierSupplyPerimeter(coinId, priorNative.observedAt)) {
      const change = ((currentNative.value - priorNative.value) / priorNative.value) * 100;
      if (Number.isFinite(change)) nativeQuantityMomentum[coinId] = change;
    }
  }
  const changePct = pairedPriorMcapUsd > 0
    ? ((pairedCurrentMcapUsd - pairedPriorMcapUsd) / pairedPriorMcapUsd) * 100
    : null;
  const mcap7dChangePct = changePct != null && Number.isFinite(changePct) ? changePct : null;

  return {
    depegs,
    activity,
    totalMcapUsd,
    mcap7dChangePct,
    trendUnavailableIds,
    ...(Object.keys(nativeQuantityMomentum).length ? { nativeQuantityMomentum } : {}),
    depegCount: depegs.length,
    eligibleUniverseCount: universe.eligibleUniverseCount,
    coveredUniverseCount: universe.coveredUniverseCount,
    historicalAssetCoverageCount: universe.historicalAssetCoverageCount,
    historicalPriceCoverageCount,
    peakDeviationFallbackCount: 0,
    openDepegsWithoutPrice,
    openDepegsWithoutWeight,
  };
}
