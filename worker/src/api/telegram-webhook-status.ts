import { getCirculatingRaw } from "@shared/lib/supply";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../lib/dex-liquidity";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { getMintBurnConfigsForStablecoin } from "../lib/mint-burn-contracts";
import { perCoinFlowCacheKey } from "./mint-burn-flows-shared";
import { getCache } from "../lib/db-cache";
import { safeJsonParse } from "../lib/api-cache-read";
import { loadStressSignalCurrentRowForCoin } from "../lib/stress-signals-current-rows";
import {
  loadActiveSafetyScoreSource,
  type ActiveSafetyScoreSource,
} from "../lib/safety-score-active-source";

/** 24h mint/burn flow older than this is "stale": shown on /status with age, omitted from the terse alert Context line. */
const MINT_BURN_FLOW_STALE_SEC = 6 * 3600;

/**
 * Data loader for the `/status <ticker>` command.
 *
 * Sources:
 * - published `stress_signals` generation for the latest DEWS band + score per coin
 * - canonical Safety Score V9 publication and identity
 * - `depeg_events`            only rows with `ended_at IS NULL` (an active event)
 * - `price_cache`             latest cached price by `asset_id = stablecoin_id`
 *
 * Peg math is NOT recomputed here. If a user wants live deviation context on a
 * stable coin, the formatted message links back to the Pharos detail page.
 */

export interface StatusForCoin {
  stablecoinId: string;
  priceUsd: number | null;
  priceUpdatedAt: number | null;
  supplyUsd: number | null;
  stablecoinsUpdatedAt: number | null;
  dews: { band: string; score: number; computedAt: number } | null;
  safety: {
    grade: string;
    score: number | null;
    model: "v9";
    methodologyVersion: string;
    publicationGenerationId: string;
    publishedAt: number;
    /** Compatibility alias for status consumers that label the publication age. */
    recordedAt: number;
  } | null;
  safetyUnavailableReason?: string | null;
  liquidity: {
    score: number | null;
    totalTvlUsd: number;
    updatedAt: number;
  } | null;
  yield: {
    currentApy: number;
    apy30d: number;
    source: string;
    pharosYieldScore: number | null;
    pysUnavailableReason?: string | null;
    updatedAt: number;
  } | null;
  flow: { netFlowUsd: number; updatedAt: number; stale: boolean } | null;
  depeg:
    | { status: "stable" }
    | {
        status: "active";
        direction: "above" | "below";
        peakDeviationBps: number;
        pegReference: number;
        startedAt: number;
      };
}

interface TelegramSafetyState {
  unavailableReason: string | null;
  source: Extract<ActiveSafetyScoreSource, { kind: "v9" }> | null;
}

async function loadTelegramSafetyState(db: D1Database): Promise<TelegramSafetyState> {
  let activeSource;
  try {
    activeSource = await loadActiveSafetyScoreSource(db);
  } catch {
    return {
      unavailableReason: "active-source-unavailable",
      source: null,
    };
  }

  if (activeSource.kind !== "v9") {
    return {
      unavailableReason: activeSource.reason,
      source: null,
    };
  }
  return {
    unavailableReason: null,
    source: activeSource,
  };
}

