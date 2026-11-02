// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, type ImgHTMLAttributes } from "react";
import { describe, expect, it, vi } from "vitest";
import { LiquidityHero } from "@/components/liquidity-hero";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import { summarizeDexVolumeWindow } from "@shared/lib/dex-volume-availability";
import { formatCurrency } from "@shared/lib/format";
import { DEX_GLOBAL_KEY } from "@shared/types/market";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";

vi.mock("next/image", () => ({
  default: (props: ImgHTMLAttributes<HTMLImageElement>) => createElement("img", { ...props, alt: props.alt ?? "" }),
}));

function makeStats(overrides: Partial<LiquidityStatsData> = {}): LiquidityStatsData {
  return {
    totalTvl: 10_000,
    totalTvlUnavailableReason: null,
    totalVol: 2_500,
    ratedCount: 3,
    nrObservedCount: 1,
    withLiquidity: 4,
    highConfidenceCoverage: 3,
    fallbackCoverage: 1,
    totalTracked: 6,
    agg7dChange: null,
    avgBalance: null,
    avgOrganic: null,
    ...overrides,
  };
}

const TAIL_GLOBAL = makeDexLiquidityData({
  totalTvlUsd: 10_000,
  totalVolume24hUsd: 2_500,
  protocolTvl: {
    curve: 3_000,
    fluid: 2_000,
    balancer: 1_500,
    orca: 1_000,
    raydium: 900,
    aerodrome: 700,
    quickswap: 400,
  },
  chainTvl: {
    ethereum: 6_000,
    base: 2_000,
    arbitrum: 1_000,
  },
  poolCount: 42,
  concentrationHhi: 0.31,
});

