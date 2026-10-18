import { describe, expect, it, vi } from "vitest";

// The static registry carries no profile-driven overlay yet, so this suite
// mounts one through the data module seam to prove the registry-level
// projections a curated inflation-index-hybrid review will consume.
const profileOverlay = vi.hoisted(() => ({
  assetId: "cpi-hybrid-fixture",
  archetype: "algorithmic",
  reviewedAt: "2026-07-20",
  sources: [{ label: "Issuer methodology", url: "https://example.com/methodology" }],
  notes: "Profile-driven inflation-index-hybrid review fixture.",
  metrics: {},
  components: {},
  profileReview: {
    profile: "inflation-index-hybrid",
    exogenousBackingShare: 0.8,
    reflexiveBackingShare: 0.2,
    contractionCapacityRatio: 0.4,
    facts: {
      collateralCoverage: { disposition: "supported", quality: "strong" },
      contractionLiquidity: { disposition: "supported", quality: "adequate" },
      indexOracle: { disposition: "issuer-undisclosed" },
      reflexiveBackstop: { disposition: "supported", quality: "strong" },
      emergencyRecovery: { disposition: "supported", quality: "limited" },
      lossRecovery: { disposition: "supported", quality: "strong" },
      protocolRedemption: { disposition: "supported", quality: "adequate" },
    },
  },
}));

const timestampOverlay = vi.hoisted(() => ({
  assetId: "timestamp-fixture", archetype: "commodity-claim", reviewedAt: "2026-10-18T10:00:00.125Z",
  sources: [{ label: "Pinned metal claim", url: "https://example.com/claim" }],
  notes: "Exact overlay and independent component clocks.", metrics: {},
  components: {
    physicalRedemption: { quality: "adequate", review: {
      reviewedAt: "2026-10-18T12:00:00.125Z", reviewer: "Fixture reviewer", rationale: "Pinned delivery terms.",
      sources: [{ label: "Pinned metal claim", url: "https://example.com/claim" }],
    } },
    titleAndAllocation: { applicability: "unavailable", rationale: "Title evidence is undisclosed.",
      sourceUrl: "https://example.com/claim", review: {
        reviewedAt: "2026-10-18T12:00:00.125Z", reviewer: "Fixture reviewer", rationale: "Searched exact claim terms.",
        sources: [{ label: "Pinned metal claim", url: "https://example.com/claim" }],
      } },
  },
}));

vi.mock("@shared/data/safety-score-v9/mechanism-review-overlays-v1.json", () => ({
  default: { schemaVersion: 1, note: "Profile-driven overlay fixture.", overlays: [profileOverlay, timestampOverlay] },
}));

import {
  getSafetyScoreV9MechanismExitFacts,
  getSafetyScoreV9MechanismReviewedUnavailableComponents,
  buildSafetyScoreV9MechanismReview,
  getSafetyScoreV9MechanismComponentEvidence,
  getSafetyScoreV9MechanismOverlayEvidence,
  getSafetyScoreV9MechanismReviewGapDisposition,
} from "../safety-score-v9/extension-mechanism";

// One UTC day past the 2026-07-20 review date, inside the twelve-month window.
const CURRENT_SEC = Date.UTC(2026, 6, 21) / 1_000;

describe("profile-driven mechanism registry projections", () => {
  it("projects the protocol-redemption exit fact from a current profile overlay", () => {
    expect(getSafetyScoreV9MechanismExitFacts("cpi-hybrid-fixture", "algorithmic", CURRENT_SEC)).toEqual([
      { factKey: "protocol-redemption", disposition: "supported", quality: "adequate" },
    ]);
  });

  it("carries no reviewed-unavailable adjudication for a pure profile overlay", () => {
    expect(
      getSafetyScoreV9MechanismReviewedUnavailableComponents("cpi-hybrid-fixture", "algorithmic", CURRENT_SEC),
    ).toEqual([]);
  });

  it("projects nothing for same-day reviews, archetype mismatches, or unknown assets", () => {
    expect(
      getSafetyScoreV9MechanismExitFacts("cpi-hybrid-fixture", "algorithmic", Date.UTC(2026, 6, 20, 12) / 1_000),
    ).toEqual([]);
    expect(getSafetyScoreV9MechanismExitFacts("cpi-hybrid-fixture", "fiat-cash", CURRENT_SEC)).toEqual([]);
    expect(getSafetyScoreV9MechanismExitFacts("unknown-asset", "algorithmic", CURRENT_SEC)).toEqual([]);
  });
});

