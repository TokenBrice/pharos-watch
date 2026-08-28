import { errorResponse, jsonResponse } from "./api-response";
import { parseIntParam } from "./api-params";

interface BackfillCoin {
  id: string;
}

interface SelectBackfillCoinsOptions {
  defaultBatchSize: number;
  allowBatchSizeOverride?: boolean;
  minBatchSize?: number;
  maxBatchSize?: number;
  maxBatch?: number;
  stablecoinParam?: string;
  batchParam?: string;
  batchSizeParam?: string;
  notFoundMessage?: string;
}

type SelectBackfillCoinsResult<T> =
  | { coins: T[] }
  | { response: Response };

/**
 * Shared parser for admin backfill target selection:
 * - `?stablecoin=<id>` for single-coin mode
 * - `?batch=<n>[&batchSize=<n>]` for batched mode
 */
export function selectBackfillCoins<T extends BackfillCoin>(
  url: URL,
  allCoins: readonly T[],
  options: SelectBackfillCoinsOptions,
): SelectBackfillCoinsResult<T> {
  const stablecoinParam = options.stablecoinParam ?? "stablecoin";
  const batchParam = options.batchParam ?? "batch";
  const batchSizeParam = options.batchSizeParam ?? "batchSize";
  const maxBatch = options.maxBatch ?? 100_000;
  const minBatchSize = options.minBatchSize ?? 1;
  const maxBatchSize = options.maxBatchSize ?? 1000;
  const allowBatchSizeOverride = options.allowBatchSizeOverride ?? true;
  const singleId = url.searchParams.get(stablecoinParam);

  if (singleId) {
    const match = allCoins.filter((coin) => coin.id === singleId);
    if (match.length === 0) {
      return {
        response: errorResponse(404, options.notFoundMessage ?? "Stablecoin not found"),
      };
    }
    return { coins: match };
  }

  let batchSize = options.defaultBatchSize;
  if (allowBatchSizeOverride) {
    const parsedBatchSize = parseIntParam(
      url.searchParams.get(batchSizeParam),
      options.defaultBatchSize,
      minBatchSize,
      maxBatchSize,
      batchSizeParam,
    );
    if (parsedBatchSize instanceof Response) {
      return { response: parsedBatchSize };
    }
    batchSize = parsedBatchSize;
  }
  const batch = parseIntParam(url.searchParams.get(batchParam), 0, 0, maxBatch, batchParam);
  if (batch instanceof Response) {
    return { response: batch };
  }
  const start = batch * batchSize;
  return { coins: allCoins.slice(start, start + batchSize) };
}

export function noCoinsInBatchResponse(): Response {
  return jsonResponse({ message: "No coins in this batch" });
}
