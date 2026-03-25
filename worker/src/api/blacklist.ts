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
} from "@shared/lib/blacklist-tracker-version";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-version";
import {
  BLACKLIST_STABLECOINS,
  type BlacklistSortDirection,
  type BlacklistSortKey,
  type BlacklistStablecoin,
} from "@shared/types/market";

const VALID_STABLECOINS = new Set<BlacklistStablecoin>(BLACKLIST_STABLECOINS);
const VALID_CHAIN_NAMES = new Set(Object.values(CHAIN_META).map((m) => m.name));
const VALID_EVENT_TYPES = new Set(["blacklist", "unblacklist", "destroy"]);
const VALID_SORT_KEYS = new Set<BlacklistSortKey>(["date", "stablecoin", "chain", "event"]);
const VALID_SORT_DIRECTIONS = new Set<BlacklistSortDirection>(["asc", "desc"]);
const BLACKLIST_ORDER_BY: Record<BlacklistSortKey, Record<BlacklistSortDirection, string>> = {
  date: {
    asc: "timestamp ASC, id ASC",
    desc: "timestamp DESC, id DESC",
  },
  stablecoin: {
    asc: "stablecoin ASC, timestamp DESC, id DESC",
    desc: "stablecoin DESC, timestamp DESC, id DESC",
  },
  chain: {
    asc: "chain_name ASC, timestamp DESC, id DESC",
    desc: "chain_name DESC, timestamp DESC, id DESC",
  },
  event: {
    asc: "event_type ASC, timestamp DESC, id DESC",
    desc: "event_type DESC, timestamp DESC, id DESC",
  },
};

function isBlacklistStablecoin(value: string): value is BlacklistStablecoin {
  return VALID_STABLECOINS.has(value as BlacklistStablecoin);
}

type BlacklistRow = {
  id: string;
  stablecoin: string;
  chain_id: string;
  chain_name: string;
  event_type: string;
  address: string;
  amount_native: number | null;
  amount_usd_at_event: number | null;
  amount_source: "event" | "historical_balance" | "derived" | "unavailable";
  amount_status: "resolved" | "recoverable_pending" | "permanently_unavailable" | "provider_failed" | "ambiguous";
  tx_hash: string;
  block_number: number;
  timestamp: number;
  methodology_version: string | null;
  contract_address: string | null;
  config_key: string | null;
  event_signature: string | null;
  event_topic0: string | null;
  explorer_tx_url: string;
  explorer_address_url: string;
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
  const query = params.get("q")?.trim().toLowerCase() ?? "";
  const sortByParam = params.get("sortBy") ?? "date";
  const sortDirectionParam = params.get("sortDirection") ?? "desc";
  if (!VALID_SORT_KEYS.has(sortByParam as BlacklistSortKey)) {
    return errorResponse(400, "Invalid sortBy parameter");
  }
  if (!VALID_SORT_DIRECTIONS.has(sortDirectionParam as BlacklistSortDirection)) {
    return errorResponse(400, "Invalid sortDirection parameter");
  }
  const sortBy = sortByParam as BlacklistSortKey;
  const sortDirection = sortDirectionParam as BlacklistSortDirection;

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    const normalized = stablecoin.toUpperCase();
    if (!isBlacklistStablecoin(normalized)) {
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
  if (query) {
    const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push("LOWER(address) LIKE ? ESCAPE '\\'");
    filterBindings.push(`%${escaped}%`);
  }

  const { events, total } = await fetchPaginatedEvents<
    BlacklistRow,
    {
      methodologyVersion: string;
      id: string;
      stablecoin: string;
      chainId: string;
      chainName: string;
      eventType: string;
      address: string;
      amountNative: number | null;
      amountUsdAtEvent: number | null;
      amountSource: BlacklistRow["amount_source"];
      amountStatus: BlacklistRow["amount_status"];
      txHash: string;
      blockNumber: number;
      timestamp: number;
      explorerTxUrl: string;
      explorerAddressUrl: string;
      contractAddress: string | null;
      configKey: string | null;
      eventSignature: string | null;
      eventTopic0: string | null;
    }
  >(db, {
    tableName: "blacklist_events",
    orderBy: BLACKLIST_ORDER_BY[sortBy][sortDirection],
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
      amountNative: row.amount_native,
      amountUsdAtEvent: row.amount_usd_at_event,
      amountSource: row.amount_source,
      amountStatus: row.amount_status,
      txHash: row.tx_hash,
      blockNumber: row.block_number,
      timestamp: row.timestamp,
      contractAddress: row.contract_address,
      configKey: row.config_key,
      eventSignature: row.event_signature,
      eventTopic0: row.event_topic0,
      explorerTxUrl: row.explorer_tx_url,
      explorerAddressUrl: row.explorer_address_url,
    }),
  });

  const latestTs =
    events.length > 0 ? events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity) : Math.floor(Date.now() / 1000);
  const freshnessTs = await getLatestSuccessfulCronTimestamp(db, "sync-blacklist", latestTs);
  const methodologyVersion = events[0]?.methodologyVersion ?? getBlacklistTrackerMethodologyVersionAt(latestTs);
  const methodologyVersionLabel = toMethodologyVersionLabel(methodologyVersion);

  return jsonResponse(
    {
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
    },
    addFreshnessHeaders(
      {
        "Cache-Control": CACHE_PROFILES.realtime,
      },
      freshnessTs,
      900,
    ),
  );
});
