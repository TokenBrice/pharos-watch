import { chunkArray } from "@shared/lib/collections";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { throwIfAborted } from "../../lib/abort";
import { batchExecute, executeAtomicBatch } from "../../lib/db";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
import { isFreshDexPoolObservation } from "../../lib/depeg-trust-policy";
import { requireFiniteNumber } from "../../lib/number-utils";
import {
  CURVE_NAV_SPOT_QUOTE_POLICY,
  type CurveNavSpotQuoteEvidence,
  type PoolEntry,
} from "./types";
import { getDexGroupLineage, selectIndependentChallengerPools, type DexPriceLineage } from "./price-lineage";
import { CHALLENGER_LINEAGE_PRICE, hasChallengerPriceLineageColumn } from "./challenger-types";
import {
  areUniformClockedCurveNavObservations,
  buildCurveNavRejectedPoolFilter,
  canonicalCurveNavPoolKey,
  classifyPoolCurveNavIntegrityFailure,
  isIndependentlyVerifiedClockedObservation,
  isValidClockedNavCorroboratorObservation,
  matchesRejectedCurveNavPool,
  normalizeCurveNavScoringRejectionReason,
  projectRetainedPoolPrice,
  validateClockedCurveNavObservation,
  type CurveNavQuoteRejectionRecord,
} from "./scoring-helpers";
import { SCHEDULED_EVENT_WALL_CLOCK_LIMIT_MS } from "../../lib/cron-timeouts";

export interface DexPriceChallengerPoolRow extends DexPriceLineage {
  stablecoinId: string;
  poolId: string;
  chain: string;
  protocol: string;
  sourceFamily: string;
  priceUsd: number;
  tvlUsd: number;
  priceObservedAt: number | null;
  curveNavSpotQuote?: CurveNavSpotQuoteEvidence;
  quotePublishedAtSec?: number;
  quoteExpiresAtSec?: number;
}


const CHALLENGER_COVERAGE_TARGET = 0.95;
const CHALLENGER_HARD_CAP = 50;
/** Bound prepared challenger rows independently of the full active asset set. */
export const DEX_PRICE_CHALLENGER_BATCH_SIZE = 25;
const CHALLENGER_D1_MAX_BOUND_PARAMETERS = 100;
function prepareMultiRowStatements(
  db: D1Database,
  rows: readonly (readonly unknown[])[],
  storeLineage: boolean,
): D1PreparedStatement[] {
  const columnCount = storeLineage ? 10 : 9;
  if (rows.length === 0) return [];
  if (rows.some((row) => row.length !== columnCount)) {
    throw new Error(
      `DEX challenger publication expected ${columnCount} binds per row`,
    );
  }

  const rowsPerStatement = Math.floor(
    CHALLENGER_D1_MAX_BOUND_PARAMETERS / columnCount,
  );
  return chunkArray(rows, rowsPerStatement).map((rowChunk) => {
    const placeholders = `(${new Array(columnCount).fill("?").join(", ")})`;
    const valuesSql = new Array(rowChunk.length).fill(placeholders).join(", ");
    return db
      .prepare(
        `INSERT INTO dex_price_challenger_payloads_v2
          (publication_id, stablecoin_id, pool_id, chain, protocol, source_family,
           price_usd, tvl_usd, price_observed_at${storeLineage ? ", price_lineage_json" : ""})
         VALUES ${valuesSql}
         ON CONFLICT(publication_id, stablecoin_id, pool_id) DO NOTHING`,
      )
      .bind(...rowChunk.flat());
  });
}



