import { SUBGRAPH_PER_CHAIN_TIMEOUT_MS } from "./constants";
import {
  fetchSubgraphEntities,
  type FetchSubgraphEntitiesConfig,
  type FetchSubgraphEntitiesResult,
} from "./subgraph-helpers";

interface RunSubgraphFamilyParams<TEntity, TLookups> {
  graphApiKey: string | null;
  signal?: AbortSignal;
  subgraphs: Record<string, string>;
  missingApiKeyMessage?: string | null;
  familyLabel: string;
  createLookups: () => TLookups;
  buildConfig: (
    chain: string,
    subgraphUrl: string,
    combinedSignal: AbortSignal,
    lookups: TLookups,
  ) => FetchSubgraphEntitiesConfig<TEntity>;
  handleResult: (
    lookups: TLookups,
    chain: string,
    result: FetchSubgraphEntitiesResult,
  ) => void;
  buildChainSummary?: (chain: string, result: FetchSubgraphEntitiesResult) => string;
  buildFinalSummary: (lookups: TLookups) => string;
}

export async function runSubgraphFamily<TEntity, TLookups>(
  params: RunSubgraphFamilyParams<TEntity, TLookups>,
): Promise<TLookups> {
  const lookups = params.createLookups();

  if (!params.graphApiKey) {
    if (params.missingApiKeyMessage) {
      console.log(params.missingApiKeyMessage);
    }
    return lookups;
  }

  await Promise.all(
    Object.entries(params.subgraphs).map(async ([chain, subgraphId]) => {
      try {
        const perChainTimeout = AbortSignal.timeout(SUBGRAPH_PER_CHAIN_TIMEOUT_MS);
        const combinedSignal = params.signal
          ? AbortSignal.any([params.signal, perChainTimeout])
          : perChainTimeout;
        const subgraphUrl = `https://gateway.thegraph.com/api/${params.graphApiKey}/subgraphs/id/${subgraphId}`;
        const result = await fetchSubgraphEntities<TEntity>(
          params.buildConfig(chain, subgraphUrl, combinedSignal, lookups),
        );
        params.handleResult(lookups, chain, result);
        if (result.shouldLogIndex && params.buildChainSummary) {
          console.log(params.buildChainSummary(chain, result));
        }
      } catch (error) {
        if (params.signal?.aborted) throw error;
        console.warn(`[dex-liquidity] ${params.familyLabel} ${chain} failed (non-fatal):`, error);
      }
    }),
  );

  console.log(params.buildFinalSummary(lookups));
  return lookups;
}
