import operationalResilienceOverlaysAsset from "@shared/data/safety-score-v9/operational-resilience-overlays-v1.json";
import { describe, expect, it } from "vitest";
import {
  getSafetyScoreV9OperationalResilienceOverlay,
  getSafetyScoreV9OperationalResilienceOverlayEvidence,
  SAFETY_SCORE_V9_OPERATIONAL_RESILIENCE_OVERLAYS_DIGEST,
  SafetyScoreV9OperationalResilienceOverlayFileSchema,
  SafetyScoreV9OperationalResilienceOverlaySchema,
} from "../safety-score-v9-extension-operational-resilience";

const REVIEWED_AT_SEC = Date.parse("2026-07-23T12:37:19Z") / 1_000;
const CURRENT_CLOCK_SEC = Date.parse("2026-07-24T00:00:00Z") / 1_000;
const EXPIRES_AT_SEC = Date.parse("2027-07-23T12:37:19Z") / 1_000;

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

  it("records a bounded BDO report span without upgrading assurance to an audit or asserting no missed periods", () => {
    const overlay = getSafetyScoreV9OperationalResilienceOverlay("usdt-tether", CURRENT_CLOCK_SEC);
    expect(overlay?.reserveReconciliation).toEqual(
      expect.objectContaining({
        firstReportPeriodEnd: "2022-06-30",
        latestReportPeriodEnd: "2026-03-31",
        observedReportHistoryMonths: 45,
        reportedCadence: "quarterly",
        continuityEvidence: "issuer-reported",
        missedMaterialPeriods: null,
        latestAssurance: {
          level: "reasonable-assurance",
          standard: "ISAE 3000 (Revised)",
          periodEnd: "2026-03-31",
          sourceIds: ["bdo-2026-q1-reserves-assurance"],
        },
      }),
    );
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
      /45-month endpoint span/,
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
