import {
  withErrorHandler,
  addFreshnessHeaders,
  isValidStablecoinId,
  errorResponse,
  parseIntParam,
  jsonResponse,
  getLatestSuccessfulCronTimestamp,
} from "../lib/api-utils";
import { buildPaginatedQuery } from "../lib/db";
import { CACHE_PROFILES } from "../lib/constants";
import { CHAIN_META } from "../../../src/lib/chains";

const VALID_CHAIN_IDS = new Set(Object.keys(CHAIN_META));
const VALID_DIRECTIONS = new Set(["mint", "burn"]);

interface EventRow {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: string;
  amount: number;
  amount_usd: number | null;
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

    const stablecoin = params.get("stablecoin");
    if (!stablecoin) {
      return errorResponse(400, "Missing required parameter: stablecoin");
    }
    if (!isValidStablecoinId(stablecoin)) {
      return errorResponse(400, "Invalid stablecoin ID");
    }

    const direction = params.get("direction");
    if (direction && !VALID_DIRECTIONS.has(direction)) {
      return errorResponse(400, "Invalid direction parameter");
    }
    const chain = params.get("chain");
    if (chain && !VALID_CHAIN_IDS.has(chain)) {
      return errorResponse(400, "Invalid chain parameter");
    }
    const minAmountRaw = params.get("minAmount");
    const minAmount = minAmountRaw !== null ? parseFloat(minAmountRaw) : null;

    const limit = parseIntParam(params.get("limit"), 50, 1, 500);
    const offset = parseIntParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

    // Build WHERE conditions
    const conditions: string[] = ["stablecoin_id = ?"];
    const filterBindings: (string | number)[] = [stablecoin];

    if (direction) {
      conditions.push("direction = ?");
      filterBindings.push(direction);
    }
    if (chain) {
      conditions.push("chain_id = ?");
      filterBindings.push(chain);
    }
    if (minAmount !== null && !isNaN(minAmount) && minAmount > 0) {
      conditions.push("COALESCE(amount_usd, amount) >= ?");
      filterBindings.push(minAmount);
    }

    const { where, limitClause, offsetClause, paginationBindings } =
      buildPaginatedQuery({ conditions, limit, offset });

    const sql = `SELECT * FROM mint_burn_events${where} ORDER BY timestamp DESC${limitClause}${offsetClause}`;

    const [countBatch, dataBatch] = await db.batch([
      db
        .prepare(`SELECT COUNT(*) as total FROM mint_burn_events${where}`)
        .bind(...filterBindings),
      db.prepare(sql).bind(...filterBindings, ...paginationBindings),
    ]);

    const total =
      ((countBatch.results ?? []) as { total: number }[])[0]?.total ?? 0;
    const rows = (dataBatch.results ?? []) as EventRow[];

    const events = rows.map((row) => ({
      id: row.id,
      stablecoinId: row.stablecoin_id,
      symbol: row.symbol,
      chainId: row.chain_id,
      direction: row.direction as "mint" | "burn",
      amount: row.amount,
      amountUsd: row.amount_usd,
      counterparty: row.counterparty,
      txHash: row.tx_hash,
      blockNumber: row.block_number,
      timestamp: row.timestamp,
      explorerTxUrl: row.explorer_tx_url,
      priceUsed: row.price_used,
      priceTimestamp: row.price_timestamp,
      priceSource: row.price_source,
    }));

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
