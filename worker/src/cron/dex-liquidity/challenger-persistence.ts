import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { batchExecute } from "../../lib/db";
import { requireFiniteNumber } from "../../lib/number-utils";
import type { PoolEntry } from "./types";

export interface DexPriceChallengerPoolRow {
  stablecoinId: string;
  poolId: string;
  chain: string;
  protocol: string;
  sourceFamily: string;
  priceUsd: number;
  tvlUsd: number;
}

export interface DexPriceChallengerSnapshotRow {
  stablecoinId: string;
  snapshotAt: number;
  publishedAt: number;
  hasRows: boolean;
  sourceCoverageComplete: boolean;
}

export interface DexPriceChallengerPublicationInput {
  stablecoinId: string;
  snapshotAt: number;
  rows: DexPriceChallengerPoolRow[];
  sourceCoverageComplete: boolean;
  publishedAt?: number;
}

export interface DexPriceChallengerPublicationPlan {
  stablecoinId: string;
  snapshotAt: number;
  publishedAt: number;
  hasRows: boolean;
  sourceCoverageComplete: boolean;
  shouldPublishSnapshot: boolean;
  skipReason: "incomplete-coverage" | null;
  payloadStatements: DexPriceChallengerSqlStatement[];
  snapshotStatement: DexPriceChallengerSqlStatement | null;
  cleanupStatements: DexPriceChallengerSqlStatement[];
}

export interface DexPriceChallengerLoadRow {
  stablecoinId: string;
  poolId: string;
  chain: string;
  protocol: string;
  sourceFamily: string;
  priceUsd: number;
  tvlUsd: number;
  snapshotAt: number;
  publishedAt: number;
}

export interface DexPriceChallengerLoadDiagnostics {
  mode: "published" | "legacy" | "mixed" | "absent";
  missingTables: boolean;
  emptyPublishedCoins: string[];
  incompletePublishedCoins: string[];
  legacyFallbackCoins: string[];
  staleSnapshotCoins: string[];
}

export interface DexPriceChallengerLoadResult {
  challengersByStablecoin: Map<string, DexPriceChallengerLoadRow[]>;
  diagnostics: DexPriceChallengerLoadDiagnostics;
}

export interface DexPriceChallengerTableState {
  challengersTable: boolean;
  snapshotsTable: boolean;
}

export interface DexPriceChallengerSqlStatement {
  sql: string;
  binds: unknown[];
}

interface LegacyDexPoolSource {
  protocol: string;
  chain: string;
  price: number;
  tvl: number;
}

const CHALLENGER_COVERAGE_TARGET = 0.95;
const CHALLENGER_HARD_CAP = 50;

/** Return the writable publication sequence with payload rows first and snapshot metadata last. */
export function getDexPriceChallengerPublicationStatements(
  plan: DexPriceChallengerPublicationPlan,
): DexPriceChallengerSqlStatement[] {
  return plan.snapshotStatement == null
    ? [...plan.payloadStatements]
    : [...plan.payloadStatements, plan.snapshotStatement];
}

function toLowerString(value: string): string {
  return value.trim().toLowerCase();
}

