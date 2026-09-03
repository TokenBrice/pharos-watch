import operationalResilienceOverlaysAsset from "@shared/data/safety-score-v9/operational-resilience-overlays-v1.json";
import { describe, expect, it } from "vitest";
import {
  getSafetyScoreV9OperationalResilienceOverlay,
  getSafetyScoreV9OperationalResilienceOverlayEvidence,
  SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST,
  SafetyScoreV9OperationalResilienceOverlayFileSchema,
  SafetyScoreV9OperationalResilienceOverlaySchema,
} from "../safety-score-v9/extension-operational-resilience";

const REVIEWED_AT_SEC = Date.parse("2026-07-23T12:37:19Z") / 1_000;
const CURRENT_CLOCK_SEC = Date.parse("2026-07-24T00:00:00Z") / 1_000;
const EXPIRES_AT_SEC = Date.parse("2027-07-23T12:37:19Z") / 1_000;

const USDT_ASSURANCE_LEDGER = [
  {
    sourceId: "moore-2021-q1-reserves-assurance",
    publishedAt: "2021-04-27",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/2UzdY0r33LkkYfr8VDJwwb/7860230f667ed8622fc068949f5fcf94/tether-assurance-mar-2021-2.pdf",
  },
  {
    sourceId: "moore-2021-q2-reserves-assurance",
    publishedAt: "2021-08-06",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/VcNv0hgvQ2a3Ochjs5TqR/59e77f0c076544a88f977d1d36b76dbf/tether_assuranceconsolidated_reserves_report_2021-06-30.pdf",
  },
  {
    sourceId: "moore-2021-q3-reserves-assurance",
    publishedAt: "2021-12-03",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/01lZdtaNYx7jZ4jU5xmlYO/90aa0d5b1e3559c393ff135f987ddbd0/tether-assurance-sept-30-2021.pdf",
  },
  {
    sourceId: "mha-2021-q4-reserves-assurance",
    publishedAt: "2022-02-19",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/4hiNJsZ98LlZqCJHKzrLpV/2b6338482ef0093382885f80ba6f1083/Tether_Assurance-12-31-21.pdf",
  },
  {
    sourceId: "mha-2022-q1-reserves-assurance",
    publishedAt: "2022-05-18",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/1np5dpcwuHrWJ4AgUgI3Vn/e0dac722de3cea07766e05c52773748b/Tether_Assurance_Consolidated_Reserves_Report_2022-03-31__3_.pdf",
  },
  {
    sourceId: "bdo-2022-q2-reserves-assurance",
    publishedAt: "2022-08-10",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/2xJyKdUKicdRUWpC9buRWR/6fe2987698dbbf39b947af718d736ddb/Std_ISAE_3000R_Opinion_30-6-2022_RC134792022BD0303.pdf",
  },
  {
    sourceId: "bdo-2022-q3-reserves-assurance",
    publishedAt: "2022-11-10",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/1Xfu4398CIoMiuKjPhvnHM/6d1608c90bb775d2d432b7b24264da28/ESO.02_Std_ISAE_3000R_Opinion_30-9-2022_RC134792022BD0548.pdf",
  },
  {
    sourceId: "bdo-2022-q4-reserves-assurance",
    publishedAt: "2023-02-08",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/53L8YRM4ZHCEeqlpKbc3Q8/2e6cbcd1593b3e5ea867718c5938d6c8/Std_ISAE_3000R_Opinion_BDO_31-12-2022_Tether_CRR.pdf",
  },
  {
    sourceId: "bdo-2023-q1-reserves-assurance",
    publishedAt: "2023-05-09",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/24G4DuQ0HE7h7EQE6vGy4J/8a8a170edf687ea07b3f86048af8b87b/ESO.03.01_Std_ISAE_3000R_Opinion_31-03-2023_BDO_Tether_CRR.pdf",
  },
  {
    sourceId: "bdo-2023-q2-reserves-assurance",
    publishedAt: "2023-07-31",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/63oJePOHqIvrcnXWMPZ1M0/4cfaf2e7cdf80c30b17fdc70faaf741f/ESO.03.01_Std_ISAE_3000R_Opinion_30-06-2023_BDO_Tether_CRR.pdf",
  },
  {
    sourceId: "bdo-2023-q3-reserves-assurance",
    publishedAt: "2023-10-31",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/36XORApdEYAq3AsH1FTXRT/9205ac62f2f57178c47ac5e2eca098c0/Std_ISAE_3000R_Opinion_30-09-2023_BDO_Tether_CRR_RC134792023BD0430.pdf",
  },
  {
    sourceId: "bdo-2023-q4-reserves-assurance",
    publishedAt: "2024-01-31",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/7DZ8nVyr8zTaWhJqTIsMsH/b8e55bc151c9bb74adf20ff840e84088/ESO.03.01_Std_ISAE_3000R_Opinion_31-12-2023_BDO_Tether_CRR_RC134792023BD0684__1_.pdf",
  },
  {
    sourceId: "bdo-2024-q1-reserves-assurance",
    publishedAt: "2024-04-30",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/2JwUN6EeDvWi02CyuQd2nJ/d7b3b4c3800ec70abd7282cc79fa2973/ISAE_3000R_-_Opinion_on_Consolidated_Financials_Figures_and_Reserves_Report_31.03.2024_RC134792024BD0043.pdf",
  },
  {
    sourceId: "bdo-2024-q2-reserves-assurance",
    publishedAt: "2024-07-31",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/6h4YWqZOXbwtBaPtYgICGy/d7462f312aa15b872f8474322ba90363/ISAE_3000R_-_Opinion_on_Consolidated_Financials_Figures_30.06.2024_RC134792024BD0209.pdf",
  },
  {
    sourceId: "bdo-2024-q3-reserves-assurance",
    publishedAt: "2024-10-31",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/5TKa7xwJVLIAnVBMWb7iTq/5688216da5194fce27f4a0f2e808a486/ISAE_3000R_-_Opinion_on_Tether_Consolidated_Financials_Figures_30.09.2024_.pdf",
  },
  {
    sourceId: "bdo-2024-q4-reserves-assurance",
    publishedAt: "2025-01-31",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/6L2yLNnLltcCP6ZcTxJrll/aea0ec279fea08637445c8be57f63d87/ISAE_3000R_-_Opinion_on_Tether_Consolidated_Financials_Figures_31.12.2024.pdf",
  },
  {
    sourceId: "bdo-2025-q1-reserves-assurance",
    publishedAt: "2025-04-30",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/1LdSmP3HBynDxm6wvkDSsL/c4bcbd1f6fc18a0e8b3a12444ac8ae97/ISAE_3000R_-_Opinion_Tether_International_Financial_Figures___Reserves_Report_31.03.2025_RC187322025BD0040.pdf",
  },
  {
    sourceId: "bdo-2025-q2-reserves-assurance",
    publishedAt: "2025-07-31",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/2SGAAXnsb1wKByIzkhcbSx/9efa4682b3cd4c62d87a4c88ee729693/ISAE_3000R_-_Opinion_Tether_International_Financial_Figure_RC187322025BD0201.pdf",
  },
  {
    sourceId: "bdo-2025-q3-reserves-assurance",
    publishedAt: "2025-10-31",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/6GbUTVK4tTYAytefu5daIi/6cac18eb4b526c9c52640a3d2bed9642/ISAE_3000R_-_Opinion_Tether_International_Financial_Figure_31-10-2025.pdf",
  },
  {
    sourceId: "bdo-2025-q4-reserves-assurance",
    publishedAt: "2026-01-30",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/20d2BoOAd28ZfkiQPYPjGN/4ed12f5939e1e06ee5aceccad4effbe4/ISAE_3000R_-_Opinion_Tether_International_Financial_Figure_31-12-2025.pdf",
  },
  {
    sourceId: "bdo-2026-q1-reserves-assurance",
    publishedAt: "2026-04-30",
    url: "https://assets.ctfassets.net/vyse88cgwfbl/6crn1tXbl6AtWZBWucZnfg/c4ff472d70c1b48c2f689f27b54c84f5/ISAE_3000R_-_Opinion_Tether_International_Financial_Figure_31-03-2026.pdf",
  },
] as const;

