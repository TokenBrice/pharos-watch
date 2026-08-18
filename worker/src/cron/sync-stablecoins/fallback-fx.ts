import {
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
} from "./pricing";
import { loadFreshFxRates, loadReplayPriceCacheForTrustedContinuity } from "./shared";
import type {
  FallbackFxInput,
  FallbackFxOutput,
} from "./fallback-types";

export async function hydrateFallbackFxPhase(
  input: FallbackFxInput,
): Promise<FallbackFxOutput> {
  const { fxFallbackRates, validationReferences } = await loadFreshFxRates(
    input.db,
    "[sync-stablecoins:fallback]",
  );
  const replayPriceCache = await loadReplayPriceCacheForTrustedContinuity(input.db);

  return {
    fxFallbackRates,
    validationReferences,
    validationContexts: createValidationContextResolver(),
    previousTrustedPrices: buildPreviousTrustedPriceLookup(
      input.previousAssetsById,
      input.syncStartSec,
      replayPriceCache,
    ),
    // Returned so downstream cached-fallback pricing reuses this snapshot
    // instead of loading the full price_cache table a second time per run.
    replayPriceCache,
  };
}