export async function detectDexPriceChallengerTableState(db: D1Database): Promise<DexPriceChallengerTableState> {
  try {
    const rows = await db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name IN ('dex_price_challengers', 'dex_price_challenger_snapshots')`,
      )
      .all<{ name: string }>();
    const names = new Set((rows.results ?? []).map((row) => row.name));
    return {
      challengersTable: names.has("dex_price_challengers"),
      snapshotsTable: names.has("dex_price_challenger_snapshots"),
    };
  } catch {
    return { challengersTable: false, snapshotsTable: false };
  }
}

export function buildDexPriceChallengerPublicationPlan(
  input: DexPriceChallengerPublicationInput,
): DexPriceChallengerPublicationPlan {
  const stablecoinId = toLowerString(input.stablecoinId);
  const snapshotAt = Math.floor(requireFiniteNumber(input.snapshotAt, "dex-price-challengers: snapshotAt"));
  const publishedAt = Math.floor(input.publishedAt ?? snapshotAt);
  const sourceCoverageComplete = !!input.sourceCoverageComplete;
  const hasRows = input.rows.length > 0;

  const payloadStatements = input.rows.map((row) => {
    const stablecoin = toLowerString(row.stablecoinId);
    if (stablecoin !== stablecoinId) {
      throw new Error(
        `dex-price-challengers: row stablecoin "${row.stablecoinId}" does not match batch stablecoin "${stablecoinId}"`,
      );
    }
    return {
      sql:
        `INSERT INTO dex_price_challengers
          (stablecoin_id, snapshot_at, pool_id, chain, protocol, source_family, price_usd, tvl_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stablecoin_id, snapshot_at, pool_id) DO UPDATE SET
           chain = excluded.chain,
           protocol = excluded.protocol,
           source_family = excluded.source_family,
           price_usd = excluded.price_usd,
           tvl_usd = excluded.tvl_usd`,
      binds: [
        stablecoin,
        snapshotAt,
        row.poolId.trim(),
        row.chain.trim(),
        row.protocol.trim(),
        row.sourceFamily.trim(),
        row.priceUsd,
        row.tvlUsd,
      ],
    } satisfies DexPriceChallengerSqlStatement;
  });

  const snapshotStatement = sourceCoverageComplete
    ? {
        sql:
          `INSERT INTO dex_price_challenger_snapshots
            (stablecoin_id, snapshot_at, published_at, has_rows, source_coverage_complete)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(stablecoin_id) DO UPDATE SET
             snapshot_at = excluded.snapshot_at,
             published_at = excluded.published_at,
             has_rows = excluded.has_rows,
             source_coverage_complete = excluded.source_coverage_complete`,
        binds: [stablecoinId, snapshotAt, publishedAt, hasRows ? 1 : 0, 1],
      }
    : null;

  const cleanupStatements = [
    {
      sql:
        `DELETE FROM dex_price_challengers
         WHERE stablecoin_id = ? AND snapshot_at < ?`,
      binds: [stablecoinId, snapshotAt],
    } satisfies DexPriceChallengerSqlStatement,
  ];

  return {
    stablecoinId,
    snapshotAt,
    publishedAt,
    hasRows,
    sourceCoverageComplete,
    shouldPublishSnapshot: sourceCoverageComplete,
    skipReason: sourceCoverageComplete ? null : "incomplete-coverage",
    payloadStatements,
    snapshotStatement,
    cleanupStatements,
  };
}

export function selectDexPriceChallengerRowsFromPools(
  stablecoinId: string,
  pools: PoolEntry[],
  minPoolTvlUsd: number,
): DexPriceChallengerPoolRow[] {
  const qualifying = pools
    .filter((pool) =>
      Number.isFinite(pool.price) &&
      (pool.price ?? 0) > 0 &&
      Number.isFinite(pool.tvlUsd) &&
      pool.tvlUsd >= minPoolTvlUsd,
    )
    .sort((a, b) => b.tvlUsd - a.tvlUsd || a.poolId.localeCompare(b.poolId));

  if (qualifying.length === 0) return [];

  const totalQualifyingTvl = qualifying.reduce((sum, pool) => sum + pool.tvlUsd, 0);
  const rows: DexPriceChallengerPoolRow[] = [];
  let retainedTvl = 0;

  for (const pool of qualifying) {
    rows.push({
      stablecoinId,
      poolId: pool.poolId,
      chain: pool.chain,
      protocol: pool.project,
      sourceFamily: pool.source,
      priceUsd: pool.price as number,
      tvlUsd: pool.tvlUsd,
    });
    retainedTvl += pool.tvlUsd;

    const coverageRatio = totalQualifyingTvl > 0 ? retainedTvl / totalQualifyingTvl : 1;
    if (rows.length >= CHALLENGER_HARD_CAP) break;
    if (coverageRatio >= CHALLENGER_COVERAGE_TARGET) break;
  }

  return rows;
}

export async function publishDexPriceChallengerSnapshots(
  db: D1Database,
  input: {
    snapshotAt: number;
    retainedPoolsByStablecoin: Map<string, PoolEntry[]>;
    sourceCoverageCompleteByStablecoin: Map<string, boolean>;
    minPoolTvlUsd: number;
  },
): Promise<{
  publishedStablecoins: number;
  skippedStablecoins: number;
  missingTables: boolean;
}> {
  const state = await detectDexPriceChallengerTableState(db);
  if (!state.challengersTable || !state.snapshotsTable) {
    return {
      publishedStablecoins: 0,
      skippedStablecoins: ACTIVE_STABLECOINS.length,
      missingTables: true,
    };
  }

  const statements: D1PreparedStatement[] = [];
  let publishedStablecoins = 0;
  let skippedStablecoins = 0;

  for (const meta of ACTIVE_STABLECOINS) {
    const stablecoinId = meta.id;
    const rows = selectDexPriceChallengerRowsFromPools(
      stablecoinId,
      input.retainedPoolsByStablecoin.get(stablecoinId) ?? [],
      input.minPoolTvlUsd,
    );
    const plan = buildDexPriceChallengerPublicationPlan({
      stablecoinId,
      snapshotAt: input.snapshotAt,
      rows,
      sourceCoverageComplete: input.sourceCoverageCompleteByStablecoin.get(stablecoinId) ?? false,
    });
    if (!plan.shouldPublishSnapshot) {
      skippedStablecoins++;
      continue;
    }

    publishedStablecoins++;
    for (const stmt of getDexPriceChallengerPublicationStatements(plan)) {
      statements.push(db.prepare(stmt.sql).bind(...stmt.binds));
    }
    for (const stmt of plan.cleanupStatements) {
      statements.push(db.prepare(stmt.sql).bind(...stmt.binds));
    }
  }

  if (statements.length > 0) {
    await batchExecute(db, statements);
  }

  return {
    publishedStablecoins,
    skippedStablecoins,
    missingTables: false,
  };
}

async function loadLegacyDexPoolChallengers(
  db: D1Database,
  minPoolTvlUsd: number,
  maxAgeSec: number,
  nowSec: number,
): Promise<{
  challengersByStablecoin: Map<string, DexPriceChallengerLoadRow[]>;
  topPoolCoins: Set<string>;
  fallbackCoins: Set<string>;
}> {
  const challengersByStablecoin = new Map<string, DexPriceChallengerLoadRow[]>();
  const topPoolCoins = new Set<string>();
  const fallbackCoins = new Set<string>();

  try {
    const rows = await db
      .prepare(
        `SELECT stablecoin_id, top_pools_json, updated_at
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__' AND top_pools_json IS NOT NULL`,
      )
      .all<{ stablecoin_id: string; top_pools_json: string; updated_at: number }>();

    for (const row of rows.results ?? []) {
      if (nowSec - row.updated_at > maxAgeSec) continue;
      let pools: Array<{ project?: unknown; chain?: unknown; tvlUsd?: unknown; price?: unknown; poolId?: unknown }>;
      try {
        pools = JSON.parse(row.top_pools_json);
      } catch {
        continue;
      }
      if (!Array.isArray(pools) || pools.length === 0) continue;

      const qualifying: DexPriceChallengerLoadRow[] = [];
      for (const pool of pools) {
        const price = typeof pool.price === "number" ? pool.price : Number(pool.price);
        const tvlUsd = typeof pool.tvlUsd === "number" ? pool.tvlUsd : Number(pool.tvlUsd);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tvlUsd) || tvlUsd < minPoolTvlUsd) continue;
        qualifying.push({
          stablecoinId: row.stablecoin_id,
          poolId: typeof pool.poolId === "string" ? pool.poolId : "",
          chain: typeof pool.chain === "string" ? pool.chain : "unknown",
          protocol: typeof pool.project === "string" ? pool.project : "unknown",
          sourceFamily: "legacy-top-pools",
          priceUsd: price,
          tvlUsd,
          snapshotAt: row.updated_at,
          publishedAt: row.updated_at,
        });
      }
      if (qualifying.length > 0) {
        challengersByStablecoin.set(row.stablecoin_id, qualifying);
        topPoolCoins.add(row.stablecoin_id);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[challenger-persistence] Unexpected error loading legacy challengers:", msg);
    }
  }

  try {
    const rows = await db
      .prepare("SELECT stablecoin_id, price_sources_json, updated_at FROM dex_prices WHERE price_sources_json IS NOT NULL")
      .all<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>();

    for (const row of rows.results ?? []) {
      if (nowSec - row.updated_at > maxAgeSec) continue;
      if (challengersByStablecoin.has(row.stablecoin_id)) continue;
      let sources: LegacyDexPoolSource[];
      try {
        sources = JSON.parse(row.price_sources_json);
      } catch {
        continue;
      }
      if (!Array.isArray(sources) || sources.length === 0) continue;

      const qualifying: DexPriceChallengerLoadRow[] = [];
      for (const source of sources) {
        if (source.tvl < minPoolTvlUsd || !Number.isFinite(source.price) || source.price <= 0) continue;
        qualifying.push({
          stablecoinId: row.stablecoin_id,
          poolId: `${row.stablecoin_id}:${source.protocol}:${source.chain}`,
          chain: source.chain,
          protocol: source.protocol,
          sourceFamily: "legacy-price-sources",
          priceUsd: source.price,
          tvlUsd: source.tvl,
          snapshotAt: row.updated_at,
          publishedAt: row.updated_at,
        });
      }
      if (qualifying.length > 0) {
        challengersByStablecoin.set(row.stablecoin_id, qualifying);
        fallbackCoins.add(row.stablecoin_id);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[challenger-persistence] Unexpected error loading legacy price-source challengers:", msg);
    }
  }

  return { challengersByStablecoin, topPoolCoins, fallbackCoins };
}

