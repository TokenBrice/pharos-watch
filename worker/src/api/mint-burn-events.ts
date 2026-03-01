import { withErrorHandler, addFreshnessHeaders, isValidStablecoinId } from "../lib/api-utils";
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
}

export const handleMintBurnEvents = withErrorHandler(
  "mint-burn-events",
  async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;

    const stablecoin = params.get("stablecoin");
    if (!stablecoin) {
      return new Response(
        JSON.stringify({ error: "Missing required parameter: stablecoin" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (!isValidStablecoinId(stablecoin)) {
      return new Response(
        JSON.stringify({ error: "Invalid stablecoin ID" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const direction = params.get("direction");
    if (direction && !VALID_DIRECTIONS.has(direction)) {
      return new Response(
        JSON.stringify({ error: "Invalid direction parameter" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const chain = params.get("chain");
    if (chain && !VALID_CHAIN_IDS.has(chain)) {
      return new Response(
        JSON.stringify({ error: "Invalid chain parameter" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const minAmountRaw = params.get("minAmount");
    const minAmount = minAmountRaw !== null ? parseFloat(minAmountRaw) : null;

    const rawLimit = params.get("limit");
    const limit = rawLimit !== null
      ? Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 500)
      : 50;
    const offset = Math.max(parseInt(params.get("offset") ?? "0", 10) || 0, 0);

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
    }));

    const latestTs =
      events.length > 0
        ? events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity)
        : Math.floor(Date.now() / 1000);

    return new Response(JSON.stringify({ events, total }), {
      headers: addFreshnessHeaders(
        {
          "Content-Type": "application/json",
          "Cache-Control": CACHE_PROFILES.realtime,
        },
        latestTs,
        900,
      ),
    });
  },
);
