// @vitest-environment jsdom

import { Fragment, type ReactNode } from "react";
import type * as RechartsModule from "recharts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReserveTreemap } from "@/components/reserve-treemap";
import { ReserveTreemapChart } from "@/components/reserve-treemap-chart";
import { condenseReserveSlices, reviewedCompositionSlices } from "@/components/stablecoin-detail/reserve-presentation";
import { projectReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { RISK_COLORS } from "@/lib/chart-colors";
import type { ReserveCompositionSlice } from "@/components/stablecoin-detail/reserve-presentation";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";

// The server render never measures its container, so the treemap draws its
// skeleton unless a test marks the chart ready.
const chart = vi.hoisted(() => ({ ready: false, width: 640, height: 288 }));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: () => {}, ...chart }),
}));

// A linear layout double retains Recharts' denominator contract: tile area is
// size / sum(size). This makes dropped weights observable without pinning squarification.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof RechartsModule>()),
  Treemap: ({ data, content }: {
    data: Record<string, unknown>[];
    content: (props: Record<string, unknown>) => ReactNode;
  }) => {
    const total = data.reduce((sum, slice) => sum + Number(slice.size), 0);
    let y = 0;
    return <svg>{data.map((slice, index) => {
      const height = chart.height * Number(slice.size) / total;
      const cell = content({ ...slice, x: 0, y, width: chart.width, height, depth: 1 });
      y += height;
      return <Fragment key={index}>{cell}</Fragment>;
    })}</svg>;
  },
}));

const SLICE = (
  label: string,
  pct: number,
  risk: ReserveCompositionSlice["risk"],
  role: string | null = null,
): ReserveCompositionSlice => ({
  key: label,
  label,
  pct,
  risk,
  detail: null,
  role,
});

const render = (slices: ReserveCompositionSlice[]) =>
  renderToStaticMarkup(<ReserveTreemap slices={slices} subject="Reviewed reserve slices" />);

afterEach(() => { chart.ready = false; chart.width = 640; });

function chartTiles(slices: ReserveCompositionSlice[], unreviewedPct = 0, labelLimit = Infinity) {
  chart.ready = true;
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<ReserveTreemapChart data={slices} unreviewedPct={unreviewedPct} labelLimit={labelLimit} />);
  return [...container.querySelectorAll("svg > g")];
}

