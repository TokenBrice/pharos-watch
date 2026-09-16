import { describe, expect, it } from "vitest";
import {
  getConcentrationLabel,
  getHhiBand,
  getOrganicFractionTier,
} from "@/components/dex-liquidity-card-model";
import { crowdingBand, throatLabelForCrowding } from "@/components/exit-route-model";

describe("DEX liquidity verdict bands", () => {
  it.each([0, 0.1799, 0.18, 0.3499, 0.35, 1])(
    "uses one canonical HHI band at %s across card and exit-route surfaces",
    (hhi) => {
      const band = getHhiBand(hhi);

      expect(getConcentrationLabel(hhi).label).toBe(band.concentrationLabel);
      expect(crowdingBand(hhi)).toBe(band.key);
      expect(throatLabelForCrowding(hhi)).toBe(band.throatLabel);
    },
  );

  it("uses the canonical organic tiers for thresholds and mature low-organic pools", () => {
    expect(getOrganicFractionTier(0.7)).toMatchObject({ label: "Organic" });
    expect(getOrganicFractionTier(0.3)).toMatchObject({ label: "Mixed" });
    expect(getOrganicFractionTier(0.29)).toMatchObject({ label: "Incentivized" });
    expect(getOrganicFractionTier(0.29, 365)).toMatchObject({ label: "Established" });
    expect(getOrganicFractionTier(0.7).summaryColor).toContain("emerald");
    expect(getOrganicFractionTier(0.3).summaryColor).toContain("amber");
    expect(getOrganicFractionTier(0.29).summaryColor).toContain("red");
  });
});
