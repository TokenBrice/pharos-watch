// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainSummary } from "@shared/types/chains";
import type { ChainStablecoin } from "../use-chains";

const { useChainsMock, useChainStablecoinsMock } = vi.hoisted(() => ({
  useChainsMock: vi.fn(),
  useChainStablecoinsMock: vi.fn(),
}));

vi.mock("../use-chains", () => ({
  useChains: useChainsMock,
  useChainStablecoins: useChainStablecoinsMock,
}));

import { useChainProfileData } from "../use-chain-profile-data";

function makeChain(overrides: Partial<ChainSummary> = {}): ChainSummary {
  return {
    id: "ethereum",
    name: "Ethereum",
    logoPath: "/chains/ethereum.png",
    type: "evm",
    totalUsd: 1_500_000_000,
    change24h: 15_000_000,
    change24hPct: 0.01,
    change7d: 30_000_000,
    change7dPct: 0.02,
    change30d: 45_000_000,
    change30dPct: 0.03,
    stablecoinCount: 2,
    dominantStablecoin: {
      id: "usdc-circle",
      symbol: "USDC",
      share: 0.5,
    },
    dominanceShare: 0.32,
    healthScore: 84,
    healthBand: "robust",
    healthFactors: {
      quality: 82,
      chainEnvironment: 80,
      concentration: 78,
      pegStability: 88,
      backingDiversity: 76,
    },
    ...overrides,
  };
}

function makeCoin(overrides: Partial<ChainStablecoin> = {}): ChainStablecoin {
  return {
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
    price: 1,
    pegType: "peggedUSD",
    supplyOnChain: 500_000_000,
    chainShare: 0.5,
    change24h: 1_000_000,
    change24hPct: 0.01,
    change7d: 2_000_000,
    change7dPct: 0.02,
    change30d: 3_000_000,
    change30dPct: 0.03,
    backing: "rwa-backed",
    ...overrides,
  };
}

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
