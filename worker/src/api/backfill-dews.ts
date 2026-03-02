import { withErrorHandler, errorResponse, jsonResponse } from "../lib/api-utils";
import { requireAdmin } from "../lib/auth";
import { computeDEWS } from "../lib/dews";
import type { DEWSInput } from "../lib/dews";

interface DepegEvent {
  stablecoin_id: string;
  started_at: number;
  ended_at: number | null;
  peak_deviation_bps: number | null;
}

interface EventResult {
  stablecoinId: string;
  startedAt: number;
  peakBps: number | null;
  preDepegScores: { daysBeforeDepeg: number; score: number; band: string }[];
  predicted: boolean; // ALERT+ before depeg start
  leadTimeDays: number | null;
}

export const handleBackfillDEWS = withErrorHandler(
  "backfill-dews",
  async (db: D1Database, _url: URL, adminKey?: string, request?: Request): Promise<Response> => {
    const authError = await requireAdmin(request, adminKey);
    if (authError) return authError;

    // Load completed depeg events
    const events = await db
      .prepare(
        "SELECT stablecoin_id, started_at, ended_at, peak_deviation_bps FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at ASC",
      )
      .all<DepegEvent>();

    if (!events.results.length) {
      return errorResponse(404, "No completed depeg events found");
    }

    // Load supply_history for reconstructing historical inputs
    const supplyRows = await db
      .prepare("SELECT stablecoin_id, snapshot_date, circulating FROM supply_history ORDER BY snapshot_date ASC")
      .all<{ stablecoin_id: string; snapshot_date: number; circulating: number }>();

    // Index supply by coin+date
    const supplyIndex = new Map<string, Map<number, number>>();
    for (const row of supplyRows.results) {
      if (!supplyIndex.has(row.stablecoin_id)) supplyIndex.set(row.stablecoin_id, new Map());
      supplyIndex.get(row.stablecoin_id)!.set(row.snapshot_date, row.circulating);
    }

    // Load dex_liquidity_history for historical liquidity scores
    const liqRows = await db
      .prepare("SELECT stablecoin_id, date, score, tvl FROM dex_liquidity_history ORDER BY date ASC")
      .all<{ stablecoin_id: string; date: number; score: number; tvl: number }>();

    const liqIndex = new Map<string, { date: number; score: number; tvl: number }[]>();
    for (const row of liqRows.results) {
      if (!liqIndex.has(row.stablecoin_id)) liqIndex.set(row.stablecoin_id, []);
      liqIndex.get(row.stablecoin_id)!.push(row);
    }

    const DAY = 86400;
    const results: EventResult[] = [];
    let tpCount = 0;
    let totalLeadTimeDays = 0;
    let leadTimeCount = 0;

    for (const event of events.results) {
      const coinSupply = supplyIndex.get(event.stablecoin_id);
      const coinLiq = liqIndex.get(event.stablecoin_id) ?? [];
      const preDepegScores: EventResult["preDepegScores"] = [];
      let predicted = false;
      let leadTimeDays: number | null = null;

      // Check 7 days before the depeg event
      for (let d = 7; d >= 0; d--) {
        const targetDay = event.started_at - d * DAY;
        const dayMidnight = Math.floor(targetDay / DAY) * DAY;

        // Reconstruct supply
        const current = coinSupply?.get(dayMidnight) ?? 0;
        const prevDay = coinSupply?.get(dayMidnight - DAY) ?? current;
        const prevWeek = coinSupply?.get(dayMidnight - 7 * DAY) ?? current;

        if (current <= 0) continue;

        // Find closest liquidity data
        const liqNow = coinLiq.find((l) => Math.abs(l.date - dayMidnight) < 2 * DAY);
        const liq7d = coinLiq.find(
          (l) => Math.abs(l.date - (dayMidnight - 7 * DAY)) < 2 * DAY,
        );

        const input: DEWSInput = {
          stablecoinId: event.stablecoin_id,
          mcapUsd: current,
          pegType: "peggedUSD", // most depeg events are USD pegs
          circulatingCurrent: current,
          circulatingPrevDay: prevDay,
          circulatingPrevWeek: prevWeek,
          weightedBalanceRatio: null,
          avgPoolStress: null,
          topPools: null,
          liquidityScore: liqNow?.score ?? null,
          liquidityScore7dAgo: liq7d?.score ?? null,
          tvlCurrent: liqNow?.tvl ?? null,
          tvl7dAgo: liq7d?.tvl ?? null,
          priceConfidence: null,
          prevPriceConfidence: null,
          price: null, // historical price not available in supply_history
          pegRef: 1.0,
          dexPriceUsd: null,
          blacklistEvents24h: 0,
          blacklistEvents7d: 0,
          hasBlacklistTracking: false,
          burnVolume24hUsd: null,
          mintVolume24hUsd: null,
          burnBaseline30dUsd: null,
          flowDataAgeDays: 0,
          yieldWarnings: [],
          psiScore: null,
        };

        const result = computeDEWS(input);
        preDepegScores.push({
          daysBeforeDepeg: d,
          score: result.score,
          band: result.band,
        });

        // Check if ALERT+ was reached before the depeg
        if (
          d > 0 &&
          !predicted &&
          (result.band === "ALERT" || result.band === "WARNING" || result.band === "DANGER")
        ) {
          predicted = true;
          leadTimeDays = d;
        }
      }

      if (predicted) {
        tpCount++;
        if (leadTimeDays !== null) {
          totalLeadTimeDays += leadTimeDays;
          leadTimeCount++;
        }
      }

      results.push({
        stablecoinId: event.stablecoin_id,
        startedAt: event.started_at,
        peakBps: event.peak_deviation_bps,
        preDepegScores,
        predicted,
        leadTimeDays,
      });
    }

    const totalEvents = results.length;
    const tpRate = totalEvents > 0 ? Math.round((tpCount / totalEvents) * 100) : 0;
    const avgLeadTime = leadTimeCount > 0 ? Math.round((totalLeadTimeDays / leadTimeCount) * 10) / 10 : null;

    return jsonResponse({
      summary: {
        totalEvents,
        truePositives: tpCount,
        tpRate: `${tpRate}%`,
        avgLeadTimeDays: avgLeadTime,
        note: "Backtest uses supply_history + dex_liquidity_history only. Pool balance, price confidence, blacklist, and flow signals are unavailable for historical data.",
      },
      events: results,
    });
  },
);
