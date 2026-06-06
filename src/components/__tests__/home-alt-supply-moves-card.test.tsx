// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupplyMovesCard } from "@/components/home-alt-mini-cards/supply-moves-card";
import type { StablecoinData } from "@shared/types";

const { useLogosMock, useStablecoinsMock } = vi.hoisted(() => ({
  useLogosMock: vi.fn(),
  useStablecoinsMock: vi.fn(),
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: useLogosMock,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/lib/stablecoin-static-data", () => ({
  ACTIVE_STABLECOIN_ID_SET: new Set(["usdr-real", "usdc-circle", "eur-stasis"]),
}));

vi.mock("next/image", () => ({
  default: ({ alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <img alt={alt} {...props} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SupplyMovesCard", () => {
  it("links the peak supply mover to its stablecoin page", () => {
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          makeStablecoin({
            id: "usdr-real",
            symbol: "USDR",
            currentSupply: 30_200_000,
            previousWeekSupply: 10_000_000,
          }),
          makeStablecoin({
            id: "usdc-circle",
            symbol: "USDC",
            currentSupply: 12_000_000,
            previousWeekSupply: 10_000_000,
          }),
          makeStablecoin({
            id: "eur-stasis",
            symbol: "EURS",
            currentSupply: 10_000_000,
            previousWeekSupply: 20_000_000,
          }),
        ],
      },
      isLoading: false,
    });
    useLogosMock.mockReturnValue({ data: { "usdr-real": "/logos/usdr.png" } });

    render(<SupplyMovesCard />);

    const peakLink = screen.getByRole("link", {
      name: "USDR supply moved +202% over 7 days",
    });
    expect(peakLink.getAttribute("href")).toBe("/stablecoin/usdr-real");
    expect(peakLink.textContent).toContain("Peak 7d");
  });
});

function makeStablecoin({
  id,
  symbol,
  currentSupply,
  previousWeekSupply,
}: {
  id: string;
  symbol: string;
  currentSupply: number;
  previousWeekSupply: number;
}): StablecoinData {
  return {
    id,
    name: symbol,
    symbol,
    geckoId: null,
    pegType: "USD",
    pegMechanism: "fiat-backed",
    price: 1,
    priceSource: "test",
    priceConfidence: "high",
    priceUpdatedAt: null,
    priceObservedAt: null,
    priceObservedAtMode: null,
    priceSyncedAt: null,
    consensusSources: [],
    agreeSources: [],
    circulating: { peggedUSD: currentSupply },
    circulatingPrevDay: {},
    circulatingPrevWeek: { peggedUSD: previousWeekSupply },
    circulatingPrevMonth: {},
    chainCirculating: {},
    chains: [],
  } as StablecoinData;
}
