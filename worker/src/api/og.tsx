import { logWorkerEventArgs } from "../lib/structured-log";
import * as React from "react";
import satori, { init as initSatori } from "satori/standalone";
import yogaWasm from "satori/yoga.wasm";
import { Resvg, initResvg, resvgWasmModule } from "@cf-wasm/resvg/workerd";
import { OG_FONTS } from "../lib/og-fonts";
import { StablecoinCard, type StablecoinCardData } from "../lib/og-templates/stablecoin-card";
import { SafetyScoresCard, type SafetyScoresCardData } from "../lib/og-templates/safety-scores-card";
import { DepegCard, type DepegCardData } from "../lib/og-templates/depeg-card";
import { StabilityIndexCard, type StabilityIndexCardData } from "../lib/og-templates/stability-index-card";
import { ChainCard, type ChainCardData } from "../lib/og-templates/chain-card";
import { isActiveChainAggregateAsset } from "./chains";
import { aggregateChains } from "@shared/lib/chain-aggregator";
import { ratioToPercentage } from "@shared/lib/stats";
import { derivePegRates } from "@shared/lib/peg-rates";
import { CHAIN_META } from "@shared/lib/chains";
import { resolveOrReject } from "../lib/api-utils";
import { loadDexLiquidityMap } from "../lib/dex-liquidity";
import { getConditionBand } from "../lib/stability-index";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { ACTIVE_IDS, FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import { derivePegAnalyticsSnapshot } from "../lib/peg-analytics";
import { loadPegAnalyticsCache } from "../lib/peg-analytics-cache";
import { API_CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getVariantDisplay } from "@shared/lib/variant-display";
import type { BackingType } from "@shared/types";
import { loadActiveSafetyScoreSource } from "../lib/safety-score-active-source";
import { isSafetyScoreV9SnapshotFresh } from "../lib/safety-score-v9-consumer-freshness";

// ---------------------------------------------------------------------------
// WASM singleton initialization (yoga for satori + resvg for SVG→PNG)
// ---------------------------------------------------------------------------

// Intentional per-isolate cache — WASM init runs once per Worker isolate; module-scope `let` is the documented exception. See docs/worker-infrastructure.md.
let wasmInitialization: Promise<void> | null = null;

/** @internal Reset isolate-local WASM initialization so test files can share a process. */
export function resetOgWasmInitializationForTests(): void {
  wasmInitialization = null;
}

async function ensureWasm(): Promise<void> {
  if (!wasmInitialization) {
    wasmInitialization = (async () => {
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
    })().catch((error) => {
      wasmInitialization = null;
      throw error;
    });
  }
  await wasmInitialization;
}

function nowUtcLabel(): string {
  return `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const OG_WIDTH = 1200;
const OG_HEIGHT = 628;
const CACHE_HEADERS = {
  "Content-Type": "image/png",
  "Cache-Control": API_CACHE_PROFILES.ogImage,
};

function ogErrorResponse(msg: string, status: number, extra?: Record<string, string>): Response {
  return new Response(msg, {
    status,
    headers: { "Content-Type": "text/plain", ...extra },
  });
}

function ogDataNotYetAvailable(): Response {
  return ogErrorResponse("Data not yet available", 503, {
    "Retry-After": "60",
    "Cache-Control": "no-store",
  });
}

interface OgSafetyScoreEntry {
  score: number | null;
  grade: string;
}

type OgSafetyScoreSource =
  | {
      kind: "ok";
      model: "v9";
      methodologyVersion: string;
      expectedCount: number;
      scores: Record<string, OgSafetyScoreEntry>;
    }
  | {
      kind: "error";
      reason: string;
    };

async function loadOgSafetyScoreSource(db: D1Database): Promise<OgSafetyScoreSource> {
  const active = await loadActiveSafetyScoreSource(db);
  if (active.kind === "error") {
    return {
      kind: "error",
      reason: active.reason,
    };
  }

  if (!isSafetyScoreV9SnapshotFresh(active.snapshot)) {
    return {
      kind: "error",
      reason: "stale-cache",
    };
  }
  return {
    kind: "ok",
    model: "v9",
    methodologyVersion: active.snapshot.safetyScoreIdentity.methodologyVersion,
    expectedCount: active.snapshot.completeness.expectedCount,
    scores: Object.fromEntries(
      active.snapshot.cards.map((card) => [
        card.id,
        { score: card.score, grade: card.grade },
      ]),
    ),
  };
}

function safetyScoreOgPresentation(
  safetySource: OgSafetyScoreSource,
): { lastUpdated: string; headers: Record<string, string> } {
  if (safetySource.kind === "ok") {
    return {
      lastUpdated: `${safetySource.model.toUpperCase()} ${safetySource.methodologyVersion}`,
      headers: {
        ...CACHE_HEADERS,
        "X-Safety-Score-Model": safetySource.model,
        "X-Safety-Score-Status": "current",
      },
    };
  }

  return {
    lastUpdated: "DEGRADED: V9 safety score unavailable",
    headers: {
      // Keep degraded OG renders edge-cacheable: /api/og/* is public and
      // unauthenticated, and rendering each miss runs the WASM PNG pipeline.
      // The explicit degraded headers keep consumers from treating the image as
      // current safety-score evidence while avoiding no-store render amplification.
      ...CACHE_HEADERS,
      "X-Safety-Score-Model": "v9",
      "X-Safety-Score-Status": "degraded",
      "X-Safety-Score-Reason": safetySource.reason,
    },
  };
}

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
  backing: BackingType;
  governance: string;
  redemptionScore: number | null;
  change24h: number | null;
  variantLabel?: string | null;
  variantParentSymbol?: string | null;
  isFrozen?: boolean;
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
  variantLabel,
  variantParentSymbol,
  isFrozen,
}: StablecoinOgSignalsInput): StablecoinCardData {
  const pegPrice = coin.price ?? 1;
  const mcap = getCirculatingRaw(coin);
  const prevWeekMcap = getPrevWeekRaw(coin);
  const sparklineData = sparklineRows.map((row) => row.price).reverse();

  return {
    name: coin.name,
    symbol: coin.symbol,
    grade: grade ?? "NR",
    pegPrice,
    dewsBand: dewsBand ?? "CALM",
    liquidityScore: dexLiquidityScore ?? 0,
    mcap,
    flow7d: flow7d ?? (mcap - prevWeekMcap),
    sparklineData: sparklineData.length >= 2 ? sparklineData : [pegPrice, pegPrice],
    hasActiveDepeg,
    pegScore,
    backing,
    governance,
    redemptionScore,
    change24h,
    variantLabel: variantLabel ?? null,
    variantParentSymbol: variantParentSymbol ?? null,
    isFrozen: isFrozen ?? false,
    lastUpdated: nowUtcLabel(),
  };
}

// ---------------------------------------------------------------------------
// /api/og/stablecoin/:id
// ---------------------------------------------------------------------------

async function handleStablecoinOg(db: D1Database, coinId: string): Promise<Response> {
  const resolved = resolveOrReject(coinId);
  if (resolved instanceof Response) {
    return ogErrorResponse("Unknown stablecoin", 404);
  }
  const id = resolved.canonicalId;

  const isFrozen = FROZEN_IDS.has(id);

  // Parallel queries: stablecoins cache, dex liquidity, DEWS, report card, 7d price sparkline,
  // active depeg, 7d flow, and 24h price change.
  const [
    stablecoinsPayload,
    dexLiqMap,
    dewsRow,
    safetySource,
    sparklineRows,
    activeDepegRow,
    flowRow,
    price24hRow,
  ] = await Promise.all([
    loadStablecoinsCache(db, {
      mode: "strict",
      contract: "published",
    }),
    loadDexLiquidityMap(db),
    db
      .prepare(
        "SELECT score, band FROM stress_signals WHERE stablecoin_id = ? ORDER BY computed_at DESC LIMIT 1",
      )
      .bind(id)
      .first<{ score: number; band: string }>(),
    loadOgSafetyScoreSource(db),
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
      .bind(id, Math.floor(Date.now() / 1000) - 7 * DAY_SECONDS)
      .first<{ net_flow: number | null }>(),
    db
      .prepare(
        `WITH current_snapshot AS (
          SELECT price, snapshot_date
          FROM supply_history
          WHERE stablecoin_id = ? AND price IS NOT NULL
          ORDER BY snapshot_date DESC
          LIMIT 1
        )
        SELECT
          current_snapshot.price as current_price,
          (
            SELECT price
            FROM supply_history
            WHERE stablecoin_id = ?
              AND price IS NOT NULL
              AND snapshot_date <= current_snapshot.snapshot_date - ?
            ORDER BY snapshot_date DESC
            LIMIT 1
          ) as prev_day_price
        FROM current_snapshot`,
      )
      .bind(id, id, DAY_SECONDS)
      .first<{ current_price: number; prev_day_price: number | null }>(),
  ]);

  if (!hasUsableStablecoinsPayload(stablecoinsPayload)) {
    return ogDataNotYetAvailable();
  }

  const { peggedAssets, fxFallbackRates } = stablecoinsPayload.payload;
  const coin = peggedAssets.find((a) => a.id === id);
  if (!coin) {
    return ogErrorResponse("Stablecoin not found in cache", 404);
  }

  const meta = TRACKED_META_BY_ID.get(id);
  const reportCardRow = safetySource.kind === "ok"
    ? safetySource.scores[id] ?? null
    : null;

  // Cache-first: only pegScore is needed here, and the direct compute
  // re-scans ~21K depeg_events rows per render. The cache is published every
  // 15 minutes by the report-cards pass. The published cache is nav-inclusive
  // (it also serves peg-summary) while the fallback compute excludes nav
  // tokens, so force null for nav tokens to keep both branches in agreement.
  let pegScore: number | null = null;
  const pegAnalyticsCache = await loadPegAnalyticsCache(db).catch(() => null);
  if (pegAnalyticsCache && pegAnalyticsCache.kind === "ok") {
    pegScore = meta?.flags.navToken === true
      ? null
      : pegAnalyticsCache.pegDataById.get(id)?.pegScore ?? null;
  } else {
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
    pegScore = pegAnalytics.pegDataById.get(id)?.pegScore ?? null;
  }
  const liq = dexLiqMap[id];
  const variantLabel = meta?.variantKind ? getVariantDisplay(meta.variantKind).shortLabel : null;
  const variantParentSymbol = meta?.variantOf
    ? (TRACKED_META_BY_ID.get(meta.variantOf)?.symbol ?? meta.variantOf)
    : null;

  // Calculate 24h price change
  let change24h: number | null = null;
  if (price24hRow?.current_price && price24hRow?.prev_day_price) {
    change24h = ((price24hRow.current_price - price24hRow.prev_day_price) / price24hRow.prev_day_price) * 100;
  }

  const safetyPresentation = safetyScoreOgPresentation(safetySource);
  const data = {
    ...deriveStablecoinOgCardData({
      coin,
      dexLiquidityScore: liq?.liquidityScore ?? null,
      dewsBand: dewsRow?.band,
      grade: reportCardRow?.grade,
      sparklineRows: sparklineRows.results ?? [],
      hasActiveDepeg: activeDepegRow !== null,
      flow7d: flowRow?.net_flow,
      pegScore,
      backing: meta?.flags.backing ?? "rwa-backed",
      governance: meta?.flags.governance ?? "centralized",
      redemptionScore: null, // Not available in current cache schema
      change24h,
      variantLabel,
      variantParentSymbol,
      isFrozen,
    }),
    safetyModel: safetySource.kind === "ok" ? safetySource.model : null,
    lastUpdated: safetyPresentation.lastUpdated,
  };

  const png = await renderPng(<StablecoinCard data={data} />);
  return new Response(png, { headers: safetyPresentation.headers });
}

// ---------------------------------------------------------------------------
// /api/og/safety-scores
// ---------------------------------------------------------------------------

async function handleSafetyScoresOg(db: D1Database): Promise<Response> {
  const [stablecoinsPayload, safetySource] = await Promise.all([
    loadStablecoinsCache(db, {
      mode: "strict",
      contract: "published",
    }),
    loadOgSafetyScoreSource(db),
  ]);

  const gradeDistribution: Record<string, number> = {
    "A+": 0, A: 0, "A-": 0,
    "B+": 0, B: 0, "B-": 0,
    "C+": 0, C: 0, "C-": 0,
    D: 0, F: 0, NR: 0,
  };

  let pulseScore = 0;
  let ratedCount = 0;
  const allScores: Array<{ symbol: string; grade: string; score: number }> = [];

  const symbolById = new Map<string, string>();
  const payloadUsable = hasUsableStablecoinsPayload(stablecoinsPayload);
  if (payloadUsable) {
    for (const asset of stablecoinsPayload.payload.peggedAssets) {
      symbolById.set(asset.id, asset.symbol);
    }
  }
  const totalCoins = safetySource.kind === "ok"
    ? safetySource.expectedCount
    : payloadUsable
      ? stablecoinsPayload.payload.peggedAssets.length
      : ACTIVE_IDS.size;

  if (safetySource.kind === "ok") {
    for (const [id, entry] of Object.entries(safetySource.scores)) {
      const grade = entry.grade;
      if (grade in gradeDistribution) {
        gradeDistribution[grade]++;
      } else {
        gradeDistribution["NR"]++;
      }
      if (entry.grade !== "NR" && entry.score !== null) {
        pulseScore += entry.score;
        ratedCount++;
        const symbol = symbolById.get(id) ?? TRACKED_META_BY_ID.get(id)?.symbol;
        if (symbol) {
          allScores.push({ symbol, grade, score: entry.score });
        }
      }
    }
  }

  const avgScore = ratedCount > 0 ? pulseScore / ratedCount : null;

  allScores.sort((a, b) => b.score - a.score);
  const topPerformers = allScores.slice(0, 3);
  const bottomPerformers = allScores.slice(-3).reverse();

  const safetyPresentation = safetyScoreOgPresentation(safetySource);
  const data: SafetyScoresCardData = {
    gradeDistribution,
    // An average score is not an asset-level grade under either methodology.
    pulseGrade: null,
    pulseScore: avgScore,
    coverageRatio: totalCoins > 0 ? ratedCount / totalCoins : 0,
    totalCoins,
    topPerformers,
    bottomPerformers,
    trend: null,
    safetyModel: safetySource.kind === "ok" ? safetySource.model : null,
    lastUpdated: safetyPresentation.lastUpdated,
  };

  const png = await renderPng(<SafetyScoresCard data={data} />);
  return new Response(png, { headers: safetyPresentation.headers });
}

// ---------------------------------------------------------------------------
// /api/og/depeg
// ---------------------------------------------------------------------------

async function handleDepegOg(db: D1Database): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - DAY_SECONDS;

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
    lastUpdated: nowUtcLabel(),
  };

  const png = await renderPng(<DepegCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// /api/og/stability-index
// ---------------------------------------------------------------------------

async function handleStabilityIndexOg(db: D1Database): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * DAY_SECONDS;

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
      .bind(now - DAY_SECONDS)
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
    lastUpdated: nowUtcLabel(),
  };

  const png = await renderPng(<StabilityIndexCard data={data} />);
  return new Response(png, { headers: CACHE_HEADERS });
}

// ---------------------------------------------------------------------------
// /api/og/chain/:id
// ---------------------------------------------------------------------------

async function handleChainOg(db: D1Database, chainId: string): Promise<Response> {
  if (!CHAIN_META[chainId]) {
    return ogErrorResponse("Unknown chain", 404);
  }

  const stablecoinsResult = await loadStablecoinsCache(db, {
    mode: "strict",
    contract: "published",
  });
  if (stablecoinsResult.kind !== "ok") {
    return ogDataNotYetAvailable();
  }

  const { peggedAssets, fxFallbackRates } = stablecoinsResult.payload;
  const activePeggedAssets = peggedAssets.filter(isActiveChainAggregateAsset);
  const { rates: pegRates } = derivePegRates(activePeggedAssets, TRACKED_META_BY_ID, fxFallbackRates);

  // Safety scores feed the chain health factor. An incomplete or mismatched
  // compact publication deliberately leaves chain health unrated.
  const safetyScores: Record<string, number> = {};
  const safetySource = await loadOgSafetyScoreSource(db);
  if (safetySource.kind === "ok") {
    for (const [id, entry] of Object.entries(safetySource.scores)) {
      if (entry.score !== null) {
        safetyScores[id] = entry.score;
      }
    }
  }

  const aggregated = aggregateChains({ peggedAssets: activePeggedAssets, safetyScores, pegRates });
  const chain = aggregated.chains.find((entry) => entry.id === chainId);

  // Every CHAIN_META chain page bakes this og:image URL, but aggregateChains()
  // skips chains whose tracked supply is currently zero. Render a degraded
  // "no tracked supply" card instead of 404 so baked share images never break
  // when a chain's supply transiently drops out of the aggregate.
  const safetyPresentation = safetyScoreOgPresentation(safetySource);
  const data: ChainCardData = chain
    ? {
        name: chain.name,
        totalUsd: chain.totalUsd,
        change7dPercent: ratioToPercentage(chain.change7dPct),
        stablecoinCount: chain.stablecoinCount,
        dominanceShare: chain.dominanceShare,
        healthScore: chain.healthScore,
        healthBand: chain.healthBand,
        topStablecoins: (chain.topStablecoins ?? []).slice(0, 4).map((coin) => ({
          symbol: coin.symbol,
          share: coin.share,
          supplyUsd: coin.supplyUsd,
        })),
        safetyModel: safetySource.kind === "ok" ? safetySource.model : null,
        lastUpdated: safetyPresentation.lastUpdated,
      }
    : {
        name: CHAIN_META[chainId].name,
        totalUsd: 0,
        change7dPercent: 0,
        stablecoinCount: 0,
        dominanceShare: 0,
        healthScore: null,
        healthBand: null,
        topStablecoins: [],
        safetyModel: safetySource.kind === "ok" ? safetySource.model : null,
        lastUpdated: safetyPresentation.lastUpdated,
      };

  const png = await renderPng(<ChainCard data={data} />);
  return new Response(png, { headers: safetyPresentation.headers });
}

// ---------------------------------------------------------------------------
// Main OG route dispatcher
// ---------------------------------------------------------------------------

const STABLECOIN_OG_PATTERN = /^\/api\/og\/stablecoin\/(.+)$/;
const CHAIN_OG_PATTERN = /^\/api\/og\/chain\/([a-z0-9-]+)$/;

interface OgRoute {
  pattern: RegExp;
  /** Decode/normalize the captured segment; a Response short-circuits both GET and HEAD. */
  resolveCapture?: (capture: string) => string | Response;
  /** HEAD-only existence check. GET surfaces the same 404 from its renderer. */
  headCheck?: (capture: string) => Response | null;
  render: (db: D1Database, capture: string) => Promise<Response>;
}

const OG_ROUTES: readonly OgRoute[] = [
  {
    pattern: STABLECOIN_OG_PATTERN,
    resolveCapture: (raw) => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return ogErrorResponse("Malformed URI", 400);
      }
    },
    headCheck: (coinId) =>
      resolveOrReject(coinId) instanceof Response ? ogErrorResponse("Unknown stablecoin", 404) : null,
    render: (db, coinId) => handleStablecoinOg(db, coinId),
  },
  {
    pattern: CHAIN_OG_PATTERN,
    headCheck: (chainId) => (CHAIN_META[chainId] ? null : ogErrorResponse("Unknown chain", 404)),
    render: (db, chainId) => handleChainOg(db, chainId),
  },
  { pattern: /^\/api\/og\/safety-scores$/, render: (db) => handleSafetyScoresOg(db) },
  { pattern: /^\/api\/og\/depeg$/, render: (db) => handleDepegOg(db) },
  { pattern: /^\/api\/og\/stability-index$/, render: (db) => handleStabilityIndexOg(db) },
];

export async function handleOg(db: D1Database, path: string, method = "GET"): Promise<Response | null> {
  const route = OG_ROUTES.find((candidate) => candidate.pattern.test(path));
  if (!route) return null;

  const rawCapture = path.match(route.pattern)?.[1] ?? "";
  const capture = route.resolveCapture ? route.resolveCapture(rawCapture) : rawCapture;
  if (capture instanceof Response) return capture;

  if (method === "HEAD") {
    return route.headCheck?.(capture) ?? new Response(null, { headers: CACHE_HEADERS });
  }

  try {
    return await route.render(db, capture);
  } catch (err) {
    logWorkerEventArgs("api", "error", "[og] Render error:", err);
    // Render-internal/transient failure (satori throw, resvg WASM crash, missing
    // font, D1 read failure). Permanent errors (unknown coin, malformed input)
    // return their own 4xx earlier and never reach this catch. Use 503 + no-store
    // so the CDN does not pin a failure response, and surface error.name for
    // diagnostics without leaking the full message.
    const errorClass = err instanceof Error ? err.name : "UnknownError";
    return ogErrorResponse("OG image generation failed", 503, {
      "Retry-After": "60",
      "Cache-Control": "no-store",
      "X-Render-Error-Class": errorClass,
    });
  }
}
