// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DistributionSection } from "@/components/stablecoin-detail/distribution-section";

const { useDexLiquidityMock, useStablecoinsMock } = vi.hoisted(() => ({
  useDexLiquidityMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ useDexLiquidity: useDexLiquidityMock }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: useStablecoinsMock }));

afterEach(() => {
  vi.clearAllMocks();
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
    expect(figure.getAttribute("aria-label")).toContain("2 chains");
    expect(screen.getByText("Unattributed")).toBeTruthy();
    expect(screen.getAllByText("50%")).toHaveLength(2);
    expect(screen.queryByText("100%")).toBeNull();
  },
);

it("states a single-category distribution as a figure rather than a one-color ring", () => {
  useStablecoinsMock.mockReturnValue({
    data: {
      peggedAssets: [{ id: "usdc-circle", chainCirculating: { Ethereum: { current: 4_000_000_000 } } }],
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

  const figure = screen.getByRole("figure", { name: "Circulating supply distribution across 1 chain" });
  expect(figure.textContent).toContain("Ethereum");
  expect(figure.textContent).toContain("100%");
  expect(figure.querySelector("svg")).toBeNull();
});

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

  expect(screen.getByRole("figure", { name: "Circulating supply distribution across 4 chains" })).toBeTruthy();
  expect(screen.getByText("90%")).toBeTruthy();
  expect(screen.getByText("6%")).toBeTruthy();
  expect(screen.getByText("Other")).toBeTruthy();
  // Arbitrum at the threshold and the merged 2% remainder.
  expect(screen.getAllByText("2%")).toHaveLength(2);
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

it("keeps cached distribution visible behind a stale notice and drops it once the refresh lands", () => {
  const refetch = vi.fn();
  const cached = {
    data: {
      peggedAssets: [
        { id: "usdc-circle", chainCirculating: { Ethereum: { current: 60_000 }, Base: { current: 40_000 } } },
      ],
    },
    isLoading: false,
    dataUpdatedAt: Date.now(),
    refetch,
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

  // Error must not win over data that is still worth showing.
  // The stale notice shares the status role with the freshness chip, so
  // match it by its message instead of by role alone.
  const staleNotice = () =>
    screen
      .getAllByRole("status")
      .find((node) => node.textContent?.includes("Chain distribution data refresh failed"));
  expect(staleNotice()).toBeDefined();
  expect(screen.getByText("60%")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Retry chain distribution data" }));
  expect(refetch).toHaveBeenCalledTimes(1);

  useStablecoinsMock.mockReturnValue({ ...cached, error: null });
  rerender(<DistributionSection stablecoinId="usdc-circle" />);

  expect(staleNotice()).toBeUndefined();
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
  expect(screen.queryByText("Liquidity by Protocol")).toBeNull();
});
