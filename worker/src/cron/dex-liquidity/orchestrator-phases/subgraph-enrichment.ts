import { rethrowIfAborted } from "../../../lib/abort";
import type { PriceValidationReferences } from "../../../lib/price-validation";
import { fetchUniV3Data, fetchAerodromeData } from "../fetch-primary";
import type { DexPriceObs, SymbolLookups } from "../types";

export interface SubgraphEnrichmentPhaseResult {
  uniV3PoolFees: Map<string, number>;
  uniV3SymbolFees: Map<string, number>;
  uniV3PriceObs: Map<string, DexPriceObs[]>;
  aerodromePriceObs: Map<string, DexPriceObs[]>;
  aerodromeIsStable: Map<string, boolean>;
}

export async function fetchSubgraphEnrichmentPhase(params: {
  graphApiKey: string | null;
  symbolToIds: SymbolLookups["symbolToIds"];
  symbolToChainScopedIds: SymbolLookups["symbolToChainScopedIds"];
  chainAddressToId: SymbolLookups["chainAddressToId"];
  signal?: AbortSignal;
  validationReferences: PriceValidationReferences;
}): Promise<SubgraphEnrichmentPhaseResult & { failedSources: string[] }> {
  const failedSources: string[] = [];

  let uniV3PoolFees = new Map<string, number>();
  let uniV3SymbolFees = new Map<string, number>();
  let uniV3PriceObs = new Map<string, DexPriceObs[]>();
  try {
    const uniV3Data = await fetchUniV3Data(
      params.graphApiKey,
      params.symbolToIds,
      params.symbolToChainScopedIds,
      params.chainAddressToId,
      params.signal,
      params.validationReferences,
    );
    uniV3PoolFees = uniV3Data.uniV3PoolFees;
    uniV3SymbolFees = uniV3Data.uniV3SymbolFees;
    uniV3PriceObs = uniV3Data.uniV3PriceObs;
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] UniV3 fetch failed (non-fatal):", err);
    failedSources.push("univ3-subgraph");
  }

  let aerodromePriceObs = new Map<string, DexPriceObs[]>();
  let aerodromeIsStable = new Map<string, boolean>();
  try {
    const aeroData = await fetchAerodromeData(
      params.graphApiKey,
      params.symbolToIds,
      params.symbolToChainScopedIds,
      params.chainAddressToId,
      params.signal,
      params.validationReferences,
    );
    aerodromePriceObs = aeroData.aerodromePriceObs;
    aerodromeIsStable = aeroData.aerodromeIsStable;
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] Aerodrome fetch failed (non-fatal):", err);
    failedSources.push("aerodrome-subgraph");
  }

  return {
    uniV3PoolFees,
    uniV3SymbolFees,
    uniV3PriceObs,
    aerodromePriceObs,
    aerodromeIsStable,
    failedSources,
  };
}
