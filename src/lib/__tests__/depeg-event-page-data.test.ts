import { describe, expect, it } from "vitest";
import { buildExploreDepegEventLinks } from "@/lib/depeg-event-page-data";

describe("buildExploreDepegEventLinks", () => {
  it("uses the compact month-year label for the newest event pages", () => {
    const kau = buildExploreDepegEventLinks("kau-kinesis", "KAU");
    expect(kau).toHaveLength(5);
    for (const link of kau) {
      expect(link.label).toMatch(/^KAU depeg [A-Z][a-z]{2} \d{4}$/);
      expect(link.href).toMatch(/^\/depeg\/kau-/);
    }
  });
});
