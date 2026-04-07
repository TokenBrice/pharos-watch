import {
  withErrorHandler,
  addFreshnessHeaders,
  errorResponse,
  parseEnumParam,
  parseOptionalEnumParam,
  parseQueryParams,
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
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  BLACKLIST_STABLECOINS,
  type BlacklistSortDirection,
  type BlacklistSortKey,
  type BlacklistStablecoin,
} from "@shared/types/market";
import {
  mapBlacklistEventRow,
  type BlacklistEventApiRecord,
  type BlacklistEventRow,
} from "../lib/blacklist-api";

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

export const handleBlacklist = withErrorHandler("blacklist", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const numericParams = parseQueryParams(params, {
    limit: { type: "int", default: 1000, min: 0, max: 1000, rangePolicy: "reject" },
    offset: { type: "int", default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, rangePolicy: "reject" },
  });
  if (numericParams instanceof Response) return numericParams;
  const limit = numericParams.limit === 0 ? 1000 : numericParams.limit;
  const { offset } = numericParams;
  const stablecoin = params.get("stablecoin");
  const chain = params.get("chain");
  const eventType = parseOptionalEnumParam(params.get("eventType"), VALID_EVENT_TYPES, "eventType");
  if (eventType instanceof Response) return eventType;
  const query = params.get("q")?.trim().toLowerCase() ?? "";
  const sortBy = parseEnumParam(params.get("sortBy"), VALID_SORT_KEYS, "sortBy", "date");
  if (sortBy instanceof Response) return sortBy;
  const sortDirection = parseEnumParam(params.get("sortDirection"), VALID_SORT_DIRECTIONS, "sortDirection", "desc");
  if (sortDirection instanceof Response) return sortDirection;

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
    conditions.push("event_type = ?");
    filterBindings.push(eventType);
  }
  if (query) {
    const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push("LOWER(address) LIKE ? ESCAPE '\\'");
    filterBindings.push(`%${escaped}%`);
  }

  const { events, total } = await fetchPaginatedEvents<
    BlacklistEventRow,
    BlacklistEventApiRecord
  >(db, {
    tableName: "blacklist_events",
    orderBy: BLACKLIST_ORDER_BY[sortBy][sortDirection],
    conditions,
    filterBindings,
    limit,
    offset,
    mapRow: mapBlacklistEventRow,
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
      API_FRESHNESS_MAX_AGE_SEC.blacklist,
    ),
  );
});
