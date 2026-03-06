import {
  withErrorHandler,
  addFreshnessHeaders,
  resolveOrReject,
  errorResponse,
  parseIntParam,
  jsonResponse,
  getLatestSuccessfulCronTimestamp,
  fetchPaginatedEvents,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

const ETHEREUM_CHAIN_ID = "ethereum";
const VALID_CHAIN_IDS = new Set([ETHEREUM_CHAIN_ID]);
const VALID_DIRECTIONS = new Set(["mint", "burn"]);
const VALID_BURN_TYPES = new Set(["effective_burn", "bridge_burn", "review_required"]);

interface EventRow {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: string;
  amount: number;
  amount_usd: number | null;
  burn_type: "effective_burn" | "bridge_burn" | "review_required" | null;
  burn_review_reason: string | null;
  counterparty: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
  price_used: number | null;
  price_timestamp: number | null;
  price_source: string | null;
}

export const handleMintBurnEvents = withErrorHandler(
  "mint-burn-events",
  async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;

    const stablecoinInput = params.get("stablecoin");
    if (!stablecoinInput) {
      return errorResponse(400, "Missing required parameter: stablecoin");
    }
    const resolved = resolveOrReject(stablecoinInput, `path=${url.pathname}`);
    if (resolved instanceof Response) {
      return resolved;
    }
    const stablecoinId = resolved.canonicalId;

    const direction = params.get("direction");
    if (direction && !VALID_DIRECTIONS.has(direction)) {
      return errorResponse(400, "Invalid direction parameter");
    }
    const chain = params.get("chain");
    if (chain && !VALID_CHAIN_IDS.has(chain)) {
      return errorResponse(400, "Invalid chain parameter");
    }
    const burnType = params.get("burnType");
    if (burnType && !VALID_BURN_TYPES.has(burnType)) {
      return errorResponse(400, "Invalid burnType parameter");
    }
    const minAmountRaw = params.get("minAmount");
    const minAmount = minAmountRaw !== null ? parseFloat(minAmountRaw) : null;

    const limit = parseIntParam(params.get("limit"), 50, 1, 500, "limit");
    if (limit instanceof Response) {
      return limit;
    }
    const offset = parseIntParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER, "offset");
    if (offset instanceof Response) {
      return offset;
    }

    // Build WHERE conditions
    const conditions: string[] = ["stablecoin_id = ?", "chain_id = ?"];
    const filterBindings: (string | number)[] = [stablecoinId, ETHEREUM_CHAIN_ID];

    if (direction) {
      conditions.push("direction = ?");
      filterBindings.push(direction);
    }
    if (chain) {
      conditions.push("chain_id = ?");
      filterBindings.push(chain);
    }
    if (burnType) {
      conditions.push("burn_type = ?");
      filterBindings.push(burnType);
    }
    if (minAmount !== null && !isNaN(minAmount) && minAmount > 0) {
      conditions.push("COALESCE(amount_usd, amount) >= ?");
      filterBindings.push(minAmount);
    }

    const { events, total } = await fetchPaginatedEvents<EventRow, {
      id: string;
      stablecoinId: string;
      symbol: string;
      chainId: string;
      direction: "mint" | "burn";
      amount: number;
      amountUsd: number | null;
      burnType: EventRow["burn_type"];
      burnReviewReason: string | null;
      counterparty: string | null;
      txHash: string;
      blockNumber: number;
      timestamp: number;
      explorerTxUrl: string;
      priceUsed: number | null;
      priceTimestamp: number | null;
      priceSource: string | null;
    }>(db, {
      tableName: "mint_burn_events",
      orderBy: "timestamp DESC",
      conditions,
      filterBindings,
      limit,
      offset,
      mapRow: (row) => ({
      id: row.id,
      stablecoinId: row.stablecoin_id,
      symbol: row.symbol,
      chainId: row.chain_id,
      direction: row.direction as "mint" | "burn",
      amount: row.amount,
      amountUsd: row.amount_usd,
      burnType: row.burn_type,
      burnReviewReason: row.burn_review_reason,
      counterparty: row.counterparty,
      txHash: row.tx_hash,
      blockNumber: row.block_number,
      timestamp: row.timestamp,
      explorerTxUrl: row.explorer_tx_url,
      priceUsed: row.price_used,
      priceTimestamp: row.price_timestamp,
      priceSource: row.price_source,
      }),
    });

    const latestTs =
      events.length > 0
        ? events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity)
        : Math.floor(Date.now() / 1000);
    const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-mint-burn", latestTs);

    return jsonResponse({ events, total }, addFreshnessHeaders({
      "Cache-Control": CACHE_PROFILES.realtime,
    }, freshnessTs, 900));
  },
);
