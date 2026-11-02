import { describe, expect, it } from "vitest";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinData } from "@shared/types";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";
import { buildCompareSelectionInsights } from "@/lib/compare-selection-insights";

function entry(id: string): ComparisonCoinEntry {
  const meta = CLIENT_TRACKED_META_BY_ID.get(id);
  if (!meta) throw new Error(`missing client meta for ${id}`);
  return {
    id,
    symbol: meta.symbol,
    name: meta.name,
    data: {} as StablecoinData,
    meta: meta as unknown as ComparisonCoinEntry["meta"],
    bluechipPublicationAvailable: false,
  };
}

function build(ids: string[]) {
  return buildCompareSelectionInsights({
    selectedIds: ids,
    selectedCoins: ids.map((id) => ({ id, name: id, symbol: id })),
    comparisonCoins: ids.map(entry),
  });
}

describe("buildCompareSelectionInsights", () => {
  it("reads an all-fixed-peg USD set as a same-peg substitution decision", () => {
    const insights = build(["usdc-circle", "usdt-tether"])!;
    expect(insights.lens).toContain("Same-peg peer set");
    expect(insights.structure).toContain("Common peg target: US Dollar");
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
