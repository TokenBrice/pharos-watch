import {
  withErrorHandler,
  addFreshnessHeaders,
  errorResponse,
  parseIntParam,
  jsonResponse,
  getLatestSuccessfulCronTimestamp,
  buildMethodologyEnvelope,
  fetchPaginatedEvents,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { CHAIN_META } from "@shared/lib/chains";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
  getBlacklistTrackerMethodologyVersionAt,
  toBlacklistTrackerMethodologyVersionLabel,
} from "@shared/lib/blacklist-tracker-version";

const VALID_STABLECOINS = new Set(["USDC", "USDT", "PAXG", "XAUT"]);
const VALID_CHAIN_NAMES = new Set(Object.values(CHAIN_META).map((m) => m.name));
const VALID_EVENT_TYPES = new Set(["blacklist", "unblacklist", "destroy"]);
type BlacklistRow = {
  id: string; stablecoin: string; chain_id: string; chain_name: string;
  event_type: string; address: string; amount: number | null; tx_hash: string;
  block_number: number; timestamp: number; methodology_version: string | null;
  explorer_tx_url: string; explorer_address_url: string;
};

export const handleBlacklist = withErrorHandler("blacklist", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const parsedLimit = parseIntParam(params.get("limit"), 1000, 0, 1000, "limit");
  if (parsedLimit instanceof Response) {
    return parsedLimit;
  }
  const limit = parsedLimit === 0 ? 1000 : parsedLimit;
  const offset = parseIntParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER, "offset");
  if (offset instanceof Response) {
    return offset;
  }
  const stablecoin = params.get("stablecoin");
  const chain = params.get("chain");
  const eventType = params.get("eventType");

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    const normalized = stablecoin.toUpperCase();
    if (!VALID_STABLECOINS.has(normalized)) {
      return errorResponse(400, "Invalid stablecoin parameter");
    }
    conditions.push("stablecoin = ?");
    filterBindings.push(normalized);
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

  const { events, total } = await fetchPaginatedEvents<BlacklistRow, {
    methodologyVersion: string;
    id: string;
    stablecoin: string;
    chainId: string;
    chainName: string;
    eventType: string;
    address: string;
    amount: number | null;
    txHash: string;
    blockNumber: number;
    timestamp: number;
    explorerTxUrl: string;
    explorerAddressUrl: string;
  }>(db, {
    tableName: "blacklist_events",
    orderBy: "timestamp DESC",
    conditions,
    filterBindings,
    limit,
    offset,
    mapRow: (row) => ({
      methodologyVersion: row.methodology_version ?? getBlacklistTrackerMethodologyVersionAt(row.timestamp),
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
    }),
  });

  const latestTs = events.length > 0 ? events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity) : Math.floor(Date.now() / 1000);
  const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-blacklist", latestTs);
  const methodologyVersion = events[0]?.methodologyVersion ?? getBlacklistTrackerMethodologyVersionAt(latestTs);
  const methodologyVersionLabel = toBlacklistTrackerMethodologyVersionLabel(methodologyVersion);

  return jsonResponse({
    events,
    total,
    methodology: buildMethodologyEnvelope({
      version: methodologyVersion,
      versionLabel: methodologyVersionLabel,
      currentVersion: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
      currentVersionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
      changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
      asOf: latestTs,
    }),
  }, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.realtime,
  }, freshnessTs, 900));
});
