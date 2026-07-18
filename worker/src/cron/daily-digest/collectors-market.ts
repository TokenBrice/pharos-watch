import type { DigestInputData } from "@shared/types/digest";
import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { classifyDepegLifecycle, type DepegLifecycleFlag } from "../../lib/depeg-lifecycle";
import { getCirculatingRaw } from "@shared/lib/supply";
import { ACTIVE_DEPEG_PROMPT_LIMIT, getDepegMarketImpactScore, isCriticalDepegRisk } from "@shared/lib/digest-risk";
import { buildInClause } from "../../lib/db";
import {
  computeFlowIntensity,
  computeGaugeScore,
  getGaugeBand,
  detectFlightToQuality,
} from "../../lib/mint-burn-scoring";
import { isCanonicalMintBurnPair } from "../../lib/mint-burn-canonical-chain";
import { SECONDS } from "../../lib/time-constants";
import { computeDigestMintBurnFtqFlows } from "./mint-burn-ftq";
import {
  collectorDegraded,
  collectorOk,
  markCollectorDegraded,
  type CollectorContext,
  type CollectorResult,
} from "./collectors-shared";

type FlowIntensityRow = {
  id: string;
  symbol: string;
  intensity: number | null;
  net24h: number;
  mcap: number;
};

type FlowIntensityRowWithIntensity = FlowIntensityRow & { intensity: number };

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
    activeDepegCount: number;
    topDepegs: DigestInputData["topDepegs"];
    lifecycleFlags: DepegLifecycleFlag[];
  }>
> {
  try {
    const activeDepegs = await ctx.db
      .prepare(
        "SELECT stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, peak_price, peg_reference FROM depeg_events WHERE ended_at IS NULL",
      )
      .all<{
        stablecoin_id: string;
        symbol: string;
        peg_type: string | null;
        direction: "above" | "below";
        peak_deviation_bps: number;
        started_at: number;
        peak_price: number | null;
        peg_reference: number | null;
      }>();
    const rows = activeDepegs.results ?? [];

    const withImpact = rows.flatMap((row) => {
      if (!ctx.trackedStablecoinIds.has(row.stablecoin_id) || FROZEN_IDS.has(row.stablecoin_id)) {
        return [];
      }
      const mcapUsd = ctx.mcapById.get(row.stablecoin_id) ?? 0;
      const ageHours = Math.max(0, Math.round((ctx.nowSec - row.started_at) / SECONDS.ONE_HOUR));
      const asset = ctx.stablecoinAssetById.get(row.stablecoin_id);
      const livePrice =
        typeof asset?.price === "number" && Number.isFinite(asset.price) && asset.price > 0 ? asset.price : null;
      const direction = row.direction;
      const bps = direction === "below" ? -Math.abs(row.peak_deviation_bps) : Math.abs(row.peak_deviation_bps);
      // Severity decisions run on the live deviation vs the event's peg
      // reference; the stored peak is context only. Without a usable live
      // price the peak remains the basis, flagged so downstream consumers
      // never mistake it for a current observation.
      const pegReference =
        typeof row.peg_reference === "number" && Number.isFinite(row.peg_reference) && row.peg_reference > 0
          ? row.peg_reference
          : null;
      const currentBps =
        livePrice != null && pegReference != null
          ? Math.round(((livePrice - pegReference) / pegReference) * 10_000)
          : null;
      const severityBps = currentBps ?? bps;
      const severityBasis: "current" | "peak-fallback" = currentBps != null ? "current" : "peak-fallback";
      const impactScore = getDepegMarketImpactScore(severityBps, mcapUsd);
      return {
        stablecoinId: row.stablecoin_id,
        symbol: row.symbol,
        bps,
        direction,
        mcapUsd,
        startedAt: row.started_at,
        ageHours,
        impactScore,
        peakBps: row.peak_deviation_bps,
        severityBps,
        severityBasis,
        ...(currentBps != null ? { currentBps } : {}),
        ...(row.peak_price != null ? { peakPriceUsd: row.peak_price } : {}),
        ...(livePrice != null ? { currentPriceUsd: livePrice } : {}),
        suppressReason: getActiveDepegSuppressReason({ mcapUsd, ageHours, bps: severityBps }),
      };
    });
    withImpact.sort((a, b) => {
      const criticalDelta =
        Number(isCriticalDepegRisk({ bps: b.severityBps, mcapUsd: b.mcapUsd })) -
        Number(isCriticalDepegRisk({ bps: a.severityBps, mcapUsd: a.mcapUsd }));
      return criticalDelta || b.impactScore - a.impactScore || Math.abs(b.severityBps) - Math.abs(a.severityBps);
    });
    const topDepegs = withImpact
      .slice(0, ACTIVE_DEPEG_PROMPT_LIMIT)
      .map(
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
          ...(currentBps != null ? { currentBps } : {}),
          ...(peakPriceUsd != null ? { peakPriceUsd } : {}),
          ...(currentPriceUsd != null ? { currentPriceUsd } : {}),
          ...(suppressReason ? { suppressReason } : {}),
        }),
      );

    // Lifecycle review runs over the FULL open-event set, not the top-8 slice:
    // a stalled collapse must not escape review by ranking ninth.
    const lifecycleFlags = classifyDepegLifecycle(withImpact);

    return collectorOk({ activeDepegCount: withImpact.length, topDepegs, lifecycleFlags });
  } catch (error) {
    console.error("[daily-digest] Failed to query active depegs:", error);
    return collectorDegraded({ activeDepegCount: 0, topDepegs: [], lifecycleFlags: [] }, "active-depegs-query");
  }
}

