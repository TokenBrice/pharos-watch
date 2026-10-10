import { loadLegacyDexPoolChallengers } from "./challenger-legacy";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import { recordRuntimeFallbackUsage } from "../../lib/runtime-fallback-telemetry";
import type {
  DexPriceChallengerLoadRow,
  DexPriceChallengerLoadDiagnostics,
  DexPriceChallengerLoadResult,
} from "./challenger-types";

export type {
  DexPriceChallengerLoadRow,
  DexPriceChallengerLoadDiagnostics,
  DexPriceChallengerLoadResult,
};

type LegacyDexPoolChallengerLoadResult = Awaited<ReturnType<typeof loadLegacyDexPoolChallengers>>;

async function hasLegacyCandidatesWithoutSnapshots(
  db: D1Database,
  maxAgeSec: number,
  nowSec: number,
): Promise<boolean> {
  const minUpdatedAt = nowSec - maxAgeSec;
  const sources = [
    `SELECT stablecoin_id
     FROM dex_liquidity
     WHERE stablecoin_id != '__global__'
       AND top_pools_json IS NOT NULL
       AND updated_at >= ?
       AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}
       AND NOT EXISTS (
         SELECT 1
         FROM dex_price_challenger_snapshots snapshots
         WHERE snapshots.stablecoin_id = dex_liquidity.stablecoin_id
       )
     LIMIT 1`,
    `SELECT stablecoin_id
     FROM dex_prices
     WHERE price_sources_json IS NOT NULL
       AND updated_at >= ?
       AND NOT EXISTS (
         SELECT 1
         FROM dex_price_challenger_snapshots snapshots
         WHERE snapshots.stablecoin_id = dex_prices.stablecoin_id
       )
     LIMIT 1`,
  ];

  for (const sql of sources) {
    const rows = await db.prepare(sql).bind(minUpdatedAt).all<{ stablecoin_id: string }>();
    if ((rows.results ?? []).length > 0) return true;
  }

  return false;
}

