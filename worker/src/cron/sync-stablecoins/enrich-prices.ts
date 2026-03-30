import { getCache } from "../../lib/db-cache";
import { throwIfAborted } from "../../lib/abort";
import { hasMissingPrice, type PeggedAsset } from "./enrich-prices-shared";
import { runDlContractPasses, runCmcPass, runDexScreenerPass, runJupiterPass } from "./enrich-prices-passes";

export { isReasonablePrice, PRICE_BOUNDS } from "../../lib/price-validation";
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

type EnrichmentPassCounts = Omit<EnrichmentStats, "totalMissing" | "finalMissing" | "failedPasses">;

interface EnrichmentPassResult {
  counts: Partial<EnrichmentPassCounts>;
  failures?: string[];
}

interface EnrichmentPassContext {
  assets: PeggedAsset[];
  cmcApiKey?: string;
  db?: D1Database;
  fxRates?: Record<string, number>;
  signal?: AbortSignal;
}

interface EnrichmentPassDefinition {
  label: string;
  failureLabel?: string;
  run: (context: EnrichmentPassContext) => Promise<EnrichmentPassResult>;
}

const FALLBACK_PRICE_PASSES: readonly EnrichmentPassDefinition[] = [
  {
    label: "DefiLlama contracts",
    run: async ({ assets, signal }) => {
      const result = await runDlContractPasses(assets, signal);
      return {
        counts: {
          pass1: result.pass1,
          pass1b: result.pass1b,
        },
        failures: result.failures,
      };
    },
  },
  {
    label: "CoinMarketCap",
    failureLabel: "coinmarketcap",
    run: async ({ assets, cmcApiKey, fxRates, db, signal }) => ({
      counts: {
        passCmc: (await runCmcPass(assets, cmcApiKey, fxRates, db, signal)).resolved,
      },
    }),
  },
  {
    label: "Jupiter",
    failureLabel: "jupiter",
    run: async ({ assets, fxRates, db, signal }) => ({
      counts: {
        passJupiter: (await runJupiterPass(assets, fxRates, db, signal)).resolved,
      },
    }),
  },
  {
    label: "DexScreener",
    failureLabel: "dexscreener",
    run: async ({ assets, fxRates, db, signal }) => ({
      counts: {
        passDex: (await runDexScreenerPass(assets, fxRates, db, signal)).resolved,
      },
    }),
  },
];

function createEmptyEnrichmentCounts(): EnrichmentPassCounts {
  return {
    pass1: 0,
    pass1b: 0,
    passCmc: 0,
    passJupiter: 0,
    passDex: 0,
  };
}

async function runEnrichmentPasses(context: EnrichmentPassContext): Promise<{
  counts: EnrichmentPassCounts;
  failedPasses: string[];
}> {
  const counts = createEmptyEnrichmentCounts();
  const failedPasses: string[] = [];

  for (const pass of FALLBACK_PRICE_PASSES) {
    try {
      const result = await pass.run(context);
      for (const [key, value] of Object.entries(result.counts) as Array<[keyof EnrichmentPassCounts, number | undefined]>) {
        if (typeof value === "number") {
          counts[key] = value;
        }
      }
      if (result.failures?.length) {
        failedPasses.push(...result.failures);
      }
    } catch (err) {
      if (context.signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      console.warn(`[sync-stablecoins] ${pass.label} enrichment failed:`, err);
      if (pass.failureLabel) {
        failedPasses.push(pass.failureLabel);
      }
    }
  }

  return { counts, failedPasses };
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

  // ── Pass 1/1b: Contract addresses via DefiLlama coins API ──
  // Wrapped separately so DL failure does not abort CMC/DexScreener passes.
  const {
    counts: {
      pass1: pass1Count,
      pass1b: pass1bCount,
      passCmc: passCmcCount,
      passJupiter: passJupiterCount,
      passDex: passDexCount,
    },
    failedPasses,
  } = await runEnrichmentPasses({
    assets,
    cmcApiKey,
    db,
    fxRates,
    signal,
  });

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