export async function collectBlacklistActivity(
  ctx: CollectorContext,
): Promise<CollectorResult<DigestInputData["blacklistActivity"]>> {
  try {
    const blRows = await ctx.db
      .prepare(
        "SELECT stablecoin AS symbol, chain_name, event_type, amount_usd_at_event FROM blacklist_events WHERE timestamp >= ? AND timestamp < ? ORDER BY amount_usd_at_event DESC",
      )
      .bind(ctx.nowSec - SECONDS.ONE_DAY, ctx.nowSec)
      .all<{ symbol: string; chain_name: string; event_type: string; amount_usd_at_event: number | null }>();
    const blEvents = blRows.results ?? [];
    if (blEvents.length > 0) {
      const eventCount = blEvents.length;
      const totalAmountUsd = blEvents.reduce((sum, event) => sum + (event.amount_usd_at_event ?? 0), 0);
      const hasLargeEvent = blEvents.some((event) => (event.amount_usd_at_event ?? 0) > 10_000_000);
      if (eventCount >= 2 || hasLargeEvent) {
        return collectorOk({
          eventCount,
          totalAmountUsd,
          topEvents: blEvents
            .filter((event) => event.event_type === "blacklist" || event.event_type === "destroy")
            .slice(0, 5)
            .map((event) => ({
              symbol: event.symbol,
              chain: event.chain_name,
              type: event.event_type as "blacklist" | "destroy",
              amountUsd: event.amount_usd_at_event ?? 0,
            })),
        });
      }
    }
  } catch (error) {
    console.error("[daily-digest] Failed to query blacklist events:", error);
    return collectorDegraded(undefined, "blacklist-activity-query");
  }
  return collectorOk(undefined);
}

