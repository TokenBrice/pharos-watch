import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/cron-lease";
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
/** Bound prepared challenger rows independently of the full active asset set. */
export const DEX_PRICE_CHALLENGER_BATCH_SIZE = 25;
const CHALLENGER_D1_MAX_BOUND_PARAMETERS = 100;
const CHALLENGER_PAYLOAD_COLUMN_COUNT = 8;
const CHALLENGER_CLEANUP_ID_BATCH_SIZE = CHALLENGER_D1_MAX_BOUND_PARAMETERS - 1;

function chunkRows<T>(rows: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

function prepareMultiRowStatements(
  db: D1Database,
  sqlPrefix: string,
  conflictClause: string,
  rows: readonly (readonly unknown[])[],
  columnCount: number,
): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  if (rows.some((row) => row.length !== columnCount)) {
    throw new Error(`DEX challenger publication expected ${columnCount} binds per row`);
  }

  const rowsPerStatement = Math.floor(CHALLENGER_D1_MAX_BOUND_PARAMETERS / columnCount);
  return chunkRows(rows, rowsPerStatement).map((rowChunk) => {
    const placeholders = `(${new Array(columnCount).fill("?").join(", ")})`;
    return db
      .prepare(`${sqlPrefix} VALUES ${new Array(rowChunk.length).fill(placeholders).join(", ")} ${conflictClause}`)
      .bind(...rowChunk.flat());
  });
}

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
    consumeRetainedPools?: boolean;
  },
  signal?: AbortSignal,
): Promise<{
  publishedStablecoins: number;
  skippedStablecoins: number;
  missingTables: boolean;
}> {
  const snapshotAt = Math.floor(requireFiniteNumber(input.snapshotAt, "dex-price-challengers: snapshotAt"));
  const state = await detectDexPriceChallengerTableState(db);
  if (!state.challengersTable || !state.snapshotsTable) {
    if (input.consumeRetainedPools) {
      for (const pools of input.retainedPoolsByStablecoin.values()) pools.length = 0;
      input.retainedPoolsByStablecoin.clear();
    }
    return {
      publishedStablecoins: 0,
      skippedStablecoins: ACTIVE_STABLECOINS.length,
      missingTables: true,
    };
  }

  const pendingPayloadStatements: D1PreparedStatement[] = [];
  const flushPendingPayloadStatements = async (): Promise<void> => {
    if (pendingPayloadStatements.length === 0) return;
    let batch: D1PreparedStatement[] | null = pendingPayloadStatements.splice(
      0,
      pendingPayloadStatements.length,
    );
    try {
      await batchExecute(db, batch, {
        chunkSize: DEX_PRICE_CHALLENGER_BATCH_SIZE,
        signal,
      });
    } finally {
      batch = null;
    }
  };
  const queuePayloadStatement = async (statement: D1PreparedStatement): Promise<void> => {
    pendingPayloadStatements.push(statement);
    if (pendingPayloadStatements.length >= DEX_PRICE_CHALLENGER_BATCH_SIZE) {
      await flushPendingPayloadStatements();
    }
  };
  const publishedStablecoinIds: string[] = [];
  let publishedStablecoins = 0;
  let skippedStablecoins = 0;

  for (const meta of ACTIVE_STABLECOINS) {
    throwIfAborted(signal);
    const stablecoinId = meta.id;
    const retainedPools = input.retainedPoolsByStablecoin.get(stablecoinId) ?? [];
    const rows = selectDexPriceChallengerRowsFromPools(
      stablecoinId,
      retainedPools,
      input.minPoolTvlUsd,
    );
    if (input.consumeRetainedPools) {
      input.retainedPoolsByStablecoin.delete(stablecoinId);
      retainedPools.length = 0;
    }
    const plan = buildDexPriceChallengerPublicationPlan({
      stablecoinId,
      snapshotAt,
      rows,
      sourceCoverageComplete: input.sourceCoverageCompleteByStablecoin.get(stablecoinId) ?? false,
    });
    if (!plan.shouldPublishSnapshot) {
      skippedStablecoins++;
      continue;
    }

    publishedStablecoins++;
    const payloadRows = plan.payloadStatements.map((statement) => statement.binds);
    const payloadStatements = prepareMultiRowStatements(
      db,
      `INSERT INTO dex_price_challengers
        (stablecoin_id, snapshot_at, pool_id, chain, protocol, source_family, price_usd, tvl_usd)`,
      `ON CONFLICT(stablecoin_id, snapshot_at, pool_id) DO UPDATE SET
         chain = excluded.chain,
         protocol = excluded.protocol,
         source_family = excluded.source_family,
         price_usd = excluded.price_usd,
         tvl_usd = excluded.tvl_usd`,
      payloadRows,
      CHALLENGER_PAYLOAD_COLUMN_COUNT,
    );
    for (const statement of payloadStatements) {
      await queuePayloadStatement(statement);
    }
    if (plan.snapshotStatement != null) {
      publishedStablecoinIds.push(plan.stablecoinId);
    }
  }

  if (input.consumeRetainedPools) input.retainedPoolsByStablecoin.clear();
  await flushPendingPayloadStatements();

  // Snapshot pointers are the public visibility boundary. Publish every
  // complete asset together only after all payload rows have landed. One
  // set-based statement avoids retaining hundreds of binds and prepared
  // statements at this all-or-none boundary.
  if (publishedStablecoinIds.length > 0) {
    const publishedIdsJson = JSON.stringify(publishedStablecoinIds);
    const snapshotResult = await runWithOverloadRetry(
      () =>
        db.prepare(
          `INSERT INTO dex_price_challenger_snapshots (
             stablecoin_id, snapshot_at, published_at, has_rows, source_coverage_complete
           )
           SELECT CAST(stablecoin_ids.value AS TEXT),
                  ?,
                  ?,
                  CASE WHEN EXISTS (
                    SELECT 1
                      FROM dex_price_challengers payload
                     WHERE payload.stablecoin_id = CAST(stablecoin_ids.value AS TEXT)
                       AND payload.snapshot_at = ?
                  ) THEN 1 ELSE 0 END,
                  1
             FROM json_each(?) stablecoin_ids
            WHERE stablecoin_ids.type = 'text'
           ON CONFLICT(stablecoin_id) DO UPDATE SET
             snapshot_at = excluded.snapshot_at,
             published_at = excluded.published_at,
             has_rows = excluded.has_rows,
             source_coverage_complete = excluded.source_coverage_complete`,
        ).bind(snapshotAt, snapshotAt, snapshotAt, publishedIdsJson).run(),
      3,
      signal,
    );
    const snapshotChanges = Number(snapshotResult.meta?.changes ?? 0);
    if (snapshotChanges !== publishedStablecoinIds.length) {
      throw new Error(
        `DEX challenger snapshot publication wrote ${snapshotChanges}/${publishedStablecoinIds.length} pointers`,
      );
    }
  }

  const cleanupStatements = chunkRows(publishedStablecoinIds, CHALLENGER_CLEANUP_ID_BATCH_SIZE).map((idChunk) =>
    db
      .prepare(
        `DELETE FROM dex_price_challengers
         WHERE snapshot_at < ?
           AND stablecoin_id IN (${new Array(idChunk.length).fill("?").join(", ")})`,
      )
      .bind(snapshotAt, ...idChunk)
  );
  await batchExecute(db, cleanupStatements, {
    chunkSize: DEX_PRICE_CHALLENGER_BATCH_SIZE,
    signal,
  });

  return {
    publishedStablecoins,
    skippedStablecoins,
    missingTables: false,
  };
}
