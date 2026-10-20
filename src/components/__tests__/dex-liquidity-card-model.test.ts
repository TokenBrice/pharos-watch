import { describe, expect, it } from "vitest";
import { getHhiBand } from "@shared/lib/classification";
import { makeDexLiquidityData } from "@/test/fixtures/dex-liquidity";
import {
  getConcentrationLabel,
  getOrganicFractionTier,
  getLiquidityEvidenceLabel,
} from "@/components/dex-liquidity-card-model";
import { crowdingBand, throatLabelForCrowding } from "@/components/exit-route-model";

describe("DEX liquidity verdict bands", () => {
  it.each([0, 0.1799, 0.18, 0.3499, 0.35, 1])(
    "uses one canonical HHI band at %s across card and exit-route surfaces",
    (hhi) => {
      const band = getHhiBand(hhi);

      expect(getConcentrationLabel(hhi)?.label).toBe(band?.concentrationLabel);
      expect(crowdingBand(hhi)).toBe(band?.key);
      expect(throatLabelForCrowding(hhi)).toBe(band?.throatLabel);
    },
  );

  it("pins the reviewed HHI band thresholds at their boundaries (liquidity methodology v6.6)", () => {
    expect(getHhiBand(1)).toMatchObject({ key: "crowded", concentrationLabel: "High" });
    expect(getHhiBand(0.35)).toMatchObject({ key: "crowded", concentrationLabel: "High" });
    expect(getHhiBand(0.3499)).toMatchObject({ key: "visible", concentrationLabel: "Medium" });
    expect(getHhiBand(0.3)).toMatchObject({ key: "visible", concentrationLabel: "Medium" });
    expect(getHhiBand(0.18)).toMatchObject({ key: "visible", concentrationLabel: "Medium" });
    expect(getHhiBand(0.2)).toMatchObject({ key: "visible", concentrationLabel: "Medium" });
    expect(getHhiBand(0.1799)).toMatchObject({ key: "broad", concentrationLabel: "Low" });
    expect(getHhiBand(0)).toMatchObject({ key: "broad", concentrationLabel: "Low" });
  });

  it.each([NaN, Infinity, -Infinity, null, undefined, -0.01, 1.01])(
    "does not grant favorable crowding evidence to invalid HHI %s",
    (hhi) => {
      expect(getHhiBand(hhi)).toBeNull();
      expect(getConcentrationLabel(hhi)).toBeNull();
      expect(crowdingBand(hhi)).toBe("unknown");
      expect(throatLabelForCrowding(hhi)).toBe("Crowding not scored");
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

  it("keeps unavailable partial-measured coverage distinct from observed zero", () => {
    const partial = makeDexLiquidityData({
      liquidityEvidenceClass: "partial_measured", totalTvlUsd: 100, balanceMeasuredTvlUsd: null,
    });
    const unavailable = getLiquidityEvidenceLabel(partial);
    expect(unavailable).toMatch(/unavailable/i);
    expect(unavailable).not.toContain("0%");
    expect(getLiquidityEvidenceLabel({ ...partial, balanceMeasuredTvlUsd: 0 })).toContain("0%");
    expect(getLiquidityEvidenceLabel({ ...partial, balanceMeasuredTvlUsd: 25 })).toContain("25%");
  });
});
