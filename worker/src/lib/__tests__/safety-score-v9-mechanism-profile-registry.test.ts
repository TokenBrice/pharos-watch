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

vi.mock("@shared/data/safety-score-v9/mechanism-review-overlays-v1.json", () => ({
  default: { schemaVersion: 1, note: "Profile-driven overlay fixture.", overlays: [profileOverlay] },
}));

import {
  getSafetyScoreV9MechanismExitFacts,
  getSafetyScoreV9MechanismReviewedUnavailableComponents,
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
