import { getCache } from "../../lib/db-cache";
import { throwIfAborted } from "../../lib/abort";
import { hasMissingPrice, type PeggedAsset } from "./enrich-prices-shared";
import { runDlContractPasses, runCmcPass, runDexScreenerPass, runJupiterPass } from "./enrich-prices-passes";

export { buildPriceReasonablenessOptions, isReasonablePrice, PRICE_BOUNDS } from "../../lib/price-validation";
export {
  applyPoolChallenge,
  fetchPrimaryPrices,
  runGtProbePass,
  type PriceValidationStats,
  type PrimaryPriceResult,
} from "./enrich-prices-primary";

export interface DefiLlamaCoinPrice {
  price: number;
  symbol: string;
  timestamp: number;
  confidence: number;
}
export type { PeggedAsset } from "./enrich-prices-shared";
export { applyResolvedPrice, hasMissingPrice } from "./enrich-prices-shared";

export interface EnrichmentStats {
  totalMissing: number;
  pass1: number;
  pass1b: number;
  passCmc: number;
  passJupiter: number;
  passDex: number;
  finalMissing: number;
  failedPasses: string[];
}

export async function enrichMissingPrices(
  assets: PeggedAsset[],
  cmcApiKey?: string,
  db?: D1Database,
  signal?: AbortSignal,
): Promise<EnrichmentStats> {
  throwIfAborted(signal);
  const totalMissing = assets.filter(hasMissingPrice).length;
  if (totalMissing === 0) {
    return {
      totalMissing: 0,
      pass1: 0,
      pass1b: 0,
      passCmc: 0,
      passJupiter: 0,
      passDex: 0,
      finalMissing: 0,
      failedPasses: [],
    };
  }

  // Load FX rates once — shared across all passes for dynamic price bounds
  let fxRates: Record<string, number> | undefined;
  if (db) {
    try {
      const fxCache = await getCache(db, "fx-rates");
      if (fxCache) fxRates = JSON.parse(fxCache.value);
    } catch (e) {
      console.warn("[enrich-prices] Failed to load FX rates for price bounds:", e);
    }
  }

  const failedPasses: string[] = [];

  // ── Pass 1/1b: Contract addresses via DefiLlama coins API ──
  // Wrapped separately so DL failure does not abort CMC/DexScreener passes.
  const dlResult = await runDlContractPasses(assets, signal);
  const pass1Count = dlResult.pass1;
  const pass1bCount = dlResult.pass1b;
  failedPasses.push(...dlResult.failures);

  let passCmcCount = 0;
  let passJupiterCount = 0;
  let passDexCount = 0;

  try {
    const cmcResult = await runCmcPass(assets, cmcApiKey, fxRates, db, signal);
    passCmcCount = cmcResult.resolved;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] CoinMarketCap enrichment failed:", err);
    failedPasses.push("coinmarketcap");
  }

  try {
    const jupiterResult = await runJupiterPass(assets, fxRates, db, signal);
    passJupiterCount = jupiterResult.resolved;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] Jupiter enrichment failed:", err);
    failedPasses.push("jupiter");
  }

  try {
    const dexResult = await runDexScreenerPass(assets, fxRates, db, signal);
    passDexCount = dexResult.resolved;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[sync-stablecoins] DexScreener enrichment failed:", err);
    failedPasses.push("dexscreener");
  }

  const finalMissing = assets.filter(hasMissingPrice).length;
  const totalEnriched = pass1Count + pass1bCount + passCmcCount + passJupiterCount + passDexCount;
  if (totalMissing > 0) {
    console.log(
      `[enrich] ${totalMissing} assets missing prices → ` +
      `Pass 1: +${pass1Count}, Pass 1b (multi-chain): +${pass1bCount}, ` +
      `Pass 2 (CMC): +${passCmcCount}, ` +
      `Pass 3 (Jupiter): +${passJupiterCount}, ` +
      `Pass 4 (DexScreener): +${passDexCount}, still missing: ${finalMissing}`
    );
  }
  if (totalEnriched > 0) {
    console.log(`[sync-stablecoins] Enriched prices for ${totalEnriched} assets`);
  }
  return {
    totalMissing,
    pass1: pass1Count,
    pass1b: pass1bCount,
    passCmc: passCmcCount,
    passJupiter: passJupiterCount,
    passDex: passDexCount,
    finalMissing,
    failedPasses,
  };
}
