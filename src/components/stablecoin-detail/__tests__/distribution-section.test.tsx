// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DistributionSection } from "@/components/stablecoin-detail/distribution-section";

import type { ApiMeta } from "@/lib/api";
const { useDexLiquidityMock, useStablecoinsMock } = vi.hoisted(() => ({
  useDexLiquidityMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ useDexLiquidityCoin: useDexLiquidityMock }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: useStablecoinsMock }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("keeps both distribution modules visible as unavailable when their sources fail", () => {
  useStablecoinsMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: new Error("list failed"),
    dataUpdatedAt: 0,
    refetch: vi.fn(),
  });
  useDexLiquidityMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: new Error("liquidity failed"),
    dataUpdatedAt: 0,
    refetch: vi.fn(),
  });

  render(<DistributionSection stablecoinId="usdc-circle" />);

  expect(screen.getAllByRole("alert")).toHaveLength(2);
  expect(screen.getByText(/Chain distribution data is temporarily unavailable/)).toBeTruthy();
  expect(screen.getByText(/DEX distribution data is temporarily unavailable/)).toBeTruthy();
});

it("keeps a frozen archive's chain context but never mounts the current DEX child", () => {
  useStablecoinsMock.mockReturnValue({
    data: undefined, isLoading: false, error: new Error("list failed"), dataUpdatedAt: 0, refetch: vi.fn(),
  });
  render(<DistributionSection stablecoinId="buck-buck-assets" frozen />);
  expect(useDexLiquidityMock).not.toHaveBeenCalled();
  expect(screen.getByText(/Chain distribution data is temporarily unavailable/)).toBeTruthy();
  expect(screen.queryByText(/DEX distribution data/)).toBeNull();
});

it.each([
  { label: "all missing", chainCirculating: { Ethereum: { current: null }, Base: { current: null } } },
  { label: "registered partial", chainCirculating: { Ethereum: { current: null }, Base: { current: 100 } } },
  { label: "unregistered partial", chainCirculating: { Ethereum: { current: 100 }, "not-yet-registered-chain": { current: null } } },
])("renders unavailable rather than a distribution with an unknown chain balance ($label)", ({ chainCirculating }) => {
  useStablecoinsMock.mockReturnValue({
    data: { peggedAssets: [{
      id: "usdc-circle",
      chainCirculating,
    }] },
    isLoading: false, error: null, dataUpdatedAt: Date.now(), refetch: vi.fn(),
  });
  useDexLiquidityMock.mockReturnValue({
    data: {}, isLoading: false, error: null, dataUpdatedAt: Date.now(), refetch: vi.fn(),
  });

  render(<DistributionSection stablecoinId="usdc-circle" />);

  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("figure")).toBeNull();
});

it.each(["not-yet-registered-chain", "sUSDe unattributed OFT escrow", "savUSD unattributed CCIP escrow"])(
  "includes positive unattributed supply in the whole distribution denominator (%s)",
  (label) => {
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [{ id: "usdc-circle", chainCirculating: {
        Ethereum: { current: 100_000 }, [label]: { current: 100_000 },
      } }] },
      isLoading: false, error: null, dataUpdatedAt: Date.now(), refetch: vi.fn(),
    });
    useDexLiquidityMock.mockReturnValue({
      data: {}, isLoading: false, error: null, dataUpdatedAt: Date.now(), refetch: vi.fn(),
    });
    render(<DistributionSection stablecoinId="usdc-circle" />);
    const figure = screen.getByRole("figure");
    expect(figure.getAttribute("aria-label")).toBe("Circulating supply distribution across 1 chain, plus $100.00K Unattributed supply");
    expect(screen.getByText("Unattributed")).toBeTruthy();
    expect(screen.getAllByText("50%")).toHaveLength(2);
    expect(screen.queryByText("100%")).toBeNull();
  },
);



