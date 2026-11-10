import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import type {
  BlacklistEventType,
  BlacklistSortDirection,
  BlacklistSortKey,
  BlacklistStablecoin,
  BlacklistSummaryRefresh,
} from "@shared/types";
import type { DataHealthCatchUp } from "@/lib/data-health";

/** Names each config the producer reported behind its safe head for the freshness banner. */
export function blacklistSummaryCatchUp(refresh: BlacklistSummaryRefresh | undefined): DataHealthCatchUp | null {
  if (!refresh) return null;
  return {
    observedAt: refresh.observedAt,
    sources: refresh.behindConfigs.map((config) => ({
      label: `${config.symbol} on ${config.chainName}`,
      lastSucceededAt: config.lastSucceededAt,
    })),
  };
}

export interface FetchBlacklistEventsParams {
  stablecoin?: BlacklistStablecoin | "all";
  /** Canonical chain id; filters without depending on the summary's chain-name map. */
  chainId?: string;
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
    chainId: params.chainId,
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
