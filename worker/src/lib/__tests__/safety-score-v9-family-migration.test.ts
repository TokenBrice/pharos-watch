import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { SafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";

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
    }],
  },
}));

import {
  buildSafetyScoreV9MechanismReview,
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
