import { withErrorHandler } from "../lib/api-utils";
import { buildPaginatedQuery } from "../lib/db";
import { CACHE_PROFILES } from "../lib/constants";

export const handleMintBurn = withErrorHandler("mint-burn", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const rawLimit = params.get("limit");
  const limit = rawLimit !== null ? Math.max(parseInt(rawLimit, 10) || 0, 0) : 0;
  const offset = Math.max(parseInt(params.get("offset") ?? "0", 10) || 0, 0);
  const stablecoin = params.get("stablecoin");
  const chain = params.get("chain");
  const eventType = params.get("eventType");

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    conditions.push("stablecoin = ?");
    filterBindings.push(stablecoin);
  }
  if (chain) {
    conditions.push("chain_name = ?");
    filterBindings.push(chain);
  }
  if (eventType) {
    conditions.push("event_type = ?");
    filterBindings.push(eventType);
  }

  const { where, limitClause, offsetClause, paginationBindings } = buildPaginatedQuery({
    conditions, limit, offset,
  });

  const sql = `SELECT * FROM mint_burn_events${where} ORDER BY timestamp DESC${limitClause}${offsetClause}`;

  const [countBatch, dataBatch] = await db.batch([
    db.prepare(`SELECT COUNT(*) as total FROM mint_burn_events${where}`).bind(...filterBindings),
    db.prepare(sql).bind(...filterBindings, ...paginationBindings),
  ]);
  const total = (countBatch.results as { total: number }[])?.[0]?.total ?? 0;

  type MintBurnRow = {
    id: string; stablecoin: string; chain_id: string; chain_name: string;
    event_type: string; amount: number; address: string | null; tx_hash: string;
    block_number: number; timestamp: number; explorer_tx_url: string;
  };
  const events = ((dataBatch.results ?? []) as MintBurnRow[]).map((row) => ({
    id: row.id,
    stablecoin: row.stablecoin,
    chainId: row.chain_id,
    chainName: row.chain_name,
    eventType: row.event_type,
    amount: row.amount,
    address: row.address,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    timestamp: row.timestamp,
    explorerTxUrl: row.explorer_tx_url,
  }));

  return new Response(JSON.stringify({ events, total }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
    },
  });
});