describe("exact-timestamp mechanism registry projections", () => {
  const overlaySec = Date.parse("2026-10-18T10:00:00.125Z") / 1_000;
  const componentSec = Date.parse("2026-10-18T12:00:00.125Z") / 1_000;
  it("admits whole-overlay evidence and history exactly at the pin, retaining component clocks", () => {
    expect(getSafetyScoreV9MechanismOverlayEvidence("timestamp-fixture", "commodity-claim", overlaySec - 0.001)).toBeNull();
    expect(getSafetyScoreV9MechanismOverlayEvidence("timestamp-fixture", "commodity-claim", overlaySec))
      .toMatchObject({ reviewedAt: timestampOverlay.reviewedAt });
    expect(getSafetyScoreV9MechanismOverlayEvidence("timestamp-fixture", "commodity-claim", overlaySec, { history: true }))
      .toMatchObject({ reviewedAt: timestampOverlay.reviewedAt });
    expect(getSafetyScoreV9MechanismComponentEvidence("timestamp-fixture", "commodity-claim", componentSec - 0.001)).toEqual([]);
    expect(getSafetyScoreV9MechanismComponentEvidence("timestamp-fixture", "commodity-claim", componentSec)).toHaveLength(2);
    expect(getSafetyScoreV9MechanismReviewGapDisposition("timestamp-fixture", "commodity-claim", componentSec)).toBeNull();
  });

  it("projects component-backed exit and nondisclosure only after their own instant", () => {
    expect(getSafetyScoreV9MechanismExitFacts("timestamp-fixture", "commodity-claim", componentSec - 0.001)).toEqual([]);
    expect(getSafetyScoreV9MechanismExitFacts("timestamp-fixture", "commodity-claim", componentSec))
      .toEqual([{ factKey: "physical-redemption", disposition: "supported", quality: "adequate" }]);
    expect(getSafetyScoreV9MechanismReviewedUnavailableComponents("timestamp-fixture", "commodity-claim", componentSec - 0.001))
      .toEqual([]);
    expect(getSafetyScoreV9MechanismReviewedUnavailableComponents("timestamp-fixture", "commodity-claim", componentSec))
      .toMatchObject([{ componentKey: "titleAndAllocation", reviewedAt: "2026-10-18T12:00:00.125Z" }]);
    const review = buildSafetyScoreV9MechanismReview(
      { clockSec: componentSec, liveReserveMap: {}, liveReserveProvenanceMap: {} } as Parameters<typeof buildSafetyScoreV9MechanismReview>[0],
      { id: "timestamp-fixture" }, "commodity-claim",
    );
    expect(review).toMatchObject({ physicalRedemption: { quality: "adequate", status: { observationState: "known" } } });
  });

  it("does not let a newer component pin extend the whole overlay's expiry", () => {
    const expirySec = overlaySec + 31_536_000;
    expect(getSafetyScoreV9MechanismExitFacts("timestamp-fixture", "commodity-claim", expirySec - 0.001)).toHaveLength(1);
    expect(getSafetyScoreV9MechanismExitFacts("timestamp-fixture", "commodity-claim", expirySec)).toEqual([]);
    expect(getSafetyScoreV9MechanismOverlayEvidence("timestamp-fixture", "commodity-claim", expirySec)).toBeNull();
    expect(getSafetyScoreV9MechanismComponentEvidence("timestamp-fixture", "commodity-claim", expirySec)).toEqual([]);
  });
});