it("keeps a chain at exactly the Other threshold as its own slice", () => {
  // 2% is the fold threshold: Arbitrum sits exactly on it and stays named,
  // while the two 1% chains merge into Other.
  useStablecoinsMock.mockReturnValue({
    data: {
      peggedAssets: [
        {
          id: "usdc-circle",
          chainCirculating: {
            Ethereum: { current: 90_000 },
            Base: { current: 6_000 },
            Arbitrum: { current: 2_000 },
            Solana: { current: 1_000 },
            Tron: { current: 1_000 },
          },
        },
      ],
    },
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
  });
  useDexLiquidityMock.mockReturnValue({
    data: {},
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
  });

  render(<DistributionSection stablecoinId="usdc-circle" />);

  expect(screen.getByRole("figure", { name: "Circulating supply distribution across 5 chains" })).toBeTruthy();
  expect(screen.getByText("90%")).toBeTruthy();
  expect(screen.getByText("6%")).toBeTruthy();
  expect(screen.getByText("Other")).toBeTruthy();
  // Arbitrum at the threshold and the merged 2% remainder.
  expect(screen.getAllByText("2%")).toHaveLength(2);
});

it.each([
  { name: "three members folded into Other", protocolTvl: { curve: 97_000, aave: 1_000, uniswap: 1_000, balancer: 1_000, zero: 0, invalid: -1 }, count: 4, other: true, shares: ["97%", "3%"] },
  { name: "all small members folded into Other", protocolTvl: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`protocol-${i}`, 1_000])), count: 51, other: true, shares: ["100%"] },
  { name: "one positive category", protocolTvl: { curve: 100_000, zero: 0 }, count: 1, other: false, shares: ["100%"] },
])("announces underlying categories, not display groups ($name)", ({ protocolTvl, count, other, shares }) => {
  useStablecoinsMock.mockReturnValue({
    data: { peggedAssets: [{ id: "usdc-circle", chainCirculating: { Ethereum: { current: 100_000 } } }] },
    isLoading: false, error: null, dataUpdatedAt: Date.now(), refetch: vi.fn(),
  });
  useDexLiquidityMock.mockReturnValue({
    data: { "usdc-circle": { totalTvlUsd: 100_000, poolCount: count, protocolTvl } },
    isLoading: false, error: null, dataUpdatedAt: Date.now(), refetch: vi.fn(),
  });
  render(<DistributionSection stablecoinId="usdc-circle" />);
  expect(screen.getByRole("figure", { name: "Circulating supply distribution across 1 chain" })).toBeTruthy();
  const figure = screen.getByRole("figure", { name: `DEX liquidity TVL distribution across ${count} ${count === 1 ? "protocol" : "protocols"}` });
  const contents = within(figure.parentElement!);
  expect(contents.queryByText("Other") != null).toBe(other);
  for (const share of shares) expect(contents.getByText(share)).toBeTruthy();
});

it("names an entirely unattributed residual separately from known chains", () => {
  useStablecoinsMock.mockReturnValue({
    data: { peggedAssets: [{ id: "usdc-circle", chainCirculating: { "unknown-chain": { current: 100_000 } } }] },
    isLoading: false, error: null, dataUpdatedAt: Date.now(), refetch: vi.fn(),
  });
  useDexLiquidityMock.mockReturnValue({ data: {}, isLoading: false, error: null, dataUpdatedAt: Date.now(), refetch: vi.fn() });
  render(<DistributionSection stablecoinId="usdc-circle" />);
  expect(screen.getByRole("figure", { name: "Circulating supply distribution across 0 chains, plus $100.00K Unattributed supply" })).toBeTruthy();
  expect(screen.getByText("100%")).toBeTruthy();
});

it("preserves observed positive shares alongside an explicit zero chain balance", () => {
  useStablecoinsMock.mockReturnValue({
    data: {
      peggedAssets: [
        {
          id: "usdc-circle",
          chainCirculating: {
            Ethereum: { current: 60_000 },
            Base: { current: 40_000 },
            Solana: { current: 0 },
          },
        },
      ],
    },
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
  });
  useDexLiquidityMock.mockReturnValue({
    data: {},
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
  });

  render(<DistributionSection stablecoinId="usdc-circle" />);

  expect(screen.getByRole("figure", { name: "Circulating supply distribution across 2 chains" })).toBeTruthy();
  expect(screen.getByText("60%")).toBeTruthy();
  expect(screen.getByText("40%")).toBeTruthy();
  expect(screen.queryByText("Solana")).toBeNull();
  expect(screen.queryByText("Other")).toBeNull();
});