export async function loadPublishedDexPoolChallengers(
  db: D1Database,
  minPoolTvlUsd: number,
  maxAgeSec: number,
  nowSec: number,
): Promise<DexPriceChallengerLoadResult> {
  const state = await detectDexPriceChallengerTableState(db);
  const legacy = await loadLegacyDexPoolChallengers(db, minPoolTvlUsd, maxAgeSec, nowSec);

  if (!state.challengersTable || !state.snapshotsTable) {
    return {
      challengersByStablecoin: legacy.challengersByStablecoin,
      diagnostics: {
        mode:
          legacy.topPoolCoins.size > 0 || legacy.fallbackCoins.size > 0
            ? "legacy"
            : "absent",
        missingTables: true,
        emptyPublishedCoins: [],
        incompletePublishedCoins: [],
        legacyFallbackCoins: [...new Set([...legacy.topPoolCoins, ...legacy.fallbackCoins])],
        staleSnapshotCoins: [],
      },
    };
  }

  const challengersByStablecoin = new Map<string, DexPriceChallengerLoadRow[]>();
  const emptyPublishedCoins: string[] = [];
  const incompletePublishedCoins: string[] = [];
  const staleSnapshotCoins: string[] = [];
  const legacyFallbackCoins = new Set<string>();
  const publishedCoins = new Set<string>();
  const legacyUsedCoins = new Set<string>();

  let snapshotRows: Array<{
    stablecoin_id: string;
    snapshot_at: number;
    published_at: number;
    has_rows: number;
    source_coverage_complete: number;
  }> = [];
  try {
    const snapshots = await db
      .prepare(
        `SELECT stablecoin_id, snapshot_at, published_at, has_rows, source_coverage_complete
         FROM dex_price_challenger_snapshots
         WHERE stablecoin_id != '__global__'`,
      )
      .all<{
        stablecoin_id: string;
        snapshot_at: number;
        published_at: number;
        has_rows: number;
        source_coverage_complete: number;
      }>();
    snapshotRows = snapshots.results ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[challenger-persistence] Unexpected error loading challenger snapshots:", msg);
    }
    return {
      challengersByStablecoin: legacy.challengersByStablecoin,
      diagnostics: {
        mode: legacy.challengersByStablecoin.size > 0 ? "legacy" : "absent",
        missingTables: true,
        emptyPublishedCoins: [],
        incompletePublishedCoins: [],
        legacyFallbackCoins: [...new Set([...legacy.topPoolCoins, ...legacy.fallbackCoins])],
        staleSnapshotCoins: [],
      },
    };
  }

  const snapshotByCoin = new Map(snapshotRows.map((row) => [row.stablecoin_id, row]));

  let challengerRows: Array<{
    stablecoin_id: string;
    snapshot_at: number;
    pool_id: string;
    chain: string;
    protocol: string;
    source_family: string;
    price_usd: number;
    tvl_usd: number;
  }> = [];
  try {
    const challengers = await db
      .prepare(
        `SELECT stablecoin_id, snapshot_at, pool_id, chain, protocol, source_family, price_usd, tvl_usd
         FROM dex_price_challengers
         WHERE stablecoin_id != '__global__'`,
      )
      .all<{
        stablecoin_id: string;
        snapshot_at: number;
        pool_id: string;
        chain: string;
        protocol: string;
        source_family: string;
        price_usd: number;
        tvl_usd: number;
      }>();
    challengerRows = challengers.results ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[challenger-persistence] Unexpected error loading challenger rows:", msg);
    }
    return {
      challengersByStablecoin: legacy.challengersByStablecoin,
      diagnostics: {
        mode: legacy.challengersByStablecoin.size > 0 ? "legacy" : "absent",
        missingTables: true,
        emptyPublishedCoins: [],
        incompletePublishedCoins: [],
        legacyFallbackCoins: [...new Set([...legacy.topPoolCoins, ...legacy.fallbackCoins])],
        staleSnapshotCoins: [],
      },
    };
  }

  const rowsByCoinAndSnapshot = new Map<string, DexPriceChallengerLoadRow[]>();
  for (const row of challengerRows) {
    if (row.snapshot_at == null) continue;
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
      publishedAt: snapshotByCoin.get(row.stablecoin_id)?.published_at ?? row.snapshot_at,
    });
    rowsByCoinAndSnapshot.set(key, existing);
  }

  for (const snapshot of snapshotRows) {
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

  for (const coinId of [...legacy.topPoolCoins, ...legacy.fallbackCoins]) {
    if (publishedCoins.has(coinId)) continue;
    if (!legacyFallbackCoins.has(coinId) && snapshotByCoin.has(coinId)) continue;
    const legacyRows = legacy.challengersByStablecoin.get(coinId);
    if (legacyRows && legacyRows.length > 0) {
      challengersByStablecoin.set(coinId, legacyRows);
      legacyFallbackCoins.add(coinId);
      legacyUsedCoins.add(coinId);
    }
  }

  for (const coinId of legacy.challengersByStablecoin.keys()) {
    if (challengersByStablecoin.has(coinId)) continue;
    if (publishedCoins.has(coinId)) continue;
    if (!snapshotByCoin.has(coinId)) {
      challengersByStablecoin.set(coinId, legacy.challengersByStablecoin.get(coinId) ?? []);
      legacyFallbackCoins.add(coinId);
      legacyUsedCoins.add(coinId);
    }
  }

  const hasPublished = publishedCoins.size > 0;
  const hasLegacy = legacyUsedCoins.size > 0;
  const mode: DexPriceChallengerLoadDiagnostics["mode"] =
    hasPublished && hasLegacy ? "mixed" : hasPublished ? "published" : hasLegacy ? "legacy" : "absent";

  return {
    challengersByStablecoin,
    diagnostics: {
      mode,
      missingTables: false,
      emptyPublishedCoins,
      incompletePublishedCoins,
      legacyFallbackCoins: [...legacyFallbackCoins],
      staleSnapshotCoins,
    },
  };
}
