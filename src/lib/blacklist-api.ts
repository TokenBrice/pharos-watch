import { apiFetch } from "@/lib/api";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type {
  BlacklistEventType,
  BlacklistResponse,
  BlacklistSortDirection,
  BlacklistSortKey,
  BlacklistStablecoin,
  BlacklistSummaryResponse,
} from "@shared/types";
import { BlacklistResponseSchema, BlacklistSummaryResponseSchema } from "@shared/types/market";

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

export function fetchBlacklistEvents(params: FetchBlacklistEventsParams): Promise<BlacklistResponse> {
  return apiFetch(buildBlacklistEventsPath(params), BlacklistResponseSchema);
}

export function fetchBlacklistSummary(): Promise<BlacklistSummaryResponse> {
  return apiFetch(API_PATHS.blacklistSummary(), BlacklistSummaryResponseSchema);
}
