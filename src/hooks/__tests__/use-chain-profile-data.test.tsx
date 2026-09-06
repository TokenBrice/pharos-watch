// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainsResponse } from "@shared/types/chains";
import { RatioSchema } from "@shared/types/ratio";
import { makeChain, makeCoin } from "./chain-profile-fixtures";

const { useRegisteredApiQueryMock } = vi.hoisted(() => ({
  useRegisteredApiQueryMock: vi.fn(),
}));

vi.mock("../api-hooks", () => ({
  useRegisteredApiQuery: useRegisteredApiQueryMock,
}));

import { useChainProfileData } from "../use-chain-profile-data";

const SNAPSHOT_SEC = 1_710_500_000;

function makeResponse(overrides: Partial<ChainsResponse> = {}): ChainsResponse {
  return {
    chains: [makeChain({ totalUsd: 500_000_000 })],
    globalTotalUsd: 500_000_000,
    chainAttributedTotalUsd: 500_000_000,
    unattributedTotalUsd: 0,
    globalChange24hPct: RatioSchema.parse(0),
    globalChange7dPct: RatioSchema.parse(0),
    globalChange30dPct: RatioSchema.parse(0),
    chainDetail: {
      chainId: "ethereum",
      totalUsd: 500_000_000,
      coins: [makeCoin()],
    },
    updatedAt: SNAPSHOT_SEC,
    healthMethodologyVersion: "1.5",
    _meta: {
      updatedAt: SNAPSHOT_SEC,
      ageSeconds: 60,
      status: "fresh",
      dependencies: {
        reportCards: {
          status: "fresh",
          updatedAt: SNAPSHOT_SEC,
          ageSeconds: 60,
        },
      },
      safetyScoreIdentity: null,
    },
    ...overrides,
  };
}

function makeQuery(data: ChainsResponse | undefined, overrides: Record<string, unknown> = {}) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    dataUpdatedAt: data ? SNAPSHOT_SEC * 1_000 : 0,
    meta: data?._meta ?? null,
    ...overrides,
  };
}

describe("useChainProfileData", () => {
  beforeEach(() => {
    useRegisteredApiQueryMock.mockReset();
  });

  it("uses the Worker detail rows and total as the page model authority", () => {
    const payload = makeResponse({
      chainDetail: {
        chainId: "ethereum",
        totalUsd: 500_000_000,
        coins: [
          makeCoin({ id: "usdc-circle", supplyUsd: 375_000_000, chainShare: RatioSchema.parse(0.75) }),
          makeCoin({ id: "usdt-tether", supplyUsd: 125_000_000, chainShare: RatioSchema.parse(0.25) }),
        ],
      },
    });
    useRegisteredApiQueryMock.mockReturnValue(makeQuery(payload));

    const { result } = renderHook(() => useChainProfileData("ethereum"));

    expect(result.current.chain?.totalUsd).toBe(payload.chainDetail?.totalUsd);
    expect(result.current.totalUsd).toBe(payload.chainDetail?.totalUsd);
    expect(result.current.coins).toBe(payload.chainDetail?.coins);
    expect(result.current.coins).toEqual(payload.chainDetail?.coins);
    expect(useRegisteredApiQueryMock).toHaveBeenCalledTimes(1);
  });

  it("confirms a missing chain only after the Worker response is available", () => {
    useRegisteredApiQueryMock.mockReturnValue(makeQuery(makeResponse({ chains: [], chainDetail: undefined })));

    const { result } = renderHook(() => useChainProfileData("ethereum"));

    expect(result.current.chain).toBeNull();
    expect(result.current.canConfirmMissingChain).toBe(true);
    expect(result.current.hasAnyData).toBe(true);
    expect(result.current.coins).toEqual([]);
  });

  it("reports initial loading before the chain response arrives", () => {
    useRegisteredApiQueryMock.mockReturnValue(makeQuery(undefined, { isLoading: true }));

    const { result } = renderHook(() => useChainProfileData("ethereum"));

    expect(result.current.isInitialLoading).toBe(true);
    expect(result.current.hasAnyData).toBe(false);
    expect(result.current.routeError).toBeNull();
  });

  it("surfaces a chain response error without inventing detail data", () => {
    const responseError = new Error("chains unavailable");
    useRegisteredApiQueryMock.mockReturnValue(makeQuery(undefined, {
      isError: true,
      error: responseError,
    }));

    const { result } = renderHook(() => useChainProfileData("ethereum"));

    expect(result.current.routeError).toBe(responseError);
    expect(result.current.canConfirmMissingChain).toBe(false);
    expect(result.current.coins).toEqual([]);
  });

  it("refetches the single authoritative query through refetchAll", async () => {
    const refetch = vi.fn().mockResolvedValue({ status: "success", error: null });
    useRegisteredApiQueryMock.mockReturnValue(makeQuery(makeResponse(), { refetch }));

    const { result } = renderHook(() => useChainProfileData("ethereum"));

    await act(async () => {
      await result.current.refetchAll();
    });

    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