export async function collectSupplyVelocity(
  ctx: CollectorContext,
): Promise<CollectorResult<DigestInputData["supplyVelocity"]>> {
  try {
    const top10 = ctx.coreAggregateStablecoinAssets
      .map((coin) => ({ id: coin.id, symbol: coin.symbol, mcap: getCirculatingRaw(coin) }))
      .sort((a, b) => b.mcap - a.mcap)
      .slice(0, 10);

    if (top10.length > 0) {
      const yesterday = ctx.todayTs - SECONDS.ONE_DAY;
      const weekAgo = ctx.todayTs - 7 * SECONDS.ONE_DAY;
      const top10IdInClause = buildInClause(top10.map((coin) => coin.id));
      const supplyRows = await ctx.db
        .prepare(
          `SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history WHERE stablecoin_id IN (${top10IdInClause.sql}) AND snapshot_date IN (?, ?, ?)`,
        )
        .bind(...top10IdInClause.binds, ctx.todayTs, yesterday, weekAgo)
        .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();

      const snapMap = new Map<string, Map<number, number>>();
      for (const row of supplyRows.results ?? []) {
        let byDate = snapMap.get(row.stablecoin_id);
        if (!byDate) {
          byDate = new Map();
          snapMap.set(row.stablecoin_id, byDate);
        }
        byDate.set(row.snapshot_date, row.circulating_usd);
      }

      const velocitySignals: NonNullable<DigestInputData["supplyVelocity"]> = [];
      for (const coin of top10) {
        const byDate = snapMap.get(coin.id);
        if (!byDate) continue;
        const todayVal = byDate.get(ctx.todayTs);
        const yesterdayVal = byDate.get(yesterday);
        const weekAgoVal = byDate.get(weekAgo);
        if (todayVal == null || yesterdayVal == null || weekAgoVal == null) continue;

        const change1d = todayVal - yesterdayVal;
        const change7d = todayVal - weekAgoVal;
        const dailyAvg7d = change7d / 7;
        const directionReversed = (change1d > 0 && change7d < 0) || (change1d < 0 && change7d > 0);
        const sameDirection = (change1d > 0 && change7d > 0) || (change1d < 0 && change7d < 0);
        const velocityRatio = dailyAvg7d !== 0 ? Math.abs(change1d / dailyAvg7d) : 0;
        const hasMaterialDailyMove = Math.abs(change1d) >= 1_000_000 && Math.abs(change1d) >= coin.mcap * 0.001;
        const hasMaterialWeeklyMove = Math.abs(change7d) >= 10_000_000 && Math.abs(change7d) >= coin.mcap * 0.002;

        if (!hasMaterialDailyMove && !hasMaterialWeeklyMove) continue;

        if (
          (directionReversed && hasMaterialDailyMove) ||
          (sameDirection && velocityRatio > 2.5 && hasMaterialDailyMove) ||
          (sameDirection && velocityRatio < 0.4 && hasMaterialWeeklyMove)
        ) {
          const signal = directionReversed ? "reversed" : velocityRatio > 2.5 ? "accelerating" : "decelerating";
          velocitySignals.push({ coin: coin.symbol, change1d, change7d, signal });
        }
      }

      if (velocitySignals.length > 0) {
        return collectorOk(velocitySignals);
      }
    }
  } catch (error) {
    console.error("[daily-digest] Failed to compute supply velocity:", error);
    return collectorDegraded(undefined, "supply-velocity-query");
  }
  return collectorOk(undefined);
}

export async function collectResolvedDepegs(
  ctx: CollectorContext,
  degradedReasons?: string[],
): Promise<DigestInputData["resolvedDepegs"]> {
  try {
    const cutoff48h = ctx.nowSec - SECONDS.TWO_DAYS;
    const resolvedRows = await ctx.db
      .prepare(
        `SELECT symbol, direction, peak_deviation_bps, started_at, ended_at, stablecoin_id
         FROM depeg_events
         WHERE ended_at IS NOT NULL AND ended_at >= ?
         ORDER BY ABS(peak_deviation_bps) DESC
         LIMIT 20`,
      )
      .bind(cutoff48h)
      .all<{
        symbol: string;
        direction: "above" | "below";
        peak_deviation_bps: number;
        started_at: number;
        ended_at: number;
        stablecoin_id: string;
      }>();

    const candidates = (resolvedRows.results ?? [])
      .map((row) => {
        const mcapUsd = ctx.mcapById.get(row.stablecoin_id) ?? 0;
        return {
          stablecoinId: row.stablecoin_id,
          symbol: row.symbol,
          peakBps: Math.abs(row.peak_deviation_bps),
          direction: row.direction,
          durationHours: Math.round((row.ended_at - row.started_at) / SECONDS.ONE_HOUR),
          mcapUsd,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          impactScore: getDepegMarketImpactScore(row.peak_deviation_bps, mcapUsd),
        };
      })
      .filter((row) => row.peakBps > 100 && row.mcapUsd > 20_000_000)
      .sort((a, b) => b.impactScore - a.impactScore)
      .slice(0, 5);

    if (candidates.length > 0) {
      return candidates;
    }
  } catch (error) {
    console.error("[daily-digest] Failed to query resolved depegs:", error);
    markCollectorDegraded(degradedReasons, "resolved-depegs-query");
  }
  return undefined;
}

