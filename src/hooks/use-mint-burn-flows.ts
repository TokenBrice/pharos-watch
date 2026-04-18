"use client";

import { useMemo } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { useApiQueryWithMeta } from "./use-api-query";
import { CRON_MINT_BURN } from "@/lib/cron-intervals";
import {
  MintBurnFlowsResponseSchema,
  MintBurnPerCoinResponseSchema,
  MintBurnEventsResponseSchema,
  type MintBurnFlowsResponse,
  type MintBurnPerCoinResponse,
  type MintBurnEventsResponse,
} from "@shared/types";
import {
  normalizeToSignedFlowIntensity,
  type FlowIntensitySemantics,
} from "@/lib/flow-intensity";
import { inferHas24hActivity } from "@/lib/mint-burn-coin-helpers";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
} from "@shared/lib/mint-burn-signals";

const MINT_BURN_META_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows;

function resolveFlowSemantics(
  response: MintBurnFlowsResponse,
): FlowIntensitySemantics {
  return response.gauge.intensitySemantics ?? "midpoint-v1";
}

function normalizeMintBurnFlowsResponse(
  response: MintBurnFlowsResponse,
): MintBurnFlowsResponse {
  const semantics = resolveFlowSemantics(response);

  return {
    ...response,
    gauge: {
      ...response.gauge,
      score:
        response.gauge.score === null
          ? null
          : normalizeToSignedFlowIntensity(response.gauge.score, semantics),
      intensitySemantics: "signed-v2",
    },
    coins: response.coins.map((coin) => {
      const normalizedLegacyScore =
        coin.flowIntensity === null
          ? null
          : normalizeToSignedFlowIntensity(coin.flowIntensity, semantics);
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
        pressureShiftState:
          coin.pressureShiftState
          ?? getPressureShiftState(normalizedPressureShiftScore),
        netFlowDirection24h:
          coin.netFlowDirection24h
          ?? getNetFlowDirection24h({
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
export function useMintBurnFlows(hours = 24) {
  const query = useApiQueryWithMeta<MintBurnFlowsResponse>(
    ["mint-burn-flows", "all", hours],
    API_PATHS.mintBurnFlows(hours !== 24 ? { hours } : undefined),
    CRON_MINT_BURN,
    { schema: MintBurnFlowsResponseSchema, metaMaxAgeSec: MINT_BURN_META_MAX_AGE_SEC },
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

/** Per-coin flows — returns flat object with chains[], hourly[]. Requires stablecoinId. */
export function useMintBurnFlowsCoin(
  stablecoinId: string,
  hours = 24,
  opts?: { enabled?: boolean },
) {
  return useApiQueryWithMeta<MintBurnPerCoinResponse>(
    ["mint-burn-flows", stablecoinId, hours],
    API_PATHS.mintBurnFlows({ stablecoin: stablecoinId, hours: hours !== 24 ? hours : undefined }),
    CRON_MINT_BURN,
    {
      enabled: !!stablecoinId && (opts?.enabled ?? true),
      schema: MintBurnPerCoinResponseSchema,
      metaMaxAgeSec: MINT_BURN_META_MAX_AGE_SEC,
    },
  );
}

export function useMintBurnEvents(
  stablecoinId: string,
  opts?: {
    direction?: string;
    burnType?: "effective_burn" | "bridge_burn" | "review_required";
    scope?: "all" | "counted";
    limit?: number;
    offset?: number;
  }
) {
  const params = new URLSearchParams({ stablecoin: stablecoinId });
  if (opts?.direction) params.set("direction", opts.direction);
  if (opts?.burnType) params.set("burnType", opts.burnType);
  if (opts?.scope && opts.scope !== "all") params.set("scope", opts.scope);
  if (opts?.limit) params.set("limit", opts.limit.toString());
  if (opts?.offset) params.set("offset", opts.offset.toString());
  const queryParams = Object.fromEntries(params.entries());

  return useApiQueryWithMeta<MintBurnEventsResponse>(
    [
      "mint-burn-events",
      stablecoinId,
      opts?.scope ?? "all",
      opts?.direction ?? "all",
      opts?.burnType ?? "all",
      opts?.limit ?? 50,
      opts?.offset ?? 0,
    ],
    API_PATHS.mintBurnEvents(queryParams),
    CRON_MINT_BURN,
    {
      schema: MintBurnEventsResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnEvents,
    },
  );
}
