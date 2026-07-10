import { chunkArray } from "./db";

export interface MintBurnHourlyPair {
  stablecoinId: string;
  chainId: string;
}

export interface MintBurnFirstHourRow {
  stablecoin_id: string;
  chain_id: string;
  first_hour_ts: number;
}

export type MintBurnFirstHourQueryFamily = "flows" | "status";

const FIRST_HOUR_PAIRS_PER_STATEMENT = 45;

const QUERY_COMMENTS: Record<MintBurnFirstHourQueryFamily, string> = {
  flows: "pharos:mint-burn-flows:first-hour-seek",
  status: "pharos:status-derived:mint-burn-first-hour-seek",
};

function uniquePairs(pairs: readonly MintBurnHourlyPair[]): MintBurnHourlyPair[] {
  const byKey = new Map<string, MintBurnHourlyPair>();
  for (const pair of pairs) {
    byKey.set(`${pair.stablecoinId}|${pair.chainId}`, pair);
  }
  return [...byKey.values()];
}

export function buildMintBurnFirstHourSeekStatements(
  db: D1Database,
  pairs: readonly MintBurnHourlyPair[],
  queryFamily: MintBurnFirstHourQueryFamily,
): D1PreparedStatement[] {
  return chunkArray(uniquePairs(pairs), FIRST_HOUR_PAIRS_PER_STATEMENT).map((chunk) => {
    const valuesSql = chunk.map(() => "(?, ?)").join(", ");
    const binds = chunk.flatMap((pair) => [pair.stablecoinId, pair.chainId]);
    const queryComment = QUERY_COMMENTS[queryFamily];
    return db
      .prepare(
        `SELECT /* ${queryComment}; MIN(hour_ts) as first_hour_ts via seek */
                requested.column1 AS stablecoin_id,
                requested.column2 AS chain_id,
                (
                  SELECT h.hour_ts
                    FROM mint_burn_hourly h INDEXED BY idx_mbh_chain_coin_hour
                   WHERE h.chain_id = requested.column2
                     AND h.stablecoin_id = requested.column1
                   ORDER BY h.hour_ts ASC
                   LIMIT 1
                ) AS first_hour_ts
           FROM (VALUES ${valuesSql}) AS requested`,
      )
      .bind(...binds);
  });
}

export async function loadMintBurnFirstHourRows(
  db: D1Database,
  pairs: readonly MintBurnHourlyPair[],
  queryFamily: MintBurnFirstHourQueryFamily,
): Promise<MintBurnFirstHourRow[]> {
  const statements = buildMintBurnFirstHourSeekStatements(db, pairs, queryFamily);
  if (statements.length === 0) return [];
  const results = await db.batch<{
    stablecoin_id: string;
    chain_id: string;
    first_hour_ts: number | null;
  }>(statements);
  return results
    .flatMap((result) => result.results ?? [])
    .filter((row): row is MintBurnFirstHourRow => row.first_hour_ts != null);
}
