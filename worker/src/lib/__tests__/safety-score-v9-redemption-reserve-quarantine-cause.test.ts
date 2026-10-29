import { describe, expect, it, vi } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { captureRedemptionReserveQuarantine } from "../safety-score-v9/redemption-reserve-quarantine";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const ASSET = "usdc-circle";
const CLOCK_SEC = Date.UTC(2026, 6, 13) / 1000;
const ROUTE_FAMILY = getRedemptionBackstopConfig(ASSET)!.routeFamily;
const MESSAGE = "The redemption row consumed reserve evidence whose source freshness is not scoring-eligible.";

const authoredState = vi.hoisted(() => ({ enabled: false }));
const authoredCapacityClassification = vi.hoisted(() => ({
  id: "fixture-redemption-capacity-nondisclosure",
  assetId: "usdc-circle",
  scope: {
    pillar: "exit", componentKey: "exit-route", factorKey: "capacity",
    routeKey: "redemption:redemption-backstops-unavailable:redemption:usdc-circle:offchain-issuer",
    exposureId: null, requiredDatum: "capacity",
  },
  cause: "C",
  assertion: "researched-nondisclosure",
  reviewedAt: "2026-07-12T00:00:00Z",
  reviewer: "fixture-reviewer",
  rationale: "The issuer publishes holder terms but no funded same-notional redemption capacity.",
  searchedSurfaces: ["https://issuer.example/redemption-terms"],
  sources: [{
    url: "https://issuer.example/redemption-terms",
    observedAt: "2026-07-11T00:00:00Z",
    datumAsOf: "2026-07-11",
    location: "Redemption flow",
    excerpt: "Issuer redemption is available through the issuer portal.",
    assertion: "No funded same-notional capacity or queue depth is published.",
  }],
}));

vi.mock("../safety-score-v9/fact-set-context", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    evidenceGapClassificationsFor: () => (authoredState.enabled ? [authoredCapacityClassification] : []),
  };
});

function compileWithQuarantine() {
  const original = makeV9FixedInput({ assetId: ASSET, clockSec: CLOCK_SEC });
  const quarantine = captureRedemptionReserveQuarantine({
    assetId: ASSET, redemptionGenerationId: original.redemptionGenerationId,
    routeFamily: ROUTE_FAMILY, reason: "freshness-unverified", clockSec: original.clockSec,
  });
  const fixed = normalizeFixedInput({
    ...original, baseInputGenerationId: undefined, pipelineGapByAssetId: { [ASSET]: [quarantine] },
  });
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, makeV9Extension({
    assetId: ASSET, clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint,
  }));
  const asset = compiled.assets[0]!;
  const route = asset.exitRoutes.find((candidate) => candidate.lane === "redemption")!;
  const gap = asset.gaps.find((candidate) => route.factorStatuses.capacity!.gapIds.includes(candidate.gapId))!;
  return { compiled, asset, route, gap };
}

describe("redemption reserve quarantine cause resolution at compile time", () => {
  it("carries an authored C proof to the compiled exit rail", () => {
    authoredState.enabled = true;
    const { compiled, asset, route, gap } = compileWithQuarantine();
    expect(gap).toMatchObject({
      responsibility: "issuer-undisclosed",
      causeProof: { cause: "C", classificationId: "fixture-redemption-capacity-nondisclosure" },
    });
    expect(gap.message).toBe(MESSAGE);
    expect(route).toMatchObject({ coverageClass: "diagnostic", scoreEligible: false, capacityCurve: [] });
    expect(asset.evidence.some((reference) => reference.sourceId === "evidence-gap-classifications-v1")).toBe(true);
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.exit.causeGapIds).toContain(gap.gapId);
  });

  it("keeps the compiled producer-failed A rail when no proof is authored", () => {
    authoredState.enabled = false;
    const { route, gap } = compileWithQuarantine();
    expect(gap).toMatchObject({
      responsibility: "producer-failed",
      causeProof: { cause: "A", producerState: "producer-failed", rejectionCode: "redemption-reserve-input-freshness-unverified" },
    });
    expect(gap.message).toBe(MESSAGE);
    expect(route).toMatchObject({ coverageClass: "diagnostic", scoreEligible: false, capacityCurve: [] });
  });
});
