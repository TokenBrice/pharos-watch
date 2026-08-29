import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { weightedMedian } from "@shared/lib/stats";
import { relativeBps } from "@shared/lib/depeg-signals";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { executeAtomicBatch } from "../../lib/db";
import { writeFreshnessSentinel } from "../../lib/db-cache";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { logWorkerEvent, logWorkerEventArgs } from "../../lib/structured-log";
import type { PriceValidationReferences } from "../../lib/price-validation";
import type { DexPriceObs, LiquidityMetrics } from "./types";
import { dexPriceConfidenceForSourceFamily } from "./constants";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import { aggregateProtocolSources, buildDexPriceObservationsFromRetainedPools, collapseDuplicateObservations } from "./scoring-helpers";
import { DEX_LIQUIDITY_SCORING_BATCH_SIZE, assertCurrentDexScoringGeneration, flushScoringStatements, pruneExpiredDexPriceStages, type DexPriceStageRetentionResult } from "./dex-scoring-stage-store";

const PRIMARY_PRICE_OUTLIER_MAX_DEVIATION_RATIO = 2.5;
const DISPLAY_PRICE_RATIO_MIN = 0.5,
  DISPLAY_PRICE_RATIO_MAX = 2.0;

// The completeness fence compares the generation's row counts against the
// generation's own recorded expectation, not the running bundle's active
// roster. A published generation stays internally complete after a roster
// change deploys (coin added/quarantined); the next publication slot mints a
// generation under the new roster. Comparing against the build-time constant
// here made every odd-hour reuse slot inside a roster-change window fail
// with "not the complete current publication" while all counts were equal
// (observed 2026-08-18 23:16Z after the SILK quarantine shipped).
const DEX_PRICE_EXACT_CURRENT_GENERATION_SQL = `
  SELECT generation.generation_id
  FROM dex_liquidity_publication_generations generation
  WHERE generation.generation_id = ?
    AND generation.state = 'published'
    AND generation.expected_row_count > 0
    AND generation.current_row_count = generation.expected_row_count
    AND (SELECT COUNT(*)
         FROM dex_liquidity_run_rows staged
         WHERE staged.generation_id = generation.generation_id) = generation.expected_row_count
    AND (SELECT COUNT(*)
         FROM dex_liquidity current
         WHERE current.publication_generation_id = generation.generation_id
           AND current.publication_state = 'published') = generation.expected_row_count
    AND EXISTS (
      SELECT 1
      FROM dex_liquidity current_global
      WHERE current_global.stablecoin_id = '__global__'
        AND current_global.publication_generation_id = generation.generation_id
        AND current_global.publication_state = 'published'
    )
    AND (SELECT COUNT(*)
         FROM dex_price_run_rows price_stage
         WHERE price_stage.generation_id = generation.generation_id) = ?`;

function dexPriceExactCurrentGenerationBinds(generationId: string, priceRowCount: number): unknown[] {
  return [generationId, priceRowCount];
}

/** Compute DEX-implied prices from the final retained pool set and persist to dex_prices. */
export interface DexPricePersistenceDiagnostics {
  rejectedObservationCount: number;
  rejectedByStablecoin: Array<{
    stablecoinId: string;
    reason: "peg-impossible";
    observations: Array<{
      chain: string;
      protocol: string;
      poolKey: string | null;
      price: number;
      tvl: number;
      sourceFamily: string | null;
    }>;
    truncated: number;
  }>;
  truncatedStablecoins: number;
  retention?: DexPriceStageRetentionResult;
}

const MAX_DEX_PRICE_REJECTION_ASSETS = 20;
const MAX_DEX_PRICE_REJECTIONS_PER_ASSET = 5;

