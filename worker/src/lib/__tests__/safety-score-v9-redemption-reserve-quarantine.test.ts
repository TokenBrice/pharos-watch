import { describe, expect, it } from "vitest";
import type { PipelineGapByAssetId } from "@shared/lib/report-cards-fixed-input-identity";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { findV9CauseEvidenceBindingIssues } from "@shared/lib/safety-score-v9/evidence";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import type { V9EvidenceCauseScope, V9EvidenceGapClassification } from "@shared/types/safety-score-v9-causes";
import type { RedemptionReserveQuarantineReason } from "../accepted-reserve-generation";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import {
  captureRedemptionReserveQuarantine, resolveRedemptionReserveQuarantineCause,
} from "../safety-score-v9/redemption-reserve-quarantine";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const ASSET = "usdc-circle";
const CLOCK_SEC = Date.UTC(2026, 6, 13) / 1000;
const MESSAGE = "The redemption row consumed reserve evidence whose source freshness is not scoring-eligible.";

type QuarantineEntry = PipelineGapByAssetId[string][number];

function quarantineEntry(reason: RedemptionReserveQuarantineReason = "freshness-unverified"): QuarantineEntry {
  const original = makeV9FixedInput({ assetId: ASSET, clockSec: CLOCK_SEC });
  return captureRedemptionReserveQuarantine({
    assetId: ASSET, redemptionGenerationId: original.redemptionGenerationId,
    routeFamily: getRedemptionBackstopConfig(ASSET)!.routeFamily, reason, clockSec: original.clockSec,
  });
}

function compile(quarantined: boolean, entry: QuarantineEntry = quarantineEntry()) {
  const original = makeV9FixedInput({ assetId: ASSET, clockSec: CLOCK_SEC });
  const fixed = normalizeFixedInput({
    ...original, baseInputGenerationId: undefined,
    ...(quarantined ? { pipelineGapByAssetId: { [ASSET]: [entry] } } : {}),
  });
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, makeV9Extension({
    assetId: ASSET, clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint,
  }));
  return { compiled, quarantine: entry };
}

function resolve(entry: QuarantineEntry, authoredClassifications?: readonly V9EvidenceGapClassification[]) {
  return resolveRedemptionReserveQuarantineCause({
    assetId: ASSET, scope: entry.verdict.scope, asOfSec: CLOCK_SEC, captured: entry, authoredClassifications,
  });
}

function authoredCapacityProof(scope: V9EvidenceCauseScope, overrides: Record<string, unknown> = {}) {
  return {
    id: "fixture-redemption-capacity-nondisclosure",
    assetId: ASSET,
    scope,
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
    ...overrides,
  } as V9EvidenceGapClassification;
}