export async function loadPublishedDexPoolChallengers(
  db: D1Database,
  minPoolTvlUsd: number,
  maxAgeSec: number,
  nowSec: number,
): Promise<DexPriceChallengerLoadResult> {
  let legacy: LegacyDexPoolChallengerLoadResult | null = null;
  const loadLegacy = async (): Promise<LegacyDexPoolChallengerLoadResult> => {
    legacy ??= await loadLegacyDexPoolChallengers(db, minPoolTvlUsd, maxAgeSec, nowSec);
    return legacy;
  };
  const challengersByStablecoin = new Map<string, DexPriceChallengerLoadRow[]>();
  const emptyPublishedCoins: string[] = [];
  const incompletePublishedCoins: string[] = [];
  const staleSnapshotCoins: string[] = [];
  const legacyFallbackCoins = new Set<string>();
  const publishedCoins = new Set<string>();
  const legacyUsedCoins = new Set<string>();

  // Read the visibility pointer and its exact generation in one SQLite snapshot.
  // LEFT JOIN preserves authoritative empty pointers during publication cleanup.
  const joined = await db.prepare(
    `SELECT snapshots.stablecoin_id, snapshots.snapshot_at, snapshots.published_at,
            snapshots.has_rows, snapshots.source_coverage_complete,
            payload.pool_id, payload.chain, payload.protocol, payload.source_family,
            payload.price_usd, payload.tvl_usd
       FROM dex_price_challenger_snapshots snapshots
       LEFT JOIN dex_price_challengers payload
         ON payload.stablecoin_id = snapshots.stablecoin_id
        AND payload.snapshot_at = snapshots.snapshot_at
       WHERE snapshots.stablecoin_id != '__global__'`,
  ).all<{
    stablecoin_id: string;
    snapshot_at: number;
    published_at: number;
    has_rows: number;
    source_coverage_complete: number;
    pool_id: string | null;
    chain: string;
    protocol: string;
    source_family: string;
    price_usd: number;
    tvl_usd: number;
  }>();
  const snapshotByCoin = new Map<string, (NonNullable<typeof joined.results>)[number]>();
  const rowsByCoinAndSnapshot = new Map<string, DexPriceChallengerLoadRow[]>();
  for (const row of joined.results ?? []) {
    snapshotByCoin.set(row.stablecoin_id, row);
    if (row.pool_id == null) continue;
    const key = `${row.stablecoin_id}:${row.snapshot_at}`;
    const existing = rowsByCoinAndSnapshot.get(key) ?? [];
    existing.push({
      stablecoinId: row.stablecoin_id,
      poolId: row.pool_id,
      chain: row.chain,
      protocol: row.protocol,
      sourceFamily: row.source_family,
      priceUsd: row.price_usd,
      tvlUsd: row.tvl_usd,
      snapshotAt: row.snapshot_at,
      publishedAt: row.published_at,
    });
    rowsByCoinAndSnapshot.set(key, existing);
  }

  for (const snapshot of snapshotByCoin.values()) {
    const ageSec = nowSec - snapshot.snapshot_at;
    if (ageSec > maxAgeSec) {
      staleSnapshotCoins.push(snapshot.stablecoin_id);
      legacyFallbackCoins.add(snapshot.stablecoin_id);
      continue;
    }

    if (!snapshot.source_coverage_complete) {
      incompletePublishedCoins.push(snapshot.stablecoin_id);
      legacyFallbackCoins.add(snapshot.stablecoin_id);
      continue;
    }

    const key = `${snapshot.stablecoin_id}:${snapshot.snapshot_at}`;
    const rows = rowsByCoinAndSnapshot.get(key) ?? [];

    if (snapshot.has_rows === 0) {
      challengersByStablecoin.set(snapshot.stablecoin_id, []);
      publishedCoins.add(snapshot.stablecoin_id);
      emptyPublishedCoins.push(snapshot.stablecoin_id);
      continue;
    }

    if (rows.length > 0) {
      challengersByStablecoin.set(
        snapshot.stablecoin_id,
        rows
          .filter((row) => Number.isFinite(row.priceUsd) && row.priceUsd > 0 && Number.isFinite(row.tvlUsd) && row.tvlUsd >= minPoolTvlUsd)
          .sort((a, b) => b.tvlUsd - a.tvlUsd || a.poolId.localeCompare(b.poolId)),
      );
      publishedCoins.add(snapshot.stablecoin_id);
    } else {
      legacyFallbackCoins.add(snapshot.stablecoin_id);
    }
  }

  const needsLegacy =
    legacyFallbackCoins.size > 0 ||
    await hasLegacyCandidatesWithoutSnapshots(db, maxAgeSec, nowSec);

  if (needsLegacy) {
    const loadedLegacy = await loadLegacy();
    for (const coinId of [...loadedLegacy.topPoolCoins, ...loadedLegacy.fallbackCoins]) {
      if (publishedCoins.has(coinId)) continue;
      if (!legacyFallbackCoins.has(coinId) && snapshotByCoin.has(coinId)) continue;
      const legacyRows = loadedLegacy.challengersByStablecoin.get(coinId);
      if (legacyRows && legacyRows.length > 0) {
        challengersByStablecoin.set(coinId, legacyRows);
        legacyFallbackCoins.add(coinId);
        legacyUsedCoins.add(coinId);
      }
    }

    for (const coinId of loadedLegacy.challengersByStablecoin.keys()) {
      if (challengersByStablecoin.has(coinId)) continue;
      if (publishedCoins.has(coinId)) continue;
      if (!snapshotByCoin.has(coinId)) {
        challengersByStablecoin.set(coinId, loadedLegacy.challengersByStablecoin.get(coinId) ?? []);
        legacyFallbackCoins.add(coinId);
        legacyUsedCoins.add(coinId);
      }
    }
  }

  const hasPublished = publishedCoins.size > 0;
  const hasLegacy = legacyUsedCoins.size > 0;
  if (hasLegacy || legacyFallbackCoins.size > 0) {
    recordRuntimeFallbackUsage("dex-challenger-legacy", {
      reason: hasLegacy ? "legacy-rows-used" : "legacy-needed-without-rows",
      legacyUsedCoins: legacyUsedCoins.size,
      legacyFallbackCoins: legacyFallbackCoins.size,
      staleSnapshotCoins: staleSnapshotCoins.length,
      incompletePublishedCoins: incompletePublishedCoins.length,
    });
  }
  const mode: DexPriceChallengerLoadDiagnostics["mode"] =
    hasPublished && hasLegacy ? "mixed" : hasPublished ? "published" : hasLegacy ? "legacy" : "absent";

  return {
    challengersByStablecoin,
    diagnostics: {
      mode,
      emptyPublishedCoins,
      incompletePublishedCoins,
      legacyFallbackCoins: [...legacyFallbackCoins],
      staleSnapshotCoins,
    },
  };
}
