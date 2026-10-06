import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReserveTreemap } from "@/components/reserve-treemap";
import type { ReserveCompositionSlice } from "@/components/stablecoin-detail/reserve-presentation";
import { RISK_ACCENT_COLORS, RISK_COLORS } from "@/lib/chart-colors";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";

const SLICE = (label: string, pct: number, risk: ReserveCompositionSlice["risk"]): ReserveCompositionSlice => ({
  key: label,
  label,
  pct,
  risk,
  detail: null,
});

const render = (slices: ReserveCompositionSlice[]) =>
  renderToStaticMarkup(<ReserveTreemap slices={slices} subject="Reviewed reserve slices" />);

describe("ReserveTreemap", () => {
  it("draws a single-slice basket as one labelled bar, never a giant tile", () => {
    const html = render([SLICE("ETH", 100, "very-low")]);
    expect(html).toContain('aria-label="Reviewed reserve slices: ETH 100%"');
    expect(html).toContain("ETH · 100%");
    expect(html).not.toContain("pharos-chart-stage");
  });

  it("draws a basket led by a slice at or above 90% as a bar and still labels every other share", () => {
    const html = render([SLICE("USDe staking vault shares", 92, "medium"), SLICE("Cash buffer", 8, "very-low")]);
    expect(html).toContain("USDe staking vault shares · 92%");
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

  it("keys exactly the tiers drawn, each swatch carrying its tile's fill and accent", () => {
    const html = render([
      SLICE("T-bills", 50, "very-low"),
      SLICE("Repo", 30, "medium"),
      SLICE("Private credit", 20, "high"),
    ]);
    expect(html).toContain("Very Low Risk");
    expect(html).toContain("Medium Risk");
    expect(html).toContain("High Risk");
    expect(html).not.toContain("Very High Risk");
    // Delimited: a naive "Low Risk" substring also matches "Very Low Risk".
    expect(html).not.toContain(">Low Risk<");
    expect(html.match(/rounded-\[2px\]/g)).toHaveLength(3);
    for (const risk of ["very-low", "medium", "high"] as const) {
      expect(html).toContain(`background-color:${RISK_COLORS[risk]}`);
      expect(html).toContain(`border-color:${RISK_ACCENT_COLORS[risk]}`);
    }
  });

  it("keys a single-tier basket too, so its colour always has a key", () => {
    const html = render([SLICE("Cash", 60, "very-low"), SLICE("T-bills", 40, "very-low")]);
    expect(html).toContain("Very Low Risk");
    expect(html.match(/rounded-\[2px\]/g)).toHaveLength(1);
  });

  it("renders nothing for an empty or all-zero basket", () => {
    expect(render([])).toBe("");
    expect(render([SLICE("Cash", 0, "very-low")])).toBe("");
  });

  it("reads compact and standalone reserve-risk labels from the shared classification owner", () => {
    expect(RESERVE_RISK_PRESENTATION["very-low"]).toEqual({
      shortLabel: "Very low",
      longLabel: "Very Low Risk",
    });
  });
});
