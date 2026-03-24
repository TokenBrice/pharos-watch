// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StablecoinTable } from "@/components/stablecoin-table";
import type { StablecoinData } from "@shared/types";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [{ index: 0, start: 0, end: 40 }],
    getTotalSize: () => 40,
  }),
}));

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

const coin = {
  id: "usdt-tether",
  name: "Tether",
  symbol: "USDT",
  pegType: "peggedUSD",
  price: 1,
  circulating: { peggedUSD: 100_000_000 },
  circulatingPrevDay: { peggedUSD: 99_000_000 },
  circulatingPrevWeek: { peggedUSD: 98_000_000 },
  circulatingPrevMonth: { peggedUSD: 97_000_000 },
  chainCirculating: {},
  chains: ["Ethereum"],
} as unknown as StablecoinData;

describe("StablecoinTable", () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockReset();
  });

  it("normalizes persisted column visibility from localStorage", () => {
    localStorage.setItem("pharos-table-columns", JSON.stringify(["mcap", "bogus"]));

    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
      />,
    );

    expect(screen.getByText("Market Cap")).toBeTruthy();
    expect(screen.queryByText("Price")).toBeNull();
  });

  it("keeps horizontal scrolling enabled on the table viewport", () => {
    render(
      <StablecoinTable
        data={[coin]}
        isLoading={false}
        activeFilters={[]}
        pegRates={{}}
      />,
    );

    const table = screen.getAllByRole("table")[0];
    const scrollContainer = table?.parentElement;

    expect(scrollContainer?.className).toContain("overflow-x-auto");
    expect(scrollContainer?.className).not.toContain("overflow-x-hidden");
    expect(scrollContainer?.className).not.toContain("xl:overflow-x-hidden");
  });
});
