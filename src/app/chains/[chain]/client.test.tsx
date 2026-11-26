// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ImgHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RatioSchema } from "@shared/types/ratio";
import { ChainProfileClient } from "./client";
import { makeChain, makeCoin } from "@/hooks/__tests__/chain-profile-fixtures";

const push = vi.fn();
const refetchAll = vi.fn();
const { useChainProfileDataMock, useCoinStatesMock, clock } = vi.hoisted(() => ({
  useChainProfileDataMock: vi.fn(),
  useCoinStatesMock: vi.fn(),
  clock: { nowMs: null as number | null },
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

vi.mock("@/hooks/use-coin-states", () => ({ useCoinStates: useCoinStatesMock }));
vi.mock("@/hooks/use-utc-day-clock", () => ({ useUtcDayNowMs: () => clock.nowMs }));

// Two fixture coins carrying Noble-scoped alerts (one event shared) beside the real active registry,
// whose live alerts are stripped so catalog notices cannot perturb the fixture.
vi.mock("@shared/lib/stablecoins/client-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/stablecoins/client-registry")>();
  const closes = { type: "warning", title: "Noble route closes", kind: "deadline", deadline: "2027-01-12", chains: ["noble"] };
  const scoped = {
    ...actual.CLIENT_ACTIVE_STABLECOINS[0]!, id: "scoped-usd", symbol: "SUSD", name: "Scoped USD", chainIds: ["noble"],
    alerts: [
      { type: "warning", title: "Noble bridge caveat", chains: ["noble"] },
      closes,
      { type: "info", title: "Old Noble migration", kind: "deadline", deadline: "2026-09-01", chains: ["noble"] },
      { type: "warning", title: "Asset-wide cutoff", kind: "deadline", deadline: "2026-12-01" },
    ],
  };
  const second = { ...scoped, id: "scoped-two", symbol: "XUSD", name: "Second Scoped USD", alerts: [{ ...closes }] };
  const real = actual.CLIENT_ACTIVE_STABLECOINS.map(({ alerts: _alerts, ...coin }) => coin);
  return { ...actual, CLIENT_ACTIVE_STABLECOINS: [...real, scoped, second] };
});

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
    useCoinStatesMock.mockReturnValue({ byId: new Map(), liveReady: true });
    clock.nowMs = null;
  });

  it("shows an unavailable share and suppresses composition without an admitted detail total", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: makeChain({ dominanceShare: null }), totalUsd: null,
    }));
    render(<ChainProfileClient chainId="ethereum" />);
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByText("Stablecoin composition")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });


  const absent = {
    chain: null, canConfirmMissingChain: true,
    chainsQuery: { data: { chains: [] }, error: null, dataUpdatedAt: 1_710_500_000_000, meta: { updatedAt: 1_710_500_000, ageSeconds: 60, status: "fresh" } },
  };

  it("keeps the untracked fallback for an absent chain only when no tracked coin lives there", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState(absent));

    render(<ChainProfileClient chainId="unregistered-chain" />);

    expect(screen.getByText("Pharos doesn't have a chain read for this one yet.")).toBeTruthy();
    expect(screen.getByText("View all chains")).toBeTruthy();
  });

  it("names a tracked coin's critical state on a chain with no read", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({ ...absent, coins: [], totalUsd: null }));
    useCoinStatesMock.mockReturnValue({
      byId: new Map([["iusd-initia", [{ kind: "critical", notice: { type: "danger", title: "Initia L1 halted", kind: "paused", asOf: "2026-10-30" } }]]]), liveReady: true,
    });
    const { container } = render(<ChainProfileClient chainId="initia" />);
    expect(screen.getByRole("status").textContent)
      .toContain("1 tracked coin reports a critical, paused or deadline state: iUSD: Initia L1 halted (updated 2026-10-30).");
    expect(container.querySelector("[data-coin-state=critical]")?.textContent).toContain("Critical notice · Initia L1 halted");
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    expect(screen.queryByText(/may have been removed/)).toBeNull();
  });

  // Chain-scoped alerts show under the hero whatever the chain read says, outside the 30-day chip horizon:
  // one row per shared event, earliest date first and dateless last, each coin its own link.
  const clocked = Date.parse("2026-11-26T12:00:00Z");
  const both = ["scoped-usd", "scoped-two"];
  it.each([
    ["a live Noble read, clock known", "noble", {}, clocked, "Holder notices for Noble", [
      ["SUSD, XUSD: Noble route closes Jan 12, 2027 · in 47 days", both],
      ["SUSD: Noble bridge caveat", ["scoped-usd"]],
    ]],
    ["no Noble read, before hydration", "noble", { ...absent, coins: [], totalUsd: null }, null, "Holder notices for Noble", [
      ["SUSD: Old Noble migration Sep 1, 2026", ["scoped-usd"]],
      ["SUSD, XUSD: Noble route closes Jan 12, 2027", both],
      ["SUSD: Noble bridge caveat", ["scoped-usd"]],
    ]],
    ["another chain", "ethereum", {}, clocked, null, []],
  ] as const)("lists chain-scoped holder notices on %s", (_label, chainId, hookState, nowMs, heading, items) => {
    useChainProfileDataMock.mockReturnValue(makeHookState(hookState));
    clock.nowMs = nowMs;
    render(<ChainProfileClient chainId={chainId} />);
    expect(useCoinStatesMock).toHaveBeenCalledWith({ chainId });
    const banner = screen.queryByRole("region", { name: /Holder notices? for/ });
    expect(banner ? within(banner).getByRole("heading").textContent : null).toBe(heading);
    const rows = banner ? within(banner).getAllByRole("listitem") : [];
    expect(rows.map((row) => [
      row.textContent?.replace(/\s+/g, " ").trim(),
      within(row).getAllByRole("link").map((link) => link.getAttribute("href")?.match(/^\/stablecoin\/([^/]+)\/?$/)?.[1]),
    ])).toEqual(items);
  });

  it("leaves a chain-scoped deadline to the holder notices and names an asset-wide one on a chain with no read", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({ ...absent, coins: [], totalUsd: null }));
    const deadline = (title: string, date: string, daysToDeadline: number, chains?: string[]) =>
      ({ kind: "deadline", notice: { type: "warning", title, kind: "deadline", deadline: date, ...(chains ? { chains } : {}) }, daysToDeadline });
    useCoinStatesMock.mockReturnValue({
      byId: new Map([
        ["scoped-usd", [deadline("Noble route closes", "2026-12-15", 19, ["noble"])]],
        ["scoped-two", [deadline("Asset-wide cutoff", "2026-12-01", 5)]],
      ]),
      liveReady: true,
    });
    const { container } = render(<ChainProfileClient chainId="noble" />);
    expect(screen.getByText(/tracked coins? reports?/).textContent)
      .toBe("1 tracked coin reports a critical, paused or deadline state: XUSD: Asset-wide cutoff (Dec 1, 2026 · in 5 days).");
    // Both coins keep their state chips in the tracked list.
    expect(container.querySelectorAll("[data-coin-state=deadline]")).toHaveLength(2);
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
    expect(screen.getByText("Partial supply")).toBeTruthy();
    expect(screen.getByText(/2 unavailable supply observations excluded/)).toBeTruthy();
    expect(screen.getByText("Partial global share")).toBeTruthy();
    expect(screen.getByText(/3 assets excluded from global supply/)).toBeTruthy();
  });

  it("shows a query error instead of the missing-chain fallback when chain summaries are unavailable", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chain: null,
      canConfirmMissingChain: false,
      routeError: new Error("chains unavailable"),
    }));

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.getByText("Failed to load this dataset")).toBeTruthy();
    expect(screen.queryByText("Pharos doesn't have a chain read for this one yet.")).toBeNull();
  });

  it("keeps a held report-card input over fresh supply off the hero and out of the body (ADR-42)", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      chainsQuery: {
        data: { chains: [makeChain()] },
        error: null,
        dataUpdatedAt: 1_710_500_000_000,
        meta: {
          updatedAt: 1_710_500_000, ageSeconds: 600, status: "degraded",
          dependencies: { reportCards: { status: "stale", reason: "stale-cache", ageSeconds: 7_200 } },
        },
      },
    }));
    render(<ChainProfileClient chainId="ethereum" />);
    expect(screen.queryByRole("button", { name: /Chain Health inputs/ })).toBeNull();
    expect(screen.queryByText(/Data quality warning/)).toBeNull();
  });

  it("keeps rendering the cached chain without a reader notice after a failed refresh (ADR-42)", () => {
    useChainProfileDataMock.mockReturnValue(makeHookState({
      routeError: new Error("cached response"),
    }));

    render(<ChainProfileClient chainId="ethereum" />);

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // the chain name is the page H1; the hero renders the chain's figures, never a duplicate name card or chain ID
    expect(screen.getByText("Total supply")).toBeTruthy();
    expect(screen.queryByText(/Chain ID/)).toBeNull();
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
      .toContain("observed for 0% of peg-eligible chain supply");
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
      "Peg observed on 60% of peg-eligible chain supply; 30% without a usable price is scored neutral 50; 10% has no peg reference.",
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
    expect(health.getByText("Peg observed on 99% of peg-eligible chain supply.")).toBeTruthy();
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

});
