import { logWorkerEventArgs } from "../../lib/structured-log";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT } from "../../lib/constants";
import { throwIfAborted } from "../../lib/abort";
import type { DexPriceObs } from "./types";

export type SubgraphPriceObservation = { stablecoinId: string; obs: DexPriceObs };

export function mergeDexPriceObservationMap(
  target: Map<string, DexPriceObs[]>,
  source: Map<string, DexPriceObs[]>,
): void {
  for (const [id, observations] of source) {
    const existing = target.get(id) ?? [];
    existing.push(...observations);
    target.set(id, existing);
  }
}

export type FetchSubgraphEntitiesConfig<TEntity> = {
  subgraphUrl: string;
  sourceLabel: string;
  chain: string;
  buildQuery: (skip: number) => string;
  extractEntities: (data: unknown) => TEntity[] | undefined;
  mapEntity: (entity: TEntity) => SubgraphPriceObservation[];
  signal?: AbortSignal;
  pageSize?: number;
  maxPages?: number;
  errorHandling?: {
    warnOnFetchFailure?: boolean;
    warnOnGraphQlErrors?: boolean;
  };
};

export type FetchSubgraphEntitiesResult = {
  entityCount: number;
  observationCount: number;
  observations: Map<string, DexPriceObs[]>;
  shouldLogIndex: boolean;
};

export async function fetchSubgraphEntities<TEntity>(
  config: FetchSubgraphEntitiesConfig<TEntity>,
): Promise<FetchSubgraphEntitiesResult> {
  const observations = new Map<string, DexPriceObs[]>();
  let entityCount = 0;
  let observationCount = 0;
  let shouldLogIndex = false;

  const pageSize = config.pageSize ?? 0;
  const maxPages = Math.max(1, config.maxPages ?? 1);
  const warnOnFetchFailure = config.errorHandling?.warnOnFetchFailure ?? true;
  const warnOnGraphQlErrors = config.errorHandling?.warnOnGraphQlErrors ?? true;

  try {
    for (let page = 0; page < maxPages; page++) {
      throwIfAborted(config.signal);
      const skip = pageSize > 0 ? page * pageSize : 0;
      const result = await fetchJsonWithRetry<{
        data?: unknown;
        errors?: { message: string }[];
      }>(config.subgraphUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: config.buildQuery(skip) }),
        signal: config.signal,
      });
      if (!result?.response.ok) {
        if (warnOnFetchFailure) {
          logWorkerEventArgs("handler", "warn", `[dex-liquidity] ${config.sourceLabel} failed for ${config.chain}: ${result?.response.status}`);
        }
        break;
      }

      const json = result.body;
      const entities = config.extractEntities(json.data) ?? [];
      shouldLogIndex = true;

      if (json.errors?.length && warnOnGraphQlErrors) {
        logWorkerEventArgs("handler", "warn",
          `[dex-liquidity] ${config.sourceLabel} GraphQL errors for ${config.chain}:`,
          json.errors.map((e) => e.message).join("; "),
        );
        if (entities.length === 0) {
          shouldLogIndex = false;
          break;
        }
      }

      if (entities.length === 0) break;
      entityCount += entities.length;

      for (const entity of entities) {
        const mapped = config.mapEntity(entity);
        for (const { stablecoinId, obs } of mapped) {
          const existing = observations.get(stablecoinId) ?? [];
          existing.push(obs);
          observations.set(stablecoinId, existing);
          observationCount++;
        }
      }

      if (!pageSize || entities.length < pageSize) break;
    }
  } catch (err) {
    if (config.signal?.aborted) throw err;
    logWorkerEventArgs("handler", "warn", `[dex-liquidity] ${config.sourceLabel} error for ${config.chain}:`, err);
    shouldLogIndex = false;
  }

  return { entityCount, observationCount, observations, shouldLogIndex };
}
