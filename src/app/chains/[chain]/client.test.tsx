// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImgHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainProfileClient } from "./client";
import { makeChain, makeCoin } from "@/hooks/__tests__/chain-profile-fixtures";

const push = vi.fn();
const refetchAll = vi.fn();
const { useChainProfileDataMock } = vi.hoisted(() => ({
  useChainProfileDataMock: vi.fn(),
}));

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
  MethodologyTriggerButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-chain-profile-data", () => ({
  useChainProfileData: useChainProfileDataMock,
}));

function makeHookState(overrides: Record<string, unknown> = {}) {
  return {
    chain: makeChain(),
    coins: [makeCoin()],
    totalUsd: 500_000_000,
    canRenderDetailedSections: true,
    canConfirmMissingChain: true,
    detailedSectionNotice: null,
    hasAnyData: true,
    isInitialLoading: false,
    routeError: null,
    snapshotConsistency: "matched",
    chainsQuery: {
      data: { chains: [makeChain()] },
      error: null,
      dataUpdatedAt: 1_710_500_000_000,
      meta: { updatedAt: 1_710_500_000, ageSeconds: 60, status: "fresh" },
    },
    stablecoinsQuery: {
      error: null,
      dataUpdatedAt: 1_710_500_000_000,
      meta: { updatedAt: 1_710_500_000, ageSeconds: 60, status: "fresh" },
    },
    refetchAll,
    ...overrides,
  };
}

describe("ChainProfileClient", () => {
  beforeEach(() => {
    push.mockReset();
    refetchAll.mockReset();
    useChainProfileDataMock.mockReset();
    useChainProfileDataMock.mockReturnValue(makeHookState());
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the missing-chain fallback when the requested chain is absent", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: null,
      canConfirmMissingChain: true,
      chainsQuery: {
        data: { chains: [] },
        error: null,
        dataUpdatedAt: 1_710_500_000_000,
        meta: { updatedAt: 1_710_500_000, ageSeconds: 60, status: "fresh" },
      },
    }));

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getByText("Pharos doesn't have a chain read for this one yet.")).toBeTruthy();
    expect(screen.getByText("View all chains")).toBeTruthy();
  });

  it("shows a query error instead of the missing-chain fallback when chain summaries are unavailable", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: null,
      canConfirmMissingChain: false,
      routeError: new Error("chains unavailable"),
    }));

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getByText(/refresh delayed/i)).toBeTruthy();
    expect(screen.queryByText("Pharos doesn't have a chain read for this one yet.")).toBeNull();
  });

  it("shows a stale-data notice while still rendering the chain when cached data exists", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      routeError: new Error("cached response"),
    }));

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getByText(/refresh delayed/i)).toBeTruthy();
    expect(screen.getByText("Ethereum")).toBeTruthy();
  });

  it("hides detailed sections behind a sync notice when snapshots do not match", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      canRenderDetailedSections: false,
      detailedSectionNotice: "Detailed stablecoin composition is syncing to the latest chain snapshot. Breakdown sections are hidden until both sources match exactly.",
      snapshotConsistency: "mismatched",
      stablecoinsQuery: {
        error: null,
        dataUpdatedAt: 1_710_499_100_000,
        meta: { updatedAt: 1_710_499_100, ageSeconds: 960, status: "degraded" },
      },
    }));

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getByText(/Detailed stablecoin composition is syncing/i)).toBeTruthy();
    expect(screen.queryByText("Stablecoin Composition")).toBeNull();
    expect(screen.queryByText("All Stablecoins")).toBeNull();
  });

  it("explains when Chain Health is unavailable because report-card inputs are stale", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: makeChain({
        healthScore: null,
        healthBand: null,
        healthFactors: {
          quality: null,
          chainEnvironment: 80,
          concentration: 78,
          pegStability: 88,
          backingDiversity: 76,
        },
      }),
      chainsQuery: {
        data: { chains: [makeChain()] },
        error: null,
        dataUpdatedAt: 1_710_500_000_000,
        meta: {
          updatedAt: 1_710_500_000,
          ageSeconds: 60,
          status: "degraded",
          dependencies: {
            reportCards: {
              updatedAt: 1_710_489_200,
              ageSeconds: 10_800,
              status: "stale",
              reason: "stale cache",
            },
          },
        },
      },
    }));

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getByText(/report-card inputs are stale/i)).toBeTruthy();
  });

  it("filters stablecoins by backing and navigates on row click", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
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
    }));

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getAllByRole("link", { name: /USD Coin/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /DAI/ }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Crypto/i }));

    expect(screen.getByText(/Showing only/i)).toBeTruthy();
    expect(screen.getAllByText("DAI").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("link", { name: /DAI/ }).at(-1)!);
    expect(push).toHaveBeenCalledWith("/stablecoin/dai-maker/");
  });

  it("shows a route loading state before both data sources complete initial load", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: null,
      isInitialLoading: true,
      hasAnyData: false,
    }));

    const { container } = render(<ChainProfileClient chainId="ethereum" />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});
