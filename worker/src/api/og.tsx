import * as React from "react";
import satori, { init as initSatori } from "satori/standalone";
import yogaWasm from "satori/yoga.wasm";
import { Resvg, initResvg, resvgWasmModule } from "@cf-wasm/resvg/workerd";
import { OG_FONTS } from "../lib/og-fonts";
import { StablecoinCard, type StablecoinCardData } from "../lib/og-templates/stablecoin-card";
import { SafetyScoresCard, type SafetyScoresCardData } from "../lib/og-templates/safety-scores-card";
import { DepegCard, type DepegCardData } from "../lib/og-templates/depeg-card";
import { StabilityIndexCard, type StabilityIndexCardData } from "../lib/og-templates/stability-index-card";
import { resolveOrReject } from "../lib/api-utils";
import { loadDexLiquidityMap } from "../lib/dex-liquidity";
import { getConditionBand } from "../lib/stability-index";
import { sumPegBuckets } from "@shared/lib/supply";
import { ACTIVE_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadReportCardCache } from "../lib/report-card-cache";
import { derivePegAnalyticsSnapshot } from "../lib/peg-analytics";
import { scoreToGrade } from "@shared/lib/report-cards";

// ---------------------------------------------------------------------------
// WASM singleton initialization (yoga for satori + resvg for SVG→PNG)
// ---------------------------------------------------------------------------

let wasmInitialized = false;

async function ensureWasm(): Promise<void> {
  if (!wasmInitialized) {
    const errors: unknown[] = [];

    // Initialize yoga WASM for satori layout engine
    try {
      await initSatori(yogaWasm);
    } catch (e: unknown) {
      // Ignore if already initialized in this isolate
      if (!(e instanceof Error && e.message.includes("already"))) {
        errors.push(e);
      }
    }

    // Initialize resvg WASM for SVG→PNG rendering
    try {
      await initResvg(resvgWasmModule);
    } catch (e: unknown) {
      // @cf-wasm/resvg throws if already initialized in this isolate
      if (!(e instanceof Error && e.message.includes("already called"))) {
        errors.push(e);
      }
    }

    if (errors.length > 0) {
      throw errors[0];
    }
    wasmInitialized = true;
  }
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const OG_WIDTH = 1200;
const OG_HEIGHT = 628;
const CACHE_HEADERS = {
  "Content-Type": "image/png",
  "Cache-Control": "public, max-age=900, s-maxage=900",
};

// ---------------------------------------------------------------------------
// SVG → PNG render pipeline
// ---------------------------------------------------------------------------

async function renderPng(element: React.ReactNode): Promise<Uint8Array> {
  await ensureWasm();

  const svg = await satori(element, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: OG_FONTS,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OG_WIDTH },
  });
  const rendered = resvg.render();
  return rendered.asPng();
}

interface StablecoinOgCoinInput {
  name: string;
  symbol: string;
  price?: number | null;
  circulating: Record<string, number>;
  circulatingPrevWeek?: Record<string, number> | null;
}

interface StablecoinOgSignalsInput {
  coin: StablecoinOgCoinInput;
  dexLiquidityScore: number | null;
  dewsBand: string | null | undefined;
  grade: string | null | undefined;
  sparklineRows: Array<{ price: number }>;
  hasActiveDepeg: boolean;
  flow7d: number | null | undefined;
  pegScore: number | null;
  backing: string;
  governance: string;
  redemptionScore: number | null;
  change24h: number | null;
}

export function deriveStablecoinOgCardData({
  coin,
  dexLiquidityScore,
  dewsBand,
  grade,
  sparklineRows,
  hasActiveDepeg,
  flow7d,
  pegScore,
  backing,
  governance,
  redemptionScore,
  change24h,
}: StablecoinOgSignalsInput): StablecoinCardData {
  const pegPrice = coin.price ?? 1;
  const mcap = sumPegBuckets(coin.circulating);
  const prevWeekMcap = sumPegBuckets(coin.circulatingPrevWeek ?? undefined);
  const sparklineData = sparklineRows.map((row) => row.price).reverse();

  return {
    name: coin.name,
    symbol: coin.symbol,
    grade: grade ?? "NR",
    pegPrice,
    dewsBand: dewsBand ?? "CALM",
    liquidityScore: dexLiquidityScore ?? 0,
    mcap,
    vol24h: null,
    flow7d: flow7d ?? (mcap - prevWeekMcap),
    sparklineData: sparklineData.length >= 2 ? sparklineData : [pegPrice, pegPrice],
    hasActiveDepeg,
    pegScore,
    backing,
    governance,
    redemptionScore,
    change24h,
    lastUpdated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  };
}

