// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ImgHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RatioSchema } from "@shared/types/ratio";
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
    canConfirmMissingChain: true,
    hasAnyData: true,
    isInitialLoading: false,
    routeError: null,
    chainsQuery: {
      data: { chains: [makeChain()] },
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

  it("shows unavailable supply rather than untracked copy for a coverage-listed chain", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: null,
      supplyUnavailable: true,
      canConfirmMissingChain: false,
    }));
    render(<ChainProfileClient chainId="ethereum" />);
    expect(screen.getByText(/all current observations were excluded/i)).toBeTruthy();
    expect(screen.queryByText(/may not be tracked/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry chain data" }));
    expect(refetchAll).toHaveBeenCalledTimes(1);
  });

  it("discloses partial chain supply and the incomplete global-share denominator", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: makeChain({ unavailableSupplyObservationCount: 2 }),
      supplyCoverage: {
        aggregateUnavailableAssetCount: 3,
        chainUnavailableObservationCount: 2,
        chainIdsWithUnavailableObservations: ["ethereum"],
      },
    }));
    render(<ChainProfileClient chainId="ethereum" />);
    expect(screen.getByText("Partial Supply")).toBeTruthy();
    expect(screen.getByText(/2 unavailable supply observations excluded/)).toBeTruthy();
    expect(screen.getByText("Partial Global Share")).toBeTruthy();
    expect(screen.getByText(/3 assets excluded from global supply/)).toBeTruthy();
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

  it("renders an NR peg factor and an NR composite withheld for peg coverage", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: makeChain({
        healthScore: null,
        healthBand: null,
        healthFactors: { quality: 82, chainEnvironment: 80, concentration: 78, pegStability: null, backingDiversity: 76 },
        pegStabilityCoverage: {
          status: "unavailable",
          observedSupplyUsd: 0,
          eligibleSupplyUsd: 1_500_000_000,
          coverage: RatioSchema.parse(0),
          noUsablePriceSupplyUsd: 1_500_000_000,
          noPegReferenceSupplyUsd: 0,
          neutralImputedSupplyUsd: 0,
          observedScore: null,
        },
      }),
    }));

    render(<ChainProfileClient chainId="ethereum" />);
    const health = within(screen.getByRole("region", { name: "Chain Health" }));

    expect(health.getByText(/not rated because peg-stability coverage is below the 95% minimum/i).textContent)
      .toContain("observed for 0% of chain supply");
    expect(health.queryByText(/Insufficient safety score coverage/i)).toBeNull();
    expect(health.getByText("Not rated: no usable peg price was observed for this chain's supply.")).toBeTruthy();
    // Only the peg factor is null here; quality cleared its gate and keeps its number.
    expect(health.getByText("NR")).toBeTruthy();
    expect(health.getByText("82")).toBeTruthy();
  });

  it("discloses partial peg coverage and neutral placeholder supply beside a published peg factor", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: makeChain({
        healthFactors: { quality: 82, chainEnvironment: 80, concentration: 78, pegStability: 70, backingDiversity: 76 },
        pegStabilityCoverage: {
          status: "partial",
          observedSupplyUsd: 600,
          eligibleSupplyUsd: 1_000,
          coverage: RatioSchema.parse(0.6),
          noUsablePriceSupplyUsd: 300,
          noPegReferenceSupplyUsd: 100,
          neutralImputedSupplyUsd: 300,
          observedScore: 83,
        },
      }),
    }));

    render(<ChainProfileClient chainId="ethereum" />);
    const health = within(screen.getByRole("region", { name: "Chain Health" }));

    expect(health.getByText(
      "Peg observed on 60% of chain supply; 30% without a usable price is scored neutral 50; 10% has no peg reference.",
    )).toBeTruthy();
    expect(health.getByText("70")).toBeTruthy();
    expect(health.queryByText("NR")).toBeNull();
  });

  it("keeps the partial-coverage disclosure beside a published composite without rounding coverage up to 100%", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: makeChain({
        healthScore: 84,
        healthBand: "robust",
        healthFactors: { quality: 82, chainEnvironment: 80, concentration: 78, pegStability: 99, backingDiversity: 76 },
        pegStabilityCoverage: {
          status: "partial",
          observedSupplyUsd: 148_694_100_000,
          eligibleSupplyUsd: 148_700_000_000,
          coverage: RatioSchema.parse(148_694_100_000 / 148_700_000_000),
          noUsablePriceSupplyUsd: 5_900_000,
          noPegReferenceSupplyUsd: 0,
          neutralImputedSupplyUsd: 0,
          observedScore: 99,
        },
      }),
    }));

    render(<ChainProfileClient chainId="ethereum" />);
    const health = within(screen.getByRole("region", { name: "Chain Health" }));

    expect(health.getByText("robust")).toBeTruthy();
    expect(health.getByText("Peg observed on 99% of chain supply.")).toBeTruthy();
    expect(health.queryByText(/not rated because/i)).toBeNull();
  });

  it("filters the stablecoin table by backing and restores all rows when cleared", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      coins: [
        makeCoin(),
        makeCoin({
          id: "dai-maker",
          name: "DAI",
          symbol: "DAI",
          supplyUsd: 400_000_000,
          chainShare: RatioSchema.parse(0.4),
          backing: "crypto-backed",
        }),
      ],
      totalUsd: 900_000_000,
    }));

    render(<ChainProfileClient chainId="ethereum" />);

    const table = within(screen.getByTestId("chain-detail-stablecoins-table"));
    expect(table.getByRole("link", { name: /USD Coin/ })).toBeTruthy();
    expect(table.getByRole("link", { name: /DAI/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Crypto/i }));

    expect(screen.getByText(/Showing only/i)).toBeTruthy();
    expect(table.queryByRole("link", { name: /USD Coin/ })).toBeNull();
    expect(table.getByRole("link", { name: /DAI/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Clear filter/i }));
    expect(table.getByRole("link", { name: /USD Coin/ })).toBeTruthy();
    expect(table.getByRole("link", { name: /DAI/ })).toBeTruthy();
  });

  it("shows a route loading state before the chain response completes initial load", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: null,
      isInitialLoading: true,
      hasAnyData: false,
    }));

    const { container } = render(<ChainProfileClient chainId="ethereum" />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});