describe("redemption rows quarantined for inadmissible consumed reserve evidence", () => {
  it("keeps a producer-failed redemption rail instead of reading the withheld row as an absent route", () => {
    // A documented channel without a captured row remains diagnostic, not absent.
    // Only the consumed-reserve quarantine may attribute its capacity gap to A.
    const baseline = compile(false).compiled.assets[0]!;
    const baselineRoute = baseline.exitRoutes.find((route) => route.lane === "redemption")!;
    expect(baselineRoute).toMatchObject({ coverageClass: "diagnostic", scoreEligible: false, capacityCurve: [] });
    const baselineGap = baseline.gaps.find((gap) => baselineRoute.factorStatuses.capacity!.gapIds.includes(gap.gapId))!;
    expect(baselineGap).toMatchObject({ responsibility: "unresearched", causeProof: { cause: "U" } });

    const { compiled, quarantine } = compile(true);
    const asset = compiled.assets[0]!;
    const route = asset.exitRoutes.find((candidate) => candidate.lane === "redemption")!;
    expect(route).toMatchObject({ coverageClass: "diagnostic", scoreEligible: false, capacityCurve: [] });
    expect(route.status.observationState).toBe("missing");
    const gap = asset.gaps.find((candidate) => route.factorStatuses.capacity!.gapIds.includes(candidate.gapId))!;
    expect(gap).toMatchObject({
      responsibility: "producer-failed",
      causeProof: { cause: "A", producerState: "producer-failed", rejectionCode: "redemption-reserve-input-freshness-unverified" },
    });
    expect(asset.evidence.find((row) => row.evidenceId === quarantine.evidence.evidenceId)).toEqual(quarantine.evidence);

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.exit.causeGapIds).toContain(gap.gapId);
  });

  it("keeps the captured producer failure and its machine-readable reason when no proof is authored", () => {
    const quarantine = quarantineEntry();
    expect(resolve(quarantine)).toEqual({
      causeProof: quarantine.verdict.proof,
      responsibility: "producer-failed",
      evidenceReferences: [quarantine.evidence],
      message: MESSAGE,
    });
    expect(resolve(quarantine, []).causeProof).toEqual(quarantine.verdict.proof);
  });

  it("moves the rail to the issuer cause only with a current authored C proof for the same datum", () => {
    const quarantine = quarantineEntry();
    const resolved = resolve(quarantine, [authoredCapacityProof(quarantine.verdict.scope)]);
    expect(resolved.causeProof).toMatchObject({
      cause: "C", classificationId: "fixture-redemption-capacity-nondisclosure",
      assertion: "researched-nondisclosure", reviewedAt: "2026-07-12T00:00:00Z",
    });
    expect(resolved.responsibility).toBe("issuer-undisclosed");
    // The producer rejection reason survives the reclassification.
    expect(resolved.message).toBe(MESSAGE);
    expect(resolved.diagnostics).toBeUndefined();
    expect(resolved.evidenceReferences.map((reference) => reference.disposition)).toEqual(["rejected", "published"]);

    // The authored proof binds its own evidence bytes and admits the withheld read.
    const gap = createV9FactGapV3({
      gapId: `${ASSET}:gap:route:${quarantine.verdict.scope.routeKey}:capacity`,
      reasonCode: "missing-runtime-route-evidence", ownerDomain: "exit", policyRuleId: "v9.exit.same-notional-route",
      observationState: "missing", responsibility: resolved.responsibility,
      path: { kind: "optional-exit", routeKey: quarantine.verdict.scope.routeKey! },
      message: resolved.message, evidenceRefIds: resolved.evidenceReferences.map((reference) => reference.evidenceId),
      causeScope: quarantine.verdict.scope, causeProof: resolved.causeProof,
    });
    expect(findV9CauseEvidenceBindingIssues({
      assetId: ASSET, gaps: [gap], evidence: [...resolved.evidenceReferences],
    })).toEqual([]);
  });

  it("keeps the producer failure for a superseded live-reserve configuration even with a C proof", () => {
    const quarantine = quarantineEntry("config-mismatch");
    const resolved = resolve(quarantine, [authoredCapacityProof(quarantine.verdict.scope)]);
    expect(resolved.causeProof).toEqual(quarantine.verdict.proof);
    expect(resolved.responsibility).toBe("producer-failed");
  });

  it.each([
    {
      name: "an expired review",
      classification: (scope: V9EvidenceCauseScope) => authoredCapacityProof(scope, {
        reviewedAt: "2025-06-01T00:00:00Z",
        sources: [{ url: "https://issuer.example/redemption-terms", observedAt: "2025-05-30T00:00:00Z",
          datumAsOf: "2025-05-30", location: "Redemption flow", excerpt: "Issuer redemption is available.",
          assertion: "No funded same-notional capacity or queue depth is published." }],
      }),
      diagnostic: true,
    },
    {
      name: "a future-dated review",
      classification: (scope: V9EvidenceCauseScope) => authoredCapacityProof(scope, { reviewedAt: "2026-07-14T00:00:00Z" }),
      diagnostic: true,
    },
    {
      name: "a source dated after its review",
      classification: (scope: V9EvidenceCauseScope) => authoredCapacityProof(scope, {
        sources: [{ url: "https://issuer.example/redemption-terms", observedAt: "2026-07-13T00:00:00Z",
          datumAsOf: "2026-07-11", location: "Redemption flow", excerpt: "Issuer redemption is available.",
          assertion: "No funded same-notional capacity or queue depth is published." }],
      }),
      diagnostic: false,
    },
    {
      name: "another datum's proof",
      classification: (scope: V9EvidenceCauseScope) => authoredCapacityProof({ ...scope, factorKey: "cost", requiredDatum: "cost" }),
      diagnostic: false,
    },
    {
      name: "a public-data classification",
      classification: (scope: V9EvidenceCauseScope) => ({
        id: "fixture-redemption-capacity-public", assetId: ASSET, scope, cause: "B",
        assertion: "required-data-public", reviewedAt: "2026-07-12T00:00:00Z", reviewer: "fixture-reviewer",
        sources: [{ url: "https://issuer.example/redemption-terms", observedAt: "2026-07-11T00:00:00Z",
          datumAsOf: "2026-07-11", location: "Redemption flow", excerpt: "Issuer redemption is available.",
          assertion: "The exact capacity datum is public." }],
      } as unknown as V9EvidenceGapClassification),
      diagnostic: false,
    },
  ])("keeps the captured A proof and reason for $name", ({ classification, diagnostic }) => {
    const quarantine = quarantineEntry();
    const resolved = resolve(quarantine, [classification(quarantine.verdict.scope)]);
    expect(resolved.causeProof).toEqual(quarantine.verdict.proof);
    expect(resolved.responsibility).toBe("producer-failed");
    expect(resolved.message).toBe(MESSAGE);
    expect(resolved.evidenceReferences).toEqual([quarantine.evidence]);
    if (diagnostic) {
      expect(resolved.diagnostics).toContainEqual(expect.objectContaining({
        code: "cause-proof-conversion-failed", scope: quarantine.verdict.scope,
      }));
    } else {
      expect(resolved.diagnostics).toBeUndefined();
    }
  });

  it("keeps the producer failure when authored classifications conflict for the same datum", () => {
    const quarantine = quarantineEntry();
    const resolved = resolve(quarantine, [
      authoredCapacityProof(quarantine.verdict.scope),
      authoredCapacityProof(quarantine.verdict.scope, { id: "fixture-conflicting-capacity" }),
    ]);
    expect(resolved.causeProof).toEqual(quarantine.verdict.proof);
    expect(resolved.responsibility).toBe("producer-failed");
    expect(resolved.diagnostics).toEqual([expect.objectContaining({ code: "cause-proof-conversion-failed" })]);
  });
});
