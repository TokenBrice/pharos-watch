import { logWorkerEventArgs } from "../../lib/structured-log";
import { mapWithConcurrency } from "../../lib/concurrency";
import { SUBGRAPH_FAMILY_MAX_CONCURRENCY, SUBGRAPH_PER_CHAIN_TIMEOUT_MS } from "./constants";
import {
  fetchSubgraphEntities,
  type FetchSubgraphEntitiesConfig,
  type FetchSubgraphEntitiesResult,
  type SubgraphFailureReason,
} from "./subgraph-helpers";

interface RunSubgraphFamilyParams<TEntity, TLookups> {
  graphApiKey: string | null;
  signal?: AbortSignal;
  subgraphs: Record<string, string>;
  missingApiKeyMessage?: string | null;
  familyLabel: string;
  maxConcurrency?: number;
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

/** One chain's failed read, persisted in stage metadata (ADR-31). */
export interface SubgraphChainFailure {
  chain: string;
  /** `broad` is the family listing; `exact` is a follow-up exact-id read. */
  phase: "broad" | "exact";
  reason: SubgraphFailureReason;
  /** The per-chain `SUBGRAPH_PER_CHAIN_TIMEOUT_MS` budget expired. */
  timedOut: boolean;
  /**
   * Set when a bisected exact batch isolated pools that fail alone: only those
   * were excluded and the chain did not fail. `isolatedPoolIds` is a sample.
   */
  isolatedPoolIdCount?: number;
  isolatedPoolIds?: string[];
}

/** Lookups plus the chains whose source did not answer this run. */
export type SubgraphFamilyResult<TLookups> = TLookups & {
  failedChains: string[];
  /**
   * Why each failed chain failed. `univ3-subgraph:ethereum` labels stay stable
   * for status consumers; this map is the machine-readable reason behind the
   * label and is logged with the family summary.
   */
  failedChainReasons: Record<string, SubgraphFailureReason>;
  chainFailures: SubgraphChainFailure[];
};

export async function runSubgraphFamily<TEntity, TLookups extends object>(
  params: RunSubgraphFamilyParams<TEntity, TLookups>,
): Promise<SubgraphFamilyResult<TLookups>> {
  const lookups = params.createLookups();
  const failedChains: string[] = [];
  const failedChainReasons: Record<string, SubgraphFailureReason> = {};
  const chainFailures: SubgraphChainFailure[] = [];

  if (!params.graphApiKey) {
    if (params.missingApiKeyMessage) {
      logWorkerEventArgs("handler", "info", params.missingApiKeyMessage);
    }
    return { ...lookups, failedChains, failedChainReasons, chainFailures };
  }

  const subgraphs = Object.entries(params.subgraphs);
  await mapWithConcurrency(
    subgraphs,
    params.maxConcurrency ?? SUBGRAPH_FAMILY_MAX_CONCURRENCY,
    async ([chain, subgraphId]) => {
      const perChainTimeout = AbortSignal.timeout(SUBGRAPH_PER_CHAIN_TIMEOUT_MS);
      try {
        const combinedSignal = params.signal
          ? AbortSignal.any([params.signal, perChainTimeout])
          : perChainTimeout;
        const subgraphUrl = `https://gateway.thegraph.com/api/${params.graphApiKey}/subgraphs/id/${subgraphId}`;
        const result = await fetchSubgraphEntities<TEntity>(
          params.buildConfig(chain, subgraphUrl, combinedSignal, lookups),
        );
        params.handleResult(lookups, chain, result);
        if (result.failed) {
          failedChains.push(chain);
          failedChainReasons[chain] = result.failureReason ?? "http";
          chainFailures.push({
            chain, phase: "broad", reason: failedChainReasons[chain], timedOut: perChainTimeout.aborted,
          });
        }
        if (result.shouldLogIndex && params.buildChainSummary) {
          logWorkerEventArgs("handler", "info", params.buildChainSummary(chain, result));
        }
      } catch (error) {
        if (params.signal?.aborted) throw error;
        failedChains.push(chain);
        failedChainReasons[chain] = "http";
        chainFailures.push({
          chain, phase: "broad", reason: "http",
          timedOut: perChainTimeout.aborted || (error instanceof Error && error.name === "TimeoutError"),
        });
        logWorkerEventArgs("handler", "warn", `[dex-liquidity] ${params.familyLabel} ${chain} failed (non-fatal):`, error);
      }
    },
    { signal: params.signal },
  );

  if (failedChains.length > 0) {
    logWorkerEventArgs("handler", "warn", `[dex-liquidity] ${params.familyLabel} failed chains:`, failedChainReasons);
  }
  logWorkerEventArgs("handler", "info", params.buildFinalSummary(lookups));
  return { ...lookups, failedChains, failedChainReasons, chainFailures };
}
