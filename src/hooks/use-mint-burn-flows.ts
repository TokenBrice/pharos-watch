"use client";

import {
  asMetaQueryOptions,
  createRegisteredApiPollingQueryOptions,
  useRegisteredApiQuery,
} from "./api-hooks";
import type { MintBurnFlowsResponse, MintBurnPerCoinResponse, MintBurnEventsResponse } from "@shared/types";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  type MintBurnEventsDescriptorOptions,
} from "@/lib/api-query-descriptors";

/** Aggregate flows — returns gauge, coins[], hourly[]. No stablecoin filter. */
export function useMintBurnFlows(hours = 24, opts?: { enabled?: boolean }) {
  return useRegisteredApiQuery<MintBurnFlowsResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.mintBurnFlows(hours),
    { enabled: opts?.enabled },
  );
}

export function mintBurnFlowsCoinQueryOptions(stablecoinId: string, hours = 24, opts?: { enabled?: boolean }) {
  return asMetaQueryOptions<MintBurnPerCoinResponse>(
    createRegisteredApiPollingQueryOptions<MintBurnPerCoinResponse>(
      FRONTEND_API_QUERY_DESCRIPTORS.mintBurnFlowsCoin(stablecoinId, hours),
      { enabled: !!stablecoinId && (opts?.enabled ?? true) },
    ),
  );
}

export function useMintBurnEvents(
  stablecoinId: string,
  opts?: MintBurnEventsDescriptorOptions,
) {
  return useRegisteredApiQuery<MintBurnEventsResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.mintBurnEvents(stablecoinId, opts),
  );
}
