import { describe, expect, it } from "vitest";
import { buildSafetyScoreV9AccessClaimGraph } from "../safety-score-v9/extension-access-lookthrough";
import { ReviewEvidenceBuilder } from "../safety-score-v9/extension-shared";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { makeAccessReview } from "@shared/lib/__tests__/safety-score-v9-access-lookthrough.test-support";
import { makeV9Extension, makeV9FixedInput, makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import { alphaMeta, metaMap } from "./safety-score-v9-fact-set.test-support";
import { computeSafetyScoreV9ReserveExposureKey } from "../safety-score-v9/fact-set-schema";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { resolveCauseGapId } from "@shared/types/safety-score-v9-public-cause-gaps";

function compiledGraph(clockSec: number, reviewedAt: string) {
  return buildSafetyScoreV9AccessClaimGraph({ assetId: "alpha", clockSec, generationId: "fixture-generation", evidence: new ReviewEvidenceBuilder("alpha", clockSec), review: makeAccessReview("alpha", reviewedAt) })!;
}
describe("access claim graph compiler", () => {
  it("admits exact receipt identities while leaving reserve proportions unpriced", () => {
    const graph = compiledGraph(Date.parse("2026-06-01T00:00:00Z") / 1000, "2026-01-01T00:00:00Z");
    expect(graph.edges.filter((edge) => edge.basis.kind === "reserve-position").map((edge) => edge.weight)).toEqual([null, null, null]);
    expect(graph.edges.filter((edge) => edge.basis.kind === "serial-claim").map((edge) => edge.weight)).toEqual([1, 1]);
    expect(graph.authorities[0]!.actingDeployment).toEqual({ chainId: "ethereum", claimAddress: "claim:token" });
  });
  it("uses the existing expiry clock at the exact boundary and rejects future evidence without backdating", () => {
    const start = Date.parse("2025-01-01T00:00:00Z") / 1000;
    expect(compiledGraph(start + V9_ACCESS_EVIDENCE_MAX_AGE_SEC, "2025-01-01T00:00:00Z").nodes[0]!.status.observationState).toBe("known");
    expect(compiledGraph(start + V9_ACCESS_EVIDENCE_MAX_AGE_SEC + 1, "2025-01-01T00:00:00Z").nodes[0]!.status.observationState).toBe("stale");
    const future = compiledGraph(start - 1, "2025-01-01T00:00:00Z");
    expect(future.nodes[0]!.status.evidenceRefIds).toEqual([]);
    expect(future.unresolved.map((branch) => branch.reason)).toContain("future-dated");
  });
  it("does not worsen numeric scores or parent caps when partial reviewed facts are authored", () => {
    const fixed = makeV9FixedInput();
    const extension = makeV9Extension({ clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
    const before = buildSafetyScoreV9Candidate({ fixedInput: fixed, extension, publishedAtSec: fixed.clockSec });
    const evidence = new ReviewEvidenceBuilder("alpha", fixed.clockSec);
    const review = makeAccessReview("alpha", new Date((fixed.clockSec - 100) * 1000).toISOString());
    for (const edge of review.edges) if (edge.basis.kind === "reserve-position") edge.basis = { kind: "selected-observation" };
    review.unresolved.push({ branchKey: "origin-disclosure", nodeKey: "token", reason: "issuer-undisclosed", responsibility: "issuer-undisclosed", review: { ...review.nodes[0]!.review, responsibility: "issuer-undisclosed" } });
    extension.assets[0]!.accessReview!.freeze.claimGraph = buildSafetyScoreV9AccessClaimGraph({ assetId: "alpha", clockSec: fixed.clockSec, generationId: fixed.baseInputGenerationId, evidence, review });
    const built = evidence.finish();
    extension.assets[0]!.researchEvidence.push(...built.researchEvidence);
    extension.assets[0]!.componentEvidence.push(...built.componentEvidence);
    const after = buildSafetyScoreV9Candidate({ fixedInput: fixed, extension, publishedAtSec: fixed.clockSec });
    expect(before.quarantines).toEqual([]); expect(after.quarantines).toEqual([]);
    const old = before.candidate.cards[0]!, card = after.candidate.cards[0]!;
    expect(old.score).not.toBeNull();
    expect(card.score).toBe(old.score);
    for (const pillar of ["backing", "exit", "control"] as const) {
      const { causeGapRefs: _newRefs, ...actual } = card.pillars[pillar];
      const { causeGapRefs: _oldRefs, ...expected } = old.pillars[pillar];
      expect(actual).toEqual(expected);
      expect((card.pillars[pillar].causeGapRefs ?? []).map((ref) => resolveCauseGapId(after.candidate, card, ref)))
        .toEqual((old.pillars[pillar].causeGapRefs ?? []).map((ref) => resolveCauseGapId(before.candidate, old, ref)));
    }
    expect(card.bindingCap).toEqual(old.bindingCap);
    expect(card.accessPosture).toMatchObject({ transfer: "permissionless", freezeExposure: "upstream", freezeLookthrough: { diagnosticOnly: true, coverageState: "incomplete", knownAdverseReachShare: null, unresolvedCoverageShare: null } });
    expect(card.accessPosture.freezeLookthrough!.authorities[0]!.authorityKey).toBe("origin:freeze");
    const queue = buildV9EvidenceGapQueue({ factSet: after.compiledFacts, policy: V9_CANDIDATE_POLICY_V1 });
    expect(queue.entries.find((entry) => entry.gapId.includes("origin-disclosure"))).toMatchObject({
      responsibility: "unresearched",
    });
    expect(after.compiledFacts.assets[0]!.gaps.find((gap) => gap.gapId.includes("origin-disclosure"))!.causeProof.cause).toBe("U");
  });
  it("quantifies only a matched admitted current portfolio, not standing structure or a mismatched position", () => {
    const rows = makeV9FixedInput().liveReserveMap.alpha!;
    const fixed = makeV9FixedInput({ omitLiveReserve: true });
    const extension = makeV9Extension({ clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
    const asset = extension.assets[0]!;
    asset.reviewedStaticReserveRows = { rows, evidenceClass: "static-validated", provenance: "curated", sourceKind: "portfolio-observation", scopeId: "portfolio" };
    asset.reserveScopeAdmissions = [{ kind: "portfolio-observation", scopeId: "portfolio", liabilityBookKey: "book", deploymentRefs: [], admitted: true, rejectionCodes: [], currentLiabilityShare: null, wholeAssetComposition: true, observedAtSec: fixed.clockSec - 100, evidenceRefIds: [] }];
    const review = makeAccessReview("alpha", new Date((fixed.clockSec - 100) * 1000).toISOString());
    review.nodes = review.nodes.filter((node) => node.nodeKey === "root" || node.nodeKey === "token");
    review.edges = [{ ...review.edges[1]!, basis: { kind: "reserve-position", exposureKey: computeSafetyScoreV9ReserveExposureKey(rows[0]!), sourceKey: null } }];
    review.partitions = review.partitions.filter((partition) => partition.nodeKey === "root");
    const evidence = new ReviewEvidenceBuilder("alpha", fixed.clockSec);
    evidence.add({ componentKeys: ["reviewed-static-reserves"], sourceId: "fixture.reviewed-portfolio", reviewedAt: new Date((fixed.clockSec - 100) * 1000).toISOString(), sources: [{ label: "Fixture portfolio", url: "https://example.com/portfolio" }], payload: rows, maxAgeSec: 500 });
    asset.accessReview!.freeze.claimGraph = buildSafetyScoreV9AccessClaimGraph({ assetId: "alpha", clockSec: fixed.clockSec, generationId: fixed.baseInputGenerationId, evidence, review });
    const built = evidence.finish();
    asset.researchEvidence.push(...built.researchEvidence); asset.componentEvidence.push(...built.componentEvidence);
    const run = () => buildSafetyScoreV9Candidate({ fixedInput: fixed, extension, publishedAtSec: fixed.clockSec });
    const admitted = run();
    expect(admitted.quarantines).toEqual([]);
    expect(admitted.candidate.cards[0]!.accessPosture.freezeLookthrough!.knownAdverseReachShare).toBe(1);
    asset.reserveScopeAdmissions![0]!.kind = "standing-structure";
    expect(run().candidate.cards[0]!.accessPosture.freezeLookthrough!.knownAdverseReachShare).toBeNull();
    asset.reserveScopeAdmissions![0]!.kind = "portfolio-observation";
    const edge = asset.accessReview!.freeze.claimGraph!.edges[0]!;
    edge.basis = { kind: "reserve-position", exposureKey: computeSafetyScoreV9ReserveExposureKey(rows[0]!), sourceKey: "wrong-position" };
    const rejected = run();
    expect(rejected.quarantines).toEqual([]);
    expect(rejected.candidate.cards[0]!.accessPosture.freezeExposure).toBe("unknown");
    expect(rejected.candidate.cards[0]!.accessPosture.freezeLookthrough!.authorities).toEqual([]);
  });
  it.each(["syzusd-yuzu", "xdai-gnosis", "nusd-nexus", "nxusd-nereus"])("keeps %s claim-scope boundaries in a synthetic compiler scenario", (assetId) => {
    const fixed = makeV9FixedInput({ assetId });
    const extension = makeV9Extension({ assetId, clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
    const review = makeAccessReview(assetId, new Date((fixed.clockSec - 100) * 1000).toISOString());
    for (const edge of review.edges) if (edge.basis.kind === "reserve-position") edge.basis = { kind: "selected-observation" };
    if (assetId === "xdai-gnosis") review.authorities[0]!.actingDeployment.chainId = "solana";
    if (assetId === "nusd-nexus") {
      const leaf = review.nodes.find((node) => node.nodeKey === "clean")!;
      leaf.noCurrentReach = false;
      review.authorities.push({ ...review.authorities[0]!, authorityKey: "second-origin:freeze", nodeKey: leaf.nodeKey, actingDeployment: leaf.identity });
    }
    if (assetId === "nxusd-nereus") {
      const receipt = review.edges.find((edge) => edge.edgeKey === "receipt-bridge")!;
      if (receipt.basis.kind === "serial-claim") receipt.basis.entireClaim = false;
    }
    if (assetId === "syzusd-yuzu") review.unresolved.push({ branchKey: "satellite-scope", nodeKey: "root", reason: "scope-unreconciled", responsibility: "integration-missing", review: review.nodes[0]!.review });
    const evidence = new ReviewEvidenceBuilder(assetId, fixed.clockSec);
    const asset = extension.assets[0]!;
    asset.accessReview!.freeze.claimGraph = buildSafetyScoreV9AccessClaimGraph({ assetId, clockSec: fixed.clockSec, generationId: fixed.baseInputGenerationId, evidence, review });
    const built = evidence.finish(); asset.researchEvidence.push(...built.researchEvidence); asset.componentEvidence.push(...built.componentEvidence);
    const result = buildSafetyScoreV9Candidate({ fixedInput: fixed, extension, publishedAtSec: fixed.clockSec });
    expect(result.quarantines).toEqual([]);
    const card = result.candidate.cards[0]!;
    expect(card.accessPosture.transfer).toBe("permissionless");
    expect(card.accessPosture.freezeLookthrough!.unresolvedCoverageShare).toBeNull();
    expect(card.accessPosture.freezeLookthrough!.coverageState).toBe("incomplete");
    if (assetId === "xdai-gnosis") {
      expect(card.accessPosture.freezeExposure).toBe("unknown");
      expect(card.accessPosture.freezeLookthrough!.authorities).toEqual([]);
      expect(card.accessPosture.freezeLookthrough!.unresolved.some((row) => row.reason === "deployment-mismatch")).toBe(true);
    } else {
      expect(card.accessPosture.freezeExposure).toBe("upstream");
      expect(card.accessPosture.freezeLookthrough!.authorities.map((row) => row.authorityKey)).toEqual(assetId === "nusd-nexus" ? ["origin:freeze", "second-origin:freeze"] : ["origin:freeze"]);
    }
  });
  it("does not add a raw reserve upstream alongside a reviewed claim graph", () => {
    const fixed = makeV9TwoAssetFixedInput();
    const reviewedAt = new Date((fixed.clockSec - 100) * 1000).toISOString();
    const blacklistReview = {
      reviewedStatus: "inherited" as const,
      evidence: "Reviewed inherited reserve exposure.",
      reviewer: "Fixture reviewer",
      reviewedAt: "1970-01-01",
      sources: [{ label: "Reserve access review", url: "https://example.com/reserve-access" }],
    };
    const metaById = metaMap(
      alphaMeta({
        blacklistabilityReview: blacklistReview,
        reserves: [{ name: "Beta reserve", pct: 100, risk: "low", coinId: "beta" }],
      }),
      alphaMeta({ id: "beta", blacklistabilityReview: { ...blacklistReview, reviewedStatus: true } }),
    );
    const review = makeAccessReview("alpha", reviewedAt);
    for (const edge of review.edges) if (edge.basis.kind === "reserve-position") edge.basis = { kind: "selected-observation" };
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById,
      registryFingerprint: fixed.registryFingerprint,
      accessClaimGraphReviews: new Map([["alpha", review]]),
    });
    const result = buildSafetyScoreV9Candidate({ fixedInput: fixed, extension, publishedAtSec: fixed.clockSec });
    expect(result.quarantines).toEqual([]);
    const access = result.compiledFacts.assets.find((asset) => asset.assetId === "alpha")!.accessReview;
    expect(access.freeze.structuralDisposition).toBe("inherited-untracked-upstream");
    expect(access.freeze.reviews[0]).toMatchObject({ upstreamAssetId: null, failureDomains: [] });
    const posture = result.candidate.cards.find((card) => card.id === "alpha")!.accessPosture;
    expect(posture.freezeExposure).toBe("upstream");
    expect(posture.freezeLookthrough!.authorities.map((authority) => authority.authorityKey)).toEqual(["origin:freeze"]);
    expect(posture.freezeLookthrough!.knownAdverseReachShare).toBeNull();
  });
  it("isolates a malformed receiving graph without synthetic active upstream assets", () => {
    const fixed = makeV9TwoAssetFixedInput();
    const review = makeAccessReview("alpha", new Date((fixed.clockSec - 100) * 1000).toISOString());
    review.edges[0]!.toNodeKey = "missing-target";
    const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(alphaMeta(), alphaMeta({ id: "beta" })), registryFingerprint: fixed.registryFingerprint, accessClaimGraphReviews: new Map([["alpha", review]]) });
    expect(extension.assets.find((asset) => asset.assetId === "alpha")!.admissionQuarantine).toMatchObject({ path: "accessReview" });
    expect(extension.assets.find((asset) => asset.assetId === "beta")!.admissionQuarantine).toBeUndefined();
  });
});
