import { logWorkerEventArgs } from "../../lib/structured-log";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { USER_AGENT } from "../../lib/constants";
import { throwIfAborted, yieldToEventLoop } from "../../lib/abort";
import { isResponseBodyTooLargeError } from "../../lib/response-body";
import { SUBGRAPH_PAGE_MAX_RESPONSE_BYTES } from "./constants";
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
  /**
   * Hard per-response byte cap for one page. Defaults to
   * `SUBGRAPH_PAGE_MAX_RESPONSE_BYTES`; a page that exceeds it fails the source
   * instead of yielding a partially parsed page.
   */
  maxResponseBytes?: number;
  errorHandling?: {
    warnOnFetchFailure?: boolean;
    warnOnGraphQlErrors?: boolean;
  };
};

/** Machine-readable reason a source failed, for status/log consumers. */
export type SubgraphFailureReason =
  /** The page body exceeded `maxResponseBytes` and was cancelled unread. */
  | "body-over-cap"
  /** The provider never answered: transport failure or exhausted HTTP retries. */
  | "http"
  /** The provider answered with GraphQL errors and no entities. */
  | "graphql";

export type FetchSubgraphEntitiesResult = {
  entityCount: number;
  observationCount: number;
  observations: Map<string, DexPriceObs[]>;
  shouldLogIndex: boolean;
  /**
   * The source did not answer: an HTTP failure, a GraphQL error that yielded
   * no entities, or a transport error. A healthy source that legitimately has
   * nothing to report stays `false`.
   */
  failed: boolean;
  /** Present only when `failed` is true. */
  failureReason?: SubgraphFailureReason;
};

export async function fetchSubgraphEntities<TEntity>(
  config: FetchSubgraphEntitiesConfig<TEntity>,
): Promise<FetchSubgraphEntitiesResult> {
  const observations = new Map<string, DexPriceObs[]>();
  let entityCount = 0;
  let observationCount = 0;
  let shouldLogIndex = false;
  let failed = false;
  let failureReason: SubgraphFailureReason | undefined;

  const pageSize = config.pageSize ?? 0;
  // Paging without a page size would refetch offset 0 for every page.
  const maxPages = pageSize > 0 ? Math.max(1, config.maxPages ?? 1) : 1;
  const maxResponseBytes = config.maxResponseBytes ?? SUBGRAPH_PAGE_MAX_RESPONSE_BYTES;
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
      }, 2, {
        maxResponseBytes,
        // Preserve the final thrown failure so the overflow class survives the
        // retry loop instead of collapsing into a generic "no response".
        throwOnFinalNetworkError: true,
      });
      if (!result?.response.ok) {
        if (warnOnFetchFailure) {
          logWorkerEventArgs("handler", "warn", `[dex-liquidity] ${config.sourceLabel} failed for ${config.chain}: ${result?.response.status}`);
        }
        failed = true;
        failureReason = "http";
        break;
      }

      const json = result.body;
      const entities = config.extractEntities(json.data) ?? [];
      shouldLogIndex = true;

      if (json.errors?.length) {
        if (warnOnGraphQlErrors) {
          logWorkerEventArgs("handler", "warn",
            `[dex-liquidity] ${config.sourceLabel} GraphQL errors for ${config.chain}:`,
            json.errors.map((e) => e.message).join("; "),
          );
        }
        if (entities.length === 0) {
          shouldLogIndex = false;
          failed = true;
          failureReason = "graphql";
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
      // Mapping a full page is synchronous work measured in tens of
      // milliseconds per thousand entities; yield before the next page so the
      // slot heartbeat and abort timers keep firing during a multi-page
      // fan-out instead of waiting for the whole family to drain.
      await yieldToEventLoop(config.signal);
    }
  } catch (err) {
    if (config.signal?.aborted) throw err;
    if (isResponseBodyTooLargeError(err)) {
      logWorkerEventArgs("handler", "warn", `[dex-liquidity] ${config.sourceLabel} body over cap for ${config.chain}:`, err);
      shouldLogIndex = false;
      failed = true;
      failureReason = "body-over-cap";
      return { entityCount, observationCount, observations, shouldLogIndex, failed, failureReason };
    }
    logWorkerEventArgs("handler", "warn", `[dex-liquidity] ${config.sourceLabel} error for ${config.chain}:`, err);
    shouldLogIndex = false;
    failed = true;
    failureReason = "http";
  }

  return failureReason === undefined
    ? { entityCount, observationCount, observations, shouldLogIndex, failed }
    : { entityCount, observationCount, observations, shouldLogIndex, failed, failureReason };
}
