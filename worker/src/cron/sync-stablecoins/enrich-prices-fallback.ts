import type { PeggedAsset } from "./enrich-prices-shared";
import { runDlContractPasses, runCmcPass, runDexScreenerPass, runJupiterPass } from "./enrich-prices-passes";

export interface EnrichmentPassCounts {
  pass1: number;
  pass1b: number;
  passCmc: number;
  passJupiter: number;
  passDex: number;
}

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
    run: async ({ assets, fxRates, signal }) => {
      const result = await runDlContractPasses(assets, fxRates, signal);
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

export async function runEnrichmentPasses(context: EnrichmentPassContext): Promise<{
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