// ---------------------------------------------------------------------------
// /api/og/stablecoin/:id
// ---------------------------------------------------------------------------

async function handleStablecoinOg(db: D1Database, coinId: string): Promise<Response> {
  const resolved = resolveOrReject(coinId);
  if (resolved instanceof Response) {
    return new Response("Unknown stablecoin", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  const id = resolved.canonicalId;

  if (!ACTIVE_IDS.has(id)) {
    return new Response("Unknown stablecoin", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  // Parallel queries: stablecoins cache, dex liquidity, DEWS, report card, 7d price sparkline,
  // active depeg, 7d flow, and 24h price change.
  const [
    stablecoinsPayload,
    dexLiqMap,
    dewsRow,
    reportCardRow,
    sparklineRows,
    activeDepegRow,
    flowRow,
    price24hRow,
  ] = await Promise.all([
    loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false }),
    loadDexLiquidityMap(db),
    db
      .prepare(
        "SELECT score, band FROM stress_signals WHERE stablecoin_id = ? ORDER BY computed_at DESC LIMIT 1",
      )
      .bind(id)
      .first<{ score: number; band: string }>(),
    loadReportCardCache(db).then((result) => (result.kind === "ok" ? result.payload.scores?.[id] ?? null : null)),
    db
      .prepare(
        "SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 7",
      )
      .bind(id)
      .all<{ price: number }>(),
    db
      .prepare(
        "SELECT id FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL LIMIT 1",
      )
      .bind(id)
      .first<{ id: number }>(),
    db
      .prepare(
        `SELECT SUM(net_flow_usd) as net_flow
         FROM mint_burn_hourly
         WHERE stablecoin_id = ? AND hour_ts >= ?`,
      )
      .bind(id, Math.floor(Date.now() / 1000) - 7 * 86400)
      .first<{ net_flow: number | null }>(),
    db
      .prepare(
        `SELECT 
          (SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1) as current_price,
          (SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1 OFFSET 1) as prev_day_price`,
      )
      .bind(id, id)
      .first<{ current_price: number; prev_day_price: number }>(),
  ]);

  if (!hasUsableStablecoinsPayload(stablecoinsPayload)) {
    return new Response("Data not yet available", { status: 503, headers: { "Content-Type": "text/plain" } });
  }

  const { peggedAssets, fxFallbackRates } = stablecoinsPayload.payload;
  const coin = peggedAssets.find((a) => a.id === id);
  if (!coin) {
    return new Response("Stablecoin not found in cache", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const methodologyAsOf =
    typeof stablecoinsPayload.updatedAt === "number"
      ? stablecoinsPayload.updatedAt
      : Math.floor(Date.now() / 1000);
  const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
    peggedAssets,
    fxFallbackRates,
    methodologyAsOf,
    includeNavTokens: false,
  });
  const meta = TRACKED_META_BY_ID.get(id);
  const liq = dexLiqMap[id];

  // Calculate 24h price change
  let change24h: number | null = null;
  if (price24hRow?.current_price && price24hRow?.prev_day_price) {
    change24h = ((price24hRow.current_price - price24hRow.prev_day_price) / price24hRow.prev_day_price) * 100;
  }

  const data = deriveStablecoinOgCardData({
    coin,
    dexLiquidityScore: liq?.liquidityScore ?? null,
    dewsBand: dewsRow?.band,
    grade: reportCardRow?.grade,
    sparklineRows: sparklineRows.results ?? [],
    hasActiveDepeg: activeDepegRow !== null,
    flow7d: flowRow?.net_flow,
    pegScore: pegAnalytics.pegDataById.get(id)?.pegScore ?? null,
    backing: meta?.flags.backing ?? "rwa-backed",
    governance: meta?.flags.governance ?? "centralized",
    redemptionScore: null, // Not available in current cache schema
    change24h,
  });

  const png = await renderPng(<StablecoinCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// /api/og/safety-scores
// ---------------------------------------------------------------------------

async function handleSafetyScoresOg(db: D1Database): Promise<Response> {
  const stablecoinsPayload = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });

  const gradeDistribution: Record<string, number> = {
    "A+": 0, A: 0, "A-": 0,
    "B+": 0, B: 0, "B-": 0,
    "C+": 0, C: 0, "C-": 0,
    D: 0, F: 0, NR: 0,
  };

  let pulseScore = 0;
  let ratedCount = 0;
  let totalCoins = ACTIVE_IDS.size;

  // For top/bottom performers and trend
  const allScores: Array<{ symbol: string; grade: string; score: number }> = [];
  let weekAgoScore: number | null = null;

  const reportCardCache = await loadReportCardCache(db);
  if (reportCardCache.kind === "ok") {
    // Get current scores
    for (const [id, entry] of Object.entries(reportCardCache.payload.scores)) {
      const grade = entry.grade;
      if (grade in gradeDistribution) {
        gradeDistribution[grade]++;
      } else {
        gradeDistribution["NR"]++;
      }
      if (entry.grade !== "NR") {
        pulseScore += entry.score;
        ratedCount++;
        
        // Build list for top/bottom performers
        const meta = stablecoinsPayload.kind === "ok" 
          ? stablecoinsPayload.payload.peggedAssets.find(a => a.id === id)
          : undefined;
        if (meta) {
          allScores.push({
            symbol: meta.symbol,
            grade,
            score: entry.score,
          });
        }
      }
    }
    
    // Get week-ago pulse score for trend (approximate from snapshots if available)
    // For now, use a simple approximation or set to null
    weekAgoScore = null;
  }

  if (hasUsableStablecoinsPayload(stablecoinsPayload)) {
    totalCoins = stablecoinsPayload.payload.peggedAssets.length;
  }

  const avgScore = ratedCount > 0 ? pulseScore / ratedCount : 0;
  const pulseGrade = ratedCount > 0 ? scoreToGrade(Math.round(avgScore)) : "NR";

  // Sort for top/bottom performers
  const sortedByScore = [...allScores].sort((a, b) => b.score - a.score);
  const topPerformers = sortedByScore.slice(0, 3);
  const bottomPerformers = sortedByScore.slice(-3).reverse();

  // Calculate trend (week over week change)
  const trend = weekAgoScore !== null ? ((avgScore - weekAgoScore) / weekAgoScore) * 100 : null;

  const data: SafetyScoresCardData = {
    gradeDistribution,
    pulseGrade,
    pulseScore: avgScore,
    coverageRatio: totalCoins > 0 ? ratedCount / totalCoins : 0,
    totalCoins,
    topPerformers,
    bottomPerformers,
    trend,
    lastUpdated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  };

  const png = await renderPng(<SafetyScoresCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// /api/og/depeg
// ---------------------------------------------------------------------------

async function handleDepegOg(db: D1Database): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 86400;

  const [activeDepegsResult, psiRow, stressRows, activeDepegsDetails, recoveredTodayResult, newTodayResult] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) as count FROM depeg_events WHERE ended_at IS NULL")
      .first<{ count: number }>(),
    db
      .prepare("SELECT score, band FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ score: number; band: string }>(),
    db
      .prepare(
        `SELECT s.band
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{ band: string }>(),
    // New: Get active depeg details
    db
      .prepare(
        `SELECT stablecoin_id, symbol, peak_deviation_bps
         FROM depeg_events
         WHERE ended_at IS NULL
         ORDER BY ABS(peak_deviation_bps) DESC
         LIMIT 5`
      )
      .all<{ stablecoin_id: string; symbol: string; peak_deviation_bps: number }>(),
    // New: Count recovered in last 24h
    db
      .prepare(
        `SELECT COUNT(*) as count FROM depeg_events 
         WHERE ended_at IS NOT NULL AND ended_at > ?`
      )
      .bind(oneDayAgo)
      .first<{ count: number }>(),
    // New: Count new in last 24h
    db
      .prepare(
        `SELECT COUNT(*) as count FROM depeg_events 
         WHERE started_at > ?`
      )
      .bind(oneDayAgo)
      .first<{ count: number }>(),
  ]);

  const dewsDistribution = { danger: 0, alert: 0, warning: 0, normal: 0 };
  let totalCoins = 0;
  for (const row of stressRows.results ?? []) {
    totalCoins++;
    switch (row.band) {
      case "DANGER":
        dewsDistribution.danger++;
        break;
      case "ALERT":
        dewsDistribution.alert++;
        break;
      case "WARNING":
        dewsDistribution.warning++;
        break;
      default:
        dewsDistribution.normal++;
        break;
    }
  }

  const activeDepegCount = activeDepegsResult?.count ?? 0;
  const coinsAtPeg = totalCoins - activeDepegCount;

  // Format active depegs for display
  const activeDepegs = (activeDepegsDetails.results ?? []).map(row => ({
    symbol: row.symbol,
    name: TRACKED_META_BY_ID.get(row.stablecoin_id)?.name ?? row.symbol,
    deviationBps: row.peak_deviation_bps,
  }));

  const data: DepegCardData = {
    activeDepegCount,
    psiScore: psiRow?.score ?? 0,
    psiBand: psiRow?.band ?? "BEDROCK",
    coinsAtPeg: Math.max(0, coinsAtPeg),
    totalCoins,
    dewsDistribution,
    activeDepegs,
    recoveredToday: recoveredTodayResult?.count ?? 0,
    newToday: newTodayResult?.count ?? 0,
    lastUpdated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  };

  const png = await renderPng(<DepegCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// /api/og/stability-index
// ---------------------------------------------------------------------------

async function handleStabilityIndexOg(db: D1Database): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 86400;

  const [
    latestSample, 
    avg24hRow, 
    avg7dRow,
    historyRows,
    athRow,
    atlRow,
  ] = await Promise.all([
    db
      .prepare("SELECT score, band, stored_at FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ score: number; band: string; stored_at: number }>(),
    db
      .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?")
      .bind(now - 86400)
      .first<{ avg: number | null }>(),
    // New: 7-day average
    db
      .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?")
      .bind(sevenDaysAgo)
      .first<{ avg: number | null }>(),
    db
      .prepare("SELECT score FROM stability_index ORDER BY computed_at DESC LIMIT 14")
      .all<{ score: number }>(),
    // New: All-time high
    db
      .prepare("SELECT MAX(score) as max FROM stability_index_samples")
      .first<{ max: number | null }>(),
    // New: All-time low
    db
      .prepare("SELECT MIN(score) as min FROM stability_index_samples")
      .first<{ min: number | null }>(),
  ]);

  const psiScore = latestSample?.score ?? 0;
  const psiBand = latestSample?.band ?? getConditionBand(psiScore);
  const avg24h = avg24hRow?.avg ?? psiScore;
  const delta24h = psiScore - avg24h;
  const avg7d = avg7dRow?.avg ?? psiScore;

  // Build sparkline from daily history (newest first → reverse for chronological)
  const sparklineData = (historyRows.results ?? []).map((r) => r.score).reverse();
  if (sparklineData.length < 2) {
    sparklineData.push(psiScore, psiScore);
  }

  const allBands: Array<{ name: string; active: boolean }> = [
    "BEDROCK",
    "STEADY",
    "TREMOR",
    "FRACTURE",
    "CRISIS",
    "MELTDOWN",
  ].map((name) => ({ name, active: name === psiBand }));

  const data: StabilityIndexCardData = {
    psiScore,
    psiBand,
    delta24h: Math.round(delta24h * 100) / 100,
    sparklineData,
    bands: allBands,
    avg7d,
    allTimeHigh: athRow?.max ?? psiScore,
    allTimeLow: atlRow?.min ?? psiScore,
    flightToQuality: false,
    flightIntensity: null,
    lastUpdated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  };

  const png = await renderPng(<StabilityIndexCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// Main OG route dispatcher
// ---------------------------------------------------------------------------

const STABLECOIN_OG_PATTERN = /^\/api\/og\/stablecoin\/(.+)$/;

export async function handleOg(db: D1Database, path: string): Promise<Response | null> {
  try {
    // /api/og/stablecoin/:id
    const stablecoinMatch = path.match(STABLECOIN_OG_PATTERN);
    if (stablecoinMatch) {
      let coinId: string;
      try {
        coinId = decodeURIComponent(stablecoinMatch[1]);
      } catch {
        return new Response("Malformed URI", { status: 400, headers: { "Content-Type": "text/plain" } });
      }
      return await handleStablecoinOg(db, coinId);
    }

    // /api/og/safety-scores
    if (path === "/api/og/safety-scores") {
      return await handleSafetyScoresOg(db);
    }

    // /api/og/depeg
    if (path === "/api/og/depeg") {
      return await handleDepegOg(db);
    }

    // /api/og/stability-index
    if (path === "/api/og/stability-index") {
      return await handleStabilityIndexOg(db);
    }

    return null;
  } catch (err) {
    console.error("[og] Render error:", err);
    return new Response("OG image generation failed", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
