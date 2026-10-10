// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
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
  ACTIVE_STABLECOIN_ID_SET: new Set(["usdr-real", "usdc-circle", "eur-stasis", "usdai-usd-ai", "usdt-tether", "dai-maker", "usds-sky", "pyusd-paypal"]),
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
      dataUpdatedAt: Date.now(),
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

  it.each(["current", "previous week"] as const)("skips coins with unavailable %s supply", (unavailable) => {
    const coin = makeStablecoin({
      id: "usdr-real",
      symbol: "USDR",
      currentSupply: 30_000_000,
      previousWeekSupply: 20_000_000,
    });
    if (unavailable === "current") coin.circulating = {};
    else coin.circulatingPrevWeek = {};
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          coin,
          makeStablecoin({ id: "usdc-circle", symbol: "USDC", currentSupply: 12_000_000, previousWeekSupply: 10_000_000 }),
        ],
      },
      isLoading: false,
      dataUpdatedAt: Date.now(),
    });

    render(<SupplyMovesCard />);

    expect(screen.queryByRole("link", { name: /USDR/ })).toBeNull();
    expect(screen.getByRole("link", { name: "USDC — peak 7-day supply mover: +20.0%" })).toBeTruthy();
  });

  it.each([
    [10_000_000, 5_000_000, "+100%"],
    [5_000_000, 10_000_000, "-50.0%"],
    [0, 10_000_000, "-100%"],
  ])("retains explicit supply moves when either side meets the floor: %s / %s", (currentSupply, previousWeekSupply, change) => {
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          makeStablecoin({ id: "usdr-real", symbol: "USDR", currentSupply, previousWeekSupply }),
        ],
      },
      isLoading: false,
      dataUpdatedAt: Date.now(),
    });

    render(<SupplyMovesCard />);

    expect(screen.getByRole("link", { name: `USDR — peak 7-day supply mover: ${change}` })).toBeTruthy();
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
      dataUpdatedAt: Date.now(),
    });

    render(<SupplyMovesCard />);

    expect(screen.getByRole("link", { name: peakName })).toBeTruthy();
  });

  it.each([
    ["all positive", [10, 20, 30]],
    ["all negative", [-10, -20, -30]],
    ["one positive mover", [10]],
    ["one negative mover", [-10]],
    ["thin mixed signs", [10, -20, 30]],
    ["four on each side", [10, 20, 30, 40, -10, -20, -30, -40]],
  ] as const)("keeps directional rows disjoint and the peak unique: %s", (_label, changes) => {
    const ids = ["usdr-real", "usdc-circle", "eur-stasis", "usdt-tether", "dai-maker", "usds-sky", "pyusd-paypal", "usdai-usd-ai"];
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: changes.map((change, index) => makeStablecoin({
          id: ids[index],
          symbol: `COIN${index}`,
          currentSupply: 20_000_000 * (1 + change / 100),
          previousWeekSupply: 20_000_000,
        })),
      },
      isLoading: false,
      dataUpdatedAt: Date.parse("2026-10-10T12:00:00Z"),
    });

    render(<SupplyMovesCard />);

    const peak = screen.getByRole("link", { name: /peak 7-day supply mover/ });
    const upList = screen.getByText("Supply up").parentElement!;
    const downList = screen.getByText("Supply down").parentElement!;
    for (const row of within(upList).queryAllByRole("link")) {
      expect(row.textContent).toContain("+");
      expect(row.getAttribute("href")).not.toBe(peak.getAttribute("href"));
    }
    for (const row of within(downList).queryAllByRole("link")) {
      expect(row.textContent).toContain("-");
      expect(row.getAttribute("href")).not.toBe(peak.getAttribute("href"));
    }
    const rowLinks = [...within(upList).queryAllByRole("link"), ...within(downList).queryAllByRole("link")];
    expect(rowLinks).toHaveLength(Math.min(changes.length - 1, 6));
    expect(new Set([peak, ...rowLinks].map((row) => row.getAttribute("href"))).size).toBe(rowLinks.length + 1);
    if (changes.every((change) => change > 0)) {
      expect(within(downList).getByText("No other qualifying moves")).toBeTruthy();
    }
    if (changes.every((change) => change < 0)) {
      expect(within(upList).getByText("No other qualifying moves")).toBeTruthy();
    }
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
