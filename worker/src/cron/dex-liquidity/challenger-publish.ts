import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { batchExecute } from "../../lib/db";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
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

export interface DexPriceChallengerTableState {
  challengersTable: boolean;
  snapshotsTable: boolean;
}

interface DexPriceChallengerSqlStatement {
  sql: string;
  binds: unknown[];
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
    /* non-blocking: challenger tables may not exist yet; treat as absent so callers skip challenger logic */
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
        (row.poolId ?? "").trim(),
        (row.chain ?? "").trim(),
        (row.protocol ?? "").trim(),
        (row.sourceFamily ?? "").trim(),
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
      !isBlockedDexId(pool.project) &&
      Number.isFinite(pool.price) &&
      (pool.price ?? 0) > 0 &&
      Number.isFinite(pool.tvlUsd) &&
      pool.tvlUsd >= minPoolTvlUsd,
    )
    .sort((a, b) => b.tvlUsd - a.tvlUsd || a.poolId.localeCompare(b.poolId));

  if (qualifying.length === 0) return [];

  // Dedupe qualifying pools by poolId, preferring the higher-TVL row
  const byPoolId = new Map<string, (typeof qualifying)[number]>();
  for (const pool of qualifying) {
    const prev = byPoolId.get(pool.poolId);
    if (!prev || pool.tvlUsd > prev.tvlUsd) byPoolId.set(pool.poolId, pool);
  }
  const dedupedQualifying = [...byPoolId.values()].sort(
    (a, b) => b.tvlUsd - a.tvlUsd || a.poolId.localeCompare(b.poolId),
  );

  const totalQualifyingTvl = dedupedQualifying.reduce((sum, pool) => sum + pool.tvlUsd, 0);
  const rows: DexPriceChallengerPoolRow[] = [];
  let retainedTvl = 0;

  for (const pool of dedupedQualifying) {
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
