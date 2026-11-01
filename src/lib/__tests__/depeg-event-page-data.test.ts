import { describe, expect, it } from "vitest";
import { DEPEG_EVENT_ENTRIES, buildExploreDepegEventLinks } from "@/lib/depeg-event-page-data";

describe("buildExploreDepegEventLinks", () => {
  it("gives same-month event pages distinct labels anchored to their UTC start", () => {
    const kau = buildExploreDepegEventLinks("kau-kinesis", "KAU");
    expect(kau).toHaveLength(5);
    expect(new Set(kau.map((link) => link.label)).size).toBe(kau.length);
    expect(kau[0].label).toBe("KAU depeg March 22, 2026 at 17:01 UTC");

    const usdx = buildExploreDepegEventLinks("usdx-hex-trust", "USDX");
    expect(new Set(usdx.map((link) => link.label)).size).toBe(usdx.length);
  });

  it("never repeats an anchor name within one coin's explore list", () => {
    const coinIds = [...new Set(DEPEG_EVENT_ENTRIES.map((event) => event.stablecoinId))];
    for (const coinId of coinIds) {
      const symbol = DEPEG_EVENT_ENTRIES.find((event) => event.stablecoinId === coinId)!.symbol;
      const labels = buildExploreDepegEventLinks(coinId, symbol).map((link) => link.label);
      expect(new Set(labels).size, coinId).toBe(labels.length);
    }
  });
});
