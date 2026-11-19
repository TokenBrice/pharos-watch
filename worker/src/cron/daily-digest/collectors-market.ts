import { logWorkerEventArgs } from "../../lib/structured-log";
import type { StablecoinData } from "@shared/types/supply";
import type { DigestInputData } from "@shared/types/digest";
import { ReferenceAdmissionSchema } from "@shared/types/reference-admission";
import { isDisputedAuditVerdict } from "@shared/lib/depeg-audit";
import { reviewedDepegDisputeSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { projectCurrentPegDeviation } from "@shared/lib/current-peg-projection";
import { deriveDepegSignal, hasPublishedDeviation } from "@shared/lib/depeg-signals";
import { isReferenceDeviationHeld } from "@shared/lib/reference-market-hours";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { normalizePegType } from "@shared/lib/peg-rates";
import { readAdmittedNativeEventObservation } from "../../lib/psi-reference";
import { NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../../lib/native-peg-quote-cache";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { hasUsableCurrentPrice } from "../../lib/current-peg-observations";
import { classifyDepegLifecycle } from "../../lib/depeg-lifecycle";
import { admittedDepegRecoveryAt } from "../../lib/tape-projectors/depeg";
import { EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL } from "../../lib/depeg-event-projection";
import { getCirculatingRawOrNull, getPrevWeekRawOrNull, isOutageFallbackCarry } from "@shared/lib/supply";
import { hasComparableSupplyPerimeter, hasNativeSupplyEvidence, isMissingNativeSupplyColumn, readNativeSupplyCheckpoint, SUPPLY_SNAPSHOT_MAX_AGE_SEC, type NativeSupplyHistoryRow } from "../../lib/dews/native-quantity";
import { compareFiniteDesc } from "@shared/lib/sort";
import { getMintBurnPressureRejection, type DigestFlowSupplySnapshot } from "@shared/lib/digest-mint-burn-admission";
import { classifySupplyCoverage, parseSupplyObservationProvenance } from "@shared/lib/supply-provenance";
import { ACTIVE_DEPEG_PROMPT_LIMIT, getDepegMarketImpactScore, isCriticalDepegRisk } from "@shared/lib/digest-risk";
import {
  admitLiquidityShift,
  type LiquidityShiftRejection,
  type LiquidityShiftSnapshot,
} from "@shared/lib/digest-liquidity-admission";
import { buildInClause } from "../../lib/db";
import { BLACKLIST_PUBLIC_EVENT_SQL } from "../../lib/blacklist/shared";
import { normalizeDexLiquidityEvidence } from "../../lib/dex-liquidity";
import { getGaugeBand, getGaugeScoreInterval, isGaugeBandRobustToWithheldWeight } from "../../lib/mint-burn-scoring";
import {
  readPublishedMintBurnGauge,
  type PublishedGaugeChain,
  type PublishedGaugeCoin,
} from "../../lib/mint-burn-published-gauge";
import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import { classifyGaugeRegime } from "./prompt/regime";
import { getGaugeRiskTapeTone } from "./digest-risk-tape";
import { computeDigestMintBurnFtqFlows } from "./mint-burn-ftq";
import {
  collectorDegraded,
  collectorResult,
  collectorOk,
  depegSignalKey,
  type CollectorContext,
  type CollectorResult,
  type DigestCurrentPegObservation,
} from "./collectors-shared";
import { sortDigestLifecycleFlags, type DigestLifecycleFlag, type DigestLifecycleIncident } from "./lifecycle-review";

function digestQuoteObservedAt(asset: StablecoinData | undefined, legacy: boolean, fixedUsd: boolean): number | null {
  if (!asset || asset.priceSource === "cached") return null;
  if (asset.priceObservedAtMode === "upstream") return asset.priceObservedAt ?? null;
  if (fixedUsd && asset.priceObservedAtMode === "local_fetch" && asset.priceConfidence === "high" &&
    normalizePricingSourceKeys(asset.priceSource).length > 1) return asset.priceObservedAt ?? null;
  if (!legacy || asset.priceObservedAtMode !== undefined) return null;
  // Old producers used priceUpdatedAt for both fetch and upstream clocks. Only a
  // selected feed with a source clock can recover a dated observation.
  const at = asset.priceObservedAt === undefined ? asset.priceUpdatedAt : asset.priceObservedAt;
  if (at == null) return null;
  const distinctSourceClock = asset.priceObservedAt !== undefined || (asset.priceSyncedAt != null && at < asset.priceSyncedAt);
  const sources = normalizePricingSourceKeys(asset.priceSource);
  const verified = sources.length > 0 && sources.every((key) => {
    const feed = getPricingSourceRegistryEntry(key);
    return feed?.supportsUpstreamObservedAt && (feed.requiresObservedAt || distinctSourceClock);
  });
  return verified ? at : null;
}

function getActiveDepegSuppressReason(params: { mcapUsd: number; ageHours: number; bps: number }): string | undefined {
  if (isCriticalDepegRisk(params)) {
    return undefined;
  }
  if (params.mcapUsd < 20_000_000) {
    return "sub-$20M active depeg, too small for a lead unless nothing larger moved";
  }
  // Coin-significance floor (owner-ratified 2026-07-18): sub-$50M coins lead
  // only on break day; after 48h they are one-line coverage at most.
  if (params.ageHours >= 48 && params.mcapUsd < 50_000_000) {
    return "sub-$50M depeg past its break day, lead only on break or resolution day";
  }
  if (params.ageHours >= 168 && params.mcapUsd < 250_000_000) {
    return "week-old mid/small-cap depeg, treat as chronic unless it worsened today";
  }
  if (Math.abs(params.bps) < 50 && params.mcapUsd < 250_000_000) {
    return "low-deviation smaller-cap depeg, weak lead material";
  }
  return undefined;
}

export async function collectActiveDepegs(
  ctx: CollectorContext,
): Promise<
  CollectorResult<{
    activeDepegCount: number | null;
    activeDepegSignalKeys: string[] | null;
    topDepegs: DigestInputData["topDepegs"];
    lifecycleFlags: DigestLifecycleFlag[];
    lifecycleUnavailable: DigestLifecycleIncident[];
  }>
> {
  try {
    const activeDepegs = await ctx.db
      .prepare(
        `SELECT e.id AS event_id, e.stablecoin_id, e.symbol, e.peg_type, e.source, e.direction, e.peak_deviation_bps,
                e.started_at, e.start_price, e.peak_price, e.peg_reference, p.quote_mode,
                p.audit_verdict, nq.value AS current_native_quote
         FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
         LEFT JOIN cache nq ON nq.key = '${NATIVE_EVENT_QUOTE_CACHE_PREFIX}' || e.id
         WHERE e.ended_at IS NULL`,
      )
      .all<{
        event_id: number;
        stablecoin_id: string;
        symbol: string;
        peg_type: string | null;
        source: string;
        quote_mode: string | null;
        audit_verdict: string | null;
        start_price: number | null;
        current_native_quote: string | null;
        direction: "above" | "below";
        peak_deviation_bps: number;
        started_at: number;
        peak_price: number | null;
        peg_reference: number | null;
      }>();
    if (!activeDepegs.success || !Array.isArray(activeDepegs.results)) throw new Error("active depeg census unavailable");
    const rows = activeDepegs.results;
    let activeDepegCount = 0;
    const activeDepegSignalKeys: string[] = [];
    let supplyUnavailable = false;
    const admissionIssues = new Set<string>();
    const lifecycleUnavailable: DigestLifecycleIncident[] = [];

    const withImpact = rows.flatMap((row) => {
      if (!ctx.trackedStablecoinIds.has(row.stablecoin_id) || FROZEN_IDS.has(row.stablecoin_id)) {
        return [];
      }
      // Reviewed disputes stay in the evidence rows but are not public event counts.
      if (!isDisputedAuditVerdict(row.audit_verdict)) activeDepegCount++;
      activeDepegSignalKeys.push(depegSignalKey({ stablecoinId: row.stablecoin_id, startedAt: row.started_at }, "active"));
      const incident = { eventId: row.event_id, stablecoinId: row.stablecoin_id, startedAt: row.started_at };
      const mcapUsd = ctx.mcapById.get(row.stablecoin_id);
      if (mcapUsd == null) {
        supplyUnavailable = true;
        lifecycleUnavailable.push(incident);
        return [];
      }
      const ageHours = Math.max(0, Math.round((ctx.nowSec - row.started_at) / HOUR_SECONDS));
      const asset = ctx.stablecoinAssetById.get(row.stablecoin_id);
      const quoteEvent = { ...row, peg_reference: row.peg_reference ?? NaN, peg_type: row.peg_type ?? undefined };
      const nativeEvent = isNativePegEvent(quoteEvent);
      const nativeObservation = nativeEvent ? readAdmittedNativeEventObservation(quoteEvent, ctx.nowSec) : null;
      const published: Pick<DigestCurrentPegObservation,
        "currentDeviationBps" | "referenceAdmission" | "admittedDeviationBps" | "pegReference" | "pegReferenceUnavailable" | "currentPriceUnavailable"
      > | undefined = asset?.currentPeg;
      const current = ctx.currentPegObservationById.get(row.stablecoin_id);
      const publishedUnavailable = published?.currentPriceUnavailable || published?.pegReferenceUnavailable ||
        published?.currentDeviationBps === null;
      const observation = !hasPublishedDeviation(current) && (hasPublishedDeviation(published) || publishedUnavailable)
        ? published : current ?? published;
      const admission = ReferenceAdmissionSchema.safeParse(observation?.referenceAdmission).data;
      const legacy = !hasPublishedDeviation(observation);
      const pegCurrency = WORKER_TRACKED_META_BY_ID.get(row.stablecoin_id)?.flags.pegCurrency;
      const observationReference = observation?.pegReference?.valueUsd;
      const currentReference =
        observation?.pegReferenceUnavailable === false &&
        observationReference != null && Number.isFinite(observationReference) && observationReference > 0
          ? observationReference
          : null;
      const fixedUsd = observation?.referenceAdmission == null && currentReference === 1 &&
        (pegCurrency === "USD" || (pegCurrency == null && normalizePegType(row.peg_type ?? undefined) === "peggedUSD"));
      const usdObservedAt = digestQuoteObservedAt(asset, legacy || pegCurrency === "USD", fixedUsd);
      const livePrice = nativeEvent ? nativeObservation?.value ?? null :
        ctx.stablecoinsCacheIsFresh &&
        usdObservedAt != null && Number.isSafeInteger(usdObservedAt) && usdObservedAt > 0 && usdObservedAt <= ctx.nowSec &&
        ctx.nowSec - usdObservedAt <= API_FRESHNESS_MAX_AGE_SEC.stablecoins &&
        asset != null && hasUsableCurrentPrice(asset)
          ? asset.price
          : null;
      const priceObservedAt = nativeEvent ? nativeObservation?.observedAt : usdObservedAt;
      const direction = row.direction;
      const bps = direction === "below" ? -Math.abs(row.peak_deviation_bps) : Math.abs(row.peak_deviation_bps);
      const latchedReference =
        typeof row.peg_reference === "number" && Number.isFinite(row.peg_reference) && row.peg_reference > 0
          ? row.peg_reference
          : null;
      const liveReference = nativeEvent ? latchedReference : currentReference;
      const hasUsableQuote = livePrice != null && liveReference != null && (nativeEvent || !observation?.currentPriceUnavailable);
      const projection = projectCurrentPegDeviation(observation, fixedUsd, usdObservedAt);
      const signal = hasUsableQuote && (nativeEvent || legacy) ? deriveDepegSignal(livePrice, liveReference) : null;
      const legacyHeld = !nativeEvent && legacy && projection != null && signal != null &&
        isReferenceDeviationHeld(pegCurrency, priceObservedAt ?? ctx.nowSec, signal.rawBps);
      const matchingAdmission = admission?.status === "admitted" && admission.quoteObservedAtSec === usdObservedAt &&
        admission.decisionAtSec <= ctx.nowSec;
      const currentBps = !hasUsableQuote || legacyHeld ? null
        : nativeEvent ? signal?.bps ?? null
        : legacy || fixedUsd || matchingAdmission ? projection : null;
      const publishesCurrentObservation = currentBps != null;
      const pegReference = publishesCurrentObservation ? liveReference : null;
      if (!publishesCurrentObservation) {
        lifecycleUnavailable.push(incident);
        if (nativeEvent) {
          admissionIssues.add("active-depeg-reference-unavailable");
          admissionIssues.add("active-depeg-native-quote-unavailable");
        } else if (legacyHeld || admission?.status === "held-closed-session") {
          admissionIssues.add("active-depeg-reference-market-closed");
        } else {
          admissionIssues.add("active-depeg-reference-unavailable");
          if (admission && admission.status !== "admitted") {
            admissionIssues.add(`active-depeg-${admission.reason}`);
          }
        }
      }
      const severityBps = currentBps ?? bps;
      const severityBasis: "current" | "peak-fallback" = currentBps != null ? "current" : "peak-fallback";
      const impactScore = getDepegMarketImpactScore(severityBps, mcapUsd);
      return {
        ...incident,
        symbol: row.symbol,
        bps,
        direction,
        mcapUsd,
        ageHours,
        impactScore,
        peakBps: row.peak_deviation_bps,
        severityBps,
        severityBasis,
        quoteMode: nativeEvent ? "native-peg" as const : "usd" as const,
        ...(nativeEvent && row.peak_price != null ? { peakPriceNative: row.peak_price } : {}),
        ...(nativeEvent && publishesCurrentObservation && livePrice != null ? { currentPriceNative: livePrice } : {}),
        ...(pegReference != null ? { pegReference } : {}),
        // Marks a reference re-read each run, so editions stay comparable while it drifts.
        ...(!nativeEvent && pegReference != null ? { pegReferenceBasis: "current" as const } : {}),
        ...(publishesCurrentObservation && priceObservedAt != null ? { priceObservedAt } : {}),
        ...(currentBps != null ? { currentBps } : {}),
        ...(!nativeEvent && row.peak_price != null ? { peakPriceUsd: row.peak_price } : {}),
        ...(!nativeEvent && publishesCurrentObservation && livePrice != null ? { currentPriceUsd: livePrice } : {}),
        suppressReason: getActiveDepegSuppressReason({ mcapUsd, ageHours, bps: severityBps }),
      };
    });
    withImpact.sort((a, b) => {
      const criticalDelta =
        Number(isCriticalDepegRisk({ bps: b.severityBps, mcapUsd: b.mcapUsd })) -
        Number(isCriticalDepegRisk({ bps: a.severityBps, mcapUsd: a.mcapUsd }));
      return criticalDelta || b.impactScore - a.impactScore || Math.abs(b.severityBps) - Math.abs(a.severityBps);
    });
    const allDepegs = withImpact.map(
        ({
          stablecoinId,
          symbol,
          bps,
          direction,
          mcapUsd,
          startedAt,
          ageHours,
          impactScore,
          peakBps,
          severityBasis,
          currentBps,
          quoteMode,
          peakPriceNative,
          currentPriceNative,
          pegReference,
          pegReferenceBasis,
          priceObservedAt,
          peakPriceUsd,
          currentPriceUsd,
          suppressReason,
        }) => ({
          stablecoinId,
          symbol,
          bps,
          direction,
          mcapUsd,
          startedAt,
          ageHours,
          impactScore,
          peakBps,
          severityBasis,
          quoteMode,
          ...(peakPriceNative != null ? { peakPriceNative } : {}),
          ...(currentPriceNative != null ? { currentPriceNative } : {}),
          ...(currentBps != null ? { currentBps } : {}),
          ...(pegReference != null ? { pegReference } : {}),
          ...(pegReferenceBasis != null ? { pegReferenceBasis } : {}),
          ...(priceObservedAt != null ? { priceObservedAt } : {}),
          ...(peakPriceUsd != null ? { peakPriceUsd } : {}),
          ...(currentPriceUsd != null ? { currentPriceUsd } : {}),
          ...(suppressReason ? { suppressReason } : {}),
        }),
      );
    const topDepegs = allDepegs.slice(0, ACTIVE_DEPEG_PROMPT_LIMIT);
    if (ctx.evidence) ctx.evidence.activeDepegs = allDepegs;

    // Lifecycle review runs over the FULL open-event set, not the top-8 slice:
    // a stalled collapse must not escape review by ranking ninth.
    const lifecycleFlags = sortDigestLifecycleFlags(withImpact.flatMap((row) =>
      classifyDepegLifecycle([row]).map((flag) => ({
        ...flag,
        eventId: row.eventId,
        startedAt: row.startedAt,
        evaluatedAt: ctx.nowSec,
        priceObservedAt: row.priceObservedAt,
      }))));

    const qualityReasons = [
      ...(supplyUnavailable ? ["active-depeg-supply-unavailable"] : []),
      ...admissionIssues,
    ];
    return collectorResult(
      { activeDepegCount, activeDepegSignalKeys, topDepegs, lifecycleFlags, lifecycleUnavailable },
      [],
      qualityReasons,
    );
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to query active depegs:", error);
    return collectorDegraded({
      activeDepegCount: null, activeDepegSignalKeys: null, topDepegs: [], lifecycleFlags: [], lifecycleUnavailable: [],
    }, "active-depegs-query");
  }
}

type DigestBlacklistActivity = NonNullable<DigestInputData["blacklistActivity"]> & {
  unpricedEventCount: number;
};

export async function collectBlacklistActivity(
  ctx: CollectorContext,
): Promise<CollectorResult<DigestBlacklistActivity | undefined>> {
  try {
    const blRows = await ctx.db
      .prepare(
        `SELECT stablecoin AS symbol, chain_name, event_type, amount_usd_at_event FROM blacklist_events WHERE timestamp >= ? AND timestamp < ? AND ${BLACKLIST_PUBLIC_EVENT_SQL} ORDER BY amount_usd_at_event DESC`,
      )
      .bind(ctx.nowSec - DAY_SECONDS, ctx.nowSec)
      .all<{ symbol: string; chain_name: string; event_type: string; amount_usd_at_event: number | null }>();
    const blEvents = blRows.results ?? [];
    const activityEvents = blEvents.filter((event) => event.event_type === "blacklist" || event.event_type === "destroy");
    if (activityEvents.length > 0) {
      const eventCount = activityEvents.length;
      const unpricedEventCount = activityEvents.filter((event) => event.amount_usd_at_event == null).length;
      const totalAmountUsd = activityEvents.reduce(
        (sum, event) => sum + (event.amount_usd_at_event == null ? 0 : event.amount_usd_at_event),
        0,
      );
      // An unknown amount may be larger than the promotion threshold. Treat it
      // as a potential large event so an unrecovered freeze is not silently
      // suppressed as a quiet day; unpricedEventCount carries the uncertainty
      // through the persisted digest quality data.
      const hasLargeEvent = activityEvents.some(
        (event) => event.amount_usd_at_event == null || event.amount_usd_at_event > 10_000_000,
      );
      return collectorOk({
          editorialEligible: eventCount >= 2 || hasLargeEvent,
          eventCount,
          totalAmountUsd,
          unpricedEventCount,
          topEvents: activityEvents
            .slice(0, 5)
            .map((event) => ({
              symbol: event.symbol,
              chain: event.chain_name,
              type: event.event_type as "blacklist" | "destroy",
              amountUsd: event.amount_usd_at_event,
            })),
        });
    }
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to query blacklist events:", error);
    return collectorDegraded(undefined, "blacklist-activity-query");
  }
  return collectorOk({ eventCount: 0, totalAmountUsd: 0, unpricedEventCount: 0, editorialEligible: false, topEvents: [] });
}

function supplyMoverCheckpoint(row: NativeSupplyHistoryRow | undefined, through: number) {
  if (!row) return undefined;
  const { provenance } = parseSupplyObservationProvenance(row.supply_provenance);
  if (provenance?.nativeQuantityUnavailable) return null;
  return hasNativeSupplyEvidence(row) ? readNativeSupplyCheckpoint(row, through) : undefined;
}

function legacyUsdDelta(current: number | null | undefined, previous: number | null | undefined) {
  return current != null && previous != null && Number.isFinite(current) && current >= 0 &&
    Number.isFinite(previous) && previous >= 0 ? current - previous : null;
}

export async function collectNativeSupplyMovers(ctx: CollectorContext): Promise<CollectorResult<Pick<DigestInputData,
  "biggestSupplyChange" | "supplyVelocity" | "supplyChanges7d">>> {
  const empty = { biggestSupplyChange: null, supplyChanges7d: [] };
  const cohort = ctx.coreAggregateStablecoinAssets.flatMap((coin) => {
    const mcap = getCirculatingRawOrNull(coin);
    return mcap == null || isOutageFallbackCarry(coin) ? [] : [{
      id: coin.id, symbol: coin.symbol, name: coin.name, mcap, prevWeek: getPrevWeekRawOrNull(coin),
    }];
  });
  if (cohort.length === 0) return ctx.coreAggregateStablecoinAssets.length === 0
    ? collectorOk(empty) : collectorDegraded(empty, "supply-movers-unavailable");
  const yesterday = ctx.todayTs - DAY_SECONDS;
  const weekAgo = ctx.todayTs - 7 * DAY_SECONDS;
  type SupplyRow = NativeSupplyHistoryRow & {
    circulating_usd: number;
    valuation_price_usd?: number | null;
    valuation_observed_at_sec?: number | null;
  };
  const readRows = (withNative: boolean) => ctx.db.prepare(`SELECT stablecoin_id, snapshot_date, circulating_usd
          ${withNative ? ", circulating_native, supply_provenance, valuation_price_usd, valuation_observed_at_sec" : ""}
         FROM supply_history WHERE stablecoin_id IN (SELECT value FROM json_each(?))
           AND snapshot_date IN (?, ?, ?)`)
    .bind(JSON.stringify(cohort.map((coin) => coin.id)), ctx.todayTs, yesterday, weekAgo).all<SupplyRow>();
  try {
    const rows = await readRows(true).catch((error: unknown) => {
      if (isMissingNativeSupplyColumn(error)) return readRows(false);
      throw error;
    });
    if (!rows.success) throw new Error(rows.error ?? "Supply history read failed");
    const byCoin = new Map<string, Map<number, SupplyRow>>();
    for (const row of rows.results) {
      const history = byCoin.get(row.stablecoin_id) ?? new Map<number, SupplyRow>();
      history.set(row.snapshot_date, row);
      byCoin.set(row.stablecoin_id, history);
    }
    const top10 = new Set(cohort.slice().sort(compareFiniteDesc((coin: typeof cohort[number]) => coin.mcap))
      .slice(0, 10).map((coin) => coin.id));
    let biggestSupplyChange: DigestInputData["biggestSupplyChange"] = null;
    let biggestAbsChange = 0;
    const supplyChanges7d: NonNullable<DigestInputData["supplyChanges7d"]> = [];
    const supplyVelocity: NonNullable<DigestInputData["supplyVelocity"]> = [];
    let admitted = false;
    for (const coin of cohort) {
      const history = byCoin.get(coin.id);
      const today = history?.get(ctx.todayTs);
      const week = history?.get(weekAgo);
      if (!hasComparableSupplyPerimeter(coin.id, ctx.todayTs, weekAgo)) continue;
      const current = supplyMoverCheckpoint(today, ctx.nowSec);
      const weekCheckpoint = supplyMoverCheckpoint(week, ctx.nowSec - 7 * DAY_SECONDS);
      const price = today?.valuation_price_usd;
      const priceAt = today?.valuation_observed_at_sec;
      if (current === null || weekCheckpoint === null ||
          (price != null && (!Number.isFinite(price) || price <= 0)) ||
          (priceAt != null && (!Number.isSafeInteger(priceAt) || priceAt < ctx.todayTs - SUPPLY_SNAPSHOT_MAX_AGE_SEC ||
            priceAt > ctx.nowSec))) continue;
      const quantityEvidence = current && weekCheckpoint && price != null && priceAt != null ? {
        basis: "native-quantity" as const, current, weekAgo: weekCheckpoint,
        valuationPriceUsd: price, valuationObservedAt: priceAt,
      } : undefined;
      const weeklyChange = quantityEvidence
        ? (quantityEvidence.current.quantity - quantityEvidence.weekAgo.quantity) * quantityEvidence.valuationPriceUsd
        : legacyUsdDelta(coin.mcap, coin.prevWeek);
      if (weeklyChange != null && Number.isFinite(weeklyChange)) {
        admitted = true;
        if (coin.mcap > 1_000_000) {
          supplyChanges7d.push({ stablecoinId: coin.id, coin: coin.symbol, change7d: weeklyChange, quantityEvidence });
          if (Math.abs(weeklyChange) > biggestAbsChange) {
            biggestAbsChange = Math.abs(weeklyChange);
            biggestSupplyChange = { id: coin.id, symbol: coin.symbol, name: coin.name, changeUsd: weeklyChange,
              currentMcap: coin.mcap, quantityEvidence };
          }
        }
      }

      const yesterdayRow = history?.get(yesterday);
      if (!top10.has(coin.id) || !hasComparableSupplyPerimeter(coin.id, ctx.todayTs, yesterday)) continue;
      const dayAgo = supplyMoverCheckpoint(yesterdayRow, ctx.nowSec - DAY_SECONDS);
      if (dayAgo === null) continue;
      const velocityEvidence = quantityEvidence && dayAgo ? { ...quantityEvidence, dayAgo } : undefined;
      const change7d = velocityEvidence ? weeklyChange : legacyUsdDelta(today?.circulating_usd, week?.circulating_usd);
      const change1d = velocityEvidence
        ? (velocityEvidence.current.quantity - velocityEvidence.dayAgo.quantity) * velocityEvidence.valuationPriceUsd
        : legacyUsdDelta(today?.circulating_usd, yesterdayRow?.circulating_usd);
      if (change1d == null || change7d == null || !Number.isFinite(change1d) || !Number.isFinite(change7d)) continue;
      admitted = true;
      const directionReversed = Math.sign(change1d) === -Math.sign(change7d) && change1d !== 0 && change7d !== 0;
      const sameDirection = Math.sign(change1d) === Math.sign(change7d) && change7d !== 0;
      const velocityRatio = change7d !== 0 ? Math.abs(change1d / (change7d / 7)) : 0;
      const materialDay = Math.abs(change1d) >= 1_000_000 && Math.abs(change1d) >= coin.mcap * 0.001;
      const materialWeek = Math.abs(change7d) >= 10_000_000 && Math.abs(change7d) >= coin.mcap * 0.002;
      const signal = directionReversed && materialDay ? "reversed"
        : sameDirection && velocityRatio > 2.5 && materialDay ? "accelerating"
        : sameDirection && velocityRatio < 0.4 && materialWeek ? "decelerating" : null;
      if (signal != null) supplyVelocity.push({ stablecoinId: coin.id, coin: coin.symbol, change1d, change7d,
        signal, quantityEvidence: velocityEvidence });
    }
    return admitted ? collectorOk({ biggestSupplyChange, supplyChanges7d, supplyVelocity: supplyVelocity.length ? supplyVelocity : undefined })
      : collectorDegraded(empty, "supply-movers-unavailable");
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to read native supply checkpoints:", error);
    return collectorDegraded(empty, "supply-velocity-query");
  }
}

export async function collectResolvedDepegs(
  ctx: CollectorContext,
): Promise<CollectorResult<{
  resolvedDepegCount: number | null;
  resolvedDepegSignalKeys: string[] | null;
  resolvedDepegs: DigestInputData["resolvedDepegs"];
}>> {
  try {
    // Recovery evidence is uncapped. Only the prompt presentation below applies
    // market-cap, peak-size and top-N filters.
    const cutoff24h = ctx.nowSec - DAY_SECONDS;
    const eligibleIds = [...ctx.trackedStablecoinIds];
    const resolvedRows = await ctx.db
      .prepare(
        `SELECT e.id, e.symbol, e.direction, e.peak_deviation_bps, e.started_at, e.ended_at,
                e.stablecoin_id, e.peg_type, e.close_reason, e.recovery_price, e.recovery_peg_reference,
                e.price_coverage_json, e.last_trusted_price_at, e.price_coverage_gap_started_at,
                e.admitted_coverage_json, e.disposition
         FROM depeg_events e
         WHERE e.ended_at IS NOT NULL AND e.ended_at >= ?
           AND e.stablecoin_id IN (SELECT value FROM json_each(?))
           AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL} AND NOT ${reviewedDepegDisputeSql("e")}
         ORDER BY ABS(e.peak_deviation_bps) DESC`,
      )
      .bind(cutoff24h, JSON.stringify(eligibleIds))
      .all<Parameters<typeof admittedDepegRecoveryAt>[0] & {
        symbol: string;
        direction: "above" | "below";
        peak_deviation_bps: number;
      }>();
    if (resolvedRows.success !== true || !Array.isArray(resolvedRows.results)) {
      throw new Error(resolvedRows.error ?? "Resolved depeg read failed");
    }
    let supplyUnavailable = false;

    const recoveredRows = resolvedRows.results.flatMap((row) => {
      if (!ctx.trackedStablecoinIds.has(row.stablecoin_id) || FROZEN_IDS.has(row.stablecoin_id)) return [];
      const recoveryAt = admittedDepegRecoveryAt(row, { inferLegacyClose: true });
      return recoveryAt != null && recoveryAt >= cutoff24h && recoveryAt <= ctx.nowSec
        ? [{ ...row, recoveryAt }] : [];
    });
    const recovered = recoveredRows.flatMap((row) => {
        const mcapUsd = ctx.mcapById.get(row.stablecoin_id);
        if (mcapUsd == null) {
          supplyUnavailable = true;
          return [];
        }
        return [{
          stablecoinId: row.stablecoin_id,
          symbol: row.symbol,
          peakBps: Math.abs(row.peak_deviation_bps),
          direction: row.direction,
          durationHours: Math.round((row.recoveryAt - row.started_at) / HOUR_SECONDS),
          mcapUsd,
          startedAt: row.started_at,
          endedAt: row.recoveryAt,
          impactScore: getDepegMarketImpactScore(row.peak_deviation_bps, mcapUsd),
        }];
      });
    if (ctx.evidence) ctx.evidence.recoveredDepegs = recovered;
    const candidates = recovered
      .filter((row) => row.mcapUsd > 20_000_000 && row.peakBps > 100)
      .sort((a, b) => b.impactScore - a.impactScore)
      .slice(0, 5);

    return collectorResult(
      {
        resolvedDepegCount: recoveredRows.length,
        resolvedDepegSignalKeys: recoveredRows.map((row) => depegSignalKey({ stablecoinId: row.stablecoin_id, startedAt: row.started_at }, "resolved")),
        resolvedDepegs: candidates.length > 0 ? candidates : undefined,
      },
      [],
      supplyUnavailable ? ["resolved-depeg-supply-unavailable"] : [],
    );
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to query resolved depegs:", error);
    return collectorDegraded({ resolvedDepegCount: null, resolvedDepegSignalKeys: null, resolvedDepegs: undefined }, "resolved-depegs-query");
  }
}

export async function collectMintBurnFlows(
  ctx: CollectorContext,
): Promise<CollectorResult<DigestInputData["mintBurnFlows"]>> {
  const degradedReasons: string[] = [];
  try {
    // The Bank Run Gauge has one producer: the mint/burn flows API publishes it
    // over the tracked-pair universe with tracked-chain mcap weighting. The
    // digest re-bins that publication instead of recomputing a second composite
    // from `mint_burn_hourly` over a different universe and mcap basis.
    const published = await readPublishedMintBurnGauge(ctx.db, ctx.nowSec);
    if (published.kind !== "ok") {
      // Every non-ok gauge outcome carries a machine-readable reason. An
      // absent publication is attributable too: the critical lane publishes
      // every 30 minutes, so a missing row means the producer stopped or the
      // cache was dropped, not that the section is silently optional. The
      // digest still publishes without the section, so absence is a named
      // quality finding; a broken publication is a collector failure.
      const reason = `mint-burn-gauge-${published.reason}`;
      return published.reason === "missing"
        ? collectorResult(undefined, degradedReasons, [reason])
        : collectorResult(undefined, [...degradedReasons, reason]);
    }
    const { gauge } = published;
    if (gauge.stale) {
      degradedReasons.push("mint-burn-gauge-stale");
    }
    const gaugeScore = gauge.score;
    if (gaugeScore === null) return collectorResult(undefined, degradedReasons, ["mint-burn-gauge-unavailable"]);
    // Valuation completeness (D11-2): the digest never restates a flow claim
    // that missing USD valuation could alter. Weight withheld from the score is
    // tolerated only when every possible score preserves bands, regime and tape tone; a
    // withheld count without published weights (older producer) is unbounded.
    // A publication predating completeness is used but named.
    const qualityReasons: string[] = [];
    if (gauge.partialValuationInputs !== null && gauge.partialValuationInputs > 0) {
      const bandRobust = gauge.partialValuationMcapUsd !== null && gauge.scoredMcapUsd !== null
        && isGaugeBandRobustToWithheldWeight({
          score: gaugeScore,
          scoredMcapUsd: gauge.scoredMcapUsd,
          withheldMcapUsd: gauge.partialValuationMcapUsd,
        });
      const interval = gauge.partialValuationMcapUsd !== null && gauge.scoredMcapUsd !== null
        ? getGaugeScoreInterval({ score: gaugeScore, scoredMcapUsd: gauge.scoredMcapUsd, withheldMcapUsd: gauge.partialValuationMcapUsd })
        : null;
      const decisionsRobust = interval !== null && interval.every((bound) =>
        classifyGaugeRegime(bound) === classifyGaugeRegime(gaugeScore)
        && getGaugeRiskTapeTone(bound) === getGaugeRiskTapeTone(gaugeScore));
      if (!bandRobust || !decisionsRobust) {
        return collectorResult(undefined, degradedReasons, ["mint-burn-gauge-valuation-partial"]);
      }
      qualityReasons.push("mint-burn-gauge-valuation-partial-band-stable");
    }
    if (gauge.partialValuationInputs === null) qualityReasons.push("mint-burn-valuation-unknown");

    const ftqFlows = await computeDigestMintBurnFtqFlows(
      ctx.db,
      gauge.coins.map((coin) => ({
        id: coin.id,
        knownNetUsd: coin.net24hUsd,
        valuation: coin.valuation24h,
        classification: coin.classification24h,
        window24hComplete: coin.scanCoverage?.window24h.complete ?? null,
      })),
      // The producer publication that decided which coins have a published flow.
      gauge.publication,
    );
    if (ftqFlows.kind === "unavailable") {
      if (ftqFlows.reason === "valuation-incomplete") qualityReasons.push("mint-burn-ftq-valuation-incomplete");
      else degradedReasons.push(`mint-burn-ftq:${ftqFlows.reason}`);
    }

    // Pressure needs complete baseline evidence as well as the current window.
    const pressureCoins = gauge.coins
      .filter(
        (coin): coin is PublishedGaugeCoin & { intensity: number; net24hUsd: number } =>
          coin.intensity !== null
          && Math.abs(coin.intensity) > 20
          && coin.net24hUsd !== null
          && coin.valuation24h.completeness === "complete"
          && coin.baselineValuation === "complete"
          && (!coin.classification24h || coin.classification24h.completeness === "complete")
          && (!coin.baselineClassification || coin.baselineClassification.completeness === "complete"),
      );
    const supplyById = new Map<string, Map<number, DigestFlowSupplySnapshot>>();
    const supplyWindow = gauge.window && gauge.window.end <= ctx.nowSec ? gauge.window : null;
    const supplyEnd = supplyWindow ? Math.floor(supplyWindow.end / DAY_SECONDS) * DAY_SECONDS : null;
    const confirmationCoins = pressureCoins.filter((coin) => getMintBurnPressureRejection({
      stablecoinId: coin.id, net24hUsd: coin.net24hUsd, gaugeWeightUsd: coin.gaugeWeightUsd, window: null,
    }) === "supply-unavailable");
    if (confirmationCoins.length > 0 && supplyEnd != null) {
      try {
        const ids = buildInClause(confirmationCoins.map((coin) => coin.id));
        const rows = await ctx.db.prepare(
          `SELECT stablecoin_id, snapshot_date, circulating_usd, supply_provenance FROM supply_history WHERE stablecoin_id IN (${ids.sql}) AND snapshot_date IN (?, ?)`,
        ).bind(...ids.binds, supplyEnd - DAY_SECONDS, supplyEnd)
          .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number | null; supply_provenance: string | null }>();
        for (const row of rows.results ?? []) {
          const byDate = supplyById.get(row.stablecoin_id) ?? new Map<number, DigestFlowSupplySnapshot>();
          byDate.set(row.snapshot_date, {
            snapshotDate: row.snapshot_date,
            circulatingUsd: row.circulating_usd,
            coverage: classifySupplyCoverage(parseSupplyObservationProvenance(row.supply_provenance).provenance),
          });
          supplyById.set(row.stablecoin_id, byDate);
        }
      } catch (error) {
        logWorkerEventArgs("handler", "error", "[daily-digest] Failed to confirm mint-burn pressure supply:", error);
        degradedReasons.push("mint-burn-pressure-supply-query");
      }
    }
    const topPressure = pressureCoins
      .filter((coin) => {
        const snapshots = supplyById.get(coin.id);
        const rejection = getMintBurnPressureRejection({
          stablecoinId: coin.id,
          net24hUsd: coin.net24hUsd,
          gaugeWeightUsd: coin.gaugeWeightUsd,
          window: supplyWindow,
          previous: supplyEnd == null ? undefined : snapshots?.get(supplyEnd - DAY_SECONDS),
          current: supplyEnd == null ? undefined : snapshots?.get(supplyEnd),
        });
        if (!rejection) return true;
        qualityReasons.push(`mint-burn-pressure-${rejection}`);
        return false;
      })
      .sort((a, b) => Math.abs(b.intensity) - Math.abs(a.intensity))
      .slice(0, 3)
      .map((coin) => ({
        symbol: coin.symbol, intensity: coin.intensity, net24hUsd: coin.net24hUsd,
        gaugeWeightShare: coin.gaugeWeightUsd != null && gauge.scoredMcapUsd != null
          && gauge.scoredMcapUsd > 0 && coin.gaugeWeightUsd <= gauge.scoredMcapUsd
          ? coin.gaugeWeightUsd / gauge.scoredMcapUsd : null,
      }));

    // Published chains arrive sorted by absolute 24h net flow; only complete nets are restated.
    const topChains = gauge.chains
      .filter((chain): chain is PublishedGaugeChain & { net24hUsd: number } =>
        chain.net24hUsd !== null && chain.valuation === "complete")
      .slice(0, 3)
      .map((chain) => ({ chainId: chain.chainId, netUsd: chain.net24hUsd }));

    return collectorResult({
      gaugeScore,
      gaugeBand: getGaugeBand(gaugeScore),
      provenance: { window: gauge.window, publishedAt: gauge.publishedAt, updatedAt: gauge.updatedAt },
      classificationSource:
        ftqFlows.kind === "ok"
          ? "safety-score-v9-publication"
          : "unavailable",
      classificationReason: ftqFlows.kind === "ok" ? null : ftqFlows.reason,
      safetyScoreIdentity: ftqFlows.safetyScoreIdentity,
      flightToQuality: { active: ftqFlows.active, safeNetUsd: ftqFlows.safeNet24h, riskyNetUsd: ftqFlows.riskyNet24h },
      topPressure,
      topChains,
    }, degradedReasons, qualityReasons);
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to collect mint-burn flows:", error);
    degradedReasons.push("mint-burn-gauge-read");
    return collectorResult(undefined, degradedReasons);
  }
}

export async function collectLiquidityShifts(
  ctx: CollectorContext,
): Promise<CollectorResult<DigestInputData["liquidityShifts"]>> {
  const degradedReasons: string[] = [];
  try {
    const lookbackStart = ctx.yesterdayTs - 2 * DAY_SECONDS;
    const rows = await ctx.db
      .prepare(
        `SELECT h.stablecoin_id, h.liquidity_score, h.total_tvl_usd, h.snapshot_date,
                h.coverage_class, h.coverage_confidence, h.methodology_version
         FROM dex_liquidity_history h
         WHERE h.snapshot_date <= ? AND h.snapshot_date > ?
           AND h.liquidity_score IS NOT NULL
         ORDER BY h.stablecoin_id, h.snapshot_date DESC`,
      )
      .bind(ctx.yesterdayTs, lookbackStart)
      .all<{
        stablecoin_id: string;
        liquidity_score: number;
        total_tvl_usd: number;
        snapshot_date: number;
        coverage_class: string | null;
        coverage_confidence: number | null;
        methodology_version: string | null;
      }>();

    type LiqRow = (typeof rows.results)[number];
    const byId = new Map<string, { latest?: LiqRow; previous?: LiqRow }>();
    for (const row of rows.results ?? []) {
      let evidence;
      try {
        evidence = normalizeDexLiquidityEvidence(row);
      } catch {
        degradedReasons.push("liquidity-invalid-coverage-evidence");
        continue;
      }
      row.coverage_class = evidence.coverageClass;
      row.coverage_confidence = evidence.coverageConfidence;
      const entry = byId.get(row.stablecoin_id) ?? {};
      if (!entry.latest) entry.latest = row;
      else if (!entry.previous) entry.previous = row;
      byId.set(row.stablecoin_id, entry);
    }

    const toSnapshot = (row: LiqRow): LiquidityShiftSnapshot => ({
      snapshotDate: row.snapshot_date,
      liquidityScore: row.liquidity_score,
      totalTvlUsd: row.total_tvl_usd,
      coverageClass: row.coverage_class,
      coverageConfidence: row.coverage_confidence,
      methodologyVersion: row.methodology_version,
    });
    const shifts: NonNullable<DigestInputData["liquidityShifts"]> = [];
    const evidenceRows: NonNullable<NonNullable<CollectorContext["evidence"]>["liquidity"]> = [];
    const rejections = new Set<LiquidityShiftRejection>();
    let supplyUnavailable = false;
    for (const [id, { latest, previous }] of byId) {
      if (!latest || !previous) continue;
      const delta = latest.liquidity_score - previous.liquidity_score;
      if (Math.abs(delta) < 8) continue;

      const mcapUsd = ctx.mcapById.get(id);
      if (mcapUsd == null) {
        supplyUnavailable = true;
        continue;
      }
      if (mcapUsd < 10_000_000) continue;

      const coin = ctx.trackedStablecoinAssets.find((candidate) => candidate.id === id);
      if (!coin) continue;

      // Fail closed: an inadmissible pair yields no signal at all. The prompt
      // renders raw TVL evidence, so a hedged shift is still quotable.
      const admission = admitLiquidityShift(toSnapshot(latest), toSnapshot(previous));
      if (!admission.admissible) {
        rejections.add(admission.rejection!);
        logWorkerEventArgs(
          "handler",
          "info",
          `[daily-digest] Rejected ${coin.symbol} liquidity shift: ${admission.rejection} ` +
            `(score ${previous.liquidity_score}->${latest.liquidity_score}, ` +
            `tvl ${previous.total_tvl_usd}->${latest.total_tvl_usd}, ` +
            `coverage ${previous.coverage_class}/${latest.coverage_class}, ` +
            `methodology ${previous.methodology_version}->${latest.methodology_version})`,
        );
        continue;
      }

      evidenceRows.push({ stablecoinId: id, symbol: coin.symbol, currentScore: latest.liquidity_score });
      shifts.push({
        symbol: coin.symbol,
        currentScore: latest.liquidity_score,
        previousScore: previous.liquidity_score,
        scoreDelta: delta,
        currentTvl: latest.total_tvl_usd,
        previousTvl: previous.total_tvl_usd,
        mcapUsd,
        tvlChangePct: admission.tvlChangePct,
        expectedScoreDeltaFromTvl: admission.expectedScoreDeltaFromTvl,
        coverageClass: latest.coverage_class ?? "unknown",
        coverageConfidence: latest.coverage_confidence ?? 0,
      });
    }

    // Surface the drop so the prompt's data-quality block and the status page
    // record that a liquidity story was withheld rather than never existed.
    // A deliberately withheld story is soft quality, never a degraded run.
    const withheldStoryReasons: string[] = [...rejections].map((rejection) => `liquidity-shift-${rejection}`);
    if (supplyUnavailable) withheldStoryReasons.push("liquidity-shift-supply-unavailable");

    shifts.sort((a, b) => Math.abs(b.scoreDelta) * b.mcapUsd - Math.abs(a.scoreDelta) * a.mcapUsd);
    if (ctx.evidence) ctx.evidence.liquidity = evidenceRows;
    return collectorResult(
      shifts.length > 0 ? shifts.slice(0, 5) : undefined,
      degradedReasons,
      withheldStoryReasons,
    );
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to collect liquidity shifts:", error);
    degradedReasons.push("liquidity-shifts-query");
    return collectorResult(undefined, degradedReasons);
  }
}