it("keeps cached distribution visible without a notice through a failed refresh and its recovery", () => {
  const cached = {
    data: {
      peggedAssets: [
        { id: "usdc-circle", chainCirculating: { Ethereum: { current: 60_000 }, Base: { current: 40_000 } } },
      ],
    },
    isLoading: false,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
  };
  useStablecoinsMock.mockReturnValue({ ...cached, error: new Error("list refresh failed") });
  useDexLiquidityMock.mockReturnValue({
    data: {},
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
  });

  const { rerender } = render(<DistributionSection stablecoinId="usdc-circle" />);

  // Error must not win over data that is still worth showing, and a failed
  // refresh over that data is operator signal, not a reader notice.
  expect(screen.queryByText(/Chain distribution data refresh failed/)).toBeNull();
  expect(screen.getByText("60%")).toBeTruthy();

  useStablecoinsMock.mockReturnValue({ ...cached, error: null });
  rerender(<DistributionSection stablecoinId="usdc-circle" />);

  expect(screen.queryByText(/refresh failed/i)).toBeNull();
  expect(screen.getByText("60%")).toBeTruthy();
});

it.each([
  { poolCount: 2, totalTvlUsd: 0 },
  { poolCount: 0, totalTvlUsd: 100_000 },
])("keeps missing protocol attribution unavailable despite observed DEX activity (%j)", (aggregates) => {
  useStablecoinsMock.mockReturnValue({
    data: { peggedAssets: [] }, isLoading: false, error: null, dataUpdatedAt: 0, refetch: vi.fn(),
  });
  const refetch = vi.fn();
  useDexLiquidityMock.mockReturnValue({
    data: { "usdc-circle": { ...aggregates, protocolTvl: {} } },
    isLoading: false, error: null, dataUpdatedAt: 0, refetch,
  });
  render(<DistributionSection stablecoinId="usdc-circle" />);
  expect(screen.getByRole("alert").textContent).toContain("DEX protocol breakdown is temporarily unavailable");
  expect(screen.queryByText(/No observed DEX liquidity pools/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry dex protocol breakdown" }));
  expect(refetch).toHaveBeenCalledTimes(1);
});

it("omits the protocol distribution for genuinely empty observed DEX aggregates", () => {
  useStablecoinsMock.mockReturnValue({
    data: { peggedAssets: [] }, isLoading: false, error: null, dataUpdatedAt: 0, refetch: vi.fn(),
  });
  useDexLiquidityMock.mockReturnValue({
    data: { "usdc-circle": { poolCount: 0, totalTvlUsd: 0, protocolTvl: {} } },
    isLoading: false, error: null, dataUpdatedAt: 0, refetch: vi.fn(),
  });
  const { container } = render(<DistributionSection stablecoinId="usdc-circle" />);
  expect(container.querySelector("[role=alert]")).toBeNull();
  expect(screen.queryByText("Liquidity by protocol")).toBeNull();
});

function mockDistributions(meta: ApiMeta | null, receipt = Date.now(), error: Error | null = null) {
  const query = { meta, dataUpdatedAt: receipt, error, isLoading: false, refetch: vi.fn() };
  useStablecoinsMock.mockReturnValue({
    ...query,
    data: { peggedAssets: [{ id: "usdc-circle", chainCirculating: { Ethereum: { current: 100_000 } } }] },
  });
  useDexLiquidityMock.mockReturnValue({
    ...query,
    data: { "usdc-circle": { totalTvlUsd: 100_000, poolCount: 1, protocolTvl: { curve: 100_000 } } },
  });
}

it("keeps both old producer generations through a successful refetch and failed refresh", () => {
  const receipt = Date.now();
  const updatedAt = Math.floor(receipt / 1000) - 30 * 86_400;
  const meta: ApiMeta = { updatedAt, status: "stale", ageSeconds: 30 * 86_400 };
  mockDistributions(meta, receipt);
  const { container, rerender } = render(<DistributionSection stablecoinId="usdc-circle" />);
  const assertProducer = () => {
    expect(container.querySelectorAll('time[datetime]')).toHaveLength(2);
    for (const chip of container.querySelectorAll("time")) {
      expect(chip.getAttribute("datetime")).toBe(new Date(updatedAt * 1000).toISOString());
      expect(chip.getAttribute("data-state")).toBe("stale");
    }
  };
  assertProducer();
  expect(container.querySelectorAll('[data-health-state="stale"]')).toHaveLength(2);
  mockDistributions(meta, receipt + 30_000);
  rerender(<DistributionSection stablecoinId="usdc-circle" />);
  assertProducer();
  mockDistributions(meta, receipt + 30_000, new Error("refresh failed"));
  rerender(<DistributionSection stablecoinId="usdc-circle" />);
  assertProducer();
  expect(screen.queryByText(/refresh failed/i)).toBeNull();
});

it.each([
  { meta: { updatedAt: null, status: "unknown", ageSeconds: null }, state: "unavailable" },
  { meta: { status: "stale" }, state: "stale" },
  { meta: { status: "fresh", warning: "Source coverage incomplete" }, state: null },
  { meta: { status: "fresh", dependencies: { source: { status: "stale", reason: "source-old" } } }, state: null },
] as { meta: ApiMeta; state: string | null }[])("qualifies distribution metadata independently of a fresh receipt ($state)", ({ meta, state }) => {
  const receipt = Date.now();
  mockDistributions({ updatedAt: Math.floor(receipt / 1000), ...meta } as ApiMeta, receipt);
  const { container } = render(<DistributionSection stablecoinId="usdc-circle" />);
  // Source advisories over a current generation are operator signal; only stale or missing data is public.
  expect(container.querySelectorAll(state ? `[data-health-state="${state}"]` : "[data-health-state]"))
    .toHaveLength(state ? 2 : 0);
  if (state === "unavailable") {
    for (const chip of container.querySelectorAll("time")) {
      expect(chip.hasAttribute("datetime")).toBe(false);
      expect(chip.getAttribute("data-state")).toBe("unavailable");
      expect(chip.textContent).not.toContain("just now");
    }
  }
});

it("retains the receipt fallback only when legacy distribution metadata is absent", () => {
  const receipt = Date.now();
  mockDistributions(null, receipt);
  const { container } = render(<DistributionSection stablecoinId="usdc-circle" />);
  for (const chip of container.querySelectorAll("time")) {
    expect(chip.getAttribute("datetime")).toBe(new Date(receipt).toISOString());
  }
});

it("ages both distribution notices in place under their served budgets", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const receipt = Date.now();
  mockDistributions({ updatedAt: receipt / 1000, ageSeconds: 0, status: "fresh", freshBudgetSec: 60, degradedBudgetSec: 120 }, receipt);
  const { container } = render(<DistributionSection stablecoinId="usdc-circle" />);
  expect(container.querySelector("[data-health-state]")).toBeNull();
  act(() => vi.advanceTimersByTime(50));
  act(() => vi.advanceTimersByTime(60_001));
  expect(container.querySelectorAll("[data-health-state]")).toHaveLength(0);
  act(() => vi.advanceTimersByTime(60_000));
  expect(container.querySelectorAll('[data-health-state="stale"]')).toHaveLength(2);
  for (const chip of container.querySelectorAll("time")) {
    expect(chip.getAttribute("datetime")).toBe(new Date(receipt).toISOString());
  }
});

it("binds Supply by Chain to the one-coin distribution definition, not chain HHI", () => {
  useStablecoinsMock.mockReturnValue({
    data: undefined, isLoading: false, error: new Error("list failed"), dataUpdatedAt: 0, refetch: vi.fn(),
  });
  useDexLiquidityMock.mockReturnValue({
    data: undefined, isLoading: false, error: new Error("liquidity failed"), dataUpdatedAt: 0, refetch: vi.fn(),
  });
  render(<DistributionSection stablecoinId="usdc-circle" />);
  const triggers = screen.getAllByRole("button", { name: "Explain Supply by Chain" });
  expect(triggers.length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Explain Concentration" })).toBeNull();
  fireEvent.click(triggers[triggers.length - 1]);
  expect(screen.getByText("Current circulating supply of this stablecoin on each chain, in USD.")).toBeTruthy();
  expect(screen.queryByText(/HHI/)).toBeNull();
  expect(screen.getByRole("link", { name: "View methodology" }).getAttribute("href")).toMatch(/^\/methodology\/?#pricing-pipeline-methodology$/);
});
