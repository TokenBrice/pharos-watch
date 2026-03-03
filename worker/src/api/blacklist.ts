import { withErrorHandler, addFreshnessHeaders, isValidStablecoinId, errorResponse, parseIntParam, jsonResponse } from "../lib/api-utils";
import { buildPaginatedQuery } from "../lib/db";
import { CACHE_PROFILES } from "../lib/constants";
import { CHAIN_META } from "../../../src/lib/chains";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "../../../src/lib/blacklist-tracker-version";

const VALID_CHAIN_NAMES = new Set(Object.values(CHAIN_META).map((m) => m.name));
const VALID_EVENT_TYPES = new Set(["blacklist", "unblacklist", "destroy"]);

export const handleBlacklist = withErrorHandler("blacklist", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const limit = parseIntParam(params.get("limit"), 0, 0, 5000);
  const offset = parseIntParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const stablecoin = params.get("stablecoin");
  const chain = params.get("chain");
  const eventType = params.get("eventType");

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    if (!isValidStablecoinId(stablecoin)) {
      return errorResponse(400, "Invalid stablecoin ID");
    }
    conditions.push("stablecoin = ?");
    filterBindings.push(stablecoin);
  }
  if (chain) {
    if (!VALID_CHAIN_NAMES.has(chain)) {
      return errorResponse(400, "Invalid chain parameter");
    }
    conditions.push("chain_name = ?");
    filterBindings.push(chain);
  }
  if (eventType) {
    if (!VALID_EVENT_TYPES.has(eventType)) {
      return errorResponse(400, "Invalid eventType parameter");
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

  const latestTs = events.length > 0 ? events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity) : Math.floor(Date.now() / 1000);

  return jsonResponse({
    events,
    total,
    methodology: {
      version: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
      versionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
      currentVersion: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
      currentVersionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
      changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
      asOf: latestTs,
      isCurrent: true,
    },
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.realtime,
  }, latestTs, 900));
});