export async function computeDexPrices(
  db: D1Database,
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>,
  nowSec: number,
  references?: PriceValidationReferences,
  signal?: AbortSignal,
  exactPriceEvidenceByStablecoin?: Map<string, DexPriceObs[]>,
  generationId = `dex-liquidity-${nowSec}`,
  preloadedPrimaryPrices?: Map<string, number>,
): Promise<DexPricePersistenceDiagnostics> {
  if (!generationId.trim()) throw new Error("DEX price publication requires a generation id");
  throwIfAborted(signal);
  await assertCurrentDexScoringGeneration(db, generationId, signal);
  const retention = await pruneExpiredDexPriceStages(db, generationId, nowSec, signal);
  if (retention.error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "expired_price_stage_prune_failed",
      job: "sync-dex-liquidity",
      message: "Failed to prune expired DEX price stages",
      error: retention.error,
    });
  }
  const existingRows = await db.prepare("SELECT stablecoin_id FROM dex_prices").all<{ stablecoin_id: string }>();
  const existingIds = new Set((existingRows.results ?? []).map((row) => row.stablecoin_id));
  throwIfAborted(signal);
  await db.prepare("DELETE FROM dex_price_run_rows WHERE generation_id = ?").bind(generationId).run();
  throwIfAborted(signal);

  const primaryPrices = new Map(preloadedPrimaryPrices);
  // A supplied map is already trust-filtered; missing entries are intentional.
  let loadedStrictPrimaryPrices = preloadedPrimaryPrices !== undefined;
  const loadPrimaryPrices = async (stablecoinId: string): Promise<Map<string, number>> => {
    if (primaryPrices.has(stablecoinId) || loadedStrictPrimaryPrices) return primaryPrices;
    loadedStrictPrimaryPrices = true;
    const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict" });
    if (stablecoinsCache.kind === "ok") {
      for (const asset of stablecoinsCache.payload.peggedAssets) {
        if (
          !primaryPrices.has(asset.id)
          && asset.price != null
          && typeof asset.price === "number"
          && asset.price > 0
        ) {
          primaryPrices.set(asset.id, asset.price);
        }
      }
    }
    return primaryPrices;
  };

  const priceStmts: D1PreparedStatement[] = [];
  const queuePriceStatement = async (statement: D1PreparedStatement): Promise<void> => {
    priceStmts.push(statement);
    if (priceStmts.length >= DEX_LIQUIDITY_SCORING_BATCH_SIZE) {
      await flushScoringStatements(db, priceStmts, signal);
    }
  };
  const observedIds = new Set<string>();
  let collapsedDuplicateGroups = 0;
  let collapsedDuplicateObservations = 0;
  let rejectedObservationCount = 0;
  let rejectedStablecoinCount = 0;
  const rejectedByStablecoin: DexPricePersistenceDiagnostics["rejectedByStablecoin"] = [];
  for (const [id, retainedPools] of retainedPoolsByStablecoin) {
    throwIfAborted(signal);
    const observations =
      buildDexPriceObservationsFromRetainedPools(new Map([[id, retainedPools]]), exactPriceEvidenceByStablecoin).get(
        id,
      ) ?? [];
    if (observations.length === 0) continue;
    const prices = await loadPrimaryPrices(id);

    const {
      collapsed: collapsedObservations,
      duplicateGroups,
      duplicateObservations,
    } = collapseDuplicateObservations(observations);
    collapsedDuplicateGroups += duplicateGroups;
    collapsedDuplicateObservations += duplicateObservations;
    if (collapsedObservations.length === 0) continue;

    // Validate before selecting the aggregate so an impossible quote cannot
    // enter dex_prices while merely being hidden from price_sources_json.
    const plausibleObservations: DexPriceObs[] = [];
    const rejectedObservations: DexPriceObs[] = [];
    for (const observation of collapsedObservations) {
      (isPlausibleDexObservationPrice(id, observation.price, references)
        ? plausibleObservations
        : rejectedObservations
      ).push(observation);
    }
    if (rejectedObservations.length > 0) {
      rejectedObservationCount += rejectedObservations.length;
      rejectedStablecoinCount++;
      if (rejectedByStablecoin.length < MAX_DEX_PRICE_REJECTION_ASSETS) {
        rejectedByStablecoin.push({
          stablecoinId: id,
          reason: "peg-impossible",
          observations: rejectedObservations.slice(0, MAX_DEX_PRICE_REJECTIONS_PER_ASSET).map((observation) => ({
            chain: observation.chain,
            protocol: observation.protocol,
            poolKey: observation.poolKey ?? null,
            price: observation.price,
            tvl: observation.tvl,
            sourceFamily: observation.sourceFamily ?? null,
          })),
          truncated: Math.max(0, rejectedObservations.length - MAX_DEX_PRICE_REJECTIONS_PER_ASSET),
        });
      }
    }
    if (plausibleObservations.length === 0) continue;
    observedIds.add(id);

    // Look up primary price early — used for outlier filtering and deviation calc
    const primaryPrice = prices.get(id);

    // Filter extreme outliers relative to primary price before computing median.
    // When a source (e.g. CoinGecko aggregate) reports a price near peg for a severely
    // depegged stablecoin, its high TVL can dominate the TVL-weighted median.
    // Only apply when 3+ observations exist and majority by count agrees with primary.
    let medianInputObs = plausibleObservations;
    if (primaryPrice != null && primaryPrice > 0 && plausibleObservations.length >= 3) {
      const nearPrimary = plausibleObservations.filter((o) => {
        const ratio = o.price / primaryPrice;
        return (
          ratio >= 1 / PRIMARY_PRICE_OUTLIER_MAX_DEVIATION_RATIO && ratio <= PRIMARY_PRICE_OUTLIER_MAX_DEVIATION_RATIO
        );
      });
      if (nearPrimary.length >= 2 && nearPrimary.length > plausibleObservations.length / 2) {
        medianInputObs = nearPrimary;
      }
    }

    // Scale TVL weights by source confidence before computing median
    const adjustedObs = medianInputObs.map((o) => ({
      ...o,
      tvl: o.tvl * dexPriceConfidenceForSourceFamily(o.sourceFamily),
    }));

    // TVL-weighted lower-discrete median. The first-observation fallback
    // preserves the scoring lane's non-empty-input contract if all adjusted
    // confidence weights are non-positive.
    const medianPrice = weightedMedian(
      adjustedObs.map((observation) => ({ value: observation.price, weight: observation.tvl })),
    ) ?? adjustedObs[0].price;

    // Raw TVL for DB storage (represents actual on-chain liquidity, not confidence-weighted)
    const totalTvl = plausibleObservations.reduce((s, o) => s + o.tvl, 0);
    let deviationBps: number | null = null;
    if (primaryPrice != null && primaryPrice > 0) {
      deviationBps = relativeBps(medianPrice, primaryPrice)?.bps ?? null;
    }

    // Guard against retained pools whose prices are off-peg for the tracked stablecoin.
    // This protects price_sources_json (the "show all sources" UI) from alias-collapse
    // contamination like Fantom USDC.e rows at $0.044 flowing into usdc-circle.priceSources.
    // The scoring-level sanity gate has a wide 1% floor to avoid rejecting legitimately
    // depegged stablecoins. For the per-protocol display surface, apply a tighter 50%
    // primary-price ratio guard on top so near-peg alias-collapse rows are filtered.
    const sanePriceObs = plausibleObservations.filter((obs) => {
      if (primaryPrice != null && primaryPrice > 0) {
        const ratio = obs.price / primaryPrice;
        if (ratio < DISPLAY_PRICE_RATIO_MIN || ratio > DISPLAY_PRICE_RATIO_MAX) return false;
      }
      return true;
    });
    const protocolSources = aggregateProtocolSources(sanePriceObs);

    const meta = TRACKED_META_BY_ID.get(id);
    const symbol = meta?.symbol ?? id;

    await queuePriceStatement(
      db
        .prepare(
          `INSERT INTO dex_price_run_rows
            (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
             deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at, generation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(generation_id, stablecoin_id) DO UPDATE SET
            symbol = excluded.symbol,
            dex_price_usd = excluded.dex_price_usd,
            source_pool_count = excluded.source_pool_count,
            source_total_tvl = excluded.source_total_tvl,
            deviation_from_primary_bps = excluded.deviation_from_primary_bps,
            primary_price_at_calc = excluded.primary_price_at_calc,
            price_sources_json = excluded.price_sources_json,
            updated_at = excluded.updated_at`,
        )
        .bind(
          id,
          symbol,
          Math.round(medianPrice * 1e6) / 1e6, // 6 decimal places
          plausibleObservations.length,
          Math.round(totalTvl),
          deviationBps,
          primaryPrice ?? null,
          JSON.stringify(protocolSources),
          nowSec,
          generationId,
        ),
    );
  }

  let retiredCount = 0;
  for (const existingId of existingIds) {
    throwIfAborted(signal);
    if (observedIds.has(existingId)) continue;
    retiredCount++;
  }

  await flushScoringStatements(db, priceStmts, signal);
  const staged = await db
    .prepare(
      `/* pharos:dex-scoring:price-stage-coverage */
       SELECT COUNT(*) AS row_count
       FROM dex_price_run_rows
       WHERE generation_id = ?`,
    )
    .bind(generationId)
    .first<{ row_count: number }>();
  if (staged?.row_count !== observedIds.size) {
    throw new Error(
      `Incomplete DEX price stage for ${generationId} (rows=${staged?.row_count ?? 0}/${observedIds.size})`,
    );
  }

  await assertCurrentDexScoringGeneration(db, generationId, signal);
  const exactGenerationBinds = dexPriceExactCurrentGenerationBinds(generationId, observedIds.size);
  const publishedChanges = await executeAtomicBatch(
    db,
    [
      db
        .prepare(
          `/* pharos:dex-scoring:price-publication-fence */
           UPDATE dex_liquidity_publication_generations
           SET written_row_count = written_row_count
           WHERE generation_id = (${DEX_PRICE_EXACT_CURRENT_GENERATION_SQL})`,
        )
        .bind(...exactGenerationBinds),
      db
        .prepare(
          `DELETE FROM dex_prices
           WHERE EXISTS (${DEX_PRICE_EXACT_CURRENT_GENERATION_SQL})`,
        )
        .bind(...exactGenerationBinds),
      db
        .prepare(
          `INSERT INTO dex_prices
            (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
             deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at)
           SELECT stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
                  deviation_from_primary_bps, primary_price_at_calc, price_sources_json, updated_at
           FROM dex_price_run_rows staged_price
           WHERE staged_price.generation_id = ?
             AND EXISTS (${DEX_PRICE_EXACT_CURRENT_GENERATION_SQL})
           ORDER BY staged_price.stablecoin_id`,
        )
        .bind(generationId, ...exactGenerationBinds),
    ],
    { signal },
  );
  const allowedPublishedChanges = new Set([1 + existingIds.size + observedIds.size, 1 + observedIds.size * 2]);
  if (!allowedPublishedChanges.has(publishedChanges)) {
    throw new Error(
      `DEX price publication fence/replacement changed ${publishedChanges} rows for ${generationId}` +
        ` (expected one of ${[...allowedPublishedChanges].join(", ")})`,
    );
  }

  const published = await db
    .prepare(
      `/* pharos:dex-scoring:price-publication-coverage */
       SELECT (SELECT COUNT(*) FROM dex_prices) AS public_row_count,
              (SELECT COUNT(*) FROM dex_prices WHERE updated_at = ?) AS generation_row_count,
              (SELECT COUNT(*) FROM dex_price_run_rows WHERE generation_id = ?) AS staged_row_count`,
    )
    .bind(nowSec, generationId)
    .first<{ public_row_count: number; generation_row_count: number; staged_row_count: number }>();
  if (
    published?.public_row_count !== observedIds.size ||
    published.generation_row_count !== observedIds.size ||
    published.staged_row_count !== observedIds.size
  ) {
    throw new Error(
      `Incomplete DEX price publication for ${generationId}` +
        ` (public=${published?.public_row_count ?? 0}/${observedIds.size},` +
        ` generation=${published?.generation_row_count ?? 0}/${observedIds.size},` +
        ` staged=${published?.staged_row_count ?? 0}/${observedIds.size})`,
    );
  }
  // The sentinel tracks the live DEX publication pipeline (prices hourly), while
  // endpoint freshness is derived from the score rows' own two-hour timestamp.
  await writeFreshnessSentinel(db, "dex-liquidity", nowSec, signal);

  try {
    const cleanup = await db.prepare("DELETE FROM dex_price_run_rows WHERE generation_id = ?").bind(generationId).run();
    const cleanedRows = Number(cleanup.meta?.changes ?? 0);
    if (cleanedRows !== observedIds.size) {
      logWorkerEventArgs("handler", "warn",
        `[dex-liquidity] DEX price stage cleanup removed ${cleanedRows}/${observedIds.size} rows for ${generationId}`,
      );
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEventArgs("handler", "warn", `[dex-liquidity] Failed to clean published DEX price stage ${generationId}: ${String(error)}`);
  }

  if (observedIds.size > 0 || retiredCount > 0) {
    logWorkerEventArgs("handler", "info",
      `[dex-liquidity] Wrote ${observedIds.size} DEX price observations to dex_prices` +
        (collapsedDuplicateGroups > 0
          ? ` after collapsing ${collapsedDuplicateObservations} duplicate observations across ${collapsedDuplicateGroups} pool group(s)`
          : "") +
        (retiredCount > 0 ? ` and retired ${retiredCount} stale rows` : ""),
    );
  }
  return {
    rejectedObservationCount,
    rejectedByStablecoin,
    truncatedStablecoins: Math.max(0, rejectedStablecoinCount - rejectedByStablecoin.length),
    retention,
  };
}
