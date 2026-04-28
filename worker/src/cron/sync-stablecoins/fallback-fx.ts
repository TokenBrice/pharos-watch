import {
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
} from "./pricing";
import { loadFreshFxRates } from "./shared";
import type {
  FallbackFxInput,
  FallbackFxOutput,
} from "./fallback-types";

export async function hydrateFallbackFxPhase(
  input: FallbackFxInput,
): Promise<FallbackFxOutput> {
  const { fxFallbackRates, validationReferences } = await loadFreshFxRates(
    input.db,
    input.syncStartSec,
    "[sync-stablecoins:fallback]",
  );

  return {
    fxFallbackRates,
    validationReferences,
    validationContexts: createValidationContextResolver(),
    previousTrustedPrices: buildPreviousTrustedPriceLookup(
      input.previousAssetsById,
      input.syncStartSec,
    ),
  };
}