export async function loadStatusForCoin(db: D1Database, stablecoinId: string): Promise<StatusForCoin> {
  const nowSec = Math.floor(Date.now() / 1000);
  const isMintBurnTracked = getMintBurnConfigsForStablecoin(stablecoinId).length > 0;
  const [dewsRow, safetyState, depegRow, priceRow, liquidityRow, yieldRow, stablecoinsCache, flowCache] =
    await Promise.all([
      loadStressSignalCurrentRowForCoin(db, stablecoinId, nowSec, { staleAfterSec: 30 * 60 }),
      loadTelegramSafetyState(db),
      db
        .prepare(
          "SELECT direction, peak_deviation_bps, peg_reference, started_at FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
        )
        .bind(stablecoinId)
        .first<{
          direction: "above" | "below";
          peak_deviation_bps: number;
          peg_reference: number;
          started_at: number;
        }>(),
      db
        .prepare("SELECT price, updated_at FROM price_cache WHERE asset_id = ?")
        .bind(stablecoinId)
        .first<{ price: number; updated_at: number }>(),
      db
        .prepare(
          `SELECT liquidity_score, total_tvl_usd, updated_at
         FROM dex_liquidity
         WHERE stablecoin_id = ?
           AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
        )
        .bind(stablecoinId)
        .first<{ liquidity_score: number | null; total_tvl_usd: number; updated_at: number }>(),
      db
        .prepare(
          `SELECT current_apy, apy_30d, yield_source, pharos_yield_score, updated_at
           FROM yield_data
          WHERE stablecoin_id = ? AND is_best = 1
            AND (publication_generation_id IS NULL OR publication_state = 'published')
          ORDER BY pharos_yield_score DESC, apy_30d DESC
          LIMIT 1`,
        )
        .bind(stablecoinId)
        .first<{
          current_apy: number;
          apy_30d: number;
          yield_source: string;
          pharos_yield_score: number | null;
          updated_at: number;
        }>(),
      loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true }).catch(() => null),
      isMintBurnTracked ? getCache(db, perCoinFlowCacheKey(stablecoinId, 24)).catch(() => null) : Promise.resolve(null),
    ]);

  let flow: StatusForCoin["flow"] = null;
  if (flowCache) {
    const parsed = safeJsonParse<{ netFlowUsd?: unknown; updatedAt?: unknown } | null>(
      flowCache.value,
      null,
      "telegram-status-flow",
    );
    if (parsed && typeof parsed.netFlowUsd === "number" && Number.isFinite(parsed.netFlowUsd)) {
      const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : flowCache.updatedAt;
      flow = { netFlowUsd: parsed.netFlowUsd, updatedAt, stale: nowSec - updatedAt > MINT_BURN_FLOW_STALE_SEC };
    }
  }

  let supplyUsd: number | null = null;
  let stablecoinsUpdatedAt: number | null = null;
  if (stablecoinsCache?.kind === "ok") {
    const asset = stablecoinsCache.payload.peggedAssets.find((candidate) => candidate.id === stablecoinId);
    supplyUsd = asset ? getCirculatingRaw(asset) : null;
    stablecoinsUpdatedAt = stablecoinsCache.updatedAt;
  }

  const safetyCard =
    safetyState.source !== null
      ? safetyState.source.snapshot.cards.find((card) => card.id === stablecoinId)
      : null;

  return {
    stablecoinId,
    priceUsd: priceRow?.price ?? null,
    priceUpdatedAt: priceRow?.updated_at ?? null,
    supplyUsd,
    stablecoinsUpdatedAt,
    dews: dewsRow ? { band: dewsRow.band, score: dewsRow.score, computedAt: dewsRow.computed_at } : null,
    safety:
      safetyCard && safetyState.source !== null
        ? {
            grade: safetyCard.grade,
            score: safetyCard.score,
            model: safetyState.source.snapshot.safetyScoreIdentity.model,
            methodologyVersion: safetyState.source.snapshot.safetyScoreIdentity.methodologyVersion,
            publicationGenerationId:
              safetyState.source.snapshot.safetyScoreIdentity.publicationGenerationId,
            publishedAt: safetyState.source.snapshot.updatedAt,
            recordedAt: safetyState.source.snapshot.updatedAt,
          }
        : null,
    safetyUnavailableReason: safetyState.source === null ? safetyState.unavailableReason : null,
    liquidity: liquidityRow
      ? {
          score: liquidityRow.liquidity_score,
          totalTvlUsd: liquidityRow.total_tvl_usd,
          updatedAt: liquidityRow.updated_at,
        }
      : null,
    yield: yieldRow
      ? {
          currentApy: yieldRow.current_apy,
          apy30d: yieldRow.apy_30d,
          source: yieldRow.yield_source,
          pharosYieldScore: null,
          pysUnavailableReason: "pys-v8-retired",
          updatedAt: yieldRow.updated_at,
        }
      : null,
    flow,
    depeg: depegRow
      ? {
          status: "active",
          direction: depegRow.direction,
          peakDeviationBps: depegRow.peak_deviation_bps,
          pegReference: depegRow.peg_reference,
          startedAt: depegRow.started_at,
        }
      : { status: "stable" },
  };
}
