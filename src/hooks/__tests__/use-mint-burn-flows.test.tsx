// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeToSignedFlowIntensity } from "@/lib/flow-intensity";

const { useRegisteredApiQueryMock } = vi.hoisted(() => ({
  useRegisteredApiQueryMock: vi.fn(),
}));

vi.mock("../api-hooks", () => ({
  useRegisteredApiQuery: useRegisteredApiQueryMock,
}));

import { useMintBurnEvents, useMintBurnFlows } from "../use-mint-burn-flows";

describe("useMintBurnFlows", () => {
  beforeEach(() => {
    useRegisteredApiQueryMock.mockReset();
  });

  it("normalizes legacy flow intensity semantics and derives missing activity fields", () => {
    useRegisteredApiQueryMock.mockReturnValue({
      data: {
        gauge: {
          score: 70,
          intensitySemantics: "midpoint-v1",
        },
        coins: [
          {
            id: "usdc-circle",
            flowIntensity: 80,
            pressureShiftScore: undefined,
            pressureShiftState: undefined,
            netFlowDirection24h: undefined,
            mintCount24h: 1,
            burnCount24h: 0,
            mintVolume24hUsd: 100,
            burnVolume24hUsd: 0,
            netFlow24hUsd: 100,
          },
        ],
      },
      meta: { status: "fresh" },
    });

    const { result } = renderHook(() => useMintBurnFlows());

    expect(result.current.data?.gauge.score).toBe(
      normalizeToSignedFlowIntensity(70, "midpoint-v1"),
    );
    expect(result.current.data?.gauge.intensitySemantics).toBe("signed-v2");
    expect(result.current.data?.coins[0]).toMatchObject({
      has24hActivity: true,
      baselineDailyNetUsd: null,
      baselineDailyAbsUsd: null,
      baselineDataDays: null,
    });
    expect(result.current.data?.coins[0].flowIntensity).toBe(
      normalizeToSignedFlowIntensity(80, "midpoint-v1"),
    );
    expect(result.current.data?.coins[0].pressureShiftScore).toBe(
      normalizeToSignedFlowIntensity(80, "midpoint-v1"),
    );
    expect(result.current.data?.coins[0].pressureShiftState).toBeDefined();
    expect(result.current.data?.coins[0].netFlowDirection24h).toBe("minting");
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
