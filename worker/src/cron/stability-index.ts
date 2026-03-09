import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { PSI_ELIGIBLE_IDS } from "@shared/lib/psi-eligible";
import { PSI_METHODOLOGY_VERSION } from "@shared/lib/stability-index-version";
import type { CronResult } from "../lib/db";
import { computeStabilityIndex, getDepreciationFactor } from "../lib/stability-index";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";

export async function computeAndStoreStabilityIndex(db: D1Database, _signal?: AbortSignal): Promise<CronResult> {
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true });
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

  const tracked = stablecoinsCache.payload.peggedAssets.filter((coin) => PSI_ELIGIBLE_IDS.has(coin.id));

  let totalMcapUsd = 0;
  let totalPrevWeek = 0;
  const mcapById = new Map<string, number>();
  const symbolById = new Map<string, string>();

  for (const coin of tracked) {
    const mcap = getCirculatingRaw(coin);
    totalMcapUsd += mcap;
    totalPrevWeek += getPrevWeekRaw(coin);
    mcapById.set(coin.id, mcap);
    symbolById.set(coin.id, coin.symbol);
  }

  const mcap7dChangePct = totalPrevWeek > 0
    ? ((totalMcapUsd - totalPrevWeek) / totalPrevWeek) * 100
    : 0;

  // Active depegs — use current price to compute live deviation
  const activeDepegs = await db
    .prepare("SELECT stablecoin_id, peg_reference, started_at FROM depeg_events WHERE ended_at IS NULL")
    .all<{ stablecoin_id: string; peg_reference: number; started_at: number }>();

  // Build price lookup from stablecoins cache
  const priceById = new Map<string, number>();
  for (const coin of tracked) {
    if (coin.price != null && typeof coin.price === "number" && coin.price > 0) {
      priceById.set(coin.id, coin.price);
    }
  }

  // Read DEWS stress signals (from previous 15-min cycle) for stress breadth
  let dewsStressBreadth = 0;
  let dewsUnavailable = false;
  let dewsFailureReason: string | null = null;
  try {
    const dewsRows = await db
      .prepare(
        `SELECT s.stablecoin_id, s.score, s.band
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at
         WHERE s.band IN ('ALERT', 'WARNING', 'DANGER')`,
      )
      .all<{ stablecoin_id: string; score: number; band: string }>();

    // Count stressed coins weighted by mcap
    for (const row of dewsRows.results ?? []) {
      const coinMcap = mcapById.get(row.stablecoin_id) ?? 0;
      dewsStressBreadth += Math.sqrt(coinMcap / 1e9) * 1.5;
    }
  } catch (error) {
    dewsUnavailable = true;
    dewsFailureReason = String(error);
    console.warn("[stability-index] DEWS dependency unavailable; stress breadth defaulted to 0:", error);
  }

  // Deduplicate by stablecoin_id: group events, pick worst deviation, earliest start
  type DepegRow = { stablecoin_id: string; peg_reference: number; started_at: number };
  const grouped = new Map<string, DepegRow[]>();
  for (const r of activeDepegs.results ?? []) {
    const list = grouped.get(r.stablecoin_id) ?? [];
    list.push(r);
    grouped.set(r.stablecoin_id, list);
  }

  const now = Math.floor(Date.now() / 1000);
  const depegs: { bps: number; mcapUsd: number; depegAgeDays: number }[] = [];
  const contributors: {
    id: string; symbol: string; bps: number; mcapUsd: number;
    ageDays: number; factor: number;
  }[] = [];

  for (const [coinId, events] of grouped) {
    const price = priceById.get(coinId);
    if (!price) continue;

    let worstBps = 0;
    let earliestStart = Infinity;
    for (const e of events) {
      if (e.peg_reference <= 0) continue;
      const bps = Math.round(((price / e.peg_reference) - 1) * 10000);
      if (Math.abs(bps) > Math.abs(worstBps)) worstBps = bps;
      if (e.started_at < earliestStart) earliestStart = e.started_at;
    }

    if (earliestStart === Infinity) continue;
    const mcapUsd = mcapById.get(coinId) ?? 0;
    const ageDays = Math.max(0, (now - earliestStart) / 86400);

    depegs.push({ bps: worstBps, mcapUsd, depegAgeDays: ageDays });

    contributors.push({
      id: coinId,
      symbol: symbolById.get(coinId) ?? coinId,
      bps: worstBps,
      mcapUsd,
      ageDays: Math.round(ageDays * 10) / 10,
      factor: Math.round(getDepreciationFactor(ageDays) * 100) / 100,
    });
  }

  const result = computeStabilityIndex({ depegs, totalMcapUsd, mcap7dChangePct, dewsStressBreadth });
  if (!result) {
    console.warn(
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
      }),
    };
  }

  await db
    .prepare(
      `INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot, methodology_version)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      now,
      result.score,
      result.band,
      JSON.stringify(result.components),
      JSON.stringify({
        depegCount: depegs.length,
        totalMcapUsd,
        mcap7dChangePct,
        dewsStressBreadth,
        dewsUnavailable,
        dewsFailureReason,
        contributors,
        methodologyVersion: PSI_METHODOLOGY_VERSION,
      }),
      PSI_METHODOLOGY_VERSION,
    )
    .run();

  // Prune samples older than 90 days
  await db.prepare("DELETE FROM stability_index_samples WHERE stored_at < ?")
    .bind(Math.floor(Date.now() / 1000) - 90 * 86400)
    .run();

  console.log(`[stability-index] score=${result.score} band=${result.band}`);
  return {
    ...(dewsUnavailable ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      score: result.score,
      band: result.band,
      dewsStressBreadth,
      dewsUnavailable,
      dewsFailureReason,
    }),
  };
}