export async function collectMintBurnFlows(
  ctx: CollectorContext,
  degradedReasons?: string[],
): Promise<DigestInputData["mintBurnFlows"]> {
  try {
    const cutoff24h = ctx.nowSec - SECONDS.ONE_DAY;
    const cutoff30d = ctx.nowSec - 30 * SECONDS.ONE_DAY;

    const flow24hRows = await ctx.db
      .prepare(
        `SELECT stablecoin_id, chain_id,
                SUM(mint_volume_usd) as mint_24h,
                SUM(burn_volume_usd) as burn_24h,
                SUM(net_flow_usd) as net_24h
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         GROUP BY stablecoin_id, chain_id`,
      )
      .bind(cutoff24h)
      .all<{ stablecoin_id: string; chain_id: string; mint_24h: number; burn_24h: number; net_24h: number }>();

    const flow30dRows = await ctx.db
      .prepare(
        `SELECT stablecoin_id, chain_id,
                SUM(net_flow_usd) / 30.0 as avg_daily_net,
                SUM(mint_volume_usd + burn_volume_usd) / 30.0 as avg_daily_abs,
                COUNT(DISTINCT CAST(hour_ts / 86400 AS INTEGER)) as data_days
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         GROUP BY stablecoin_id, chain_id`,
      )
      .bind(cutoff30d)
      .all<{
        stablecoin_id: string;
        chain_id: string;
        avg_daily_net: number;
        avg_daily_abs: number;
        data_days: number;
      }>();

    const flow24h = new Map<string, { net_24h: number; mint_24h: number; burn_24h: number }>();
    for (const row of flow24hRows.results ?? []) {
      if (
        !ctx.coreAggregateStablecoinIds.has(row.stablecoin_id) ||
        !isCanonicalMintBurnPair(row.stablecoin_id, row.chain_id)
      )
        continue;
      const aggregate = flow24h.get(row.stablecoin_id) ?? { net_24h: 0, mint_24h: 0, burn_24h: 0 };
      aggregate.net_24h += row.net_24h;
      aggregate.mint_24h += row.mint_24h;
      aggregate.burn_24h += row.burn_24h;
      flow24h.set(row.stablecoin_id, aggregate);
    }
    const flow30d = new Map<string, { avg_daily_net: number; avg_daily_abs: number; data_days: number }>();
    for (const row of flow30dRows.results ?? []) {
      if (
        !ctx.coreAggregateStablecoinIds.has(row.stablecoin_id) ||
        !isCanonicalMintBurnPair(row.stablecoin_id, row.chain_id)
      )
        continue;
      const aggregate = flow30d.get(row.stablecoin_id) ?? { avg_daily_net: 0, avg_daily_abs: 0, data_days: 0 };
      aggregate.avg_daily_net += row.avg_daily_net;
      aggregate.avg_daily_abs += row.avg_daily_abs;
      aggregate.data_days = Math.max(aggregate.data_days, row.data_days);
      flow30d.set(row.stablecoin_id, aggregate);
    }

    const coinIntensities: FlowIntensityRow[] = [];
    let mintBurnExcluded = 0;
    for (const [id, flow24] of flow24h) {
      const flow30 = flow30d.get(id);
      if (!flow30) {
        mintBurnExcluded++;
        continue;
      }
      const coin = ctx.trackedStablecoinAssets.find((candidate) => candidate.id === id);
      if (!coin) continue;
      const intensity = computeFlowIntensity({
        currentDailyNet: flow24.net_24h,
        baselineDailyNet: flow30.avg_daily_net,
        baselineDailyAbs: flow30.avg_daily_abs,
        dataAgeDays: flow30.data_days,
        currentDailyAbs: flow24.mint_24h + flow24.burn_24h,
      });
      coinIntensities.push({
        id,
        symbol: coin.symbol,
        intensity,
        net24h: flow24.net_24h,
        mcap: getCirculatingRaw(coin),
      });
    }
    if (mintBurnExcluded > 0) {
      console.log(`[daily-digest] mint-burn: excluded ${mintBurnExcluded} coins without 30d baseline`);
    }

    const gaugeScore = computeGaugeScore(
      coinIntensities.map((coin) => ({ intensity: coin.intensity, mcap: coin.mcap })),
    );
    if (gaugeScore !== null) {
      const ftqFlows = await computeDigestMintBurnFtqFlows(ctx.db, coinIntensities);
      const { safeNet24h, riskyNet24h } = ftqFlows;
      const ftq = detectFlightToQuality({ safeNet24h, riskyNet24h });
      if (ftqFlows.kind === "unavailable") {
        markCollectorDegraded(degradedReasons, `mint-burn-ftq:${ftqFlows.reason}`);
      }
      const topPressure = coinIntensities
        .filter(
          (coin): coin is FlowIntensityRowWithIntensity => coin.intensity !== null && Math.abs(coin.intensity) > 20,
        )
        .sort((a, b) => Math.abs(b.intensity) - Math.abs(a.intensity))
        .slice(0, 3)
        .map((coin) => ({ symbol: coin.symbol, intensity: coin.intensity, net24hUsd: coin.net24h }));

      const chainTotals = new Map<string, number>();
      for (const row of flow24hRows.results ?? []) {
        if (
          !ctx.coreAggregateStablecoinIds.has(row.stablecoin_id) ||
          !isCanonicalMintBurnPair(row.stablecoin_id, row.chain_id)
        )
          continue;
        chainTotals.set(row.chain_id, (chainTotals.get(row.chain_id) ?? 0) + row.net_24h);
      }
      const topChains = [...chainTotals.entries()]
        .map(([chainId, netUsd]) => ({ chainId, netUsd }))
        .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd))
        .slice(0, 3);

      return {
        gaugeScore,
        gaugeBand: getGaugeBand(gaugeScore),
        classificationSource: ftqFlows.kind === "ok" ? "report-card-cache" : "unavailable",
        classificationReason: ftqFlows.kind === "ok" ? null : ftqFlows.reason,
        safetyScoreIdentity: ftqFlows.safetyScoreIdentity,
        flightToQuality: { active: ftq.active, safeNetUsd: safeNet24h, riskyNetUsd: riskyNet24h },
        topPressure,
        topChains,
      };
    }
  } catch (error) {
    console.error("[daily-digest] Failed to collect mint-burn flows:", error);
    markCollectorDegraded(degradedReasons, "mint-burn-flows-query");
  }
  return undefined;
}