describe("LiquidityHero", () => {
  it("shows an unusable 7d aggregate as a placeholder instead of NaN", () => {
    render(createElement(LiquidityHero, {
      stats: makeStats({ agg7dChange: Number.NaN }),
      liquidityMap: { [DEX_GLOBAL_KEY]: TAIL_GLOBAL },
    }));
    const label = screen.getByText("7d change, coins with 7d history");
    expect(label.parentElement?.textContent).toContain("—");
    expect(label.parentElement?.textContent).not.toMatch(/NaN/);
  });

  it.each([NaN, Infinity, -Infinity, -0.01, 1.01])("keeps invalid HHI %s unscored in map and fallback readouts", (concentrationHhi) => {
    render(createElement(LiquidityHero, {
      stats: makeStats(),
      liquidityMap: { [DEX_GLOBAL_KEY]: { ...TAIL_GLOBAL, concentrationHhi } },
    }));
    const throat = screen.getByTestId("exit-throat");
    const fallback = screen.getByTestId("exit-route-fallback-crowding");
    expect(throat.getAttribute("data-crowding-band")).toBe("unknown");
    expect(throat.getAttribute("aria-label")).toContain("crowding index not scored");
    expect(throat.textContent).toContain("NR");
    expect(fallback.textContent).toContain("NR");
    expect(fallback.textContent).not.toMatch(/(Low|Medium|High) crowding|NaN|Infinity/);
  });

  it("renders the beam, the unframed exit route map and the ledger in one hero", () => {
    const { container } = render(createElement(LiquidityHero, {
      stats: makeStats(),
      liquidityMap: { [DEX_GLOBAL_KEY]: TAIL_GLOBAL },
    }));

    const hero = screen.getByRole("group", { name: "Secondary exit depth" });
    expect(within(hero).getByText(formatCurrency(10_000))).toBeTruthy();
    expect(within(hero).getByText("4 of 6 observed on DEX")).toBeTruthy();
    expect(within(hero).getByText("3 rated · 1 NR")).toBeTruthy();
    expect(screen.getByTestId("exit-route-instrument").getAttribute("role")).toBe("img");
    // The fallback lists keep the crowding index the hidden scene carries on phones.
    expect(screen.getByTestId("exit-route-fallback-crowding").textContent).toContain("0.31");
    expect(screen.getByTestId("exit-route-fallback-crowding").textContent).toContain("Medium crowding");
    expect(screen.getByTestId("protocol-door-curve").getAttribute("data-share-pct")).toBe("30.00");
    expect(screen.getByTestId("protocol-door-_other-routes")).toBeTruthy();
    expect(screen.getByTestId("chain-lane-ethereum").getAttribute("data-share-pct")).toBe("60.00");
    expect(screen.getByTestId("exit-throat").getAttribute("data-crowding-band")).toBe("visible");
    // At rest the throat is selected: nothing is dimmed and the readout does not repeat the beam.
    expect(screen.getByTestId("selected-exit-route-panel").textContent).toContain("Exit throat");
    expect(screen.getByTestId("selected-exit-route-panel").textContent).not.toContain(formatCurrency(10_000));
    expect(screen.getByLabelText(`Curve protocol door, ${formatCurrency(3_000)}, 30.0% of DEX TVL`)).toBeTruthy();
    expect(container.querySelector('image[href="/dexes/curve.png"]')).toBeTruthy();
    expect(screen.getByTestId("chain-lane-ethereum").querySelector("image")?.getAttribute("href"))
      .toBe(resolveCompactLogoSrc("/chains/ethereum.png", 16));
    // No legacy card chrome or side metric cards.
    expect(screen.queryByText("Open routes")).toBeNull();
    expect(screen.queryByText("Leading door:")).toBeNull();

    // The throat carries the crowding index, not a second copy of the beam.
    const throat = screen.getByTestId("exit-throat");
    expect(throat.textContent).toContain("0.31");
    expect(throat.textContent).toContain("Medium crowding");
    expect(throat.textContent).not.toContain(formatCurrency(10_000));

    const ledger = screen.getByTestId("exit-route-ledger");
    expect(within(ledger).getByText("Venue mix")).toBeTruthy();
    expect(within(ledger).getByText("Chain mix")).toBeTruthy();
    expect(ledger.textContent).toContain(`Aerodrome ${formatCurrency(700)}`);
    expect(ledger.textContent).toContain(`QuickSwap ${formatCurrency(400)}`);
    expect(within(ledger).getAllByText(formatCurrency(1_100)).length).toBeGreaterThan(0);
  });

  it("updates the selected route readout from chain and throat interactions", () => {
    render(createElement(LiquidityHero, {
      stats: makeStats(),
      liquidityMap: {
        [DEX_GLOBAL_KEY]: makeDexLiquidityData({
          totalTvlUsd: 10_000,
          protocolTvl: { curve: 4_000, fluid: 2_000 },
          chainTvl: { ethereum: 5_000, base: 2_000 },
          poolCount: 42,
          concentrationHhi: 0.31,
        }),
      },
    }));

    fireEvent.focus(screen.getByTestId("chain-lane-base"));
    expect(screen.getByTestId("selected-exit-route-panel").textContent).toContain("Base");
    expect(screen.getByTestId("chain-lane-base").getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(screen.getByTestId("exit-throat"), { key: "Enter" });
    expect(screen.getByTestId("selected-exit-route-panel").textContent).toContain("Exit throat");
    expect(screen.getByTestId("exit-throat").getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(screen.getByTestId("protocol-door-curve"), { key: " " });
    expect(screen.getByTestId("selected-exit-route-panel").textContent).toContain("Curve");
  });

  it("shows a dash and no map when global depth is unavailable, a numeric zero otherwise", () => {
    const { unmount } = render(createElement(LiquidityHero, {
      stats: makeStats({ totalTvl: null, totalTvlUnavailableReason: "global-row-missing", totalVol: null }),
      liquidityMap: {},
    }));
    const hero = screen.getByRole("group", { name: "Secondary exit depth" });
    expect(hero.querySelector('p[class*="text-[2.1rem]"]')?.textContent).toBe("—");
    expect(screen.queryByTestId("exit-route-instrument")).toBeNull();
    expect(screen.getByText(/Exit routes are unavailable/)).toBeTruthy();
    unmount();

    render(createElement(LiquidityHero, { stats: makeStats({ totalTvl: 0 }), liquidityMap: {} }));
    expect(screen.getByText(formatCurrency(0))).toBeTruthy();
  });

  it("headlines a partial 24h volume window as an explicit lower bound, never a total", () => {
    const asOfSec = 1_800_000_000;
    const { availability } = summarizeDexVolumeWindow(
      [
        { volumeUsd: 1_980_000_000, observedAtSec: asOfSec - 60, tvlUsd: 8_400 },
        { volumeUsd: null, observedAtSec: null, tvlUsd: 1_600 },
      ],
      "24h",
      { asOfSec, maxObservationAgeSec: 72 * 3600 },
    );
    render(createElement(LiquidityHero, {
      stats: makeStats({ totalVol: null, totalVolAvailability: availability }),
      liquidityMap: {},
    }));

    expect(screen.getByText(`≥ ${formatCurrency(1_980_000_000)}`)).toBeTruthy();
    expect(screen.getByText("Partial lower bound: pools holding 84% of TVL")).toBeTruthy();
  });

  it("labels the 7d change with its basis and keeps the arrow neutral", () => {
    render(createElement(LiquidityHero, { stats: makeStats({ agg7dChange: -2.4 }), liquidityMap: {} }));
    const row = screen.getByText("7d change, coins with 7d history").parentElement as HTMLElement;
    expect(row.textContent).toContain("↓2.4%");
    expect(row.innerHTML).not.toMatch(/text-(red|green|emerald)/);
  });
});
