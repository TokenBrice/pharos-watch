import { describe, expect, it } from "vitest";
import { buildCompareSelectionInsights } from "@/lib/compare-selection-insights";

function build(ids: string[]) {
  return buildCompareSelectionInsights({ selectedIds: ids });
}

describe("buildCompareSelectionInsights", () => {
  it("reads an all-fixed-peg USD set as a same-peg substitution decision", () => {
    const insights = build(["usdc-circle", "usdt-tether"])!;
    expect(insights.lens).toContain("Same-peg peer set");
    expect(insights.structure).toContain("Common peg target: US Dollar");
  });

  it("builds set claims and detail links from registry meta for every selected coin", () => {
    const insights = build(["usdc-circle", "usdt-tether"])!;
    expect(insights.cohort).toContain("Shared governance model across the set");
    expect(insights.structure).toContain("Shared backing profile");
    expect(insights.links).toEqual([
      { id: "usdc-circle", symbol: "USDC" },
      { id: "usdt-tether", symbol: "USDT" },
    ]);
    expect(`${insights.cohort} ${insights.structure}`).not.toContain("still loading");
  });

  it("does not claim a shared model from an admitted subset that differs from the selection", () => {
    const insights = build(["usdc-circle", "ousd-origin-protocol"])!;
    expect(insights.cohort).toBe("Mixed governance models across the selected assets.");
    expect(insights.structure).toContain("Mixed backing structures across the set.");
    expect(insights.links.map((link) => link.id)).toEqual(["usdc-circle", "ousd-origin-protocol"]);
  });

  it.each([
    ["usde-ethena", "susde-ethena"],
    ["usyc-hashnote", "usdy-ondo-finance", "ustb-superstate"],
  ])("omits the peg-cleaner read and peg target for a NAV-bearing set (%s)", (...ids) => {
    const insights = build(ids)!;
    expect(insights.lens).toBeNull();
    expect(insights.structure).not.toContain("Common peg target");
    expect(insights.structure).toContain("Shared backing profile");
  });
});
