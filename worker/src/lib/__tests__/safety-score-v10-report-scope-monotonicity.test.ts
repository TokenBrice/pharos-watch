import { describe, expect, it } from "vitest";
import { evaluateV9Backing } from "@shared/lib/safety-score-v9/archetypes";
import { asset, exposure } from "@shared/lib/__tests__/safety-score-v9-backing.test-support";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { parseStablecoinMetaAssets } from "@shared/lib/stablecoins/schema";
import type { ProofOfReservesLatestReport } from "@shared/types/core";
import type { ReviewedEconomicDeploymentPartition } from "@shared/types/safety-score-v9-supply-attribution";
import { buildSafetyScoreV9MechanismReview } from "../safety-score-v9/extension-mechanism";
import { resolveReviewedReserveRows, type V9ExtensionRegistryMeta } from "../safety-score-v9/extension";
import { addScopedReserveEvidence, buildSafetyScoreV9ReviewedAuditedFallbackReserveRows, buildSafetyScoreV9ReviewedStaticReserveRows, buildSafetyScoreV10ScopedReserveAdmissions } from "../safety-score-v9/extension-reserves";
import type { SafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import type { ReserveObservationEnvelope } from "@shared/types/safety-score-v9-reserve-scope";
import xdaiMetaSource from "@shared/data/stablecoins/coins/xdai-gnosis.json";
import { ReviewEvidenceBuilder } from "../safety-score-v9/extension-shared";

const clockSec = Date.parse("2026-10-02T12:00:00Z") / 1000;
const asOfSec = Date.parse("2026-08-31T23:59:59Z") / 1000;
const deploymentRef = "ethereum:0x1111111111111111111111111111111111111111";
const generation = `report-cards-input:v1:${"a".repeat(64)}`;
const report: ProofOfReservesLatestReport = {
  periodEnd: "2026-08-31", publishedAt: "2026-09-28", publishedAtBasis: "signed-date-standin",
  assuranceMethod: "examination", scope: "assets-and-liabilities", liabilityReconciliation: "full",
  reviewer: "Fixture reviewer", confidence: "verified", sources: [{ label: "Report", url: "https://example.com/report" }],
};
function scopedReport(): ProofOfReservesLatestReport {
  return { ...report, coverage: {
    scopeId: "trust:august", liabilityBookKey: "issuer:trust", deploymentRefs: [deploymentRef], liabilityExclusions: [],
    denominator: { periodEnd: "2026-08-31", asOfSec, currency: "USD", unitBasis: "token-units", decimals: 18,
      totalCoveredLiabilities: "50", included: [{ identity: { deploymentRef, bookKey: "issuer:trust", account: null }, amount: "50", evidenceRefIds: ["source:report"] }],
      excluded: [], completeness: "complete", evidenceRefIds: ["source:report"], sourceSha256: "a".repeat(64) },
    reconciliationWithinScope: "full", assetsAsOfSec: asOfSec, reviewedAtSec: clockSec - 60, confidence: "verified",
  } };
}
function meta(latestReport = report, id = "scope-fixture"): V9ExtensionRegistryMeta {
  return { id, contracts: [{ chain: "ethereum", address: deploymentRef.split(":")[1], decimals: 18 }],
    reserves: [{ name: "Cash", pct: 100, risk: "very-low", assetClass: "cash", issuerOrObligor: "issuer:trust", liquidityHorizon: "immediate" }],
    reserveReview: { reviewedAt: "2026-09-30", reviewer: "Fixture reviewer", confidence: "verified", sources: report.sources,
      rationale: "Examined August composition", compositionBasis: "Report", compositionAsOf: "2026-08-31", scope: "full-composition",
      knownUnknownExposure: "None", knownUnknownExposurePct: 0 },
    proofOfReserves: { type: "independent-audit", provider: "Fixture auditor", attestorTier: "big4", url: "https://example.com/index", latestReport },
  };
}
function input(partition?: ReviewedEconomicDeploymentPartition): SafetyScoreV9CompilerInput {
  return { clockSec, baseInputGenerationId: generation, liveReserveMap: {}, liveReserveProvenanceMap: {},
    safetyScoreV9SupplyAttributionById: partition ? { "scope-fixture": partition } : {} } as unknown as SafetyScoreV9CompilerInput;
}
const partition = { model: "reviewed-economic-deployment-partition-v1", baseInputGenerationId: generation, sourceGeneration: "current-supply",
  observedAtSec: clockSec - 60, scoringClockSec: clockSec, quantitativeCompleteness: true, unattributedSupplyUsd: 0,
  aggregate: { supplyUsd: 100 }, deployments: [{ deploymentKey: deploymentRef, currentSupplyUsd: 100 }] } as ReviewedEconomicDeploymentPartition;
function withBookJoin(): ProofOfReservesLatestReport {
  const value = scopedReport();
  value.coverage!.currentBookPartition = { baseInputGenerationId: generation, sourceGeneration: "current-supply", observedAtSec: clockSec - 60,
    completeness: "complete", evidenceRefIds: ["source:current-books"], books: [
      { deploymentRef, bookKey: "issuer:trust", currentLiabilityUsd: 25, exclusions: [] },
      { deploymentRef, bookKey: "issuer:legacy", currentLiabilityUsd: 75, exclusions: [] },
    ] };
  return value;
}
function backing(latestReport: ProofOfReservesLatestReport, fixedInput = input(), archetype = "fiat-cash", id = "scope-fixture") {
  const review = buildSafetyScoreV9MechanismReview(fixedInput, meta(latestReport, id), archetype)!;
  return { review, result: evaluateV9Backing(asset([exposure({ key: "cash", weight: 1 })]), review, V9_CANDIDATE_POLICY_V1) };
}

describe("diagnostic report scope monotonicity", () => {
  it.each(["fiat-cash", "commodity-claim", "tbill"])("keeps unjoined %s assurance and Backing exactly unchanged", archetype => {
    const before = backing(report, input(), archetype);
    const after = backing(scopedReport(), input(), archetype);
    expect(after.review).toEqual(before.review);
    expect(after.result).toEqual(before.result);
  });
  it("does not overwrite a current tbill recovery overlay merely because scope was authored", () => {
    expect(backing(scopedReport(), input(), "tbill", "usdtb-ethena")).toEqual(backing(report, input(), "tbill", "usdtb-ethena"));
  });
  it.each(["no-book-join", "incomplete", "wrong-generation", "nonconserving-books"])("keeps %s partitions diagnostic", condition => {
    const value = condition === "no-book-join" ? scopedReport() : withBookJoin();
    const current = structuredClone(partition);
    if (condition === "incomplete") current.quantitativeCompleteness = false;
    if (condition === "wrong-generation") current.baseInputGenerationId = `report-cards-input:v1:${"b".repeat(64)}`;
    if (condition === "nonconserving-books") value.coverage!.currentBookPartition!.books[0].currentLiabilityUsd++;
    expect(backing(value, input(current))).toEqual(backing(report));
  });
  it("preserves audited and curated reserve admission on all legacy rungs without a current join", () => {
    const unscoped = meta();
    const scoped = meta(scopedReport());
    for (const value of [unscoped, scoped]) value.liveReservesConfig = { adapter: "curated-validated", version: 1, semantics: "collateral-mix", inputs: { primary: { kind: "onchain-solana" } } };
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(scoped, clockSec)).toEqual(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(unscoped, clockSec));
    const prudential = { supervision: "prudential" } as NonNullable<V9ExtensionRegistryMeta["mintAuthority"]>;
    unscoped.mintAuthority = prudential; scoped.mintAuthority = prudential;
    expect(buildSafetyScoreV9ReviewedStaticReserveRows(scoped, clockSec)).toEqual(buildSafetyScoreV9ReviewedStaticReserveRows(unscoped, clockSec));
    for (const value of [unscoped, scoped]) { delete value.liveReservesConfig; delete value.mintAuthority; }
    const args = { clockSec, liveReserveRows: [], liveFallbackAllowed: true, fixedInput: input() };
    expect(resolveReviewedReserveRows({ ...args, meta: scoped })).toEqual(resolveReviewedReserveRows({ ...args, meta: unscoped }));
    expect(resolveReviewedReserveRows({ ...args, meta: scoped })?.rows).toEqual(scoped.reserves);
  });
  it("allocates assurance only with a complete current economic and book join, retaining the unknown charge", () => {
    const after = backing(withBookJoin(), input(partition));
    const fragments = after.result.contributions.filter(row => row.componentKey.includes(":scope:"));
    const known = fragments.find(row => row.componentKey.endsWith(":trust:august"))!;
    const residual = fragments.find(row => row.componentKey.endsWith(":trust:august:unknown"))!;
    const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.backing;
    expect([known.score, residual.score, residual.observationState]).toEqual([policy.componentQuality.strong, policy.boundedUnknownQuality, "bounded-unknown"]);
    expect(known.normalizedWeight / residual.normalizedWeight).toBeCloseTo(1 / 3);
    expect(after.result.score!).toBeLessThan(backing(report).result.score!);
    expect(resolveReviewedReserveRows({ meta: meta(withBookJoin()), clockSec, liveReserveRows: [], liveFallbackAllowed: true, fixedInput: input(partition) })).toBeNull();
  });
  it("lowers overbroad legacy credit only for an explicit verified still-owed exclusion, not a zero or extinguished liability", () => {
    const value = scopedReport();
    const exclusion = { id: "excluded-legacy", identity: { deploymentRef, bookKey: "issuer:legacy", account: null }, kind: "legacy",
      reason: "Report explicitly excludes outstanding legacy liabilities", amount: "50", currency: "USD", unitBasis: "token-units", asOfSec,
      source: { url: "https://example.com/report", accessedAtSec: clockSec - 60, sha256: "a".repeat(64) }, economicallyOwed: true };
    value.coverage!.liabilityExclusions = [exclusion]; value.coverage!.denominator.excluded = [exclusion.id];
    expect(backing(value).result.score!).toBeLessThan(backing(report).result.score!);
    expect(resolveReviewedReserveRows({ meta: meta(value), clockSec, liveReserveRows: [], liveFallbackAllowed: true, fixedInput: input() })).toBeNull();
    exclusion.amount = "0";
    expect(backing(value)).toEqual(backing(report));
    exclusion.amount = "50"; exclusion.economicallyOwed = false;
    expect(backing(value)).toEqual(backing(report));
    exclusion.economicallyOwed = true; value.coverage!.confidence = "unknown";
    expect(backing(value)).toEqual(backing(report));
  });
  it("authors exact native-book coverage with the legacy full label without requiring every representation deployment", () => {
    const source = { name: "Scope fixture", symbol: "SCOPE", flags: { backing: "rwa-backed", governance: "centralized", rwa: false },
      ...meta(scopedReport(), "scope-schema-test"), contracts: [...meta().contracts!, { chain: "base", address: "0x2222222222222222222222222222222222222222", decimals: 18 }],
      bridgeRouteRisk: { tier: "opaque-or-unknown", summary: "Fixture unknown bridge controls", reviewedAt: "2026-09-30", reviewer: "Fixture", confidence: "unknown",
        sourceFreeRationale: "No reviewed route control facts", routes: [{ id: "base:0x2222222222222222222222222222222222222222", destinationChain: "base", contractAddress: "0x2222222222222222222222222222222222222222",
          protocol: "unknown", issuanceModel: "unknown", routeClass: "unknown", riskTier: "opaque-or-unknown", semantics: "unknown", scope: "unknown", reviewDisposition: "unresolved", reviewNote: "Bridge representation controls unreviewed" }] } };
    const parsed = parseStablecoinMetaAssets([source], "scope-fixture")[0]!;
    expect(parsed.proofOfReserves!.latestReport!.liabilityReconciliation).toBe("full");
    expect(parsed.proofOfReserves!.latestReport!.coverage!.deploymentRefs).toEqual([deploymentRef]);
    expect(parsed.proofOfReserves!.latestReport!.coverage!.currentBookPartition).toBeUndefined();
  });
  it("admits reviewed reserve-side adapter contracts and native technical subjects without making them holder liabilities", () => {
    const foreignRef = "ethereum:0x4aa42145aa6ebf72e164c9bbc74fbd3788045016";
    const nativeRef = "gnosis:native:xdai";
    const observation: ReserveObservationEnvelope = {
      kind: "onchain-observation", scopeId: "bridge-subset", liabilityBookKey: "gnosis-native-bridge-issued",
      deploymentRefs: [foreignRef, nativeRef], reviewer: "Fixture", confidence: "verified",
      reviewedAtSec: clockSec - 30, observedAtSec: clockSec - 60, expiresAtSec: clockSec + 3600,
      sourceGeneration: "fixture", sourceSha256: "a".repeat(64), completeness: "partial",
      sources: [{ url: "https://example.com/rpc", accessedAtSec: clockSec - 30, sha256: "a".repeat(64) }],
      obligations: ["pending-mints", "pending-burns", "fees", "interest"].map(key =>
        ({ key, disposition: "unresolved" as const, reason: "Not a complete economic census" })),
      blocks: [{ chain: "ethereum", number: 1, hash: `0x${"a".repeat(64)}`, timestamp: clockSec - 60, finality: "safe" }],
      quantities: [{ key: "collateral", deploymentRef: foreignRef, selector: "balanceOf", rawAmount: "100", decimals: 18 }], ratio: null,
    };
    const source = { ...meta(), name: "Scope fixture", symbol: "SCOPE", flags: { backing: "rwa-backed", governance: "centralized", rwa: false },
      liveReservesConfig: xdaiMetaSource.liveReservesConfig };
    source.reserveReview!.observations = [observation];
    const parsed = parseStablecoinMetaAssets([source], "observation-fixture")[0]!;
    expect(parsed.contracts!.map(row => `${row.chain}:${row.address}`)).toEqual([deploymentRef]);
    const admissions = buildSafetyScoreV10ScopedReserveAdmissions(parsed, input());
    expect(admissions[0]).toMatchObject({
      admitted: true, rejectionCodes: [], currentLiabilityShare: null, wholeAssetComposition: false,
    });
    const evidence = new ReviewEvidenceBuilder(parsed.id, clockSec);
    addScopedReserveEvidence(parsed, admissions, undefined, evidence);
    const bindings = evidence.finish();
    expect(bindings.researchEvidence).toMatchObject([{
      sourceId: "reserve-observation:onchain-observation", observedAtSec: clockSec - 60,
      url: "https://example.com/rpc", confidence: "verified",
    }]);
    expect(bindings.componentEvidence).toEqual([{
      componentKey: "reserve-scope:bridge-subset", evidenceKeys: admissions[0]!.evidenceRefIds,
    }]);
    expect(buildSafetyScoreV10ScopedReserveAdmissions(parsed, { ...input(), clockSec: observation.expiresAtSec + 1 })[0])
      .toMatchObject({ admitted: false, wholeAssetComposition: false, rejectionCodes: ["expired"] });
    expect(buildSafetyScoreV9MechanismReview(input(), parsed, "fiat-cash")).toEqual(buildSafetyScoreV9MechanismReview(input(), meta(), "fiat-cash"));
    observation.deploymentRefs.push("ethereum:0x9999999999999999999999999999999999999999");
    expect(() => parseStablecoinMetaAssets([source], "unknown-observed-contract")).toThrow("Unresolved reserve deployment");
    observation.deploymentRefs.pop();
    source.proofOfReserves!.latestReport = scopedReport();
    source.proofOfReserves!.latestReport!.coverage!.deploymentRefs = [foreignRef];
    source.proofOfReserves!.latestReport!.coverage!.denominator.included[0].identity.deploymentRef = foreignRef;
    expect(() => parseStablecoinMetaAssets([source], "reserve-contract-is-not-liability")).toThrow("Unresolved reserve deployment");
  });
});