export function projectPoolChallenger(
  stablecoinId: string,
  pool: PoolEntry,
  minPoolTvlUsd: number,
  nowSec: number,
  curveNavRejections?: readonly CurveNavQuoteRejectionRecord[],
): DexPriceChallengerPoolRow | null {
  if (isBlockedDexId(pool.project)) return null;
  if (
    pool.extra?.curveNavSpotQuoteCandidate !== undefined ||
    pool.extra?.curveNavSpotQuoteRejectedReason !== undefined
  ) {
    return null;
  }
  const rejectionFilter = curveNavRejections?.length
    ? buildCurveNavRejectedPoolFilter(curveNavRejections)
    : null;
  if (
    rejectionFilter &&
    matchesRejectedCurveNavPool(pool.poolId, pool.chain, pool.project, rejectionFilter)
  ) {
    return null;
  }
  const price = projectRetainedPoolPrice(pool, stablecoinId);
  if (!price || price.tvl < minPoolTvlUsd) return null;
  if (
    rejectionFilter?.hasIntegrityRejection &&
    price.curveNavSpotQuote == null &&
    !isIndependentlyVerifiedClockedObservation(price, nowSec)
  ) {
    return null;
  }
  let curveNavMeta:
    | {
        curveNavSpotQuote: CurveNavSpotQuoteEvidence;
        quotePublishedAtSec: number;
        quoteExpiresAtSec: number;
      }
    | undefined;
  if (pool.curveNavSpotQuote !== undefined || price.curveNavSpotQuote !== undefined) {
    if (validateClockedCurveNavObservation(price, nowSec) != null) return null;
    const quote = price.curveNavSpotQuote!;
    curveNavMeta = {
      curveNavSpotQuote: quote,
      quotePublishedAtSec: nowSec,
      quoteExpiresAtSec:
        Math.min(quote.poolRatioObservedAt, quote.quoteMarkObservedAt, nowSec) +
        CURVE_NAV_SPOT_QUOTE_POLICY.quoteMaxAgeSec,
    };
  } else {
    if (price.observedAt != null && !isFreshDexPoolObservation(price.observedAt, nowSec)) {
      return null;
    }
    if (price.counterpartyPrice?.observedAtSec != null && price.counterpartyPrice.observedAtSec > nowSec) {
      return null;
    }
  }
  const lineage = getDexGroupLineage([price]);
  if (lineage?.upstreamKeys.length === 0) return null;
  return {
    stablecoinId,
    poolId: pool.poolId,
    chain: price.chain,
    protocol: price.protocol,
    sourceFamily: price.sourceFamily!,
    priceUsd: price.price,
    tvlUsd: price.tvl,
    priceObservedAt: price.observedAt ?? null,
    ...(lineage && { pricePoolKeys: lineage.pricePoolKeys, upstreamKeys: lineage.upstreamKeys }),
    ...(curveNavMeta ?? {}),
  };
}

