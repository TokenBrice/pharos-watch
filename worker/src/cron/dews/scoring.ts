import { z } from "zod";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { PSI_ELIGIBLE_STABLECOINS } from "@shared/lib/psi-eligible";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { getPegReference } from "@shared/lib/peg-rates";
import { computeDEWS } from "../../lib/dews";
import type { DEWSInput, DEWSResult, PoolEntry } from "../../lib/dews";
import type {
  ContagionAmplifiers,
  DewsScoringResult,
  DewsScoringState,
  PersistedJsonDecodeReason,
} from "./contracts";
import { decodeJsonString } from "../../lib/cache-json";
import {
  CONTAGION_BUMP_DANGER,
  CONTAGION_BUMP_WARNING,
  CONTAGION_AMPLIFIER_CAP,
} from "../../lib/constants";

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

  const scored: Array<{ meta: typeof PSI_ELIGIBLE_STABLECOINS[number]; input: DEWSInput; firstPass: DEWSResult }> = [];
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
      contagionAmplifier: 1,
    };

    const firstPass = computeDEWS(input);
    if (!firstPass) {
      insufficientDataCount++;
      continue;
    }
    scored.push({ meta, input, firstPass });
  }

  const amplifiers: ContagionAmplifiers = { byPegType: {}, triggeringIds: [] };
  for (const { input, firstPass } of scored) {
    const bump =
      firstPass.band === "DANGER" ? CONTAGION_BUMP_DANGER :
      firstPass.band === "WARNING" ? CONTAGION_BUMP_WARNING :
      1;
    if (bump <= 1) continue;
    const current = amplifiers.byPegType[input.pegType] ?? 1;
    if (bump > current) {
      amplifiers.byPegType[input.pegType] = Math.min(bump, CONTAGION_AMPLIFIER_CAP);
    }
    amplifiers.triggeringIds.push(input.stablecoinId);
  }

  // A first-pass DANGER/WARNING coin keeps its first-pass result (contagion = 1)
  // so it never amplifies itself.
  for (const { meta, input, firstPass } of scored) {
    const contagion = amplifiers.byPegType[input.pegType] ?? 1;
    const applicable = contagion > 1 && firstPass.band !== "DANGER" && firstPass.band !== "WARNING";
    const finalResult = applicable
      ? computeDEWS({ ...input, contagionAmplifier: contagion })
      : firstPass;
    if (!finalResult) {
      insufficientDataCount++;
      continue;
    }
    results.push({
      stablecoinId: meta.id,
      score: finalResult.score,
      band: finalResult.band,
      signals: finalResult.signals,
      amplifiers: finalResult.amplifiers,
    });
  }

  return {
    results,
    liqHistCoverageCount,
    insufficientDataCount,
    noCurrentSupplyIds,
  };
}