function productionUsdtOverlay(): Record<string, unknown> {
  const file = SafetyScoreV9OperationalResilienceOverlayFileSchema.parse(operationalResilienceOverlaysAsset);
  const overlay = file.overlays.find((entry) => entry.assetId === "usdt-tether");
  if (!overlay) throw new Error("Missing production USDT operational-resilience overlay");
  return structuredClone(overlay) as unknown as Record<string, unknown>;
}

describe("Safety Score v9 operational-resilience overlays", () => {
  it("loads a current, content-bound USDT overlay and excludes it outside the review window", () => {
    expect(SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", REVIEWED_AT_SEC - 1)).toBeNull();
    expect(getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", REVIEWED_AT_SEC)?.assetId).toBe(
      "usdt-tether",
    );
    expect(getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", EXPIRES_AT_SEC - 1)?.assetId).toBe(
      "usdt-tether",
    );
    expect(getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", EXPIRES_AT_SEC)).toBeNull();
    expect(getSafetyScoreV9OperationalResilienceOverlay("unknown", CURRENT_CLOCK_SEC)).toBeNull();
    expect(getSafetyScoreV9OperationalResilienceOverlayEvidence("usdt-tether", CURRENT_CLOCK_SEC)).toEqual(
      expect.objectContaining({
        reviewedAt: "2026-07-23T12:37:19Z",
        expiresAt: "2027-07-23T12:37:19Z",
        payloadSha256: SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST,
      }),
    );
  });

  it("keeps live history eligibility-only and the May 2022 redemption claim issuer-reported", () => {
    const overlay = getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", CURRENT_CLOCK_SEC);
    expect(overlay?.eligibility.liveHistory).toEqual({
      minimumLiveHistoryMonths: 120,
      observedAt: "2024-10-07",
      treatment: "eligibility-only",
      sourceIds: ["tether-2024-ten-year-milestones"],
    });
    expect(overlay?.redemptionThroughput?.cumulativeLifetimeRedeemedSupplyRatio).toBeNull();
    expect(overlay?.redemptionThroughput?.stressWindows).toEqual([
      expect.objectContaining({
        episodeKey: "terra-ust-market-stress-2022-05",
        maximumWindowDays: 7,
        redeemedUsdLowerBound: 10_000_000_000,
        redeemedSupplyRatioLowerBound: 0.12,
        settlement: { state: "settled-in-full", verification: "issuer-reported" },
        sourceIds: ["tether-2022-05-redemption-stress"],
      }),
    ]);
    const redemptionSource = overlay?.sources.find(
      (source) => source.sourceId === "tether-2022-05-redemption-stress",
    );
    expect(redemptionSource?.confidence).toBe("issuer-reported");
  });

  it("does not claim peg recovery, independently verified redemption, or an incident-free history", () => {
    const overlay = getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", CURRENT_CLOCK_SEC);
    expect(overlay?.stressEpisodes).toEqual([
      expect.objectContaining({
        episodeKey: "terra-ust-market-stress-2022-05",
        redemptionContinued: true,
        recoveredWithinSec: null,
      }),
    ]);
    expect(overlay?.incidentReview).toEqual({ state: "not-reviewed" });
    expect(JSON.stringify(overlay)).not.toContain("independently-verified-full");
  });

  it("binds all 21 signed reports without upgrading reasonable assurance to an audit", () => {
    const overlay = getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", CURRENT_CLOCK_SEC);
    expect(overlay?.reserveReconciliation).toEqual(
      expect.objectContaining({
        firstReportPeriodEnd: "2021-03-31",
        latestReportPeriodEnd: "2026-03-31",
        observedReportHistoryMonths: 60,
        reportedCadence: "quarterly",
        continuityEvidence: "independently-verified",
        missedMaterialPeriods: 0,
        historySourceIds: USDT_ASSURANCE_LEDGER.map((source) => source.sourceId),
        latestAssurance: {
          level: "reasonable-assurance",
          standard: "ISAE 3000 (Revised)",
          periodEnd: "2026-03-31",
          sourceIds: ["bdo-2026-q1-reserves-assurance"],
        },
      }),
    );
    const historySources = overlay?.reserveReconciliation?.historySourceIds.map((sourceId) => {
      const source = overlay.sources.find((candidate) => candidate.sourceId === sourceId);
      return source && {
        sourceId: source.sourceId,
        publishedAt: source.publishedAt,
        url: source.url,
      };
    });
    expect(historySources).toEqual(USDT_ASSURANCE_LEDGER);
    expect(
      overlay?.reserveReconciliation?.historySourceIds.includes("tether-2024-ten-year-milestones"),
    ).toBe(false);
    expect(
      historySources?.every((source) => {
        const record = overlay?.sources.find((candidate) => candidate.sourceId === source?.sourceId);
        return record?.confidence === "independent-assurance";
      }),
    ).toBe(true);
    const latestSource = overlay?.sources.find((source) => source.sourceId === "bdo-2026-q1-reserves-assurance");
    expect(latestSource?.confidence).toBe("independent-assurance");
    expect(overlay?.sources.some((source) => source.confidence === "audited")).toBe(false);
  });

  it("rejects uncited claims, mismatched confidence, endpoint-span inflation, and unknown fields", () => {
    const missingSource = productionUsdtOverlay();
    (
      (
        (missingSource.redemptionThroughput as Record<string, unknown>).stressWindows as Array<
          Record<string, unknown>
        >
      )[0].sourceIds as string[]
    )[0] = "missing-source";
    expect(() => SafetyScoreV9OperationalResilienceOverlaySchema.parse(missingSource)).toThrow(
      /Unknown operational-resilience sourceId/,
    );

    const fabricatedIndependentSettlement = productionUsdtOverlay();
    const stressWindow = (
      (fabricatedIndependentSettlement.redemptionThroughput as Record<string, unknown>).stressWindows as Array<
        Record<string, unknown>
      >
    )[0];
    stressWindow.settlement = { state: "settled-in-full", verification: "independently-verified" };
    expect(() => SafetyScoreV9OperationalResilienceOverlaySchema.parse(fabricatedIndependentSettlement)).toThrow(
      /independently-verified source/,
    );

    const inflatedHistory = productionUsdtOverlay();
    (inflatedHistory.reserveReconciliation as Record<string, unknown>).observedReportHistoryMonths = 120;
    expect(() => SafetyScoreV9OperationalResilienceOverlaySchema.parse(inflatedHistory)).toThrow(
      /60-month endpoint span/,
    );

    const misclassifiedAudit = productionUsdtOverlay();
    (
      (misclassifiedAudit.reserveReconciliation as Record<string, unknown>).latestAssurance as Record<string, unknown>
    ).level = "audit";
    expect(() => SafetyScoreV9OperationalResilienceOverlaySchema.parse(misclassifiedAudit)).toThrow(
      /matching independent confidence/,
    );

    const unknownField = productionUsdtOverlay();
    unknownField.marketCapBonus = 10;
    expect(() => SafetyScoreV9OperationalResilienceOverlaySchema.parse(unknownField)).toThrow();

    const hiddenNoIncidentClaim = productionUsdtOverlay();
    hiddenNoIncidentClaim.incidentReview = { state: "not-reviewed", incidents: [] };
    expect(() => SafetyScoreV9OperationalResilienceOverlaySchema.parse(hiddenNoIncidentClaim)).toThrow();

    const uncitedLifetimeRatio = productionUsdtOverlay();
    (
      uncitedLifetimeRatio.redemptionThroughput as Record<string, unknown>
    ).cumulativeLifetimeRedeemedSupplyRatio = 0.5;
    expect(() => SafetyScoreV9OperationalResilienceOverlaySchema.parse(uncitedLifetimeRatio)).toThrow(
      /ratio and its evidence sources/,
    );
  });

  it("rejects duplicate assets and invalid clocks", () => {
    const duplicateFile = structuredClone(operationalResilienceOverlaysAsset);
    duplicateFile.overlays.push(structuredClone(duplicateFile.overlays[0]));
    expect(() => SafetyScoreV9OperationalResilienceOverlayFileSchema.parse(duplicateFile)).toThrow(
      /Duplicate operational-resilience overlay assetId/,
    );
    expect(() => getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", Number.NaN)).toThrow(
      /clock must be finite/,
    );
  });
});
