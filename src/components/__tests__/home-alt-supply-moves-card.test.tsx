// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupplyMovesCard } from "@/components/home-alt-mini-cards/supply-moves-card";
import { makeStablecoin as makeStablecoinFixture } from "@/test/fixtures/safety-scores";
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
  default: ({ alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => <img alt={alt} {...props} />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SupplyMovesCard", () => {
  it("distinguishes request failure from an empty movers list", () => {
    useStablecoinsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("market data unavailable"),
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    });
    useLogosMock.mockReturnValue({ data: {} });

    render(<SupplyMovesCard />);

    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    expect(screen.queryByText("No qualifying 7-day supply moves")).toBeNull();
  });

  it("renders a valid empty state without an endless skeleton", () => {
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      dataUpdatedAt: 1,
    });
    useLogosMock.mockReturnValue({ data: {} });

    render(<SupplyMovesCard />);

    expect(screen.getByText("No qualifying 7-day supply moves")).toBeTruthy();
  });

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
      name: "USDR — peak 7-day supply mover: +202%",
    });
    expect(peakLink.getAttribute("href")).toBe("/stablecoin/usdr-real");
    expect(peakLink.textContent).toContain("USDR");
    expect(peakLink.textContent).toContain("+202%");
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
  return makeStablecoinFixture({
    id,
    name: symbol,
    symbol,
    pegType: "USD",
    priceConfidence: "high",
    circulating: { peggedUSD: currentSupply },
    circulatingPrevWeek: { peggedUSD: previousWeekSupply },
  });
}
