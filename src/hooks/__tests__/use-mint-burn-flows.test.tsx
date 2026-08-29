// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MintBurnFlowsResponse } from "@shared/types";
import { MintBurnFlowsResponseSchema } from "@shared/types/mint-burn";

const { useRegisteredApiQueryMock } = vi.hoisted(() => ({
  useRegisteredApiQueryMock: vi.fn(),
}));

vi.mock("../api-hooks", () => ({
  useRegisteredApiQuery: useRegisteredApiQueryMock,
}));

import { useMintBurnEvents, useMintBurnFlows } from "../use-mint-burn-flows";

const currentPayload = {
  gauge: {
    score: -34,
    band: "CAUTIOUS",
    intensitySemantics: "signed-v2",
    flightToQuality: false,
    flightIntensity: 0,
    trackedCoins: 1,
    trackedMcapUsd: 100_000_000,
  },
  coins: [
    {
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      flowIntensity: -42,
      pressureShiftScore: -42,
      pressureShiftState: "worsening",
      netFlowDirection24h: "burning",
      has24hActivity: true,
      baselineDailyNetUsd: 1_000_000,
      baselineDailyAbsUsd: 2_000_000,
      baselineDataDays: 30,
      netFlow24hUsd: -3_000_000,
      mintVolume24hUsd: 1_000_000,
      burnVolume24hUsd: 4_000_000,
      mintCount24h: 1,
      burnCount24h: 2,
      netFlow7dUsd: -5_000_000,
      netFlow30dUsd: -8_000_000,
      netFlow90dUsd: -10_000_000,
      largestEvent24h: null,
    },
  ],
  chains: [],
  hourly: [],
  updatedAt: 1_700_000_000,
  windowHours: 24,
  scope: {
    chainIds: ["ethereum"],
    label: "Configured issuance chains",
  },
  sync: {
    lastSuccessfulSyncAt: 1_700_000_000,
    freshnessStatus: "fresh",
    warning: null,
    criticalLaneHealthy: true,
  },
} satisfies MintBurnFlowsResponse;

describe("useMintBurnFlows", () => {
  beforeEach(() => {
    useRegisteredApiQueryMock.mockReset();
  });

  it("passes current signed flow values and states through unchanged", () => {
    useRegisteredApiQueryMock.mockReturnValue({
      data: currentPayload,
      meta: { status: "fresh" },
    });

    const { result } = renderHook(() => useMintBurnFlows());

    expect(result.current.data).toBe(currentPayload);
    expect(result.current.data?.gauge).toMatchObject({ score: -34, intensitySemantics: "signed-v2" });
    expect(result.current.data?.coins[0]).toMatchObject({
      flowIntensity: -42,
      pressureShiftScore: -42,
      pressureShiftState: "worsening",
      netFlowDirection24h: "burning",
      has24hActivity: true,
    });
  });

  it("rejects midpoint-v1 payloads at the live response schema boundary", () => {
    const parsed = MintBurnFlowsResponseSchema.safeParse({
      ...currentPayload,
      gauge: { ...currentPayload.gauge, intensitySemantics: "midpoint-v1" },
    });

    expect(parsed.success).toBe(false);
  });

  it("builds event queries with stable filters and offsets", () => {
    useRegisteredApiQueryMock.mockReturnValue({
      data: undefined,
      meta: null,
    });

    renderHook(() => useMintBurnEvents("usdc-circle", {
      scope: "counted",
      direction: "mint",
      burnType: "effective_burn",
      limit: 25,
      offset: 50,
    }));

    expect(useRegisteredApiQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [
          "mint-burn-events",
          "usdc-circle",
          "counted",
          "mint",
          "effective_burn",
          25,
          50,
        ],
        path: "/api/mint-burn-events?stablecoin=usdc-circle&direction=mint&burnType=effective_burn&scope=counted&limit=25&offset=50",
      }),
    );
  });
});
