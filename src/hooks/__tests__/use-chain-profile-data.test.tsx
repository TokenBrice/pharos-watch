// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChain, makeCoin } from "./chain-profile-fixtures";

const { useChainsMock, useChainStablecoinsMock } = vi.hoisted(() => ({
  useChainsMock: vi.fn(),
  useChainStablecoinsMock: vi.fn(),
}));

vi.mock("../use-chains", () => ({
  useChains: useChainsMock,
  useChainStablecoins: useChainStablecoinsMock,
}));

import { useChainProfileData } from "../use-chain-profile-data";

describe("useChainProfileData", () => {
  beforeEach(() => {
    useChainsMock.mockReset();
    useChainStablecoinsMock.mockReset();

    useChainsMock.mockReturnValue({
      data: { chains: [makeChain()] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      dataUpdatedAt: 1_710_500_000_000,
      meta: { updatedAt: 1_710_500_000, ageSeconds: 60, status: "fresh" },
    });

    useChainStablecoinsMock.mockReturnValue({
      coins: [makeCoin()],
      totalUsd: 500_000_000,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      dataUpdatedAt: 1_710_500_000_000,
      meta: { updatedAt: 1_710_500_000, ageSeconds: 60, status: "fresh" },
    });
  });

  it("allows detailed sections when both snapshots match exactly", () => {
    const { result } = renderHook(() => useChainProfileData("ethereum"));

    expect(result.current.chain?.id).toBe("ethereum");
    expect(result.current.canRenderDetailedSections).toBe(true);
    expect(result.current.snapshotConsistency).toBe("matched");
    expect(result.current.detailedSectionNotice).toBeNull();
  });

  it("blocks detailed sections when snapshots mismatch", () => {
    useChainStablecoinsMock.mockReturnValue({
      coins: [makeCoin()],
      totalUsd: 500_000_000,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      dataUpdatedAt: 1_710_499_100_000,
      meta: { updatedAt: 1_710_499_100, ageSeconds: 960, status: "degraded" },
    });

    const { result } = renderHook(() => useChainProfileData("ethereum"));

    expect(result.current.canRenderDetailedSections).toBe(false);
    expect(result.current.snapshotConsistency).toBe("mismatched");
    expect(result.current.detailedSectionNotice).toMatch(/syncing to the latest chain snapshot/i);
  });

  it("still surfaces a route error when the stablecoin refresh fails against cached data", () => {
    const refreshError = new Error("cached response");
    useChainStablecoinsMock.mockReturnValue({
      coins: [makeCoin()],
      totalUsd: 500_000_000,
      isLoading: false,
      isError: true,
      error: refreshError,
      refetch: vi.fn(),
      dataUpdatedAt: 1_710_500_000_000,
      meta: { updatedAt: 1_710_500_000, ageSeconds: 60, status: "fresh" },
    });

    const { result } = renderHook(() => useChainProfileData("ethereum"));

    expect(result.current.canRenderDetailedSections).toBe(true);
    expect(result.current.detailedSectionNotice).toMatch(/temporarily unavailable/i);
    expect(result.current.routeError).toBe(refreshError);
  });
});