export async function collectLiquidityShifts(
  ctx: CollectorContext,
  degradedReasons?: string[],
): Promise<DigestInputData["liquidityShifts"]> {
  try {
    const lookbackStart = ctx.yesterdayTs - 2 * SECONDS.ONE_DAY;
    const rows = await ctx.db
      .prepare(
        `SELECT h.stablecoin_id, h.liquidity_score, h.total_tvl_usd, h.snapshot_date
         FROM dex_liquidity_history h
         WHERE h.snapshot_date <= ? AND h.snapshot_date > ?
           AND h.liquidity_score IS NOT NULL
         ORDER BY h.stablecoin_id, h.snapshot_date DESC`,
      )
      .bind(ctx.yesterdayTs, lookbackStart)
      .all<{ stablecoin_id: string; liquidity_score: number; total_tvl_usd: number; snapshot_date: number }>();

    type LiqRow = (typeof rows.results)[number];
    const byId = new Map<string, { latest?: LiqRow; previous?: LiqRow }>();
    for (const row of rows.results ?? []) {
      const entry = byId.get(row.stablecoin_id) ?? {};
      if (!entry.latest) entry.latest = row;
      else if (!entry.previous) entry.previous = row;
      byId.set(row.stablecoin_id, entry);
    }

    const shifts: NonNullable<DigestInputData["liquidityShifts"]> = [];
    for (const [id, { latest, previous }] of byId) {
      if (!latest || !previous) continue;
      const delta = latest.liquidity_score - previous.liquidity_score;
      if (Math.abs(delta) < 8) continue;

      const mcapUsd = ctx.mcapById.get(id) ?? 0;
      if (mcapUsd < 10_000_000) continue;

      const coin = ctx.trackedStablecoinAssets.find((candidate) => candidate.id === id);
      if (!coin) continue;

      shifts.push({
        symbol: coin.symbol,
        currentScore: latest.liquidity_score,
        previousScore: previous.liquidity_score,
        scoreDelta: delta,
        currentTvl: latest.total_tvl_usd,
        previousTvl: previous.total_tvl_usd,
        mcapUsd,
      });
    }

    shifts.sort((a, b) => Math.abs(b.scoreDelta) * b.mcapUsd - Math.abs(a.scoreDelta) * a.mcapUsd);
    return shifts.length > 0 ? shifts.slice(0, 5) : undefined;
  } catch (error) {
    console.error("[daily-digest] Failed to collect liquidity shifts:", error);
    markCollectorDegraded(degradedReasons, "liquidity-shifts-query");
  }
  return undefined;
}
