import type { StablecoinData } from "../../../src/lib/types";
import { getCirculatingRaw, getPrevWeekRaw } from "../../../src/lib/supply";
import { PSI_ELIGIBLE_IDS } from "../../../src/lib/psi-eligible";
import { getCache } from "../lib/db";
import type { CronResult } from "../lib/db";
import { computeStabilityIndex, getDepreciationFactor } from "../lib/stability-index";

export async function computeAndStoreStabilityIndex(db: D1Database): Promise<CronResult> {
  const stablecoinsCache = await getCache(db, "stablecoins");
  if (!stablecoinsCache) {
    return { metadata: "skipped: no stablecoins cache" };
  }

  const parsed = JSON.parse(stablecoinsCache.value) as { peggedAssets: StablecoinData[] };
  const tracked = parsed.peggedAssets.filter((c) => PSI_ELIGIBLE_IDS.has(c.id));

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

  const result = computeStabilityIndex({ depegs, totalMcapUsd, mcap7dChangePct });

  await db
    .prepare(
      `INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      now,
      result.score,
      result.band,
      JSON.stringify(result.components),
      JSON.stringify({ depegCount: depegs.length, totalMcapUsd, mcap7dChangePct, contributors }),
    )
    .run();

  console.log(`[stability-index] score=${result.score} band=${result.band}`);
  return { metadata: `score=${result.score} band=${result.band}` };
}
