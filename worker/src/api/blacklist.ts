import { withErrorHandler, addFreshnessHeaders, isValidStablecoinId } from "../lib/api-utils";
import { buildPaginatedQuery } from "../lib/db";
import { CACHE_PROFILES } from "../lib/constants";
import { CHAIN_META } from "../../../src/lib/chains";

const VALID_CHAIN_NAMES = new Set(Object.values(CHAIN_META).map((m) => m.name));
const VALID_EVENT_TYPES = new Set(["blacklist", "unblacklist", "destroy"]);

export const handleBlacklist = withErrorHandler("blacklist", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const rawLimit = params.get("limit");
  const limit = rawLimit !== null ? Math.min(Math.max(parseInt(rawLimit, 10) || 0, 0), 5000) : 0;
  const offset = Math.max(parseInt(params.get("offset") ?? "0", 10) || 0, 0);
  const stablecoin = params.get("stablecoin");
  const chain = params.get("chain");
  const eventType = params.get("eventType");

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    if (!isValidStablecoinId(stablecoin)) {
      return new Response(JSON.stringify({ error: "Invalid stablecoin ID" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    conditions.push("stablecoin = ?");
    filterBindings.push(stablecoin);
  }
  if (chain) {
    if (!VALID_CHAIN_NAMES.has(chain)) {
      return new Response(JSON.stringify({ error: "Invalid chain parameter" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    conditions.push("chain_name = ?");
    filterBindings.push(chain);
  }
  if (eventType) {
    if (!VALID_EVENT_TYPES.has(eventType)) {
      return new Response(JSON.stringify({ error: "Invalid eventType parameter" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    conditions.push("event_type = ?");
    filterBindings.push(eventType);
  }

  const { where, limitClause, offsetClause, paginationBindings } = buildPaginatedQuery({
    conditions, limit, offset,
  });

  // Batch COUNT + SELECT for transactional consistency
  const sql = `SELECT * FROM blacklist_events${where} ORDER BY timestamp DESC${limitClause}${offsetClause}`;

  const [countBatch, dataBatch] = await db.batch([
    db.prepare(`SELECT COUNT(*) as total FROM blacklist_events${where}`).bind(...filterBindings),
    db.prepare(sql).bind(...filterBindings, ...paginationBindings),
  ]);
  const total = ((countBatch.results ?? []) as { total: number }[])[0]?.total ?? 0;

  // Map snake_case DB columns to camelCase to match BlacklistEvent interface
  type BlacklistRow = {
    id: string; stablecoin: string; chain_id: string; chain_name: string;
    event_type: string; address: string; amount: number | null; tx_hash: string;
    block_number: number; timestamp: number; explorer_tx_url: string; explorer_address_url: string;
  };
  const events = ((dataBatch.results ?? []) as BlacklistRow[]).map((row) => ({
    id: row.id,
    stablecoin: row.stablecoin,
    chainId: row.chain_id,
    chainName: row.chain_name,
    eventType: row.event_type,
    address: row.address,
    amount: row.amount,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    timestamp: row.timestamp,
    explorerTxUrl: row.explorer_tx_url,
    explorerAddressUrl: row.explorer_address_url,
  }));

  const latestTs = events.length > 0 ? Math.max(...events.map((e) => e.timestamp)) : Math.floor(Date.now() / 1000);

  return new Response(JSON.stringify({ events, total }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.realtime,
    }, latestTs, 900),
  });
});
