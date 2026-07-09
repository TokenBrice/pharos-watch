// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DistributionSection } from "@/components/stablecoin-detail/distribution-section";

const { useDexLiquidityMock, useStablecoinsMock } = vi.hoisted(() => ({
  useDexLiquidityMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ useDexLiquidity: useDexLiquidityMock }));
vi.mock("@/hooks/use-stablecoins", () => ({ useStablecoins: useStablecoinsMock }));

afterEach(() => {
  cleanup();
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
