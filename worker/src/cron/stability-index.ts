import { logWorkerEventArgs } from "../lib/structured-log";
import { getCirculatingRaw, getPrevWeekRawOrNull } from "@shared/lib/supply";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { CORE_PSI_ELIGIBLE_IDS } from "@shared/lib/psi-eligible";
import { PSI_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/stability-index";
import { round1 } from "@shared/lib/math";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { CronResult } from "../lib/cron-logger";
import { getPriceCache } from "../lib/db-cache";
import { deriveDepegSignal } from "../lib/depeg-signals";
import { computeStabilityIndex, DEWS_STRESS_BREADTH_SCALE, getDepreciationFactor } from "../lib/stability-index";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadPublishedStressSignalGeneration } from "../lib/stress-signals-current-rows";
import { canonicalizePsiStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { CORE_STABLECOIN_AGGREGATE_UNIVERSE } from "@shared/lib/stablecoins/aggregate-universe";
import { throwIfAborted } from "../lib/abort";

const REPLAY_PRICE_CACHE_TTL_SEC = 6 * 60 * 60;
const DEWS_STRESS_MAX_AGE_SEC = CRON_INTERVALS["compute-dews"] * 2;
const DEWS_STRESS_BANDS = new Set(["ALERT", "WARNING", "DANGER"]);

export async function computeAndStoreStabilityIndex(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict" });
  if (stablecoinsCache.kind !== "ok") {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        fallbackMode: "stablecoins-cache-unavailable",
        stablecoinsCacheReason: stablecoinsCache.reason,
        dewsUnavailable: true,
      }),
    };
  }

  const tracked = stablecoinsCache.payload.peggedAssets.filter((coin) => CORE_PSI_ELIGIBLE_IDS.has(coin.id));

  let totalMcapUsd = 0;
  let pairedMcapUsd = 0;
  let pairedPrevWeek = 0;
  const mcapById = new Map<string, number>();
  const symbolById = new Map<string, string>();

  for (const coin of tracked) {
    const mcap = getCirculatingRaw(coin);
    totalMcapUsd += mcap;
    const prevWeek = getPrevWeekRawOrNull(coin);
    if (prevWeek != null) {
      pairedMcapUsd += mcap;
      pairedPrevWeek += prevWeek;
    }
    mcapById.set(coin.id, mcap);
    symbolById.set(coin.id, coin.symbol);
  }

  const mcap7dChangePct = pairedPrevWeek > 0
    ? ((pairedMcapUsd - pairedPrevWeek) / pairedPrevWeek) * 100
    : 0;

  throwIfAborted(signal);

  // Active depegs — use current price to compute live deviation
  let activeDepegs: D1Result<{ stablecoin_id: string; peg_reference: number; started_at: number }>;
  try {
    activeDepegs = await db
      .prepare("SELECT stablecoin_id, peg_reference, started_at FROM depeg_events WHERE ended_at IS NULL")
      .all<{ stablecoin_id: string; peg_reference: number; started_at: number }>();
  } catch (err) {
    logWorkerEventArgs("handler", "warn", "[stability-index] depeg query failed:", err);
    const depegEventsFailureReason = String(err);
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        fallbackMode: "depeg-events-unavailable",
        depegEventsUnavailable: true,
        depegEventsFailureReason,
        totalMcapUsd,
        mcap7dChangePct,
      }),
    };
  }
  const now = Math.floor(Date.now() / 1000);

  // Build price lookup from stablecoins cache
  const priceById = new Map<string, number>();
  for (const coin of tracked) {
    if (coin.price != null && typeof coin.price === "number" && coin.price > 0) {
      priceById.set(coin.id, coin.price);
    }
  }

  // Keep already-open depegs in PSI when the current stablecoins snapshot temporarily
  // lacks a usable price but we still have a recent replay-safe positive cached price.
  const replayPriceById = new Map<string, number>();
  try {
    const replayPriceCache = await getPriceCache(db);
    for (const [assetId, cached] of replayPriceCache) {
      if (
        cached.price != null &&
        Number.isFinite(cached.price) &&
        cached.price > 0 &&
        Number.isFinite(cached.updatedAt) &&
        now - cached.updatedAt < REPLAY_PRICE_CACHE_TTL_SEC
      ) {
        replayPriceById.set(assetId, cached.price);
      }
    }
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[stability-index] replay price cache unavailable; open-depeg fallback disabled:", error);
  }

  // Read DEWS stress signals (from previous 15-min cycle) for stress breadth
  let dewsStressBreadth = 0;
  let dewsUnavailable = false;
  let dewsFailureReason: string | null = null;
  let dewsLatestComputedAt: number | null = null;
  let dewsRowsRead = 0;
  const publishedDews = await loadPublishedStressSignalGeneration(db, now);
  throwIfAborted(signal);
  if (publishedDews.status !== "ok") {
    dewsUnavailable = true;
    dewsFailureReason = publishedDews.reason;
  } else {
    const rows = publishedDews.rows.filter((row) => CORE_PSI_ELIGIBLE_IDS.has(row.stablecoin_id));
    dewsRowsRead = rows.length;
    for (const row of rows) {
      if (!Number.isFinite(row.computed_at)) {
        dewsUnavailable = true;
        dewsFailureReason ??= "stress_signals latest rows are missing computed_at";
        continue;
      }

      dewsLatestComputedAt =
        dewsLatestComputedAt == null ? row.computed_at : Math.max(dewsLatestComputedAt, row.computed_at);

      const rowAgeSec = now - row.computed_at;
      if (rowAgeSec > DEWS_STRESS_MAX_AGE_SEC) {
        dewsUnavailable = true;
        dewsFailureReason ??= `stress_signals latest row for ${row.stablecoin_id} is stale (ageSec=${rowAgeSec}, maxAgeSec=${DEWS_STRESS_MAX_AGE_SEC})`;
      }
    }

    if (!dewsUnavailable) {
      // Count stressed coins weighted by mcap after dependency freshness is proven.
      for (const row of rows) {
        if (!DEWS_STRESS_BANDS.has(row.band)) continue;
        const coinMcap = mcapById.get(row.stablecoin_id) ?? 0;
        dewsStressBreadth += Math.sqrt(coinMcap / 1e9) * DEWS_STRESS_BREADTH_SCALE;
      }
    }
  }

  if (dewsUnavailable) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        fallbackMode: "dews-unavailable",
        dewsUnavailable,
        dewsFailureReason,
        dewsLatestComputedAt,
        dewsRowsRead,
        dewsMaxAgeSec: DEWS_STRESS_MAX_AGE_SEC,
        totalMcapUsd,
        mcap7dChangePct,
        preservedCurrentSample: true,
      }),
    };
  }

  // Deduplicate by stablecoin_id: group events, pick worst deviation, earliest start
  type DepegRow = { stablecoin_id: string; peg_reference: number; started_at: number };
  const grouped = new Map<string, DepegRow[]>();
  for (const r of activeDepegs.results ?? []) {
    const canonicalId = canonicalizePsiStablecoinId(r.stablecoin_id);
    const list = grouped.get(canonicalId) ?? [];
    list.push(r);
    grouped.set(canonicalId, list);
  }

  const depegs: { bps: number; mcapUsd: number; depegAgeDays: number }[] = [];
  const contributors: {
    id: string;
    symbol: string;
    bps: number;
    mcapUsd: number;
    ageDays: number;
    factor: number;
  }[] = [];
  let replayPriceFallbackCount = 0;

  for (const [coinId, events] of grouped) {
    const currentPrice = priceById.get(coinId);
    const replayPrice = replayPriceById.get(coinId);
    const price = currentPrice ?? replayPrice;
    if (!price) continue;
    if (currentPrice == null && replayPrice != null) {
      replayPriceFallbackCount++;
    }

    let worstBps = 0;
    let earliestStart = Infinity;
    for (const e of events) {
      const depegSignal = deriveDepegSignal(price, e.peg_reference);
      if (!depegSignal) continue;
      if (depegSignal.absBps > Math.abs(worstBps)) worstBps = depegSignal.bps;
      if (e.started_at < earliestStart) earliestStart = e.started_at;
    }

    if (earliestStart === Infinity) continue;
    const mcapUsd = mcapById.get(coinId) ?? 0;
    const ageDays = Math.max(0, (now - earliestStart) / DAY_SECONDS);

    depegs.push({ bps: worstBps, mcapUsd, depegAgeDays: ageDays });

    contributors.push({
      id: coinId,
      symbol: symbolById.get(coinId) ?? coinId,
      bps: worstBps,
      mcapUsd,
      ageDays: round1(ageDays),
      factor: Math.round(getDepreciationFactor(ageDays) * 100) / 100,
    });
  }

  throwIfAborted(signal);

  const result = computeStabilityIndex({ depegs, totalMcapUsd, mcap7dChangePct, dewsStressBreadth });
  if (!result) {
    logWorkerEventArgs("handler", "warn",
      `[stability-index] skipped sample due to insufficient market-cap input (totalMcapUsd=${totalMcapUsd})`,
    );
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        fallbackMode: "insufficient-market-cap",
        totalMcapUsd,
        depegCount: depegs.length,
        dewsStressBreadth,
        dewsUnavailable,
        dewsFailureReason,
        dewsLatestComputedAt,
        dewsRowsRead,
        dewsMaxAgeSec: DEWS_STRESS_MAX_AGE_SEC,
      }),
    };
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO stability_index_samples (stored_at, score, band, components, input_snapshot, methodology_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      now,
      result.score,
      result.band,
      JSON.stringify(result.components),
      JSON.stringify({
        aggregateUniverse: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
        depegCount: depegs.length,
        totalMcapUsd,
        mcap7dChangePct,
        dewsStressBreadth,
        dewsUnavailable,
        dewsFailureReason,
        dewsLatestComputedAt,
        dewsRowsRead,
        dewsMaxAgeSec: DEWS_STRESS_MAX_AGE_SEC,
        replayPriceFallbackCount,
        contributors,
        methodologyVersion: PSI_METHODOLOGY_VERSION,
      }),
      PSI_METHODOLOGY_VERSION,
    )
    .run();

  // Prune samples older than 90 days
  await db
    .prepare("DELETE FROM stability_index_samples WHERE stored_at < ?")
    .bind(Math.floor(Date.now() / 1000) - 90 * DAY_SECONDS)
    .run();

  logWorkerEventArgs("handler", "info", `[stability-index] score=${result.score} band=${result.band}`);
  return {
    itemCount: 1,
    productivity: {
      productive: true,
      reason: "psi-sample-published",
      publications: [
        {
          surface: "psi",
          generationId: `psi:${now}`,
          publishedAt: now,
          candidateRows: 1,
          publishedRows: 1,
          expectedRows: 1,
          validationSummary: { methodologyVersion: PSI_METHODOLOGY_VERSION },
        },
      ],
    },
    metadata: JSON.stringify({
      aggregateUniverse: CORE_STABLECOIN_AGGREGATE_UNIVERSE,
      score: result.score,
      band: result.band,
      dewsStressBreadth,
      dewsUnavailable,
      dewsFailureReason,
      dewsLatestComputedAt,
      dewsRowsRead,
      dewsMaxAgeSec: DEWS_STRESS_MAX_AGE_SEC,
      replayPriceFallbackCount,
    }),
  };
}
