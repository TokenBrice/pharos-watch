import type { ApiMeta } from "@/lib/api";
import type { DataHealthCatchUp } from "@/lib/data-health";
import type { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";

/**
 * Compatibility wrapper around DataHealthBanner.
 * Prefer using `preset` to keep label/stale-time semantics centralized.
 */
export interface StaleQuery {
  preset?: keyof typeof DATA_HEALTH_PRESETS;
  label?: string;
  /** Timestamp in ms (from TanStack Query's dataUpdatedAt), 0 if never fetched */
  dataUpdatedAt: number;
  /** staleTime in ms (the cron interval) */
  staleTime?: number;
  hasData?: boolean;
  error?: unknown | null;
  meta?: ApiMeta | null;
  /**
   * First fetch in flight (TanStack `isLoading`). When omitted, a query with
   * no data, no error and `dataUpdatedAt === 0` has never settled, so it is
   * treated as in flight.
   */
  isLoading?: boolean;
  /** A build seed whose first live read is in flight; settled or paused reads must clear this. */
  awaitingLiveRead?: boolean;
  /** Producer catch-up detail, so an aged coverage clock with current totals is not read as a stall. */
  catchUp?: DataHealthCatchUp | null;
}
