import { apiFetch } from "@/lib/api";
import { API_PATHS } from "@shared/lib/api-endpoints";
import {
  BlacklistResponseSchema,
  BlacklistSummaryResponseSchema,
  type BlacklistEventType,
  type BlacklistResponse,
  type BlacklistSortDirection,
  type BlacklistSortKey,
  type BlacklistStablecoin,
  type BlacklistSummaryResponse,
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
    offset: params.offset,
  });
}

export function fetchBlacklistEvents(params: FetchBlacklistEventsParams): Promise<BlacklistResponse> {
  return apiFetch(
    buildBlacklistEventsPath(params),
    BlacklistResponseSchema,
  );
}

export function fetchBlacklistSummary(): Promise<BlacklistSummaryResponse> {
  return apiFetch(API_PATHS.blacklistSummary(), BlacklistSummaryResponseSchema);
}
