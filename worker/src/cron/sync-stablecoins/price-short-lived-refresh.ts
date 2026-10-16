import type { ChainRpcConfig } from "../../lib/chain-registry";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { hasPublishableCurrentPrice } from "../../lib/price-publication-state";
import { runDlContractPasses } from "./enrich-prices-defillama-pass";
import { runJupiterPass } from "./enrich-prices-jupiter-pass";
import type { EnrichPassResult } from "./enrich-prices-pass-common";
import type { PeggedAsset } from "./enrich-prices-shared";
import { applyTrackedAssetOverrides } from "./phase-helpers";
import type { PriceCorroborationObservation } from "./price-corroboration-observations";
import { clearPriceMetadata } from "./shared";

// Each existing fallback pass is serial and gets a bounded slot envelope.
// Quote admission, source clocks, request caps and circuit ownership stay in the passes.
const PASS_BUDGET_MS = 25_000;

export interface ShortLivedRefreshSummary {
  cohortSize: number;
  resolved: number;
  failedPasses: string[];
  timedOut: boolean;
}

export async function runShortLivedPriceRefresh(params: {
  assets: PeggedAsset[];
  db?: D1Database;
  fxRates?: Record<string, number>;
  signal?: AbortSignal;
  jupiterApiKey?: string | null;
  chainRpcs?: Map<string, ChainRpcConfig>;
  reviewedGapIds?: ReadonlySet<string>;
}): Promise<{
  contractRefresh: ShortLivedRefreshSummary;
  jupiterRefresh: ShortLivedRefreshSummary;
  observations: PriceCorroborationObservation[];
}> {
  const observations: PriceCorroborationObservation[] = [];
  const runPass = async (
    source: string,
    run: (assets: PeggedAsset[], signal: AbortSignal) => Promise<EnrichPassResult>,
  ): Promise<ShortLivedRefreshSummary> => {
    const assets = params.assets.filter((asset) => {
      if (!ACTIVE_META_BY_ID.has(asset.id)) return false;
      const hasCurrentPrice = hasPublishableCurrentPrice(asset);
      const sourceOwned = splitCompositePriceSource(asset.priceSource ?? "").includes(source);
      return (!params.reviewedGapIds?.has(asset.id) || (hasCurrentPrice && sourceOwned)) &&
        (sourceOwned || !hasCurrentPrice);
    }).map((asset) => ({ ...asset }));
    applyTrackedAssetOverrides(assets);
    for (const asset of assets) clearPriceMetadata(asset);
    const summary: ShortLivedRefreshSummary = {
      cohortSize: assets.length, resolved: 0, failedPasses: [], timedOut: false,
    };
    if (assets.length === 0) return summary;
    const timeout = createTimeoutSignal({ timeoutMs: PASS_BUDGET_MS,
      timeoutReason: new DOMException(`${source} refresh deadline`, "TimeoutError"), parentSignal: params.signal });
    try {
      const result = await run(assets, timeout.signal);
      summary.failedPasses = result.failures;
      for (const asset of assets) {
        if (!hasPublishableCurrentPrice(asset) || asset.priceSource !== source || asset.priceObservedAt == null) continue;
        observations.push({ id: asset.id, source, price: asset.price!,
          observedAt: asset.priceObservedAt, observedAtMode: asset.priceObservedAtMode ?? null });
        summary.resolved++;
      }
    } catch (error) {
      rethrowIfAborted(error, params.signal);
      if (!timeout.isTimedOut()) throw error;
      summary.timedOut = true;
      summary.failedPasses.push(`${source}-timeout`);
    } finally { timeout.dispose(); }
    throwIfAborted(params.signal);
    return summary;
  };

  const contractRefresh = await runPass("defillama-contract", (assets, signal) =>
    runDlContractPasses(assets, params.fxRates, signal, params.db));
  const jupiterRefresh = await runPass("jupiter", (assets, signal) =>
    runJupiterPass(assets, params.fxRates, params.db, signal, params.jupiterApiKey, params.chainRpcs));
  return { contractRefresh, jupiterRefresh, observations };
}
