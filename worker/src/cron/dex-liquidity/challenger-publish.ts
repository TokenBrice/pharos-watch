import { chunkArray } from "@shared/lib/collections";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { throwIfAborted } from "../../lib/abort";
import { batchExecute, executeAtomicBatch } from "../../lib/db";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
import { requireFiniteNumber } from "../../lib/number-utils";
import type { PoolEntry } from "./types";
import { projectRetainedPoolPrice } from "./scoring-helpers";
import { SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS } from "../../lib/cron-timeouts";

export interface DexPriceChallengerPoolRow {
  stablecoinId: string;
  poolId: string;
  chain: string;
  protocol: string;
  sourceFamily: string;
  priceUsd: number;
  tvlUsd: number;
  priceObservedAt: number | null;
}


const CHALLENGER_COVERAGE_TARGET = 0.95;
const CHALLENGER_HARD_CAP = 50;
/** Bound prepared challenger rows independently of the full active asset set. */
export const DEX_PRICE_CHALLENGER_BATCH_SIZE = 25;
const CHALLENGER_D1_MAX_BOUND_PARAMETERS = 100;
const CHALLENGER_PAYLOAD_COLUMN_COUNT = 9;
const CHALLENGER_VALUES_TOKEN = "__CHALLENGER_VALUES__";
const DEX_PRICE_CHALLENGER_PAYLOAD_INSERT_SQL =
  `INSERT INTO dex_price_challenger_payloads_v2
    (publication_id, stablecoin_id, pool_id, chain, protocol, source_family, price_usd, tvl_usd, price_observed_at)
   VALUES ${CHALLENGER_VALUES_TOKEN}
   ON CONFLICT(publication_id, stablecoin_id, pool_id) DO NOTHING`;

function prepareMultiRowStatements(
  db: D1Database,
  rows: readonly (readonly unknown[])[],
): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  if (rows.some((row) => row.length !== CHALLENGER_PAYLOAD_COLUMN_COUNT)) {
    throw new Error(
      `DEX challenger publication expected ${CHALLENGER_PAYLOAD_COLUMN_COUNT} binds per row`,
    );
  }

  const rowsPerStatement = Math.floor(
    CHALLENGER_D1_MAX_BOUND_PARAMETERS / CHALLENGER_PAYLOAD_COLUMN_COUNT,
  );
  return chunkArray(rows, rowsPerStatement).map((rowChunk) => {
    const placeholders = `(${new Array(CHALLENGER_PAYLOAD_COLUMN_COUNT).fill("?").join(", ")})`;
    const valuesSql = new Array(rowChunk.length).fill(placeholders).join(", ");
    return db
      .prepare(
        DEX_PRICE_CHALLENGER_PAYLOAD_INSERT_SQL.replace(
          CHALLENGER_VALUES_TOKEN,
          valuesSql,
        ),
      )
      .bind(...rowChunk.flat());
  });
}



export function selectDexPriceChallengerRowsFromPools(
  stablecoinId: string,
  pools: PoolEntry[],
  minPoolTvlUsd: number,
): DexPriceChallengerPoolRow[] {
  const qualifying = pools.flatMap((pool): DexPriceChallengerPoolRow[] => {
    if (isBlockedDexId(pool.project)) return [];
    const price = projectRetainedPoolPrice(pool);
    if (!price || price.tvl < minPoolTvlUsd) return [];
    return [{
      stablecoinId,
      poolId: pool.poolId,
      chain: price.chain,
      protocol: price.protocol,
      sourceFamily: price.sourceFamily!,
      priceUsd: price.price,
      tvlUsd: price.tvl,
      priceObservedAt: price.observedAt ?? null,
    }];
  }).sort((a, b) => b.tvlUsd - a.tvlUsd || a.poolId.localeCompare(b.poolId));

  if (qualifying.length === 0) return [];

  // Dedupe by the same bounded quote support used for admission and packing.
  const byPoolId = new Map<string, (typeof qualifying)[number]>();
  for (const pool of qualifying) {
    const prev = byPoolId.get(pool.poolId);
    if (!prev || pool.tvlUsd > prev.tvlUsd) byPoolId.set(pool.poolId, pool);
  }
  const dedupedQualifying = [...byPoolId.values()].sort(
    (a, b) => b.tvlUsd - a.tvlUsd || a.poolId.localeCompare(b.poolId),
  );

  const totalQualifyingTvl = dedupedQualifying.reduce((sum, pool) => sum + pool.tvlUsd, 0);

  const poolsByProtocol = new Map<string, (typeof dedupedQualifying)[number][]>();
  for (const pool of dedupedQualifying) {
    const protocolPools = poolsByProtocol.get(pool.protocol) ?? [];
    protocolPools.push(pool);
    poolsByProtocol.set(pool.protocol, protocolPools);
  }

  // Preserve the protocol diversity consumed by pool-challenge replacement
  // before the TVL coverage target can truncate a smaller independent venue.
  const protocolRepresentatives = [...poolsByProtocol.entries()]
    .map(([protocol, protocolPools]) => ({
      protocol,
      totalTvlUsd: protocolPools.reduce((sum, pool) => sum + pool.tvlUsd, 0),
      pool: protocolPools[0]!,
    }))
    .sort((a, b) =>
      b.totalTvlUsd - a.totalTvlUsd ||
      a.protocol.localeCompare(b.protocol) ||
      a.pool.poolId.localeCompare(b.pool.poolId)
    )
    .slice(0, CHALLENGER_HARD_CAP);

  const selectedPoolIds = new Set(protocolRepresentatives.map(({ pool }) => pool.poolId));
  const selectedPools = protocolRepresentatives.map(({ pool }) => pool);
  let retainedTvl = selectedPools.reduce((sum, pool) => sum + pool.tvlUsd, 0);

  for (const pool of dedupedQualifying) {
    if (selectedPools.length >= CHALLENGER_HARD_CAP) break;
    if (retainedTvl / totalQualifyingTvl >= CHALLENGER_COVERAGE_TARGET) break;
    if (selectedPoolIds.has(pool.poolId)) continue;

    selectedPools.push(pool);
    selectedPoolIds.add(pool.poolId);
    retainedTvl += pool.tvlUsd;
  }

  return selectedPools;
}

