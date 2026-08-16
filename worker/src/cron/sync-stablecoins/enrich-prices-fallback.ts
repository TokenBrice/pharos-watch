import { logWorkerEventArgs } from "../../lib/structured-log";
import { hasMissingPrice, type PeggedAsset } from "./enrich-prices-shared";
import { runCoingeckoLowVolumePass, runDlContractPasses, runCmcPass, runDexScreenerPass, runJupiterPass } from "./enrich-prices-passes";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";

export interface EnrichmentPassCounts {
  pass1: number;
  pass1b: number;
  passCmc: number;
  passJupiter: number;
  passDex: number;
  passCgLowVolume: number;
}

interface EnrichmentPassResult {
  counts: Partial<EnrichmentPassCounts>;
  failures?: string[];
  diagnostics?: PricingProviderAttemptDiagnostic[];
}

interface EnrichmentPassContext {
  assets: PeggedAsset[];
  cmcApiKey?: string;
  coingeckoApiKey?: string | null;
  jupiterApiKey?: string | null;
  db?: D1Database;
  fxRates?: Record<string, number>;
  signal?: AbortSignal;
  previousMissingGenerationsById?: ReadonlyMap<string, number>;
  onProgress?: EnrichmentPassProgressReporter;
}

interface EnrichmentPassDefinition {
  key: keyof EnrichmentPassCounts;
  label: string;
  failureLabel?: string;
  run: (context: EnrichmentPassContext) => Promise<EnrichmentPassResult>;
}

export interface EnrichmentPassProgress {
  phase: "pass-start" | "pass-complete" | "pass-failed";
  passKey: keyof EnrichmentPassCounts;
  passLabel: string;
  passIndex: number;
  passTotal: number;
  missingBeforePass: number;
  missingAfterPass: number;
  counts: EnrichmentPassCounts;
  failedPasses: string[];
}

export type EnrichmentPassProgressReporter = (progress: EnrichmentPassProgress) => void | Promise<void>;

const FALLBACK_PRICE_PASSES: readonly EnrichmentPassDefinition[] = [
  {
    key: "pass1",
    label: "DefiLlama contracts",
    run: async ({ assets, fxRates, db, signal }) => {
      const result = await runDlContractPasses(assets, fxRates, signal, db);
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
    key: "passCmc",
    label: "CoinMarketCap",
    failureLabel: "coinmarketcap",
    run: async ({ assets, cmcApiKey, fxRates, db, signal }) => {
      const result = await runCmcPass(assets, cmcApiKey, fxRates, db, signal);
      return {
        counts: {
          passCmc: result.resolved,
        },
        failures: result.failures,
        diagnostics: result.diagnostics,
      };
    },
  },
  {
    key: "passJupiter",
    label: "Jupiter",
    failureLabel: "jupiter",
    run: async ({ assets, fxRates, db, signal, jupiterApiKey }) => {
      const result = await runJupiterPass(assets, fxRates, db, signal, jupiterApiKey);
      return {
        counts: {
          passJupiter: result.resolved,
        },
        failures: result.failures,
        diagnostics: result.diagnostics,
      };
    },
  },
  {
    key: "passDex",
    label: "DexScreener",
    failureLabel: "dexscreener",
    run: async ({ assets, fxRates, db, signal, previousMissingGenerationsById }) => {
      const result = await runDexScreenerPass(assets, fxRates, db, signal, previousMissingGenerationsById);
      return {
        counts: {
          passDex: result.resolved,
        },
        failures: result.failures,
        diagnostics: result.diagnostics,
      };
    },
  },
  {
    key: "passCgLowVolume",
    label: "CoinGecko low-volume",
    failureLabel: "coingecko-low-volume",
    run: async ({ assets, coingeckoApiKey, fxRates, db, signal }) => {
      const result = await runCoingeckoLowVolumePass(assets, coingeckoApiKey, fxRates, db, signal);
      return {
        counts: {
          passCgLowVolume: result.resolved,
        },
        failures: result.failures,
      };
    },
  },
];

function createEmptyEnrichmentCounts(): EnrichmentPassCounts {
  return {
    pass1: 0,
    pass1b: 0,
    passCmc: 0,
    passJupiter: 0,
    passDex: 0,
    passCgLowVolume: 0,
  };
}

export async function runEnrichmentPasses(context: EnrichmentPassContext): Promise<{
  counts: EnrichmentPassCounts;
  failedPasses: string[];
  providerDiagnostics: PricingProviderAttemptDiagnostic[];
}> {
  const counts = createEmptyEnrichmentCounts();
  const failedPasses: string[] = [];
  const providerDiagnostics: PricingProviderAttemptDiagnostic[] = [];

  for (const [passIndex, pass] of FALLBACK_PRICE_PASSES.entries()) {
    const missingBeforePass = context.assets.filter(hasMissingPrice).length;
    await context.onProgress?.({
      phase: "pass-start",
      passKey: pass.key,
      passLabel: pass.label,
      passIndex,
      passTotal: FALLBACK_PRICE_PASSES.length,
      missingBeforePass,
      missingAfterPass: missingBeforePass,
      counts,
      failedPasses: [...failedPasses],
    });
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
      if (result.diagnostics?.length) {
        providerDiagnostics.push(...result.diagnostics);
      }
      await context.onProgress?.({
        phase: "pass-complete",
        passKey: pass.key,
        passLabel: pass.label,
        passIndex,
        passTotal: FALLBACK_PRICE_PASSES.length,
        missingBeforePass,
        missingAfterPass: context.assets.filter(hasMissingPrice).length,
        counts,
        failedPasses: [...failedPasses],
      });
    } catch (err) {
      if (context.signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      logWorkerEventArgs("handler", "warn", `[sync-stablecoins] ${pass.label} enrichment failed:`, err);
      if (pass.failureLabel) {
        failedPasses.push(pass.failureLabel);
      }
      await context.onProgress?.({
        phase: "pass-failed",
        passKey: pass.key,
        passLabel: pass.label,
        passIndex,
        passTotal: FALLBACK_PRICE_PASSES.length,
        missingBeforePass,
        missingAfterPass: context.assets.filter(hasMissingPrice).length,
        counts,
        failedPasses: [...failedPasses],
      });
    }
  }

  return { counts, failedPasses, providerDiagnostics };
}
