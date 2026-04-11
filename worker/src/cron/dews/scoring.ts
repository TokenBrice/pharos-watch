import { z } from "zod";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { PSI_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { getPegReference } from "@shared/lib/peg-rates";
import { computeDEWS } from "../../lib/dews";
import type { DEWSInput, PoolEntry } from "../../lib/dews";
import type {
  DewsScoringResult,
  DewsScoringState,
  PersistedJsonDecodeReason,
} from "./contracts";
import { decodeJsonString } from "../../lib/cache-json";

const RawPoolDataSchema = z.object({
  tvlUsd: z.number().default(0),
  extra: z.object({
    balanceRatio: z.number(),
  }).optional(),
});

const BLACKLIST_SYMBOL_SET = new Set<string>(BLACKLIST_STABLECOINS);
const BLACKLIST_ID_TO_SYMBOL = new Map<string, string>();
for (const meta of PSI_ELIGIBLE_STABLECOINS) {
  const symbol = typeof meta.symbol === "string" ? meta.symbol.toUpperCase() : "";
  if (!BLACKLIST_SYMBOL_SET.has(symbol)) continue;
  BLACKLIST_ID_TO_SYMBOL.set(meta.id, symbol);
}

interface BuildDewsScoringResultOptions extends DewsScoringState {
  registerMalformedPersistedInput: (options: {
    source: string;
    context: string;
    stablecoinId: string;
    updatedAt?: number | null;
    reason: PersistedJsonDecodeReason;
    degradesRun: boolean;
  }) => void;
}

function buildTopPools(
  stablecoinId: string,
  topPoolsJson: string | null,
  updatedAt: number | null,
  registerMalformedPersistedInput: BuildDewsScoringResultOptions["registerMalformedPersistedInput"],
): PoolEntry[] | null {
  if (!topPoolsJson) return null;

  const decoded = decodeJsonString<unknown[], PersistedJsonDecodeReason>(topPoolsJson, {
    mode: "degraded",
    updatedAt,
    missingReason: "missing",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => Array.isArray(parsed)
      ? { ok: true, payload: parsed }
      : { ok: false, reason: "invalid-shape" as const },
  });

  if (!decoded.ok) {
    registerMalformedPersistedInput({
      source: "dex_liquidity",
      context: "dex_liquidity.top_pools_json",
      stablecoinId,
      updatedAt,
      reason: decoded.reason,
      degradesRun: false,
    });
    return null;
  }

  return decoded.payload.map((rawPool) => {
    const parsedPool = RawPoolDataSchema.safeParse(rawPool);
    return {
      tvlUsd: parsedPool.success ? parsedPool.data.tvlUsd : 0,
      balanceRatio: parsedPool.success ? (parsedPool.data.extra?.balanceRatio ?? 1.0) : 1.0,
    };
  });
}

export function buildDewsScoringResult(options: BuildDewsScoringResultOptions): DewsScoringResult {
  const { assetById, pegRates, registerMalformedPersistedInput, sourceState } = options;
  const results: DewsScoringResult["results"] = [];
  let liqHistCoverageCount = 0;
  let insufficientDataCount = 0;
  const noCurrentSupplyIds: string[] = [];

  for (const meta of PSI_ELIGIBLE_STABLECOINS) {
    if (meta.flags?.navToken) continue;

    const asset = assetById.get(meta.id);
    if (!asset) continue;

    const current = getCirculatingRaw(asset);
    if (current <= 0) {
      noCurrentSupplyIds.push(meta.id);
      continue;
    }

    const prevDay = getPrevDayRaw(asset);
    const prevWeek = getPrevWeekRaw(asset);

    const dexLiq = sourceState.dexLiqMap.get(meta.id);
    const dexPrice = sourceState.dexPriceMap.get(meta.id);
    const liqHist = sourceState.liqHist7dMap.get(meta.id);
    if (liqHist) liqHistCoverageCount++;
    const prev = sourceState.prevSignals.get(meta.id);
    const mintBurn = sourceState.mintBurnMap.get(meta.id);

    const blacklistSymbol = BLACKLIST_ID_TO_SYMBOL.get(meta.id);
    const blacklistCounts = blacklistSymbol ? sourceState.blacklistCounts.get(blacklistSymbol) : undefined;

    const topPools = buildTopPools(
      meta.id,
      dexLiq?.top_pools_json ?? null,
      dexLiq?.updated_at ?? null,
      registerMalformedPersistedInput,
    );

    const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
    const input: DEWSInput = {
      stablecoinId: meta.id,
      mcapUsd: current,
      pegType: asset.pegType ?? "peggedUSD",
      circulatingCurrent: current,
      circulatingPrevDay: prevDay || current,
      circulatingPrevWeek: prevWeek || current,
      weightedBalanceRatio: dexLiq?.weighted_balance_ratio ?? null,
      avgPoolStress: dexLiq?.avg_pool_stress ?? null,
      topPools,
      liquidityScore: dexLiq?.liquidity_score ?? null,
      liquidityScore7dAgo: liqHist?.score ?? null,
      tvlCurrent: dexLiq?.total_tvl_usd ?? null,
      tvl7dAgo: liqHist?.tvl ?? null,
      priceConfidence: asset.priceConfidence ?? null,
      prevPriceConfidence: (prev?.price as { confidence?: string })?.confidence ?? null,
      price: asset.price ?? null,
      pegRef: pegRef ?? 1.0,
      dexPriceUsd: dexPrice?.dexPriceUsd ?? null,
      blacklistEvents24h: blacklistCounts?.count24h ?? 0,
      blacklistEvents7d: blacklistCounts?.count7d ?? 0,
      hasBlacklistTracking: Boolean(blacklistSymbol),
      burnVolume24hUsd: mintBurn?.burn24h ?? null,
      mintVolume24hUsd: mintBurn?.mint24h ?? null,
      burnBaseline30dUsd: mintBurn?.burnBaseline ?? null,
      flowDataAgeDays: mintBurn?.dataAgeDays ?? 0,
      yieldWarnings: sourceState.yieldWarnings.get(meta.id) ?? [],
      psiScore: sourceState.latestPsiScore,
      prevPoolValue: (prev?.pool as { value?: number })?.value,
      prevDivergValue: (prev?.diverg as { value?: number })?.value,
    };

    const result = computeDEWS(input);
    if (!result) {
      insufficientDataCount++;
      continue;
    }

    results.push({
      stablecoinId: meta.id,
      score: result.score,
      band: result.band,
      signals: result.signals,
    });
  }

  return {
    results,
    liqHistCoverageCount,
    insufficientDataCount,
    noCurrentSupplyIds,
  };
}