export function evaluateDexPriceChallengerPoolAdmission(
  stablecoinId: string,
  pools: readonly PoolEntry[],
  minPoolTvlUsd: number,
  nowSec = Math.floor(Date.now() / 1000),
  curveNavRejections?: readonly CurveNavQuoteRejectionRecord[],
): {
  qualifying: DexPriceChallengerPoolRow[];
  rowsByPool: Map<PoolEntry, DexPriceChallengerPoolRow>;
} {
  // Collect independently verified upstream-clocked non-Curve PoolEntry instances
  // (retaining exact object refs so larger unverified copies sharing poolId can
  // never inherit verification during isolation or TVL deduplication).
  const verifiedNonCurveByPoolKey = new Map<string, ReturnType<typeof projectRetainedPoolPrice> & object>();
  const verifiedNonCurvePoolRefs = new Set<PoolEntry>();
  for (const pool of pools) {
    if (pool.curveNavSpotQuote !== undefined) continue;
    const obs = projectRetainedPoolPrice(pool, stablecoinId);
    if (obs && isIndependentlyVerifiedClockedObservation(obs, nowSec) && obs.poolKey) {
      verifiedNonCurvePoolRefs.add(pool);
      const existing = verifiedNonCurveByPoolKey.get(obs.poolKey);
      if (!existing || obs.tvl > existing.tvl) verifiedNonCurveByPoolKey.set(obs.poolKey, obs);
    }
  }

  const allRejections: CurveNavQuoteRejectionRecord[] = [...(curveNavRejections ?? [])];
  for (const pool of pools) {
    const embeddedReason = pool.extra?.curveNavSpotQuoteRejectedReason;
    if (embeddedReason !== undefined) {
      allRejections.push({
        poolKey: pool.poolId,
        chain: pool.chain,
        reason: normalizeCurveNavScoringRejectionReason(embeddedReason),
      });
    }
  }
  const priorFilter = buildCurveNavRejectedPoolFilter(allRejections);
  const curveGroups = new Map<string, Array<{ pool: PoolEntry; obs: ReturnType<typeof projectRetainedPoolPrice> }>>();
  for (const pool of pools) {
    if (pool.curveNavSpotQuote === undefined) continue;
    const key = canonicalCurveNavPoolKey(pool.chain, pool.poolId) ?? pool.poolId;
    const list = curveGroups.get(key) ?? [];
    list.push({ pool, obs: projectRetainedPoolPrice(pool, stablecoinId) });
    curveGroups.set(key, list);
  }

  const admittedCurvePoolRefs = new Set<PoolEntry>();
  for (const group of curveGroups.values()) {
    const validObs = group.map((entry) => entry.obs).filter((obs): obs is NonNullable<typeof obs> => obs != null);
    if (group.length > 1 && (validObs.length !== group.length || !areUniformClockedCurveNavObservations(validObs))) {
      for (const { pool } of group) {
        allRejections.push({ poolKey: pool.poolId, chain: pool.chain, reason: "conflict" });
      }
      continue;
    }
    const admittedGroupEntries: Array<{ pool: PoolEntry; obs: NonNullable<ReturnType<typeof projectRetainedPoolPrice>> }> = [];
    let groupRejected = false;
    for (const { pool, obs } of group) {
      // Classify integrity/validity BEFORE skipping a prior pool rejection so a
      // future-dated or malformed copy of a pool-ineligible pool still triggers
      // coin-level integrity isolation.
      const failure = obs
        ? validateClockedCurveNavObservation(obs, nowSec)
        : (classifyPoolCurveNavIntegrityFailure(pool, nowSec) ?? "insufficient-support");
      if (failure != null || !obs) {
        allRejections.push({ poolKey: pool.poolId, chain: pool.chain, reason: failure ?? "invalid-policy" });
        groupRejected = true;
        continue;
      }
      if (matchesRejectedCurveNavPool(pool.poolId, pool.chain, pool.project, priorFilter)) {
        groupRejected = true;
        continue;
      }
      const quote = obs.curveNavSpotQuote!;
      if (quote.admissionMode === "corroborated") {
        const matched = [...new Set(quote.corroboratorPoolIds ?? [])]
          .map((poolId) => verifiedNonCurveByPoolKey.get(poolId))
          .filter((candidate): candidate is NonNullable<typeof candidate> =>
            candidate != null && isValidClockedNavCorroboratorObservation(candidate, obs, nowSec));
        const combinedTvl = obs.tvl + matched.reduce((sum, entry) => sum + entry.tvl, 0);
        if (matched.length === 0 || combinedTvl < CURVE_NAV_SPOT_QUOTE_POLICY.corroboratedCombinedMinTvlUsd) {
          allRejections.push({ poolKey: pool.poolId, chain: pool.chain, reason: "corroborator-missing" });
          groupRejected = true;
          continue;
        }
      }
      admittedGroupEntries.push({ pool, obs });
    }
    if (!groupRejected && admittedGroupEntries.length > 0) {
      // For identical uniform copies, retain the conservative min-TVL representative.
      const rep = [...admittedGroupEntries].sort((a, b) => a.obs.tvl - b.obs.tvl || a.pool.poolId.localeCompare(b.pool.poolId))[0]!;
      admittedCurvePoolRefs.add(rep.pool);
    }
  }

  const finalFilter = buildCurveNavRejectedPoolFilter(allRejections);
  if (finalFilter.hasIntegrityRejection) {
    admittedCurvePoolRefs.clear();
  }
  const enforceClockedIsolation = admittedCurvePoolRefs.size > 0 || finalFilter.hasIntegrityRejection;
  const rowsByPool = new Map<PoolEntry, DexPriceChallengerPoolRow>();
  const qualifying: DexPriceChallengerPoolRow[] = [];
  for (const pool of pools) {
    if (enforceClockedIsolation) {
      if (!admittedCurvePoolRefs.has(pool) && !verifiedNonCurvePoolRefs.has(pool)) continue;
    } else if (
      pool.curveNavSpotQuote !== undefined ||
      matchesRejectedCurveNavPool(pool.poolId, pool.chain, pool.project, finalFilter)
    ) {
      continue;
    }
    const row = projectPoolChallenger(stablecoinId, pool, minPoolTvlUsd, nowSec, allRejections);
    if (row) {
      rowsByPool.set(pool, row);
      qualifying.push(row);
    }
  }
  qualifying.sort((a, b) => b.tvlUsd - a.tvlUsd || a.poolId.localeCompare(b.poolId));
  return { qualifying, rowsByPool };
}

