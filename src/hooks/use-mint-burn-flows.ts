"use client";

import { useApiQuery, CRON_20MIN } from "./use-api-query";
import type {
  MintBurnFlowsResponse,
  MintBurnEventsResponse,
} from "@/lib/types";

export function useMintBurnFlows(stablecoinId?: string, hours = 24) {
  const params = new URLSearchParams();
  if (stablecoinId) params.set("stablecoin", stablecoinId);
  if (hours !== 24) params.set("hours", hours.toString());
  const qs = params.toString();

  return useApiQuery<MintBurnFlowsResponse>(
    ["mint-burn-flows", stablecoinId ?? "all", hours],
    `/api/mint-burn-flows${qs ? `?${qs}` : ""}`,
    CRON_20MIN
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
    CRON_20MIN
  );
}
