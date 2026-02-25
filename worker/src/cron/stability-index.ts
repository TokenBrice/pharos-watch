import type { StablecoinData } from "../../../src/lib/types";
import { getCirculatingRaw, getPrevWeekRaw } from "../../../src/lib/supply";
import { TRACKED_IDS } from "../../../src/lib/stablecoins";
import { getCache } from "../lib/db";
import type { CronResult } from "../lib/db";
import { computeStabilityIndex } from "../lib/stability-index";

export async function computeAndStoreStabilityIndex(db: D1Database): Promise<CronResult> {
  const stablecoinsCache = await getCache(db, "stablecoins");
  if (!stablecoinsCache) {
    return { metadata: "skipped: no stablecoins cache" };
  }

  const parsed = JSON.parse(stablecoinsCache.value) as { peggedAssets: StablecoinData[] };
  const tracked = parsed.peggedAssets.filter((c) => TRACKED_IDS.has(c.id));

  let totalMcapUsd = 0;
  let totalPrevWeek = 0;
  const mcapById = new Map<string, number>();

  for (const coin of tracked) {
    const mcap = getCirculatingRaw(coin);
    totalMcapUsd += mcap;
    totalPrevWeek += getPrevWeekRaw(coin);
    mcapById.set(coin.id, mcap);
  }

  const mcap7dChangePct = totalPrevWeek > 0
    ? ((totalMcapUsd - totalPrevWeek) / totalPrevWeek) * 100
    : 0;

  // Active depegs — use current price to compute live deviation
  const activeDepegs = await db
    .prepare("SELECT stablecoin_id, peg_reference FROM depeg_events WHERE ended_at IS NULL")
    .all<{ stablecoin_id: string; peg_reference: number }>();

  // Build price lookup from stablecoins cache
  const priceById = new Map<string, number>();
  for (const coin of tracked) {
    if (coin.price != null && typeof coin.price === "number" && coin.price > 0) {
      priceById.set(coin.id, coin.price);
    }
  }

  const depegs = (activeDepegs.results ?? []).flatMap((r) => {
    const price = priceById.get(r.stablecoin_id);
    if (!price || r.peg_reference <= 0) return [];
    const bps = Math.round(((price / r.peg_reference) - 1) * 10000);
    return [{ bps, mcapUsd: mcapById.get(r.stablecoin_id) ?? 0 }];
  });

  // Freeze count in last 24h
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const freezeRow = await db
    .prepare("SELECT COUNT(*) as cnt FROM blacklist_events WHERE timestamp > ?")
    .bind(cutoff)
    .first<{ cnt: number }>();
  const freezeCount24h = freezeRow?.cnt ?? 0;

  const result = computeStabilityIndex({ depegs, totalMcapUsd, freezeCount24h, mcap7dChangePct });

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(
      now,
      result.score,
      result.band,
      JSON.stringify(result.components),
      JSON.stringify({ depegCount: depegs.length, totalMcapUsd, freezeCount24h, mcap7dChangePct }),
    )
    .run();

  console.log(`[stability-index] score=${result.score} band=${result.band}`);
  return { metadata: `score=${result.score} band=${result.band}` };
}
