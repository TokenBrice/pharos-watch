import { describe, expect, it } from "vitest";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { computeV9FactSetDigest } from "@shared/lib/safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { makeExecutionCertificate } from "@shared/lib/__tests__/safety-score-v9-exit-execution.test-support";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { buildWrapperLocalFacts } from "../safety-score-v9/fact-set-wrapper";
import { makeV9RoleExtension, makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";

function compileUnwind(completion: number, options: { certificate?: boolean; stale?: boolean; extraRoute?: boolean; wrongRequest?: boolean; wrongBudget?: boolean } = {}) {
  const draft = makeV9TwoAssetFixedInput({ clockSec: Date.parse("2026-10-02T00:00:00Z") / 1_000 });
  draft.aggregateCirculatingById.beta = structuredClone(draft.aggregateCirculatingById.alpha!);
  draft.liveReserveMap.alpha = [{
    name: "Direct parent receipt", pct: 100, risk: "low", coinId: "beta", depType: "wrapper",
    assetClass: "protocol-position", issuerOrObligor: "asset:beta", riskFactors: ["smart-contract"],
    liquidityHorizon: "immediate",
  }];
  const fixed = rebuildFixed(draft);
  const extension = makeV9RoleExtension(fixed, {
    alpha: [{ upstreamAssetId: "beta", dependencyType: "wrapper", economicRole: "serial-claim", weight: 1, failureDomains: [] }],
  });
  const wrapper = extension.assets.find((asset) => asset.assetId === "alpha")!;
  wrapper.variantKind = "strategy-vault";
  wrapper.dependencies!.source = "variant";
  let factSet = structuredClone(compileSafetyScoreV9FactSetFromFixedInput(fixed, extension));
  const asset = factSet.assets.find((candidate) => candidate.assetId === "alpha")!;
  const route = structuredClone(asset.exitRoutes[0]!);
  route.status.observationState = options.stale ? "stale" : "known";
  route.scoreEligible = true;
  route.coverageClass = "exact-lower-bound";
  route.evidenceKind = "onchain-contract-state";
  delete route.feeEvidence;
  delete route.settlementBoundUnproven;
  if (options.certificate !== false) route.executionCertificate = makeExecutionCertificate();
  else delete route.executionCertificate;
  route.capacityCurve = route.capacityCurve.map((point) => ({
    ...point, completionRatio: completion, executableUsd: point.requestedNotionalUsd * completion, executionCostBps: 0,
  }));
  if (options.wrongRequest) route.capacityCurve = route.capacityCurve.map((point) => ({ ...point, requestedNotionalUsd: point.requestedNotionalUsd + 1 }));
  if (options.wrongBudget) route.capacityCurve = route.capacityCurve.map((point) => ({ ...point, maxCostBps: point.maxCostBps + 1 }));
  const context = createAssetBuildContext(normalizeSafetyScoreV9CompilerInput(fixed), extension, wrapper, "a".repeat(64));
  asset.wrapperLocalFacts = buildWrapperLocalFacts(context, {
    ...asset, exitRoutes: options.extraRoute ? [route, { ...route, scoreEligible: false }] : [route],
  });
  asset.gaps = [...asset.gaps.filter((gap) => !gap.gapId.startsWith("alpha:gap:wrapper-local:")), ...context.gaps.values()]
    .sort((left, right) => left.gapId.localeCompare(right.gapId));
  asset.evidence = [...new Map([...asset.evidence.map((evidence) => [evidence.evidenceId, evidence] as const), ...context.evidence]).values()]
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  factSet = { ...factSet, v9FactSetDigest: computeV9FactSetDigest(factSet) };
  if (asset.wrapperLocalFacts.applicability !== "wrapper") throw new Error("Expected wrapper facts");
  const card = evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1).assets.find((candidate) => candidate.assetId === "alpha")!;
  return { unwind: asset.wrapperLocalFacts.facts.measuredUnwind, card, gaps: asset.gaps };
}

describe("wrapper unwind certificate completion floors", () => {
  it.each([0.95, 0.96875, 1])("admits proven sufficient completion %s without requiring exhaustion", (completion) => {
    const result = compileUnwind(completion, { extraRoute: true });
    expect(result.unwind).toMatchObject({ disposition: "reviewed", assessment: "none" });
    expect(result.gaps.some((gap) => gap.gapId === "alpha:gap:wrapper-local:measuredUnwind")).toBe(false);
    expect(result.card.trace.wrapperParentLimit?.missingFacts).not.toContainEqual(expect.objectContaining({ factClass: "measuredUnwind" }));
  });
  it.each([0, 0.4, 0.8, 0.94999])("never turns incomplete execution %s into adverse/exhaustive unwind", (completion) => {
    expect(compileUnwind(completion).unwind.assessment).toBeNull();
  });
  it("does not admit a sampled capacity proxy or a stale transaction receipt", () => {
    expect(compileUnwind(0.99, { certificate: false }).unwind.assessment).toBeNull();
    expect(compileUnwind(0.99, { stale: true }).unwind.assessment).toBeNull();
  });
  it("never borrows another notional or cost-budget sample for the exact policy request", () => {
    expect(compileUnwind(0.99, { wrongRequest: true }).unwind.assessment).toBeNull();
    expect(compileUnwind(0.99, { wrongBudget: true }).unwind.assessment).toBeNull();
  });
});