export async function publishDexPriceChallengerSnapshots(
  db: D1Database,
  input: {
    snapshotAt: number;
    generationId: string;
    retainedPoolsByStablecoin: Map<string, PoolEntry[]>;
    minPoolTvlUsd: number;
    consumeRetainedPools?: boolean;
  },
  signal?: AbortSignal,
): Promise<{ publishedStablecoins: number; skippedStablecoins: number }> {
  const snapshotAt = Math.floor(requireFiniteNumber(input.snapshotAt, "dex-price-challengers: snapshotAt"));
  if (!input.generationId.trim()) throw new Error("DEX challenger publication requires a generation id");
  const publicationAt = Math.floor(Date.now() / 1000);
  // Twice the platform wall ceiling protects every still-running invocation,
  // including its final in-flight D1 write; source snapshot age is unrelated.
  const abandonedBefore = publicationAt - 2 * SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS / 1000;
  throwIfAborted(signal);
  // Allocate before staging: equal source clocks never share payload membership.
  const publication = await db.prepare(
    `INSERT INTO dex_price_challenger_publications_v2 (generation_id, snapshot_at, published_at)
     VALUES (?, ?, ?) RETURNING publication_id`,
  ).bind(input.generationId, snapshotAt, publicationAt).first<{ publication_id: number }>();
  if (!publication) throw new Error("DEX challenger publication allocation failed");
  const publicationId = publication.publication_id;
  const pending: D1PreparedStatement[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await batchExecute(db, pending.splice(0), { chunkSize: DEX_PRICE_CHALLENGER_BATCH_SIZE, signal });
  };
  for (const meta of ACTIVE_STABLECOINS) {
    throwIfAborted(signal);
    const pools = input.retainedPoolsByStablecoin.get(meta.id) ?? [];
    const rows = selectDexPriceChallengerRowsFromPools(meta.id, pools, input.minPoolTvlUsd);
    if (input.consumeRetainedPools) {
      input.retainedPoolsByStablecoin.delete(meta.id);
      pools.length = 0;
    }
    const statementCount = Math.ceil(rows.length / Math.floor(
      CHALLENGER_D1_MAX_BOUND_PARAMETERS / CHALLENGER_PAYLOAD_COLUMN_COUNT,
    ));
    if (pending.length + statementCount > DEX_PRICE_CHALLENGER_BATCH_SIZE) await flush();
    for (const statement of prepareMultiRowStatements(db, rows.map((row) => [
      publicationId, row.stablecoinId, row.poolId, row.chain, row.protocol,
      row.sourceFamily, row.priceUsd, row.tvlUsd, row.priceObservedAt,
    ]))) {
      pending.push(statement);
      if (pending.length >= DEX_PRICE_CHALLENGER_BATCH_SIZE) await flush();
    }
  }
  if (input.consumeRetainedPools) input.retainedPoolsByStablecoin.clear();
  await flush();
  // One transaction exposes exact membership (including empty), only while this
  // liquidity generation is current. Sequence CAS rejects same-clock losers.
  const results = await executeAtomicBatch(db, [
    db.prepare(
      "UPDATE dex_price_challenger_publications_v2 SET sealed = 1 WHERE publication_id = ?",
    ).bind(publicationId),
    db.prepare(
      `INSERT INTO dex_price_challenger_heads_v2 (stablecoin_id, publication_id, has_rows)
       SELECT CAST(coins.value AS TEXT), publication.publication_id,
              CASE WHEN EXISTS (
                SELECT 1 FROM dex_price_challenger_payloads_v2 payload
                 WHERE payload.publication_id = publication.publication_id
                   AND payload.stablecoin_id = CAST(coins.value AS TEXT)
              ) THEN 1 ELSE 0 END
         FROM dex_price_challenger_publications_v2 publication, json_each(?) coins
        WHERE publication.publication_id = ? AND coins.type = 'text'
          AND (EXISTS (
            SELECT 1 FROM dex_price_challenger_heads_v2 head
             WHERE head.stablecoin_id = CAST(coins.value AS TEXT)
          ) OR NOT EXISTS (
            SELECT 1 FROM dex_price_challenger_snapshots legacy
             WHERE legacy.stablecoin_id = CAST(coins.value AS TEXT)
               AND legacy.snapshot_at > publication.snapshot_at
          ))
          AND EXISTS (
            SELECT 1 FROM dex_liquidity current
            JOIN dex_liquidity_publication_generations generation
              ON generation.generation_id = current.publication_generation_id
             WHERE current.stablecoin_id = '__global__'
               AND current.publication_state = 'published'
               AND current.publication_generation_id = publication.generation_id
               AND current.updated_at = publication.snapshot_at
               AND generation.state = 'published'
               AND generation.expected_row_count > 0
               AND generation.current_row_count = generation.expected_row_count
               AND (SELECT COUNT(*) FROM dex_liquidity_run_rows staged
                     WHERE staged.generation_id = generation.generation_id) = generation.expected_row_count
               AND (SELECT COUNT(*) FROM dex_liquidity published
                     WHERE published.publication_generation_id = generation.generation_id
                       AND published.publication_state = 'published') = generation.expected_row_count
          )
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         publication_id = excluded.publication_id, has_rows = excluded.has_rows
       WHERE dex_price_challenger_heads_v2.publication_id < excluded.publication_id
         AND (SELECT snapshot_at FROM dex_price_challenger_publications_v2
               WHERE publication_id = dex_price_challenger_heads_v2.publication_id)
             <= (SELECT snapshot_at FROM dex_price_challenger_publications_v2
                  WHERE publication_id = excluded.publication_id)`,
    ).bind(JSON.stringify(ACTIVE_STABLECOINS.map((meta) => meta.id)), publicationId),
    // Accepted heads protect current membership. Recent unsealed publications
    // protect concurrent writers; abandoned staging drains child-before-parent.
    db.prepare(
      `DELETE FROM dex_price_challenger_payloads_v2 WHERE rowid IN (
         SELECT payload.rowid FROM dex_price_challenger_payloads_v2 payload
         JOIN dex_price_challenger_publications_v2 publication
           ON publication.publication_id = payload.publication_id
        WHERE payload.publication_id < ?
          AND (publication.sealed = 1 OR publication.published_at < ?)
          AND EXISTS (SELECT 1 FROM dex_price_challenger_heads_v2 accepted
                       WHERE accepted.publication_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM dex_price_challenger_heads_v2 head
             WHERE head.publication_id = payload.publication_id
               AND head.stablecoin_id = payload.stablecoin_id
          )
        ORDER BY payload.publication_id, payload.stablecoin_id, payload.pool_id LIMIT ?
       )`,
    ).bind(publicationId, abandonedBefore, publicationId, CHALLENGER_HARD_CAP * DEX_PRICE_CHALLENGER_BATCH_SIZE),
    db.prepare(
      `DELETE FROM dex_price_challenger_publications_v2 WHERE publication_id IN (
         SELECT publication.publication_id FROM dex_price_challenger_publications_v2 publication
        WHERE publication.publication_id < ?
          AND (publication.sealed = 1 OR publication.published_at < ?)
          AND EXISTS (SELECT 1 FROM dex_price_challenger_heads_v2 accepted
                       WHERE accepted.publication_id = ?)
          AND NOT EXISTS (SELECT 1 FROM dex_price_challenger_heads_v2 head
                           WHERE head.publication_id = publication.publication_id)
          AND NOT EXISTS (SELECT 1 FROM dex_price_challenger_payloads_v2 payload
                           WHERE payload.publication_id = publication.publication_id)
        ORDER BY publication.publication_id LIMIT ?
       )`,
    ).bind(publicationId, abandonedBefore, publicationId, DEX_PRICE_CHALLENGER_BATCH_SIZE),
  ], { signal, returnResults: true });
  const publishedStablecoins = Number(results[1]?.meta?.changes ?? 0);
  return { publishedStablecoins, skippedStablecoins: ACTIVE_STABLECOINS.length - publishedStablecoins };
}
