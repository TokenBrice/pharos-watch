import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type {
  BlacklistEventType,
  BlacklistSortDirection,
  BlacklistSortKey,
  BlacklistStablecoin,
} from "@shared/types";

export interface FetchBlacklistEventsParams {
  stablecoin?: BlacklistStablecoin | "all";
  chainName?: string | "all";
  eventType?: BlacklistEventType | "all";
  query?: string;
  sortBy?: BlacklistSortKey;
  sortDirection?: BlacklistSortDirection;
  limit?: number;
  offset?: number;
  cursor?: string;
  includeTotal?: boolean;
}

export function buildBlacklistEventsPath(params: FetchBlacklistEventsParams): string {
  return API_PATHS.blacklist({
    stablecoin: params.stablecoin && params.stablecoin !== "all" ? params.stablecoin : undefined,
    chain: params.chainName && params.chainName !== "all" ? params.chainName : undefined,
    eventType: params.eventType && params.eventType !== "all" ? params.eventType : undefined,
    q: params.query?.trim() ? params.query.trim() : undefined,
    sortBy: params.sortBy,
    sortDirection: params.sortDirection,
    limit: params.limit,
    offset: params.cursor ? undefined : params.offset,
    cursor: params.cursor,
    includeTotal: params.includeTotal,
  });
}
