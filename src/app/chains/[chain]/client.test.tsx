// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImgHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainProfileClient } from "./client";
import type { ChainSummary } from "@shared/types/chains";
import type { ChainStablecoin } from "@/hooks/use-chains";

const push = vi.fn();
const refetch = vi.fn();
const { useChainStablecoinsMock } = vi.hoisted(() => ({
  useChainStablecoinsMock: vi.fn(),
}));

let mockChainsState: {
  data: { chains: ChainSummary[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
};

let mockStablecoinsState: {
  coins: ChainStablecoin[];
  totalUsd: number;
  isLoading: boolean;
  isError: boolean;
} = {
  coins: [],
  totalUsd: 0,
  isLoading: false,
  isError: false,
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => <img {...props} alt={props.alt ?? ""} />,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
  MethodologyHint: () => null,
  MethodologyCardActions: () => null,
}));

vi.mock("@/hooks/use-chains", () => ({
  useChains: () => ({
    ...mockChainsState,
    refetch,
  }),
  useChainStablecoins: useChainStablecoinsMock,
}));

function makeChain(overrides: Partial<ChainSummary> = {}): ChainSummary {
  return {
    id: "ethereum",
    name: "Ethereum",
    type: "L1",
    totalUsd: 1_500_000_000,
    dominanceShare: 0.32,
    stablecoinCount: 2,
    change24hPct: 0.01,
    change7dPct: 0.02,
    change30dPct: 0.03,
    healthScore: 84,
    healthBand: "healthy",
    healthFactors: {
      quality: 82,
      environment: 80,
      concentration: 78,
      pegStability: 88,
      backingDiversity: 76,
    },
    backingDistribution: {
      "rwa-backed": 900_000_000,
      "crypto-backed": 600_000_000,
      other: 0,
    },
    composition: [],
    ...overrides,
  } as unknown as ChainSummary;
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

describe("ChainProfileClient", () => {
  beforeEach(() => {
    push.mockReset();
    refetch.mockReset();
    mockChainsState = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    mockStablecoinsState = {
      coins: [],
      totalUsd: 0,
      isLoading: false,
      isError: false,
    };
    useChainStablecoinsMock.mockReset();
    useChainStablecoinsMock.mockImplementation(() => mockStablecoinsState);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the missing-chain fallback when the requested chain is absent", () => {
    mockChainsState = {
      data: { chains: [] },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getByText("No data available for this chain")).toBeTruthy();
    expect(screen.getByText("View all chains")).toBeTruthy();
  });

  it("shows a stale-data notice while still rendering the chain when query data exists", () => {
    mockChainsState = {
      data: { chains: [makeChain()] },
      isLoading: false,
      isError: true,
      error: new Error("cached response"),
    };

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Ethereum")).toBeTruthy();
  });

  it("filters stablecoins by backing and navigates on row click", () => {
    mockChainsState = {
      data: { chains: [makeChain()] },
      isLoading: false,
      isError: false,
      error: null,
    };
    mockStablecoinsState = {
      coins: [
        makeCoin(),
        makeCoin({
          id: "dai-maker",
          name: "DAI",
          symbol: "DAI",
          supplyOnChain: 400_000_000,
          chainShare: 0.4,
          backing: "crypto-backed",
        }),
      ],
      totalUsd: 900_000_000,
      isLoading: false,
      isError: false,
    };

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getAllByRole("link", { name: /USD Coin/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /DAI/ }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Crypto/i }));

    expect(screen.getByText(/Showing only/i)).toBeTruthy();
    expect(screen.getAllByText("DAI").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("link", { name: /DAI/ }).at(-1)!);
    expect(push).toHaveBeenCalledWith("/stablecoin/dai-maker/");
  });

  it("derives the per-chain stablecoin model once per render", () => {
    mockChainsState = {
      data: { chains: [makeChain()] },
      isLoading: false,
      isError: false,
      error: null,
    };
    mockStablecoinsState = {
      coins: [makeCoin()],
      totalUsd: 500_000_000,
      isLoading: false,
      isError: false,
    };

    render(<ChainProfileClient chainId="ethereum" />);

    expect(useChainStablecoinsMock).toHaveBeenCalledTimes(1);
    expect(useChainStablecoinsMock).toHaveBeenCalledWith("ethereum");
  });
});
