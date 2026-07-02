"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ApiMeta } from "@/lib/api";
import {
  unwrapApiQueryWithMetaResult,
} from "./use-api-query";
import {
  createRegisteredApiPollingQueryOptionsWithMeta,
  useRegisteredApiQueryWithMeta,
} from "./api-hooks";
import type { MintBurnFlowsResponse, MintBurnPerCoinResponse, MintBurnEventsResponse } from "@shared/types";
import { normalizeToSignedFlowIntensity, type FlowIntensitySemantics } from "@/lib/flow-intensity";
import { inferHas24hActivity } from "@/lib/mint-burn-coin-helpers";
import { getNetFlowDirection24h, getPressureShiftState } from "@shared/lib/mint-burn-signals";
import {
  FRONTEND_API_QUERY_RUNTIME_REGISTRY,
  type MintBurnEventsDescriptorOptions,
} from "@/lib/api-query-runtime-registry";

function resolveFlowSemantics(response: MintBurnFlowsResponse): FlowIntensitySemantics {
  return response.gauge.intensitySemantics ?? "midpoint-v1";
}

function normalizeMintBurnFlowsResponse(response: MintBurnFlowsResponse): MintBurnFlowsResponse {
  const semantics = resolveFlowSemantics(response);

  return {
    ...response,
    gauge: {
      ...response.gauge,
      score: response.gauge.score === null ? null : normalizeToSignedFlowIntensity(response.gauge.score, semantics),
      intensitySemantics: "signed-v2",
    },
    coins: response.coins.map((coin) => {
      const normalizedLegacyScore =
        coin.flowIntensity === null ? null : normalizeToSignedFlowIntensity(coin.flowIntensity, semantics);
      const normalizedPressureShiftScore =
        coin.pressureShiftScore === undefined
          ? normalizedLegacyScore
          : coin.pressureShiftScore === null
            ? null
            : normalizeToSignedFlowIntensity(coin.pressureShiftScore, semantics);
      const has24hActivity = inferHas24hActivity(coin);

      return {
        ...coin,
        flowIntensity: normalizedLegacyScore,
        pressureShiftScore: normalizedPressureShiftScore,
        pressureShiftState: coin.pressureShiftState ?? getPressureShiftState(normalizedPressureShiftScore),
        netFlowDirection24h:
          coin.netFlowDirection24h ??
          getNetFlowDirection24h({
            netFlow24hUsd: coin.netFlow24hUsd,
            has24hActivity,
          }),
        has24hActivity,
        baselineDailyNetUsd: coin.baselineDailyNetUsd ?? null,
        baselineDailyAbsUsd: coin.baselineDailyAbsUsd ?? null,
        baselineDataDays: coin.baselineDataDays ?? null,
      };
    }),
  };
}

/** Aggregate flows — returns gauge, coins[], hourly[]. No stablecoin filter. */
export function useMintBurnFlows(hours = 24, opts?: { enabled?: boolean }) {
  const query = useRegisteredApiQueryWithMeta<MintBurnFlowsResponse>(
    FRONTEND_API_QUERY_RUNTIME_REGISTRY.mintBurnFlows(hours),
    { enabled: opts?.enabled },
  );
  const normalizedData = useMemo(
    () => (query.data ? normalizeMintBurnFlowsResponse(query.data) : undefined),
    [query.data],
  );
  return {
    ...query,
    data: normalizedData,
  };
}

export function mintBurnFlowsCoinQueryOptions(stablecoinId: string, hours = 24, opts?: { enabled?: boolean }) {
  return createRegisteredApiPollingQueryOptionsWithMeta<MintBurnPerCoinResponse>(
    FRONTEND_API_QUERY_RUNTIME_REGISTRY.mintBurnFlowsCoin(stablecoinId, hours),
    { enabled: !!stablecoinId && (opts?.enabled ?? true) },
  );
}

/** Per-coin flows — returns flat object with chains[], hourly[]. Requires stablecoinId. */
export function useMintBurnFlowsCoin(stablecoinId: string, hours = 24, opts?: { enabled?: boolean }) {
  return unwrapApiQueryWithMetaResult(
    useQuery<{ data: MintBurnPerCoinResponse; meta: ApiMeta | null }, Error>(
      mintBurnFlowsCoinQueryOptions(stablecoinId, hours, opts),
    ),
  );
}

export function useMintBurnEvents(
  stablecoinId: string,
  opts?: MintBurnEventsDescriptorOptions,
) {
  return useRegisteredApiQueryWithMeta<MintBurnEventsResponse>(
    FRONTEND_API_QUERY_RUNTIME_REGISTRY.mintBurnEvents(stablecoinId, opts),
  );
}
