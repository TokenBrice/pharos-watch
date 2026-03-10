"use client";

import { useMemo } from "react";
import { useApiQueryWithMeta, CRON_20MIN } from "./use-api-query";
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
import {
  getNetFlowDirection24h,
  getPressureShiftState,
} from "@shared/lib/mint-burn-signals";

const MINT_BURN_META_MAX_AGE_SEC = CRON_20MIN / 1000;

function inferHas24hActivity(
  coin: MintBurnFlowsResponse["coins"][number],
): boolean {
  return Boolean(
    coin.has24hActivity
    ?? coin.mintCount24h
    ?? coin.burnCount24h
    ?? coin.mintVolume24hUsd
    ?? coin.burnVolume24hUsd
    ?? coin.netFlow24hUsd,
  );
}

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
  const qs = hours !== 24 ? `?hours=${hours}` : "";
  const query = useApiQueryWithMeta<MintBurnFlowsResponse>(
    ["mint-burn-flows", "all", hours],
    `/api/mint-burn-flows${qs}`,
    CRON_20MIN,
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
  const params = new URLSearchParams({ stablecoin: stablecoinId });
  if (hours !== 24) params.set("hours", hours.toString());
  return useApiQueryWithMeta<MintBurnPerCoinResponse>(
    ["mint-burn-flows", stablecoinId, hours],
    `/api/mint-burn-flows?${params}`,
    CRON_20MIN,
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
    `/api/mint-burn-events?${params}`,
    CRON_20MIN,
    { schema: MintBurnEventsResponseSchema },
  );
}