export function selectDexPriceChallengerRowsFromPools(
  stablecoinId: string,
  pools: PoolEntry[],
  minPoolTvlUsd: number,
  nowSec = Math.floor(Date.now() / 1000),
  curveNavRejections?: readonly CurveNavQuoteRejectionRecord[],
): DexPriceChallengerPoolRow[] {
  const { qualifying } = evaluateDexPriceChallengerPoolAdmission(
    stablecoinId,
    pools,
    minPoolTvlUsd,
    nowSec,
    curveNavRejections,
  );

  if (qualifying.length === 0) return [];

  // Dedupe by the same bounded quote support used for admission and packing.
  const byPoolId = new Map<string, (typeof qualifying)[number]>();
  for (const pool of qualifying) {
    const prev = byPoolId.get(pool.poolId);
    if (!prev || pool.tvlUsd > prev.tvlUsd) byPoolId.set(pool.poolId, pool);
  }
  const uniquePools = [...byPoolId.values()];
  const dedupedQualifying = selectIndependentChallengerPools(uniquePools);

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

  // Pack independent representatives first. The reader may exclude a representative
  // for primary overlap or expiry, so keep alternate receipts within the same cap.
  for (const pool of uniquePools) {
    if (selectedPools.length >= CHALLENGER_HARD_CAP) break;
    if (pool.upstreamKeys && !selectedPoolIds.has(pool.poolId)) selectedPools.push(pool);
  }
  return selectedPools;
}

/**
 * Non-display challenger projection persisted on the current/run rows. It uses
 * the same TVL-bounded membership as the v2 publication so the legacy fallback
 * does not depend on the display-oriented top-10 top_pools_json slice.
 */
export function buildStoredChallengerPoolsJson(
  stablecoinId: string,
  pools: PoolEntry[],
  minPoolTvlUsd: number,
  nowSec = Math.floor(Date.now() / 1000),
  curveNavRejections?: readonly CurveNavQuoteRejectionRecord[],
): string | null {
  const rows = selectDexPriceChallengerRowsFromPools(stablecoinId, pools, minPoolTvlUsd, nowSec, curveNavRejections);
  return rows.length === 0
    ? null
    : JSON.stringify(rows.map(({ stablecoinId: _stablecoinId, priceUsd, ...row }) =>
      row.upstreamKeys || row.curveNavSpotQuote ? { ...row, lineagePriceUsd: priceUsd } : { ...row, priceUsd }));
}

export async function publishDexPriceChallengerSnapshots(
  db: D1Database,
  input: {
    snapshotAt: number;
    admissionNowSec?: number;
    generationId: string;
    retainedPoolsByStablecoin: Map<string, PoolEntry[]>;
    minPoolTvlUsd: number;
    consumeRetainedPools?: boolean;
    curveNavRejectionsByStablecoin?: ReadonlyMap<string, ReadonlyArray<CurveNavQuoteRejectionRecord>>;
  },
  signal?: AbortSignal,
): Promise<{ publishedStablecoins: number; skippedStablecoins: number }> {
  const snapshotAt = Math.floor(requireFiniteNumber(input.snapshotAt, "dex-price-challengers: snapshotAt"));
  if (!input.generationId.trim()) throw new Error("DEX challenger publication requires a generation id");
  const storeLineage = await hasChallengerPriceLineageColumn(db);
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
    const rows = selectDexPriceChallengerRowsFromPools(
      meta.id,
      pools,
      input.minPoolTvlUsd,
      input.admissionNowSec ?? snapshotAt,
      input.curveNavRejectionsByStablecoin?.get(meta.id),
    ).filter((row) => storeLineage || (row.upstreamKeys === undefined && row.curveNavSpotQuote === undefined));
    if (input.consumeRetainedPools) {
      input.retainedPoolsByStablecoin.delete(meta.id);
      pools.length = 0;
    }
    const statementCount = Math.ceil(rows.length / Math.floor(
      CHALLENGER_D1_MAX_BOUND_PARAMETERS / (storeLineage ? 10 : 9),
    ));
    if (pending.length + statementCount > DEX_PRICE_CHALLENGER_BATCH_SIZE) await flush();
    for (const statement of prepareMultiRowStatements(db, rows.map((row) => {
      const requiresReceipt = row.upstreamKeys !== undefined || row.curveNavSpotQuote !== undefined;
      return [
        publicationId, row.stablecoinId, row.poolId, row.chain, row.protocol,
        row.sourceFamily, requiresReceipt ? CHALLENGER_LINEAGE_PRICE : row.priceUsd, row.tvlUsd, row.priceObservedAt,
        ...(storeLineage ? [requiresReceipt
          ? JSON.stringify({
              ...(row.pricePoolKeys ? { pricePoolKeys: row.pricePoolKeys } : {}),
              ...(row.upstreamKeys ? { upstreamKeys: row.upstreamKeys } : {}),
              priceUsd: row.priceUsd,
              ...(row.curveNavSpotQuote
                ? {
                    curveNavSpotQuote: row.curveNavSpotQuote,
                    quotePublishedAtSec: row.quotePublishedAtSec,
                    quoteExpiresAtSec: row.quoteExpiresAtSec,
                  }
                : {}),
            })
          : null] : []),
      ];
    }), storeLineage)) {
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
