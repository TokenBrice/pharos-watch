"use client";

import { useApiQuery, CRON_20MIN } from "./use-api-query";
import type {
  MintBurnFlowsResponse,
  MintBurnPerCoinResponse,
  MintBurnEventsResponse,
} from "@/lib/types";

/** Aggregate flows — returns gauge, coins[], hourly[]. No stablecoin filter. */
export function useMintBurnFlows(hours = 24) {
  const qs = hours !== 24 ? `?hours=${hours}` : "";
  return useApiQuery<MintBurnFlowsResponse>(
    ["mint-burn-flows", "all", hours],
    `/api/mint-burn-flows${qs}`,
    CRON_20MIN,
  );
}

/** Per-coin flows — returns flat object with chains[], hourly[]. Requires stablecoinId. */
export function useMintBurnFlowsCoin(stablecoinId: string, hours = 24) {
  const params = new URLSearchParams({ stablecoin: stablecoinId });
  if (hours !== 24) params.set("hours", hours.toString());
  return useApiQuery<MintBurnPerCoinResponse>(
    ["mint-burn-flows", stablecoinId, hours],
    `/api/mint-burn-flows?${params}`,
    CRON_20MIN,
    { enabled: !!stablecoinId },
  );
}

export function useMintBurnEvents(
  stablecoinId: string,
  opts?: { direction?: string; limit?: number; offset?: number }
) {
  const params = new URLSearchParams({ stablecoin: stablecoinId });
  if (opts?.direction) params.set("direction", opts.direction);
  if (opts?.limit) params.set("limit", opts.limit.toString());
  if (opts?.offset) params.set("offset", opts.offset.toString());

  return useApiQuery<MintBurnEventsResponse>(
    ["mint-burn-events", stablecoinId, opts?.direction ?? "all", opts?.offset ?? 0],
    `/api/mint-burn-events?${params}`,
    CRON_20MIN,
  );
}