function areaShare(tile: Element) {
  const rect = tile.querySelector("rect")!;
  return Number(rect.getAttribute("width")) * Number(rect.getAttribute("height")) / (chart.width * chart.height);
}
describe("ReserveTreemap", () => {
  it("draws a one-slice basket as a composition bar naming the slice, its risk tier and its asset class", () => {
    const html = render([SLICE("ZEPH protocol reserve", 100, "high", "Cryptoasset")]);
    const tier = RESERVE_RISK_PRESENTATION.high.longLabel;
    expect(html).toContain(`aria-label="Reviewed reserve slices: ZEPH protocol reserve 100%, ${tier}, Cryptoasset"`);
    expect(html).toContain("ZEPH protocol reserve");
    // Visible tier text is a sentence-case phrase, never the title-case enum.
    expect(html).toContain(">High risk<");
    expect(html).toContain("Cryptoasset");
    expect(html).not.toContain("pharos-chart-stage");
    // The tier is named on the bar itself, so no separate legend is keyed.
    expect(html).not.toContain("Reserve risk tiers");
  });

  it("marks an unclassified asset class as unavailable instead of inventing one", () => {
    const html = render([SLICE("ETH", 100, "very-low")]);
    expect(html).toContain("–");
    expect(html).toContain(`aria-label="Reviewed reserve slices: ETH 100%, ${RESERVE_RISK_PRESENTATION["very-low"].longLabel}"`);
  });

  it("labels the uncovered share when a lone slice does not cover the whole basket", () => {
    const partial = render([SLICE("T-bills", 60, "very-low", "Treasury bills")]);
    expect(partial).toContain("40%");
    expect(partial).toContain("Unreviewed remainder");
    expect(render([SLICE("T-bills", 100, "very-low")])).not.toContain("Unreviewed remainder");
  });

  it("does not label floating-point summation dust as unreviewed composition", () => {
    const slices = [
      SLICE("Cash", 81.3, "medium"),
      SLICE("BTC", 9.8, "medium"),
      SLICE("ETH", 7.6, "low"),
      SLICE("Other", 1.3, "high"),
    ];
    expect(render(slices)).not.toContain("Unreviewed remainder");
    // A genuine sub-display-precision gap still remains disclosed.
    expect(render([SLICE("Bills", 99.999, "very-low"), SLICE("Loans", 0.0005, "high")]))
      .toContain("Unreviewed remainder &lt;0.01%");
  });

  it("draws a basket led by a slice at or above 90% as a bar and still labels every other share", () => {
    const html = render([SLICE("USDe staking vault shares", 92, "medium"), SLICE("Cash buffer", 8, "very-low")]);
    expect(html).toContain("USDe staking vault shares");
    expect(html).toContain("92%");
    expect(html).toContain("Other reserve slices");
    expect(html).toContain("Cash buffer");
    expect(html).toContain("8%");
  });

  it("keeps a basket just under the 90% line as a treemap", () => {
    const html = render([SLICE("T-bills", 89.9, "very-low"), SLICE("Cash", 10.1, "very-low")]);
    expect(html).toContain("pharos-chart-stage");
    // The accessible figure exists even before the viewport-gated renderer.
    expect(html).toContain('role="figure"');
    expect(html).toContain('aria-label="Reviewed reserve slices: T-bills 89.9%, Cash 10.1%"');
    expect(html).not.toContain("Other reserve slices");
  });

  it("orders the accessible description by share and rounds precise shares, keeping positive dust visible", () => {
    const html = render([SLICE("Cash", 0.004, "very-low"), SLICE("thBILL", 25.9904802, "low"), SLICE("Gold carry", 74.0045198, "medium")]);
    expect(html).toContain("Reviewed reserve slices: Gold carry 74%, thBILL 25.99%, Cash &lt;0.01%");
    expect(html).not.toContain("74.0045198");
  });

  it("renders nothing for an empty or all-zero basket", () => {
    expect(render([])).toBe("");
    expect(render([SLICE("Cash", 0, "very-low")])).toBe("");
  });

  it.each([640, 280])("retains every reviewed group's weight and risk at %spx, folding only its label", (width) => {
    chart.width = width;
    const slices = [50, 20, 10, 8, 6, 4, 2].map((pct, index) =>
      SLICE(`Reviewed ${index}`, pct, index === 6 ? "high" : "very-low"));
    const tiles = chartTiles(slices, 0, 5);
    expect(tiles).toHaveLength(7);
    tiles.forEach((tile, index) => {
      expect(areaShare(tile)).toBeCloseTo(slices[index]!.pct / 100);
      expect(tile.querySelector("rect")!.getAttribute("fill")).toBe(RISK_COLORS[slices[index]!.risk]);
    });
    expect(tiles[5]!.querySelector("text")).toBeNull();
    expect(tiles[6]!.querySelector("title")!.textContent).toContain("Reviewed 6 · 2%");
    expect(render(slices)).not.toContain("Unreviewed remainder");
  });

  it.each(["usdt-tether", "frax-frax"])("keeps the full real-registry basket denominator for %s", (id) => {
    const summary = projectReserveQualityClientSummary(TRACKED_META_BY_ID.get(id)!)!;
    const original = reviewedCompositionSlices(summary);
    const { shown, rest } = condenseReserveSlices(original);
    expect(rest.length).toBeGreaterThan(0);
    const all = [...shown, ...rest];
    const basis = Math.max(100, original.reduce((sum, slice) => sum + slice.pct, 0));
    const tiles = chartTiles(all, Math.max(0, 100 - original.reduce((sum, slice) => sum + slice.pct, 0)), shown.length);
    all.forEach((slice, index) => expect(areaShare(tiles[index]!)).toBeCloseTo(slice.pct / basis, 10));
    expect(all.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(original.reduce((sum, slice) => sum + slice.pct, 0), 10);
  });

  it("leaves an explicit unreviewed region for a multi-slice partial basket", () => {
    const slices = [SLICE("Bills", 40, "very-low"), SLICE("Loans", 20, "high")];
    const tiles = chartTiles(slices, 40);
    expect(tiles.map(areaShare)).toEqual([0.4, 0.2, 0.4]);
    expect(tiles[2]!.querySelector("rect")!.getAttribute("fill")).toBe("none");
    expect(tiles[2]!.querySelector("title")!.textContent).toContain("Unreviewed remainder · 40%");
    expect(render(slices)).toContain("Unreviewed remainder 40%");
  });

  it("keeps dominant reviewed crumbs and a genuine uncovered share separate", () => {
    const container = document.createElement("div");
    container.innerHTML = render([SLICE("Bills", 92, "very-low"), SLICE("Loans", 3, "high")]);
    const figure = container.querySelector('[role="figure"]')!;
    const segments = figure.querySelectorAll("[style*='flex:']");
    expect([...segments].map((segment) => (segment as HTMLElement).style.flexGrow)).toEqual(["92", "3", "5"]);
    expect(figure.getAttribute("aria-label")).toContain("Loans 3%, Unreviewed remainder 5%");
    expect(render([SLICE("Bills", 99.8, "very-low")])).toContain("Unreviewed remainder 0.2%");
    container.innerHTML = render([SLICE("Small reviewed position with a long name", 5, "low")]);
    const segment = container.querySelector<HTMLElement>('[style*="width:5%"]')!;
    expect(segment.style.width).toBe("5%");
    expect(segment.textContent).toBe("");
    expect(container.querySelector('[role="figure"]')!.getAttribute("aria-label")).toContain("Unreviewed remainder 95%");
  });
});
