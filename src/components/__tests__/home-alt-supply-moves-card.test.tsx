// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupplyMovesCard } from "@/components/home-alt-mini-cards/supply-moves-card";
import { makeChainGapGuard, makeStablecoin as makeStablecoinFixture } from "@shared/test-utils/stablecoin";
import type { StablecoinData } from "@shared/types/supply";

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
  ACTIVE_STABLECOIN_ID_SET: new Set(["usdr-real", "usdc-circle", "eur-stasis", "usdai-usd-ai", "usdt-tether", "dai-maker", "usds-sky", "pyusd-paypal", "xaut-tether"]),
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
      name: "USDR, peak 7-day supply mover: +202%",
    });
    expect(peakLink.getAttribute("href")).toBe("/stablecoin/usdr-real");
    expect(peakLink.textContent).toContain("USDR");
    expect(peakLink.textContent).toContain("+202%");
  });

  it("omits a repriced position when its token count is unchanged", () => {
    const coin = makeStablecoin({ id: "xaut-tether", symbol: "XAUT", currentSupply: 49_000_000, previousWeekSupply: 50_000_000 });
    coin.circulatingNative = 50_000_000;
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [coin] }, isLoading: false, dataUpdatedAt: Date.now() });
    render(<SupplyMovesCard />);
    expect(screen.queryByRole("link", { name: /peak 7-day supply mover/ })).toBeNull();
    expect(screen.getByText("No qualifying 7-day supply moves")).toBeTruthy();
  });

  it.each([undefined, {}])("distinguishes a legacy weekly series from a withheld comparison (%j)", (supplyChangeBaselines) => {
    const { supplyChangeBaselines: _baselines, ...legacy } = makeStablecoin({
      id: "usdc-circle", symbol: "USDC", currentSupply: 25_000_000, previousWeekSupply: 20_000_000,
    });
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [{ ...legacy, supplyChangeBaselines }] }, isLoading: false, dataUpdatedAt: Date.now() });
    render(<SupplyMovesCard />);
    if (supplyChangeBaselines === undefined) {
      expect(screen.getByRole("link", { name: "USDC, peak 7-day supply mover: +25.0%" })).toBeTruthy();
    } else {
      expect(screen.getByText("7-day supply moves unavailable")).toBeTruthy();
    }
  });

  it.each(["current", "week"])("uses dated USD stock when the %s native count is absent", (missing) => {
    const coin = makeStablecoin({ id: "usdc-circle", symbol: "USDC", currentSupply: 25_000_000, previousWeekSupply: 20_000_000 });
    coin.circulatingPrevWeek = { peggedUSD: 10_000_000 };
    if (missing === "week") coin.supplyChangeBaselines.week.circulatingNative = null;
    else coin.circulatingNative = null;
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [coin] }, isLoading: false, dataUpdatedAt: Date.now() });
    render(<SupplyMovesCard />);
    expect(screen.getByRole("link", { name: "USDC, peak 7-day supply mover: +25.0%" })).toBeTruthy();
  });

  it.each(["current", "previous week"] as const)("skips coins with unavailable %s supply", (unavailable) => {
    const coin = makeStablecoin({
      id: "usdr-real",
      symbol: "USDR",
      currentSupply: 30_000_000,
      previousWeekSupply: 20_000_000,
    });
    if (unavailable === "current") coin.circulating = {};
    else {
      Object.assign(coin, { supplyChangeBaselines: {} });
      coin.circulatingPrevWeek = {};
    }
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
    expect(screen.getByRole("link", { name: "USDC, peak 7-day supply mover: +20.0%" })).toBeTruthy();
  });

  it.each([true, undefined] as const)("excludes partial-chain coins from mover ranking (explicit partial=%s)", (partialCoverage) => {
    const partial = makeStablecoin({ id: "usdr-real", symbol: "USDR", currentSupply: 10_000_000, previousWeekSupply: 30_000_000 });
    partial.supplyChainGuard = makeChainGapGuard(partialCoverage);
    useStablecoinsMock.mockReturnValue({
      data: { peggedAssets: [partial, makeStablecoin({ id: "usdc-circle", symbol: "USDC", currentSupply: 12_000_000, previousWeekSupply: 10_000_000 })] },
      isLoading: false,
      dataUpdatedAt: Date.now(),
    });

    render(<SupplyMovesCard />);

    expect(screen.queryByRole("link", { name: /USDR/ })).toBeNull();
    expect(screen.getByRole("link", { name: "USDC, peak 7-day supply mover: +20.0%" })).toBeTruthy();
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

    expect(screen.getByRole("link", { name: `USDR, peak 7-day supply mover: ${change}` })).toBeTruthy();
  });

  // USDai's reviewed protocol-internal burn happened at 2026-09-23T20:48:00Z.
  it.each([
    ["seven days after the burn", "2026-09-30T20:48:00Z", "USDC, peak 7-day supply mover: +20.0%"],
    ["just inside the eight-day window", "2026-10-01T20:47:59Z", "USDC, peak 7-day supply mover: +20.0%"],
    ["once the burn leaves the window", "2026-10-01T20:48:01Z", "USDAI, peak 7-day supply mover: -29.1%"],
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

  it("anchors the internal-flow window to the supply observation clock, not receipt time", () => {
    const burnAtSec = 1_790_196_480;
    const supplyObservedAt = burnAtSec + 7 * 86_400;
    useStablecoinsMock.mockReturnValue({
      data: {
        peggedAssets: [
          makeStablecoin({
            id: "usdai-usd-ai", symbol: "USDAI", currentSupply: 218_267_235,
            previousWeekSupply: 307_738_160, supplyObservedAt,
          }),
          makeStablecoin({ id: "usdc-circle", symbol: "USDC", currentSupply: 12_000_000, previousWeekSupply: 10_000_000 }),
        ],
      },
      isLoading: false,
      // The snapshot was received a day after it was observed. Receipt time is
      // not the comparison clock, so the burn is still inside the window.
      dataUpdatedAt: (burnAtSec + 8 * 86_400 + 1) * 1000,
      meta: {
        updatedAt: supplyObservedAt,
        ageSeconds: 86_401,
        status: "stale",
        freshBudgetSec: 600,
        degradedBudgetSec: 900,
        assessedAt: burnAtSec + 8 * 86_400 + 1,
      },
    });

    render(<SupplyMovesCard />);

    expect(screen.queryByRole("link", { name: /USDAI/ })).toBeNull();
    expect(screen.getByRole("link", { name: "USDC, peak 7-day supply mover: +20.0%" })).toBeTruthy();
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
  supplyObservedAt,
}: {
  id: string;
  symbol: string;
  currentSupply: number;
  previousWeekSupply: number;
  supplyObservedAt?: number;
}): StablecoinData & { supplyChangeBaselines: { week: { circulatingUsd: number; circulatingNative: number | null } } } {
  return {
    ...makeStablecoinFixture({
      id,
      name: symbol,
      symbol,
      pegType: "USD",
      priceConfidence: "high",
      circulating: { peggedUSD: currentSupply },
      circulatingPrevWeek: { peggedUSD: previousWeekSupply },
      circulatingNative: currentSupply,
      ...(supplyObservedAt == null ? {} : { supplyObservedAt }),
    }),
    supplyChangeBaselines: { week: {
      observedAt: (supplyObservedAt ?? Math.floor(Date.now() / 1000)) - 7 * 86_400,
      circulatingUsd: previousWeekSupply,
      circulatingNative: previousWeekSupply,
    } },
  };
}
