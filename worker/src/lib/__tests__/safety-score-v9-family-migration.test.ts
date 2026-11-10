import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { SafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";

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
  default: {
    schemaVersion: 1,
    note: "Synthetic native-family admission fixture; no catalog evidence is authored.",
    overlays: [{
      assetId: "fixture-position",
      archetype: "protocol-position",
      reviewedAt: "2026-10-01",
      sources: [{ label: "Exact deployed module and liability disclosures", url: "https://example.com/module" }],
      notes: "Current exact module claim; endogenous residuals and full liability denominator unresolved.",
      metrics: {},
      components: {
        holderClaim: { quality: "limited" },
        liabilityConservation: { applicability: "unavailable", rationale: "Searched exact module inventory; complete external assets and matching liabilities are not disclosed.", sourceUrl: "https://example.com/module" },
        encumbranceAndAllocation: { applicability: "unavailable", rationale: "Historical modules and own-token claims remain unreconciled; no exclusive allocation is established.", sourceUrl: "https://example.com/module" },
      },
    }, profileOverlay, timestampOverlay],
  },
}));

import {
  buildSafetyScoreV9MechanismReview,
  getSafetyScoreV9MechanismComponentEvidence,
  getSafetyScoreV9MechanismExitFacts,
  getSafetyScoreV9MechanismOverlayEvidence,
  getSafetyScoreV9MechanismReviewedUnavailableComponents,
  getSafetyScoreV9MechanismReviewGapDisposition,
  hasAdmittedSafetyScoreV9NativeFamily,
} from "../safety-score-v9/extension-mechanism";

const reviewDay = Date.parse("2026-10-01T00:00:00Z") / 1_000;
const clockSec = reviewDay + 86_400;
const input = (clock = clockSec) => ({ clockSec: clock, liveReserveMap: {}, liveReserveProvenanceMap: {} }) as SafetyScoreV9CompilerInput;
const identity = {
  disposition: "resolved" as const,
  reviewedAt: "2026-10-01",
  reviewer: "Fixture exact-token reviewer",
  rationale: "Current exact deployed token holder claim established from pinned primary code and external corroboration.",
  sources: [{ label: "Exact token and claim binding", url: "https://example.com/exact-token" }],
};

// This is a proposed-cohort fixture, not data authoring or an assertion that the
// later catalog wave has already migrated these members.
const mentoReserveIds = [
  "audm-mento", "cadm-mento", "brlm-mento", "kesm-mento", "copm-mento",
  "zarm-mento", "xofm-mento", "ghsm-mento", "cusd-celo", "ceur-celo",
];

describe("native-family identity and evidence admission", () => {
  it("isolates an unresolved member while charging the same unproved shared ledger across the identified cohort", () => {
    const metas = mentoReserveIds.map((id) => ({
      id, mechanismArchetype: "shared-reserve" as const,
      mechanismArchetypeReview: { ...identity, rationale: `${id}: exact current ${id === "cusd-celo" || id === "ceur-celo" ? "V3 FPMM" : "V2 Broker"} claim independently bound.` },
    }));
    const reviews = metas.map((meta) => buildSafetyScoreV9MechanismReview(input(), meta, "shared-reserve"));
    for (const review of reviews) {
      if (review?.archetype !== "shared-reserve") throw new Error("Expected identified shared-reserve review");
      expect(review.liabilityConservation).toMatchObject({ quality: null, status: { observationState: "bounded-unknown", applicability: { state: "required" } } });
      expect(review.encumbranceAndAllocation.quality).toBeNull();
      expect(review.defaultRecovery.quality).toBeNull();
    }
    const unresolved = { ...metas[0]!, mechanismArchetypeReview: { ...identity, disposition: "unresolved" as const } };
    expect(buildSafetyScoreV9MechanismReview(input(), unresolved, "shared-reserve")).toBeNull();
    expect(buildSafetyScoreV9MechanismReview(input(), metas[1]!, "shared-reserve")).toEqual(reviews[1]);
    expect(hasAdmittedSafetyScoreV9NativeFamily({ id: "unknown-symbol" } as StablecoinMeta, "shared-reserve", clockSec)).toBe(false);
    expect(hasAdmittedSafetyScoreV9NativeFamily({ id: "usdr-ring", mechanismArchetypeReview: { ...identity, disposition: "unresolved" } }, "protocol-position", clockSec)).toBe(false);
  });

  it("admits native identity only next UTC day, never after exact expiry or from a different own family", () => {
    const meta = { id: "fixture-position", mechanismArchetype: "protocol-position" as const, mechanismArchetypeReview: identity };
    const maxAge = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.mechanismOverlayMaxAgeSec;
    for (const clock of [reviewDay - 1, reviewDay, clockSec - 1, reviewDay + maxAge]) {
      expect(buildSafetyScoreV9MechanismReview(input(clock), meta, "protocol-position")).toBeNull();
    }
    for (const clock of [clockSec, reviewDay + maxAge - 1]) {
      const review = buildSafetyScoreV9MechanismReview(input(clock), meta, "protocol-position");
      if (review?.archetype !== "protocol-position") throw new Error("Expected admitted position claim");
      expect(review.holderClaim.quality).toBe("limited");
      expect(review.liabilityConservation.quality).toBeNull();
      expect(getSafetyScoreV9MechanismReviewedUnavailableComponents(meta.id, "protocol-position", clock).map((row) => row.componentKey)).toEqual(["encumbranceAndAllocation", "liabilityConservation"]);
    }
    expect(getSafetyScoreV9MechanismReviewGapDisposition(meta.id, "protocol-position", clockSec - 1)?.responsibility).toBe("method-unsupported");
    expect(getSafetyScoreV9MechanismReviewedUnavailableComponents(meta.id, "protocol-position", reviewDay + maxAge).map((row) => row.componentKey)).toEqual(["encumbranceAndAllocation", "liabilityConservation"]);
    expect(buildSafetyScoreV9MechanismReview(input(), { ...meta, mechanismArchetype: "shared-reserve" }, "protocol-position")).toBeNull();
  });

  it("leaves existing CDP admission unchanged and does not infer protocol-position from a swap or reserve total", () => {
    const cdp = { id: "fixture-cdp", mechanismArchetype: "cdp" as const };
    expect(hasAdmittedSafetyScoreV9NativeFamily(cdp, "cdp", clockSec)).toBe(true);
    expect(buildSafetyScoreV9MechanismReview(input(), cdp, "cdp")).toBeNull();
    expect(buildSafetyScoreV9MechanismReview({ ...input(), liveReserveMap: { "fixture-position": [{ name: "Unreviewed reserve total", pct: 100, risk: "low" }] } }, { id: "fixture-position" }, "protocol-position")).toBeNull();
  });
});

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
