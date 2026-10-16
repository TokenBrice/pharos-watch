import { Fragment, type ReactNode } from "react";
import type * as RechartsModule from "recharts";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReserveTreemap } from "@/components/reserve-treemap";
import type { ReserveCompositionSlice } from "@/components/stablecoin-detail/reserve-presentation";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";

// The server render never measures its container, so the treemap draws its
// skeleton unless a test marks the chart ready.
const chart = vi.hoisted(() => ({ ready: false }));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({ ref: () => {}, ready: chart.ready, width: 640, height: 288 }),
}));

// Lays every slice out as one full-width tile so each cell draws its label.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof RechartsModule>()),
  Treemap: ({ data, content }: {
    data: Record<string, unknown>[];
    content: (props: Record<string, unknown>) => ReactNode;
  }) => (
    <svg>
      {data.map((slice, index) => (
        <Fragment key={index}>{content({ ...slice, x: 0, y: index * 120, width: 320, height: 120, depth: 1 })}</Fragment>
      ))}
    </svg>
  ),
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
});
