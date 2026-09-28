// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupplyMovesCard } from "@/components/home-alt-mini-cards/supply-moves-card";
import { makeStablecoin as makeStablecoinFixture } from "@shared/test-utils/stablecoin";
import type { StablecoinData } from "@shared/types";

const { logosByIdMock, useStablecoinsMock } = vi.hoisted(() => ({
  logosByIdMock: {} as Record<string, string>,
  useStablecoinsMock: vi.fn(),
}));

vi.mock("@/lib/logos", () => ({
  logosById: logosByIdMock,
  getLogoSrc: (map: Record<string, string | undefined>, id: string) => map[id],
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

vi.mock("@/lib/stablecoin-static-data", () => ({
  ACTIVE_STABLECOIN_ID_SET: new Set(["usdr-real", "usdc-circle", "eur-stasis", "usdai-usd-ai"]),
}));

vi.mock("next/image", () => ({
  default: ({ alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => <img alt={alt} {...props} />,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  for (const key of Object.keys(logosByIdMock)) delete logosByIdMock[key];
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
    logosByIdMock["usdr-real"] = "/logos/usdr.png";

    render(<SupplyMovesCard />);

    const peakLink = screen.getByRole("link", {
      name: "USDR — peak 7-day supply mover: +202%",
    });
    expect(peakLink.getAttribute("href")).toBe("/stablecoin/usdr-real");
    expect(peakLink.textContent).toContain("USDR");
    expect(peakLink.textContent).toContain("+202%");
  });

  // USDai's reviewed protocol-internal burn happened at 2026-09-23T20:48:00Z.
  it.each([
    ["seven days after the burn", "2026-09-30T20:48:00Z", "USDC — peak 7-day supply mover: +20.0%"],
    ["just inside the eight-day window", "2026-10-01T20:47:59Z", "USDC — peak 7-day supply mover: +20.0%"],
    ["once the burn leaves the window", "2026-10-01T20:48:01Z", "USDAI — peak 7-day supply mover: -29.1%"],
  ])("ranks a coin with a reviewed protocol-internal burn only outside its window: %s", (_label, now, peakName) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          makeStablecoin({ id: "usdai-usd-ai", symbol: "USDAI", currentSupply: 218_267_235, previousWeekSupply: 307_738_160 }),
          makeStablecoin({ id: "usdc-circle", symbol: "USDC", currentSupply: 12_000_000, previousWeekSupply: 10_000_000 }),
        ],
      },
      isLoading: false,
    });

    render(<SupplyMovesCard />);

    expect(screen.getByRole("link", { name: peakName })).toBeTruthy();
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
