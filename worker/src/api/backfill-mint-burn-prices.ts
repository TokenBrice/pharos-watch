import { jsonResponse } from "../lib/api-response";
import { getIdempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH } from "../lib/idempotency";
import {
  DEFAULT_HISTORICAL_MINT_PRICE_REPAIR_LIMIT,
  MAX_HISTORICAL_MINT_PRICE_REPAIR_LIMIT,
  repairHistoricalMintBurnPrices,
  type HistoricalMintPriceSourceLoader,
} from "../lib/mint-burn-historical-price-repair";

const EXECUTION_CONFIRMATION = "historical-mint-prices";

export interface BackfillMintBurnPricesOptions {
  coingeckoApiKey?: string | null;
  sourceLoader?: HistoricalMintPriceSourceLoader;
  nowSec?: number;
}

function readBoolean(url: URL, keys: string[], defaultValue: boolean): boolean {
  for (const key of keys) {
    const raw = url.searchParams.get(key);
    if (raw == null) continue;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new Error(`${key} must be true or false`);
  }
  return defaultValue;
}

function readLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw == null || raw === "") return DEFAULT_HISTORICAL_MINT_PRICE_REPAIR_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORICAL_MINT_PRICE_REPAIR_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_HISTORICAL_MINT_PRICE_REPAIR_LIMIT}`);
  }
  return limit;
}

export interface BackfillMintBurnPricesRouteContext extends BackfillMintBurnPricesOptions {
  db: D1Database;
  url: URL;
  trustedAdmin?: boolean;
  request?: Request;
}

export async function handleBackfillMintBurnPrices({
  db,
  url,
  request,
  ...options
}: BackfillMintBurnPricesRouteContext): Promise<Response> {
  try {
    const dryRun = readBoolean(url, ["dry-run", "dryRun"], true);
    const operatorRunId = getIdempotencyKey(request);
    const timeTravelBookmark = url.searchParams.get("bookmark")?.trim() || null;
    if (
      !dryRun &&
      (url.searchParams.get("confirm") !== EXECUTION_CONFIRMATION ||
        !operatorRunId ||
        !timeTravelBookmark ||
        timeTravelBookmark.length > 512)
    ) {
          return jsonResponse(
        {
          error:
            `Historical mint/burn price repair defaults to dry-run. ` +
            `Mutation requires dry-run=false&confirm=${EXECUTION_CONFIRMATION}, ` +
            `a fresh bookmark query parameter, and an Idempotency-Key header of 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
        },
            { status: 400 },
      );
    }

    const result = await repairHistoricalMintBurnPrices(db, {
      dryRun,
      limit: readLimit(url),
      stablecoinId: url.searchParams.get("stablecoin"),
      retryIrreducible: readBoolean(url, ["retry-irreducible", "retryIrreducible"], false),
      coingeckoApiKey: options.coingeckoApiKey ?? null,
      operatorRunId,
      timeTravelBookmark,
      sourceLoader: options.sourceLoader,
      nowSec: options.nowSec,
    });
      return jsonResponse(result);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("must be") || error.message.startsWith("unknown stablecoinId"))
    ) {
        return jsonResponse({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
