import {
  withErrorHandler,
  errorResponse,
  parseEnumParam,
  parseOptionalEnumParam,
  buildMethodologyEnvelope,
  buildPaginatedEventResponse,
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
import { getSupportedBlacklistChainIds, getSupportedBlacklistChainNames } from "../lib/blacklist-coverage-manifest";
import {
  type BlacklistEvent,
  type BlacklistSortDirection,
  type BlacklistSortKey,
} from "@shared/types/market";
import { isBlacklistStablecoin } from "@shared/lib/blacklist";
import { mapBlacklistEventRow, type BlacklistEventRow } from "../lib/blacklist-api";

const VALID_CHAIN_NAMES = getSupportedBlacklistChainNames();
const VALID_CHAIN_IDS = getSupportedBlacklistChainIds();
const VALID_EVENT_TYPES = new Set(["blacklist", "unblacklist", "destroy"]);
const VALID_SORT_KEYS = new Set<BlacklistSortKey>(["date", "stablecoin", "chain", "event"]);
const VALID_SORT_DIRECTIONS = new Set<BlacklistSortDirection>(["asc", "desc"]);
const BLACKLIST_MAX_OFFSET = 25_000;
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

function getBlacklistPageIndex(
  sortBy: BlacklistSortKey,
  filters: { stablecoin: boolean; chain: boolean; chainId: boolean; eventType: boolean },
): string {
  if (sortBy === "stablecoin") return "idx_blacklist_events_public_stablecoin_page";
  if (sortBy === "chain") return "idx_blacklist_events_public_chain_page";
  if (sortBy === "event") return "idx_blacklist_events_public_event_page";
  if (filters.stablecoin) return "idx_blacklist_events_public_stablecoin_page";
  if (filters.chain) return "idx_blacklist_events_public_chain_page";
  if (filters.chainId) return "idx_blacklist_events_public_chain_id_page";
  if (filters.eventType) return "idx_blacklist_events_public_event_page";
  return "idx_blacklist_events_public_date_page";
}

function getBlacklistCursor(sortBy: BlacklistSortKey, sortDirection: BlacklistSortDirection) {
  const primaryDirection: "ASC" | "DESC" = sortDirection === "asc" ? "ASC" : "DESC";
  if (sortBy === "date") {
    return {
      columns: [
        { column: "timestamp", type: "number" as const, direction: primaryDirection, getValue: (row: BlacklistEventRow) => row.timestamp },
        { column: "id", type: "string" as const, direction: primaryDirection, getValue: (row: BlacklistEventRow) => row.id },
      ],
    };
  }

  const primaryColumn = sortBy === "stablecoin"
    ? "stablecoin"
    : sortBy === "chain"
      ? "chain_name"
      : "event_type";
  const getPrimaryValue = (row: BlacklistEventRow) => sortBy === "stablecoin"
    ? row.stablecoin
    : sortBy === "chain"
      ? row.chain_name
      : row.event_type;
  return {
    columns: [
      { column: primaryColumn, type: "string" as const, direction: primaryDirection, getValue: getPrimaryValue },
      { column: "timestamp", type: "number" as const, direction: "DESC" as const, getValue: (row: BlacklistEventRow) => row.timestamp },
      { column: "id", type: "string" as const, direction: "DESC" as const, getValue: (row: BlacklistEventRow) => row.id },
    ],
  };
}

export const handleBlacklist = withErrorHandler("blacklist", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const stablecoin = params.get("stablecoin");
  const chain = params.get("chain");
  const chainId = params.get("chainId");
  const eventType = parseOptionalEnumParam(params.get("eventType"), VALID_EVENT_TYPES, "eventType");
  if (eventType instanceof Response) return eventType;
  const query = params.get("q")?.trim().toLowerCase() ?? "";
  const sortBy = parseEnumParam(params.get("sortBy"), VALID_SORT_KEYS, "sortBy", "date");
  if (sortBy instanceof Response) return sortBy;
  const sortDirection = parseEnumParam(params.get("sortDirection"), VALID_SORT_DIRECTIONS, "sortDirection", "desc");
  if (sortDirection instanceof Response) return sortDirection;

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];
  conditions.push("suppression_reason IS NULL");

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
  if (chainId) {
    const normalizedChainId = chainId.toLowerCase();
    if (!VALID_CHAIN_IDS.has(normalizedChainId)) {
      return errorResponse(400, "Invalid chainId parameter");
    }
    if (chain && CHAIN_META[normalizedChainId]?.name !== chain) {
      return errorResponse(400, "chain and chainId parameters do not match");
    }
    conditions.push("chain_id = ?");
    filterBindings.push(normalizedChainId);
  }
  if (eventType) {
    conditions.push("event_type = ?");
    filterBindings.push(eventType);
  }
  if (query) {
    const escaped = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push("LOWER(address) LIKE ? ESCAPE '\\'");
    filterBindings.push(`%${escaped}%`);
  }

  return buildPaginatedEventResponse<BlacklistEventRow, BlacklistEvent>(db, {
    tableName: "blacklist_events",
    indexName: getBlacklistPageIndex(sortBy, {
      stablecoin: stablecoin != null,
      chain: chain != null,
      chainId: chainId != null,
      eventType: eventType != null,
    }),
    orderBy: BLACKLIST_ORDER_BY[sortBy][sortDirection],
    queryComment: "pharos:blacklist-events",
    conditions,
    filterBindings,
    mapRow: mapBlacklistEventRow,
    searchParams: params,
    pagination: {
      defaultLimit: 1000,
      minLimit: 0,
      maxLimit: 1000,
      maxOffset: BLACKLIST_MAX_OFFSET,
      zeroLimitAsDefault: true,
      includeTotalDefault: false,
    },
    cursor: getBlacklistCursor(sortBy, sortDirection),
    freshness: {
      producerJob: "sync-blacklist",
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklist,
      fallbackTimestamp: (events) =>
        events.length > 0
          ? events.reduce((m, e) => Math.max(m, e.timestamp), -Infinity)
          : Math.floor(Date.now() / 1000),
    },
    cacheControl: CACHE_PROFILES.producerBacked,
    buildExtraBody: (events, _total, latestTs) => {
      const latestEvent = events.reduce<BlacklistEvent | null>(
        (latest, event) => (latest == null || event.timestamp > latest.timestamp ? event : latest),
        null,
      );
      const methodologyVersion = latestEvent?.methodologyVersion ?? getBlacklistTrackerMethodologyVersionAt(latestTs);
      const methodologyVersionLabel = toMethodologyVersionLabel(methodologyVersion);

      return {
        methodology: buildMethodologyEnvelope({
          version: methodologyVersion,
          versionLabel: methodologyVersionLabel,
          currentVersion: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
          currentVersionLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
          changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
          asOf: latestTs,
        }),
      };
    },
  });
});
