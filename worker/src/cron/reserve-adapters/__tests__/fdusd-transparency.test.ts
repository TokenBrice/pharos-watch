import { describe, expect, it } from "vitest";
import { adaptFdusdTransparency } from "../fdusd-transparency";

const SAMPLE_HTML = `
<div class="chart-bages w-dyn-list">
  <div role="list" class="bages-wrapper w-dyn-items">
    <div role="listitem" class="chart-badge w-dyn-item">
      <div>US Treasury Bills</div>
      <div class="item-value"><div class="percent-value">74.5</div><div class="percent-symbol">%</div></div>
    </div>
    <div role="listitem" class="chart-badge w-dyn-item">
      <div>Cash</div>
      <div class="item-value"><div class="percent-value">17.5</div><div class="percent-symbol">%</div></div>
    </div>
    <div role="listitem" class="chart-badge w-dyn-item">
      <div>Bank Deposits</div>
      <div class="item-value"><div class="percent-value">6</div><div class="percent-symbol">%</div></div>
    </div>
    <div role="listitem" class="chart-badge w-dyn-item">
      <div>Reverse Repos</div>
      <div class="item-value"><div class="percent-value">2</div><div class="percent-symbol">%</div></div>
    </div>
  </div>
</div>
<div class="chart-date w-dyn-list">
  <div role="list" class="w-dyn-items">
    <div role="listitem" class="date-item w-dyn-item">
      <div class="chart-date">As of </div>
      <div class="chart-date">Feb 28, 2026</div>
    </div>
  </div>
</div>
`;

describe("adaptFdusdTransparency", () => {
  it("maps the transparency badges into Pharos reserve slices", () => {
    const result = adaptFdusdTransparency(SAMPLE_HTML);
    expect(result.slices).toEqual([
      { name: "U.S. Treasury Bills", pct: 74.5, risk: "very-low" },
      { name: "Cash", pct: 17.5, risk: "very-low" },
      { name: "Bank Deposits", pct: 6, risk: "very-low" },
      { name: "Overnight Reverse Repos", pct: 2, risk: "very-low" },
    ]);
    expect(result.metadata).toMatchObject({
      sliceCount: 4,
      asOf: "Feb 28, 2026",
      sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
    });
  });

  it("throws when the page no longer exposes any reserve badges", () => {
    expect(() => adaptFdusdTransparency("<html></html>")).toThrow("no reserve composition entries");
  });
});
