import { projectTopDriver as topDrv } from "../safety-score-v9/public-top-driver";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertV9PublicCardProjections as assertProj, projectV9DetailNeighborhoodCard as detailCard, projectV9TableCard as tableCard } from "../report-cards-v9-projections";
import { attributedScoredParent as attrParent } from "../../types/safety-score-v9-public-internal";
import { countV9EvidenceObligations as countObl, iterateEvidenceResponsibilityFacts as iterFacts } from "../../types/safety-score-v9-public-evidence-facts";
import { resolveCauseGapId as resolveGap } from "../../types/safety-score-v9-public-cause-gaps";
import { resolveV9PublicWitnessTexts as resolveW } from "../../types/safety-score-v9-public-witness-texts";
import { computeV9UnknownPricedWeightShare as unkShare, resolveV9PublicControlDetails as resCtrl, SafetyScoreV9BreakdownsSchema as BdSchema, SafetyScoreV9HistoricalBreakdownsSchema as HistBdSchema } from "../../types/safety-score-v9-public-breakdowns";
import type { V9ResolvedDependencyInputs } from "../safety-score-v9/dependencies";
import { readableV9PublicText as readText, readableV9PublicWitnesses as readW } from "../safety-score-v9/public-witness-texts";
import type { V9CapTrace, V9NRReason } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 as POL } from "../safety-score-v9/policy";
import { buildSafetyScoreV9Response as buildResp, createSafetyScoreV9ResponseProjector as mkProj, projectSafetyScoreV9Card as project, V9PublicCardProjectionError as ProjErr, type V9PublicCardProjectionInput as ProjIn } from "../safety-score-v9/public";
import type { V9ProductionScoreTrace as Trace } from "../safety-score-v9/score";
import { SafetyScoreV9AccessPostureSchema as AccessSchema, SafetyScoreV9CurrentCardSchema as CardSchema, SafetyScoreV9EvidenceSummarySchema as EvSchema, SafetyScoreV9HistoricalTypedCardSchema as HistCardSchema, SafetyScoreV9PillarSchema as PillarSchema, type V9OpenEvidence } from "../../types/safety-score-v9-public";
import { SafetyScoreV9CurrentResponseSchema as RespSchema } from "../../types/safety-score-v9-publication-response";
import { makeDeploymentControl as mkCtrl, makeCompiledVotingControl as mkVote, makeOperationalIssuanceProcess as mkProc, FRAX_PROVIDER_ROW_EXCLUSION_FIXTURE as FRAX_EXCL } from "./safety-score-v9-fixtures.test-support";
import { reviewedScope, weightedQuorum } from "./safety-score-v9-control-scope.test-support";
import { ReviewedProviderRowExclusionSchema as ExclSchema } from "../../types/safety-score-v9-supply-attribution";
import { isV9OperationallyGovernedIssuanceQualified as isGovQual } from "../safety-score-v9/control-primitives";
import type { V1005ProcessDiagnostic } from "../../types/safety-score-v9-facts";
import { evaluateV9Exit as evalExit } from "../safety-score-v9/exit";
import { makeExitGap, makeExitRoute } from "./safety-score-v9-exit.test-support";
import { previousReader } from "../../types/__tests__/safety-score-v9-public.test-support";
import { scoreV9EvaluatedAsset as scoreAsset } from "../safety-score-v9/score";
import { makeV9Pillar as mkPillar, makeV9ProductionScoreInput as mkScoreIn } from "./safety-score-v9-score.test-support";
import { V9EvidenceResponsibilitySchema as OwnerSchema, V9_PUBLIC_EVIDENCE_RESPONSIBILITIES as PUB_OWNERS } from "../../types/safety-score-v9-vocabulary";
import { DANGER_PEG_MULTIPLIER_FLOOR as PEG_FLOOR } from "../../types/safety-score-v9-public-facts";
import { applyV9MeasuredCollateralization as applyCollat, evaluateV9ArchetypeBacking as evalBack } from "../safety-score-v9/archetypes/evaluation";
import { computeV9CompactResultDigest as compactDigest, projectCompactV9ScoreTrace as compactTrace } from "../safety-score-v9/trace";
import { asset as backAsset, exposure, knownStatus } from "./safety-score-v9-backing.test-support";
import { V9_PUBLIC_REPRESENTATION_VERSION as REP_VER } from "../../types/report-cards-v9-materialization";
import { createV9PublicCardShardViewFactory as mkShardView } from "../safety-score-v9/public-card-shard";
import { stableJsonStringifyV1 as sjson } from "../stable-json";

const DIG = { policy: "a".repeat(64), facts: "b".repeat(64), base: `report-cards-input:v1:${"c".repeat(64)}`, build: "d".repeat(64) } as const;
const FRESH = { backing: "current", exit: "current", control: "current" } as const;
const ACCESS = { transfer: "permissionless" as const, freezeExposure: "none-known" as const, primaryExit: "permissionless" as const, governance: "distributed" as const, unknownFields: [], signals: ["freeze:none-known", "governance:distributed", "primary-exit:permissionless", "transfer:permissionless"] };
const KNOWN = { cause: null, causeGapIds: [] as string[], scoringDisposition: "included", effectiveScoringWeight: 1 } as const;
const NEUT = { factor: 1, cause: null, causeGapIds: [] as string[] } as const;
const PILS = ["backing", "exit", "control"] as const;
const WTS = { backing: 0.4, exit: 0.35, control: 0.25 } as const;
const NR_BACK: readonly V9NRReason[] = [{ code: "missing-pillar", field: "pillars.backing", message: "Backing is missing." }];
const sc = structuredClone, js = JSON.stringify, jp = JSON.parse;
const unk = (cause: "C" | "U", gap: string) => ({ cause, causeGapIds: [gap], scoringDisposition: "bounded-uncertainty" as const });
const unk0 = (cause: "C" | "U") => ({ cause, scoringDisposition: "bounded-uncertainty" as const });

interface FxOpts { score: number | null; grade: Trace["finalGrade"]; pillars?: { backing: number | null; exit: number | null; control: number | null }; qualityScore?: number | null; pegAdjustedScore?: number | null; caps?: readonly V9CapTrace[]; nrReasons?: readonly V9NRReason[]; dependency?: ProjIn["dependencyInputs"]; }

function fx(assetId: string, o: FxOpts): ProjIn {
  const pillars = o.pillars ?? { backing: 92, exit: 90, control: 94 };
  const qs = o.qualityScore === undefined ? (o.score === null ? null : 91.8) : o.qualityScore;
  const pas = o.pegAdjustedScore === undefined ? (o.score === null ? null : qs) : o.pegAdjustedScore;
  const caps = o.caps ?? [], nrReasons = [...(o.nrReasons ?? [])];
  const ratingStatus = o.grade === null ? "pipeline-gap" : o.grade === "NR" ? "not-rated" : "rated";
  const inc = PILS.filter((p) => ratingStatus !== "pipeline-gap" || pillars[p] !== null), exc = PILS.filter((p) => !inc.includes(p));
  if (ratingStatus === "pipeline-gap") nrReasons.push({ code: inc.length === 0 ? "all-pillars-pipeline-gap" : "single-pillar-pipeline-gap", message: "Insufficient supported pillars." });
  const supportCeiling = PILS.reduce((s, p) => s + (pillars[p] ?? 0) * WTS[p], 0);
  const pf = (p: (typeof PILS)[number]) => ({ aggregationDisposition: exc.includes(p) ? ("excluded-a-b" as const) : ("included" as const), causeGapIds: pillars[p] === null ? [`gap:${p}`] : [], limitedEvidenceCauses: pillars[p] === null && ratingStatus !== "pipeline-gap" ? (["U"] as const) : [], supportedComponentKeys: pillars[p] === null ? [] : [`component:${p}`] });
  const trace: Trace = {
    assetId, policyId: "safety-score-v9", policyDigest: DIG.policy, configName: "safety-score-v9", ratingStatus,
    partialEvidence: ratingStatus === "pipeline-gap" ? { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [...exc].sort(), excludedComponentKeys: exc.map((p) => `component:${p}`).sort(), causeGapIds: exc.map((p) => `gap:${p}`).sort(), causes: ["A"] } : null,
    includedPillars: inc, excludedPillars: exc, effectiveScoringWeights: ratingStatus === "pipeline-gap" ? null : WTS, supportCeiling: qs === null ? null : supportCeiling,
    limitingPillars: [], causeGapIds: [], limitedEvidenceCauses: [], diagnosticPillarScores: pillars,
    pillarContributions: PILS.flatMap((pillar) => { const s = pillars[pillar]; return s === null || ratingStatus === "pipeline-gap" ? [] : [{ pillar, score: s, weight: WTS[pillar], weightedContribution: s }]; }),
    weightedQuality: qs, weakestPillar: Object.values(pillars).some((s) => s === null) ? null : { pillar: "exit", score: pillars.exit! },
    aggregation: qs === null ? null : { method: "smooth-bounded-headroom", score: qs, weightedQuality: qs, weakestPillar: "exit", weakestScore: pillars.exit!, headroom: 45, includedPillars: inc, excludedPillars: exc, effectiveScoringWeights: WTS, pricedUnknownPillars: [], supportCeiling },
    pegMultiplier: pas === null ? null : 1, baseAssetScore: pas, deploymentAdjustedScore: pas,
    deploymentAdjustments: [], unresolvedDeploymentSignals: [], preCapScore: pas, scoreAdjustments: [], caps, bindingCap: caps.find((c) => c.binding) ?? null,
    structuralSignals: [], finalScore: o.score, inheritableScore: o.score, finalGrade: o.grade, adverseAttribution: [], boundedUncertaintyAttribution: [],
    unresolvedFacts: [], nrReasons, propagatedParentReasons: [], factSetDigest: DIG.facts, baseInputGenerationId: DIG.base,
    evaluationBuildDigest: DIG.build, asOfSec: 1e3, sourceGenerations: { dex: "dex:g1", registry: "registry:g1" }, wrapperParentLimit: null,
  };
  const dep = o.dependency ?? { assetId, serial: [], basket: [], cycleBlocked: false };
  const dependencyReasons = dep.serial.some((d) => d.blocked) ? [{ code: "missing-parent-score" as const, path: `dependency:serial:${dep.serial[0]!.upstreamAssetId}`, message: "Required upstream is not rateable.", responsibility: "integration-missing" as const }] : [];
  return {
    trace, policy: POL,
    scoreInput: {
      pillars: {
        backing: { score: pillars.backing, ...pf("backing"), evidenceLevel: pillars.backing === null ? "insufficient" : "strong", reasons: pillars.backing === null ? [{ code: "missing-pillar-evidence", path: "backing", message: "Backing evidence is missing.", responsibility: "integration-missing" }] : [], structuralSignals: [] },
        exit: { score: pillars.exit, ...pf("exit"), evidenceLevel: "strong", reasons: [], structuralSignals: [] },
        control: { score: pillars.control, ...pf("control"), evidenceLevel: "strong", reasons: [], structuralSignals: [] },
      },
      peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] }, dependencyReasons, methodologyReasons: [],
    },
    access: ACCESS, dependencyInputs: dep,
    backing: { archetype: "fiat-cash", score: pillars.backing, contributions: pillars.backing === null ? [] : [{ componentKey: "reserve:cash", source: "reserve-exposure", score: pillars.backing, normalizedWeight: 1, weightedScore: pillars.backing, effectiveWeight: 1, ...KNOWN, wholeAssetWeight: 1, observationState: "known", provenance: "curated", evidenceRefIds: [], failureDomains: [], upstreamAssetId: null }] },
    exit: {
      score: pillars.exit, stressRequest: pillars.exit === null ? null : { requestedNotionalUsd: 1e6, maxCostBps: 200, comparisonWindowSec: 86400, rawSupplyRequestUsd: 1e6 },
      primaryRouteKey: pillars.exit === null ? null : "redemption:fixture", diversificationRouteKey: null, diversificationBonus: 0,
      routes: pillars.exit === null ? [] : [{
        routeKey: "redemption:fixture", routeId: "fixture", lane: "redemption", ...KNOWN,
        confidenceDimensions: { observation: NEUT, model: NEUT, capacityMethod: NEUT },
        capacityEvidenceTier: "live-direct", rawSameNotionalCostBps: 0, supportedComponentCeiling: pillars.exit,
        factorContributions: Object.fromEntries(Object.entries(POL.policy.semantic.exit.componentWeights).map(([k, w]) => [k, { ...KNOWN, score: pillars.exit, effectiveScoringWeight: w }])),
        routeFamily: "protocol-redemption", observationConfidence: "high", modelConfidence: "high", observationHistory: null, capacityScoringHorizon: "immediate",
        settlementDelaySec: 0, queueDepthUsd: null, dailyLimitUsd: null, minRedeemUsd: null, score: pillars.exit, included: true, exclusionReason: null,
        capacityPoint: { requestedNotionalUsd: 1e6, maxCostBps: 200, executableUsd: 1e6, completionRatio: 1, executionCostBps: 0 },
        components: { access: pillars.exit, settlement: pillars.exit, executionCertainty: pillars.exit, capacity: pillars.exit, outputAssetQuality: pillars.exit, cost: pillars.exit },
        confidenceFactor: 1, capsApplied: [],
      }],
    },
    control: { score: pillars.control, components: pillars.control === null ? [] : [{ componentKey: "control:mint", kind: "mint", posture: "bounded-admin", score: pillars.control, ...KNOWN, binding: true, controlKeys: [], failureDomains: [] }] },
    display: { labels: { "reserve:cash": "Cash", "redemption:fixture": "Protocol redemption", "control:mint": "Mint control" }, exitHolderEligibility: { "redemption:fixture": "any-holder" } },
    freshness: FRESH,
  };
}

const rfx = (id: string, o: Partial<FxOpts> = {}) => fx(id, { score: 91.8, grade: "A+", ...o });
const fx50 = (id: string) => fx(id, { score: 50, grade: "C-", qualityScore: 50, pillars: { backing: 50, exit: 50, control: 50 } });
const fx70 = (id: string) => fx(id, { score: 70, grade: "B" });
const fxNr = (id: string, caps?: readonly V9CapTrace[]) => fx(id, { score: null, grade: "NR", pillars: { backing: null, exit: 90, control: 94 }, nrReasons: NR_BACK, ...(caps ? { caps } : {}) });
const pc = (i: ProjIn) => project(i).card;
const ok = (c: unknown) => CardSchema.safeParse(c).success;
const cap = (kind: string, limit: number, source: V9CapTrace["source"], reason: string, binding: boolean): V9CapTrace => ({ kind, limit, source, reason, binding });
const ufact = (code: Trace["unresolvedFacts"][number]["code"], path: string, reason: string, extra: Partial<Trace["unresolvedFacts"][number]> = {}): Trace["unresolvedFacts"][number] => ({ code, path, reason, critical: false, responsibility: "unresearched", cause: "U", scoringDisposition: "bounded-uncertainty", ...extra });
const openEv = (): V9OpenEvidence => ({ semantics: "open-question-v1", totals: { questions: 0, open: 0, issuer: 0, documentation: 0, obligations: 0 }, owners: [], reasons: [], documentation: { questions: 0, datums: 0, facts: 0, reasons: [] }, issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null }, byCard: [] });
const meta = (tag = "public-test", extra: Record<string, unknown> = {}) => ({ openEvidence: openEv(), candidateId: `safety-score-v9:v1:${tag}`, policyVersion: "9.0", publicationGenerationId: `report-cards:v9:v1:${tag}`, publishedAtSec: 1001, ...extra });
const publish = (results: ProjIn[], extra: Partial<Parameters<typeof buildResp>[0]> = {}) => buildResp({ ...meta(), ...extra, results });
const rt = (r: ReturnType<typeof buildResp>) => RespSchema.parse(jp(js(r)));
const setScored = (i: ProjIn, si: ReturnType<typeof mkScoreIn>) => Object.assign(i, { scoreInput: si, trace: scoreAsset(si, i.policy) });

describe("Safety Score v9 public projection", () => {
  it("keeps card shards byte-identical, immutable and independent across cache eviction", () => {
    const compact = mkShardView(), orig: ReturnType<typeof pc> & { name?: string } = pc(fx("usdc-circle", { score: 90, grade: "A+" }));
    orig.name = "Unicode \u20ac \ud83d\ude80";
    const exp = sjson(orig), view = compact(orig), other = compact({ ...orig, id: "usdt-tether" });
    expect(Object.keys(view)).toEqual(Object.keys(orig)); expect(sjson(view)).toBe(exp);
    orig.pillars.backing.reasons.push({ code: "missing-reserve-composition", path: null, message: "Caller mutation" });
    expect([Object.isFrozen(orig), Object.isFrozen(view), Object.isFrozen(view.pillars.backing.reasons)]).toEqual([false, true, true]);
    expect(() => view.pillars.backing.reasons.push({ code: "missing-reserve-composition", path: null, message: "Mutation" })).toThrow();
    const memo = view.pillars;
    expect(other.pillars).toEqual(view.pillars); expect(view.pillars).toBe(memo);
    for (let i = 0; i < 32; i++) expect(compact({ ...orig, id: `cache-${i}` }).pillars).toBeDefined();
    expect(view.pillars).not.toBe(memo); expect(sjson(view)).toBe(exp);
  });

  it("emits bounded exposure from structured priced authorities, with full-set totals and no score mutation", () => {
    const i = fx("exposure", { score: 80, grade: "A-", pillars: { backing: 92, exit: 90, control: 90 } });
    const auths = [0.4, 0.3, 0.2, 0.09, 0].map((share, idx) => ({ deploymentKey: `chain:deployment-${idx}`, quality: 60, share, failureDomainKeys: [`upgrade-control:${idx}`], sourceSignals: [] }));
    const prod = mkScoreIn({ assetId: "exposure", pillars: { backing: mkPillar(92), exit: mkPillar(90), control: mkPillar(90, { deploymentAuthorities: auths }) } });
    setScored(i, prod);
    const bef = js(i.trace), c = pc(i);
    expect(c.localAuthorityExposure).toMatchObject({ worstQuality: 60, moreCount: 1, slices: [0.4, 0.3, 0.2].map((share) => ({ share, quality: 60 })) });
    expect(c.localAuthorityExposure!.coveredShare).toBeCloseTo(0.99, 12);
    expect(c.localAuthorityExposure!.slices).toHaveLength(3); expect(c.pillars.control.score).toBe(90); expect(js(i.trace)).toBe(bef);
    prod.pillars.control.deploymentAuthorities = auths.map((r) => ({ ...r, quality: 90 }));
    i.trace = scoreAsset(prod, i.policy);
    expect(pc(i)).not.toHaveProperty("localAuthorityExposure");
  });

  it.each([false, true])("reconciles both Q* lanes with interned witnesses (overlap=%s)", (overlap) => {
    expect(REP_VER).toBe(3);
    const i = fx("qstar", { score: 80, grade: "A-" });
    const prod = mkScoreIn({
      assetId: "qstar",
      pillars: { backing: mkPillar(92), exit: mkPillar(90), control: mkPillar(94, { deploymentAuthorities: [
        { deploymentKey: "a", quality: 60, share: 1, failureDomainKeys: ["upgrade-control:a"], sourceSignals: [] },
        ...(overlap ? [{ deploymentKey: "b", quality: 70, share: 0.5, failureDomainKeys: ["upgrade-control:b"], sourceSignals: [] }] : []),
      ] }) },
      dependencyStructuralSignals: [{ kind: "critical-dependency", severity: "high", reason: "Measured shared chain.", economicLossScope: "deployment", responsibility: "measured-adverse", materialSharePct: 50, exposedScore: 64, exposureKey: "common:chain", riskEventKey: "chain:failure", failureDomainKeys: ["chain:fixture"], evidence: [] }],
    });
    i.trace = scoreAsset(prod, i.policy);
    const c = pc(i);
    expect(ok(c)).toBe(true);
    const adj = resolveW(c).scoreTrace.deploymentRisk.adjustments;
    expect(adj).toHaveLength(overlap ? 3 : 2);
    expect(adj.some((r) => r.signalKey.startsWith("local-authority:") && r.adjustmentPoints > 0)).toBe(true);
  });

  it.each(["C", "U"] as const)("labels majority %s unknown-priced weight without changing scores or archives", (cause) => {
    const i = fx50("provisional"), u = unk(cause, "provisional:gap:unknown");
    i.backing = { ...i.backing!, contributions: i.backing!.contributions.map((c) => ({ ...c, ...u })) };
    i.control = { ...i.control!, components: i.control!.components.map((c) => ({ ...c, ...u, posture: "unknown" })) };
    const bef = js(i.trace), c = pc(i);
    expect(c).toMatchObject({ provisional: true, score: i.trace.finalScore, grade: i.trace.finalGrade });
    expect(c.unknownPricedWeightShare).toBeCloseTo(0.65); expect(js(i.trace)).toBe(bef);
    expect(ok({ ...c, unknownPricedWeightShare: 0.75 })).toBe(false); expect(ok({ ...c, provisional: undefined })).toBe(false);
    const { provisional: _l, unknownPricedWeightShare: _s, ...arch } = c;
    expect(ok(arch)).toBe(true);
    expect(HistCardSchema.safeParse({ ...arch, breakdowns: { ...arch.breakdowns!, exit: { ...arch.breakdowns!.exit, primaryRoute: { ...arch.breakdowns!.exit.primaryRoute!, eligibilityMultiplier: 1 } } } }).success).toBe(true);
  });

  it.each(["A", "B"] as const)("keeps %s-only Exit pricing, 55% unknown weight and Provisional beside dust", async (cause) => {
    const miss = makeExitGap(cause, "gap:exit"), rail = makeExitRoute({ observationState: "missing", status: miss.status, capacityCurve: [] });
    const dust = makeExitRoute({ routeKey: "dex:xgz", lane: "dex", routeFamily: "dex-amm", capacityEvidenceTier: "live-direct", evidenceKind: "measured-executable-depth", capacityCurve: makeExitRoute().capacityCurve.map((p) => ({ ...p, executableUsd: 0, completionRatio: 0 })) });
    const reader = await previousReader();
    for (const routes of [[rail], [dust, rail]]) {
      const exit = evalExit({ circulatingUsd: 2e7, gaps: [miss.gap], routes }, POL);
      const si = mkScoreIn({ assetId: "dust", pillars: { backing: mkPillar(50), control: mkPillar(50), exit: mkPillar(exit.score, { ...exit, reasons: [], evidenceLevel: exit.score === null ? "insufficient" : "limited", excludedCauses: [cause], excludedCauseGapIds: ["gap:exit"], excludedComponentKeys: ["rail"] }) } });
      const tr = scoreAsset(si, POL);
      const i = fx("dust", { score: tr.finalScore, grade: tr.finalGrade, qualityScore: tr.weightedQuality, pegAdjustedScore: tr.preCapScore, pillars: { backing: 50, exit: exit.score, control: 50 } });
      Object.assign(i, { trace: tr, scoreInput: si, exit });
      i.backing = { ...i.backing!, contributions: i.backing!.contributions.map((c) => ({ ...c, factors: [{ componentKey: "unknown", score: 50, normalizedWeight: 0.5, effectiveScoringWeight: 0.5, ...unk("U", "gap:backing") }, { componentKey: "known", score: 50, normalizedWeight: 0.5, ...KNOWN, effectiveScoringWeight: 0.5 }] })) };
      const c = pc(i), priced = { score: null, aggregationDisposition: "excluded-a-b", pricedUnknown: { cause: "U", score: 50 } };
      expect(c.unknownPricedWeightShare).toBeCloseTo(0.55); expect(c.provisional).toBe(true);
      expect(c.scoreTrace.aggregation!.pricedUnknownPillars).toMatchObject([{ pillar: "exit", cause: "U", score: 50 }]);
      expect(c.partialEvidence!.causes).toContain(cause);
      expect(tableCard(c).pillars.exit).toEqual(priced); expect(detailCard(c).pillars!.exit).toEqual(priced);
      expect(reader.card.safeParse(c).success).toBe(true); expect(reader.table.safeParse(tableCard(c)).success).toBe(true);
      if (routes.length > 1) {
        expect(c.breakdowns!.exit.alternatives.some((r) => r.label.includes("Negligible"))).toBe(true);
        expect(reader.card.safeParse({ ...c, reasonCodes: [...c.reasonCodes, "negligible-dex-route"] }).success).toBe(false);
      }
    }
  });

  it("uses a strict majority and weights only unknown reserve subfactors, not their whole mixed row", () => {
    const i = fx50("mixed"), u = unk("U", "mixed:gap:unknown");
    i.backing = { ...i.backing!, contributions: i.backing!.contributions.map((c) => ({ ...c, ...u, factors: [{ componentKey: "unknown", score: 50, normalizedWeight: 0.625, effectiveScoringWeight: 0.625, ...u }, { componentKey: "known", score: 50, normalizedWeight: 0.375, ...KNOWN, effectiveScoringWeight: 0.375 }] })) };
    i.control = { ...i.control!, components: i.control!.components.map((c) => ({ ...c, ...u, posture: "unknown" })) };
    expect(pc(i).provisional).toBeUndefined();
    i.backing = { ...i.backing!, contributions: i.backing!.contributions.map((c) => ({ ...c, factors: c.factors!.map((f, idx) => ({ ...f, normalizedWeight: idx === 0 ? 0.626 : 0.374, effectiveScoringWeight: idx === 0 ? 0.626 : 0.374 })) })) };
    expect(pc(i).unknownPricedWeightShare).toBeCloseTo(0.5004);
  });

  it("counts only controlling mechanism and Control unknowns, excluding measured adversity and known ties", () => {
    const c = pc(fx50("accounting")), bd = c.breakdowns!, agg = c.scoreTrace.aggregation!, u = unk0("U"), comp = bd.backing.components[0]!;
    Object.assign(comp, u, { source: "mechanism", factors: [{ score: 50, effectiveScoringWeight: 1, ...u }, { score: 90, effectiveScoringWeight: 1, cause: null, scoringDisposition: "included" }] });
    Object.assign(bd.control.components[0]!, u, { posture: "unknown" });
    expect(unkShare(bd, agg)).toBeCloseTo(0.65);
    bd.control.components[0]!.posture = "unbounded-adverse"; expect(unkShare(bd, agg)).toBeCloseTo(0.4);
    bd.control.components[0]!.posture = "unknown"; bd.control.components.push({ ...bd.control.components[0]!, cause: null, scoringDisposition: "included" });
    expect(unkShare(bd, agg)).toBeCloseTo(0.4);
    Object.assign(comp, { cause: "D", scoringDisposition: "measured-adverse" }); expect(unkShare(bd, agg)).toBe(0);
  });

  it("accounts for unavailable pillars, selected Exit factors and only uncovered no-route supply", () => {
    const c = pc(fx50("exit-accounting")), bd = c.breakdowns!, agg = c.scoreTrace.aggregation!;
    Object.assign(bd.exit.primaryRoute!.components[0]!, unk0("C"));
    expect(unkShare(bd, agg)).toBeCloseTo(0.35 * bd.exit.primaryRoute!.components[0]!.effectiveScoringWeight!);
    agg.pricedUnknownPillars = [{ pillar: "backing", cause: "U", score: 50, causeGapRefs: [] }];
    expect(unkShare(bd, agg)).toBeGreaterThan(0.4);
    Object.assign(bd.exit, { primaryRoute: null, limitedEvidenceCauses: ["U"], evaluatedScore: 25 });
    expect(unkShare(bd, agg)).toBeCloseTo(0.575);
    bd.exit.evaluatedScore = 0; expect(unkShare(bd, agg)).toBeCloseTo(0.4);
    expect(unkShare(null, agg)).toBe(0); expect(unkShare(bd, null)).toBe(0);
  });

  it("admits overall Control90 with unchanged raw components and retained pre-clamp cards", () => {
    const raw = pc(fx("control-clamp", { score: 92, grade: "A+", qualityScore: 92.05, pillars: { backing: 92, exit: 90, control: 95 } }));
    expect(BdSchema.safeParse(raw.breakdowns).success).toBe(true);
    const cl = sc(raw.breakdowns!);
    cl.control.evaluatedScore = cl.control.publishedScore = 90; expect(BdSchema.safeParse(cl).success).toBe(true);
    cl.control.evaluatedScore = cl.control.publishedScore = 89; expect(BdSchema.safeParse(cl).success).toBe(false);
  });

  it.each(["C", "U"] as const)("publishes a priced %s unknown without fabricating pillar evidence", (cause) => {
    const si = mkScoreIn({ assetId: "priced-unknown", pillars: { backing: mkPillar(92), control: mkPillar(94), exit: mkPillar(null, { aggregationDisposition: "unavailable", supportedComponentKeys: [], causeGapIds: ["gap:exit"], limitedEvidenceCauses: [cause] }) } });
    const tr = scoreAsset(si, POL);
    const i = fx("priced-unknown", { score: tr.finalScore, grade: tr.finalGrade, pillars: { backing: 92, exit: null, control: 94 }, qualityScore: tr.weightedQuality, pegAdjustedScore: tr.preCapScore });
    Object.assign(i, { trace: tr, scoreInput: si });
    const c = pc(i);
    expect(c.pillars.exit).toMatchObject({ score: null, supportedComponentKeys: [] });
    expect(c.pillars.exit.limitedEvidenceCauses ?? []).toEqual([]);
    expect(c.breakdowns?.exit).toMatchObject({ evaluatedScore: null, publishedScore: null, aggregationWeight: 0 });
    expect(c.breakdowns?.exit.limitedEvidenceCauses ?? []).toEqual([]);
    expect(c.scoreTrace.aggregation).toMatchObject({ excludedPillars: ["exit"], effectiveScoringWeights: WTS, pricedUnknownPillars: [{ pillar: "exit", cause, score: 50 }] });
    expect(ok(c)).toBe(true);
  });

  it("publishes an A pipeline cause on an included Exit pillar and prices it as unknown weight", () => {
    const i = fx50("a-cause");
    i.scoreInput.pillars.exit = mkPillar(50, { evidenceLevel: "limited", limitedEvidenceCauses: ["A"], causeGapIds: ["gap:exit"], supportedComponentKeys: [] });
    i.exit = { ...i.exit!, primaryRouteKey: null };
    const c = pc(i);
    expect(c.pillars.exit.limitedEvidenceCauses).toEqual(["A"]);
    expect(c.breakdowns?.exit.limitedEvidenceCauses).toEqual(["A"]);
    expect(ok(c)).toBe(true); expect(unkShare(c.breakdowns, c.scoreTrace.aggregation)).toBeCloseTo(0.35);
  });

  it("publishes a required-parent issuer-NR child without a table priced unknown", () => {
    const id = "wrapper-child", si = mkScoreIn({
      assetId: id,
      pillars: { backing: mkPillar(88), exit: mkPillar(86), control: mkPillar(null, { aggregationDisposition: "excluded-a-b", supportedComponentKeys: [], causeGapIds: [`${id}:gap:control-disable`], excludedCauseGapIds: [`${id}:gap:control-disable`], excludedCauses: ["B"], excludedComponentKeys: ["control:mint"] }) },
      parent: { required: true, score: null, ratingStatus: "not-rated", propagatedReasons: [{ code: "critical-unresolved", field: "parent", message: "Required parent control identity is unresolved.", cause: "D" }] },
    });
    const tr = scoreAsset(si, POL);
    expect(tr.ratingStatus).toBe("not-rated"); expect(tr.aggregation?.pricedUnknownPillars).not.toEqual([]);
    const p = mkProj();
    p.project({ trace: tr, scoreInput: si, policy: POL, access: ACCESS, dependencyInputs: { assetId: id, basket: [], cycleBlocked: false, serial: [{ upstreamAssetId: "root-token", score: null, blocked: false, ratingStatus: "not-rated", limitedEvidenceCauses: ["D"] }] } });
    const resp = p.finalize({ ...meta("issuer-nr-child"), resultDigest: compactDigest([compactTrace(tr)]) }), c = resp.cards.find((r) => r.id === id)!;
    expect(c.ratingStatus).toBe("not-rated"); expect(resp.completeness.notRatedIds).toContain(id); expect(resp.completeness.pipelineGapIds).not.toContain(id);
    expect(tableCard(c).pillars.control).toEqual({ score: null, aggregationDisposition: "excluded-a-b" });
  });

  it("names the representation of a card only one public projection rejects", () => {
    const c = pc(rfx("alpha"));
    expect(() => assertProj(c)).not.toThrow();
    const bad = sc(c);
    bad.pillars.backing.aggregationDisposition = "excluded-a-b";
    bad.scoreTrace.aggregation!.pricedUnknownPillars = [{ pillar: "backing", cause: "U", score: 50, causeGapRefs: [] }];
    let issues: z.core.$ZodIssue[] = [];
    try { assertProj(bad); } catch (e) { if (!(e instanceof z.ZodError)) throw e; issues = e.issues; }
    expect(issues.map((i) => i.path)).toContainEqual(["table", "pillars", "backing", "pricedUnknown"]);
  });

  it("rehydrates admitted card shards without losing public evidence or optional fields", () => {
    const ins = ["beta", "alpha"].map((id) => rfx(id));
    ins[0]!.display = { ...ins[0]!.display, labels: { ...ins[0]!.display?.labels, "control:mint": "Mint \u2014 public evidence" } };
    const exp = ins.map(pc).sort((a, b) => (a.id < b.id ? -1 : 1)), p = mkProj();
    for (const i of ins) p.project(i);
    ins[0]!.display = { ...ins[0]!.display, labels: { "control:mint": "Changed after projection" } };
    const resp = p.finalize({ ...meta("shard-round-trip"), resultDigest: compactDigest(ins.map((i) => compactTrace(i.trace))) });
    expect(resp.cards).toEqual(exp); expect(RespSchema.safeParse(resp).success).toBe(true);
  });

  it("releases evaluator signal objects before common-mode reconciliation without changing publication", () => {
    const results = ["alpha", "beta"].map((id) => rfx(id));
    for (const i of results) i.trace = { ...i.trace, structuralSignals: [{ kind: "centralized-mint", severity: "high", reason: "Shared mint authority.", economicLossScope: "global-claim", responsibility: "measured-adverse", pricedInPillar: "control", failureDomainKeys: ["mint-control:shared"], evidence: [] }] };
    const args = { ...meta("common-mode-ownership"), commonModeGroups: [{ failureDomain: { kind: "mint-control" as const, key: "shared" }, members: results.map((i) => ({ assetId: i.trace.assetId, owner: "control" as const, pathKey: "mint" })) }] };
    const exp = buildResp({ ...args, results }), p = mkProj();
    for (const i of results) { const sig = Proxy.revocable(i.trace.structuralSignals[0]!, {}); p.project({ ...i, trace: { ...i.trace, structuralSignals: [sig.proxy] } }); sig.revoke(); }
    expect(p.finalize({ ...args, resultDigest: exp.resultDigest })).toEqual(exp);
    expect(exp.commonModeGroups).toEqual([{ id: "mint-control:shared", kind: "mint-control", key: "shared", memberAssetIds: ["alpha", "beta"] }]);
  });

  it.each([null, 0.64])("ignores retired local Backing stamps for public and compact identity (ratio %s)", (ratio) => {
    const ord = evalBack({ archetype: "fiat-cash", asset: backAsset([exposure({ key: "cash", weight: 1, issuer: "issuer:cash" })]), components: Object.keys(POL.policy.semantic.backing.archetypes["fiat-cash"].componentWeights).map((componentKey) => ({ componentKey, fact: { status: knownStatus(`evidence:${componentKey}`), quality: "strong" as const, failureDomains: [] } })) }, POL);
    const back = applyCollat(ord, ratio === null ? null : { measurementId: "measurement:coverage", measuredAt: "2026-10-01", ratio, sourceUrl: "https://example.com/coverage", status: knownStatus("evidence:coverage", "mechanism.required") }, POL, Date.parse("2026-10-03T00:00:00Z") / 1e3);
    expect(back.score).toBe(ord.score! * (ratio ?? 1));
    const pr = (r: typeof back) => {
      const i = fx("asset", { score: 70, grade: "B", pillars: { backing: r.score, exit: 90, control: 94 } });
      i.backing = r;
      setScored(i, mkScoreIn({ pillars: i.scoreInput.pillars }));
      const compact = compactTrace(i.trace);
      return { cardBytes: js(pc(i)), compact, digest: compactDigest([compact]) };
    };
    expect(pr(back)).toEqual(pr({ ...back, policyId: "retained-policy", policySemanticDigest: "a".repeat(64), traceDigest: "b".repeat(64) } as typeof back));
  });

  it.each([
    [0.8999994999, 0.899999], [0.8999995, 0.9], [0.8999995001, 0.9], [0.8999999999, 0.9], [0.9, 0.9],
    [0.9000000001, 0.9], [0.9000004999, 0.9], [0.9000005, 0.900001], [0.9000005001, 0.900001],
  ])("projects the evaluator's full-precision peg boundary without moving scores or grades: %s", (mult, pubMult) => {
    const i = rfx("peg-boundary"), exp = i.policy.policy.semantic.formula.pegExponent, ps = 100 * mult ** (1 / exp), raw = (ps / 100) ** exp;
    setScored(i, mkScoreIn({ assetId: "peg-boundary", pillars: i.scoreInput.pillars, peg: { ...i.scoreInput.peg, score: ps } }));
    const c = pc(i);
    expect(c).toMatchObject({ score: i.trace.finalScore, grade: i.trace.finalGrade, pegMultiplier: pubMult });
    expect(c.scoreTrace.adverseAttribution.items.some((x) => x.source === "peg-performance")).toBe(raw < PEG_FLOOR);
    expect(i.trace.adverseAttribution.filter((x) => x.source === "peg-performance")).toEqual(
      raw < PEG_FLOOR ? [{ source: "peg-performance", path: "peg:historical-performance", message: `Measured peg multiplier is ${c.pegMultiplier}.`, responsibility: "measured-adverse" }] : [],
    );
  });

  it("admits only rounding intervals intersecting the raw adverse side, with exact path and message reconciliation", () => {
    const i = rfx("peg-interval"), fl = PEG_FLOOR;
    setScored(i, mkScoreIn({ assetId: "peg-interval", pillars: i.scoreInput.pillars, peg: { ...i.scoreInput.peg, score: 100 * fl ** (1 / i.policy.policy.semantic.formula.pegExponent) } }));
    const c = pc(i);
    for (const m of [fl - 1e-6, fl, fl + 0.5e-6, fl + 1e-6]) {
      const cand = sc(c);
      cand.scoreTrace.stages.pegMultiplier = cand.pegMultiplier = m;
      cand.scoreTrace.adverseAttribution.items = [{ source: "peg-performance", path: "peg:historical-performance", message: `Measured peg multiplier is ${Math.round(m * 1e6) / 1e6}.`, responsibility: "measured-adverse" }];
      expect(ok(cand)).toBe(m < fl + 0.5e-6);
      for (const f of ["path", "message"] as const) { const inv = sc(cand); inv.scoreTrace.adverseAttribution.items[0]![f] = "wrong"; expect(ok(inv)).toBe(false); }
    }
  });

  it("derives public owner order and the peg validator floor from their canonical authorities", () => {
    expect(PEG_FLOOR).toBe(POL.policy.semantic.formula.danger.adverseAttributionPegMultiplierFloor);
    const c = pc(rfx("owner-order")), owners = [...OwnerSchema.options].sort();
    expect(PUB_OWNERS).toEqual(owners);
    expect(c.scoreTrace.evidenceResponsibility.summaries.map((s) => s.responsibility)).toEqual(owners);
    expect(new Set(owners).size).toBe(OwnerSchema.options.length);
  });

  it("publishes typed identity for the primary and included/excluded alternatives", () => {
    const i = rfx("identity"), pri = i.exit!.routes[0]!;
    i.exit = { ...i.exit!, routes: [pri, { ...pri, routeKey: "opaque:included", routeId: "distinct-included", lane: "dex", routeFamily: "dex-amm" }, { ...pri, routeKey: "opaque:excluded", routeId: "distinct-excluded", score: null, included: false, exclusionReason: "missing-same-notional-route", capacityPoint: null, components: null, confidenceFactor: null, confidenceDimensions: null }] };
    const c = pc(i);
    expect(c.breakdowns!.exit.primaryRoute).toMatchObject({ routeId: "fixture", lane: "redemption" });
    expect(c.breakdowns!.exit.alternatives).toMatchObject([{ key: "opaque:excluded", routeId: "distinct-excluded", lane: "redemption", included: false }, { key: "opaque:included", routeId: "distinct-included", lane: "dex", included: true }]);
    type Leg = { breakdowns: { exit: { primaryRoute: Record<string, unknown>; alternatives: Record<string, unknown>[] } } };
    const leg = sc(c) as unknown as Leg; delete leg.breakdowns.exit.primaryRoute.routeId; delete leg.breakdowns.exit.primaryRoute.lane; expect(ok(leg)).toBe(false);
    const mAlt = sc(c) as unknown as Leg; delete mAlt.breakdowns.exit.alternatives[0]!.routeId; expect(ok(mAlt)).toBe(false);
  });

  it("publishes original stale supply provenance separately from the stress request", () => {
    const i = rfx("sizing-provenance");
    i.exit = { ...i.exit!, stressRequest: { ...i.exit!.stressRequest!, requestedNotionalUsd: 25e6, supplyObservedAtSec: 1.7e9, sizingUncertaintyReason: "stale-supply" } };
    const c = pc(i);
    expect(c.breakdowns!.exit.stressRequest).toMatchObject({ requestedNotionalUsd: 25e6, supplyObservedAtSec: 1.7e9, sizingUncertaintyReason: "stale-supply" });
    expect(ok(c)).toBe(true);
  });

  it.each([
    ["missing-runtime-route-evidence", "missing-same-notional-route", "exit-routes"],
    ["missing-oracle-profile", "unresolved-oracle-branch-applicability", "economic-control:oracle"],
    ["missing-same-notional-route", "unproven-settlement-bound", "settlement"],
    ["unresolved-exit-output", "unsupported-same-notional-route", "output"],
    ["missing-reserve-composition", "partial-reserve-review", "reserve-composition"],
    ["unreviewed-dependency-relationships", "material-dependency-unavailable", "effective-dependencies"],
  ] as const)("counts %s / %s as one exact obligation while retaining both witnesses", (code, alias, datum) => {
    const i = rfx("asset"), base = pc(i), g = `asset:gap:${datum}`;
    i.trace.unresolvedFacts = [
      ufact(code, "control:source", "Source obligation.", { sourceGapId: g, causeGapIds: [g] }),
      ufact(alias, "control:scoring-witness", "Scoring witness.", { ...(alias === "partial-reserve-review" || alias === "material-dependency-unavailable" ? {} : { sourceGapId: g }), causeGapIds: [g] }),
    ];
    const c = rt(publish([i], meta("obligation-test"))).cards[0]!, ev = c.scoreTrace.evidenceResponsibility;
    expect(ev.totalFactCount).toBe(2);
    expect([...iterFacts(ev)].map((r) => [r[0], r[1]])).toEqual([[code, "control:source"], [alias, "control:scoring-witness"]]);
    expect(ev.summaries.find((s) => s.responsibility === "unresearched")).toMatchObject({ factCount: 1, reasonCodes: [code, alias].sort() });
    expect([c.score, c.grade, c.caps, c.nrReasons, c.scoreTrace.stages, c.scoreTrace.boundedUncertaintyAttribution]).toEqual([base.score, base.grade, base.caps, base.nrReasons, base.scoreTrace.stages, base.scoreTrace.boundedUncertaintyAttribution]);
  });

  it.each([false, true])("reconciles repeated causal roots with critical=%s canonical emitted facts", (critical) => {
    const i = critical ? fxNr("asset") : rfx("asset"), base = pc(i), g = "asset:gap:reserve-composition";
    i.trace.unresolvedFacts = [
      ufact("missing-reserve-composition", "backing:source", "One source obligation.", { sourceGapId: g, causeGapIds: [g] }),
      ufact("partial-reserve-review", "backing:scoring-witness", "Repeated causal witnesses.", { critical, causeGapIds: [g, g] }),
    ];
    const c = rt(publish([i], meta("canonical-causes-test"))).cards[0]!, ev = c.scoreTrace.evidenceResponsibility;
    expect(ev.totalFactCount).toBe(2); expect(ev.facts).toHaveLength(2);
    expect(typeof ev.facts[1]![6]).toBe("number"); expect([...iterFacts(ev)][1]![6]).toHaveLength(1);
    const sum = ev.summaries.find((s) => s.responsibility === "unresearched");
    expect(sum).toMatchObject({ factCount: 1, ...(critical ? { criticalFactCount: 1 } : {}), reasonCodes: ["missing-reserve-composition", "partial-reserve-review"] });
    expect(sum?.criticalFactCount ?? 0).toBe(Number(critical));
    expect([c.score, c.grade]).toEqual([base.score, base.grade]);
    const mis = sc(c); mis.scoreTrace.evidenceResponsibility.summaries.find((s) => s.responsibility === "unresearched")!.factCount = 2;
    expect(ok(mis)).toBe(false);
  });

  it("carries documentation facts on the trace and publishes only resolvable documentation cause gaps", () => {
    const doc = "asset:gap:keyCustody", i = rfx("asset");
    i.trace.unresolvedFacts = [
      ufact("unresolved-control-identity", "control:custody", "Custody question.", { sourceGapId: doc, causeGapIds: [doc] }),
      ufact("bounded-mechanism-review", "backing:mechanism", "Mechanism review.", { sourceGapId: "asset:gap:mechanism", causeGapIds: ["asset:gap:mechanism"] }),
    ];
    i.documentationGapIds = new Map([[doc, { reason: "no-scoring-path", policyRef: "semantic.evidence.documentation.reasons.no-scoring-path", threshold: null }]]);
    const resp = publish([i], { ...meta("documentation-carrier-test"), documentationCauseGaps: [doc, "asset:gap:absent"] });
    const ev = rt(resp).cards[0]!.scoreTrace.evidenceResponsibility;
    expect(ev.documentation).toEqual({ semantics: "documentation-class-v1", totalFactCount: 1, criticalFactCount: 0, summaries: [{ reason: "no-scoring-path", factCount: 1 }] });
    expect(ev.summaries.find((s) => s.responsibility === "unresearched")).toMatchObject({ factCount: 2, documentationFactCount: 1 });
    expect(resp.documentationCauseGaps).toEqual([doc]);
  });

  it("refuses to publish a critical evidence fact as documentation", () => {
    const g = "asset:gap:critical-datum", i = rfx("asset");
    i.trace.unresolvedFacts = [ufact("unresolved-control-identity", "control:critical", "Critical datum.", { critical: true, sourceGapId: g, causeGapIds: [g], scoringDisposition: "not-applicable" })];
    i.documentationGapIds = new Map([[g, { reason: "no-scoring-path", policyRef: "semantic.evidence.documentation.reasons.no-scoring-path", threshold: null }]]);
    expect(() => project(i)).toThrow(/critical evidence fact as documentation/u);
  });

  it("counts critical roots once and preserves distinct, foreign, gapless and multi-root obligations", () => {
    const facts = [
      { s: "local:gap:first", c: ["local:gap:first"], k: false }, { s: "local:gap:first", c: ["local:gap:first"], k: true },
      { s: null, c: ["local:gap:first"], k: true }, { s: "local:gap:second", c: ["local:gap:second"], k: false },
      { s: null, c: ["foreign:gap:first"], k: false }, { s: null, c: ["foreign:gap:first"], k: false },
      { s: null, c: [], k: true }, { s: null, c: [], k: false }, { s: null, c: ["local:gap:first", "local:gap:second"], k: false },
    ];
    for (const o of [facts, [...facts].reverse()]) expect(countObl(o, (f) => f.s, (f) => f.c, (f) => f.k)).toEqual({ factCount: 7, criticalFactCount: 2 });
  });

  it("omits null optional metadata while preserving known empty dependency coverage", () => {
    const i = fx70("frax-frax"), base = js(pc(i));
    i.sharedBookId = null; i.access = { ...i.access, freezeLookthrough: null };
    expect(js(pc(i))).toBe(base);
    i.dependencyCoverage = []; expect(pc(i).dependencyCoverage).toEqual([]);
    i.sharedBookId = "reviewed-shared-book";
    i.dependencyCoverage = [{ upstreamLabel: "Unresolved issuer", upstreamAssetId: null, share: null, reason: "Identity remains unverified", sourceAsOf: null, identityVerified: false }];
    const c = CardSchema.parse(pc(i));
    expect(c.sharedBookId).toBe("reviewed-shared-book"); expect(c.dependencyCoverage).toEqual(i.dependencyCoverage);
  });

  it.each([
    ["stray-percent", "literal%", false], ["literal-percent-escape", "parent:gap:literal%20", false],
    ["unencoded-colons", "parent:gap:reserve:liquidity", false], ["encoded-round-trip", "parent:gap:reserve:liquidity %", true],
  ] as const)("round-trips %s causal paths without inventing foreign gap identities", (id, g, enc) => {
    const i = rfx(id);
    i.trace.unresolvedFacts = [ufact("unresolved-control-identity", `control:mint:cause:${enc ? encodeURIComponent(g) : g}`, "Mint authority is unresolved.", { sourceGapId: g, causeGapIds: [g] })];
    const dec = rt(publish([i], meta("causal-path-test"))), c = dec.cards[0]!;
    expect(dec.foreignCauseGaps).toEqual([g]); expect(c.localCauseGaps).toEqual([]); expect(c.score).toBe(91.8);
    const facts = [...iterFacts(c.scoreTrace.evidenceResponsibility)];
    expect(facts).toEqual([["unresolved-control-identity", "control:mint:cause:0", 0, "unresearched", false, "U", [0]]]);
    expect(resolveGap(dec, c, facts[0]![2]!)).toBe(g);
  });

  it("remaps separately admitted foreign gaps to the shared publication authority", () => {
    const res = ([["alpha", "parent-z:gap:mint"], ["beta", "parent-a:gap:mint"]] as const).map(([id, g]) => {
      const i = rfx(id);
      i.trace.unresolvedFacts = [ufact("unresolved-control-identity", `control:mint:cause:${g}`, "Mint authority is unresolved.", { sourceGapId: g, causeGapIds: [g] })];
      return i;
    });
    const resp = publish(res, meta("foreign-gap-test"));
    expect(resp.foreignCauseGaps).toEqual(["parent-a:gap:mint", "parent-z:gap:mint"]);
    expect(resp.cards.map((c) => c.foreignCauseGapRefs)).toEqual([[1], [0]]);
    expect(resp.cards.map((c) => resolveGap(resp, c, [...iterFacts(c.scoreTrace.evidenceResponsibility)][0]![2]!))).toEqual(["parent-z:gap:mint", "parent-a:gap:mint"]);
  });

  it("keeps the publication clock boundary after individual card admission", () => {
    expect(() => publish([rfx("alpha")], { ...meta("clock-test"), publishedAtSec: 999 })).toThrow("Publication cannot predate evidence");
  });

  it("keeps a pipeline gap distinct from NR while retaining the surviving diagnostic pillar", () => {
    const c = pc(fx("pipeline-gap", { score: null, grade: null, pillars: { backing: null, exit: null, control: 94 } }));
    expect(c).toMatchObject({ ratingStatus: "pipeline-gap", score: null, grade: null, qualityScore: null, pegAdjustedScore: null, pegMultiplier: null, weakestPillar: null, nrReasons: [], partialEvidence: { excludedPillars: ["backing", "exit"], causes: ["A"] }, pillars: { control: { score: 94 } }, scoreTrace: { aggregation: null } });
    expect(c.reasonCodes).toContain("single-pillar-pipeline-gap"); expect(c.breakdowns?.control.components[0]?.score).toBe(94);
    expect(ok({ ...c, grade: "NR" })).toBe(false);
  });

  it("projects an A/B exclusion that owns no priced component", () => {
    const i = fx70("b-awaiting-curation");
    i.trace.partialEvidence = { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [], excludedComponentKeys: [], causeGapIds: ["control:gap:economic-control:oracle"], causes: ["B"] };
    i.reasonCodes = ["partial-evidence-pipeline-gap"];
    const c = pc(i);
    expect(c.partialEvidence).toMatchObject({ excludedPillars: [], excludedComponentKeys: [], causes: ["B"] });
    expect(c.partialEvidence?.causeGapRefs).toHaveLength(1); expect(c.ratingStatus).toBe("rated"); expect(ok(c)).toBe(true);
  });

  it.each([false, true])("projects unavailable pillars with optional diagnostic gaps (%s)", (diag) => {
    const i = fx("unavailable", { score: null, grade: null, pillars: { backing: null, exit: null, control: 94 } });
    Object.assign(i.trace.partialEvidence!, { causes: [], causeGapIds: [], excludedComponentKeys: [] });
    for (const p of ["backing", "exit"] as const) Object.assign(i.scoreInput.pillars[p], { aggregationDisposition: "unavailable", causeGapIds: diag ? [`unavailable:gap:${p}`] : [] });
    const c = pc(i);
    expect(c.ratingStatus).toBe("pipeline-gap"); expect(c.partialEvidence?.causes).toEqual([]);
    expect(c.partialEvidence?.causeGapRefs).toHaveLength(diag ? 2 : 0);
  });

  it("retains local diagnostics alongside inherited A gaps in an excluded wrapper pillar", () => {
    const i = fx("srusd-reservoir", { score: null, grade: null, pillars: { backing: 92, exit: null, control: null } });
    const pG = "rusd-reservoir:gap:route:redemption:capacity", lG = "srusd-reservoir:gap:route:redemption:capacity", dG = "srusd-reservoir:gap:exit-route:redemption:access";
    const pe = i.trace.partialEvidence!;
    pe.causeGapIds.push(pG, lG); pe.excludedComponentKeys.push("dependency:parent", "redemption:srusd");
    Object.assign(i.scoreInput.pillars.exit, { causeGapIds: [...i.scoreInput.pillars.exit.causeGapIds, pG, lG, dG], excludedCauseGapIds: [lG], excludedComponentKeys: ["redemption:srusd"], excludedCauses: ["A"] });
    const orig = sc(pe);
    i.trace.unresolvedFacts = [
      ufact("missing-same-notional-route", `exit:route:cause:${dG}`, "Access has not been researched.", { sourceGapId: dG, causeGapIds: [dG] }),
      ufact("missing-same-notional-route", `exit:summary:cause:${dG}`, "Diagnostic access view.", { causeGapIds: [dG] }),
    ];
    const resp = publish([i], { ...meta("wrapper-diagnostic-test"), policyVersion: "10.12" }), c = resp.cards[0]!;
    expect(c.partialEvidence!.causeGapRefs.map((r) => resolveGap(resp, c, r)).sort()).toEqual([...new Set([...pe.causeGapIds, dG])].sort());
    expect(c.foreignCauseGapRefs.map((r) => resp.foreignCauseGaps[r])).toContain(pG);
    expect(c.partialEvidence).toMatchObject({ excludedPillars: ["control", "exit"], causes: ["A"], excludedComponentKeys: expect.arrayContaining(["dependency:parent", "redemption:srusd"]) });
    expect(c).toMatchObject({ ratingStatus: "pipeline-gap", score: null, grade: null });
    expect(c.pillars.exit.causeGapRefs!.every((r) => c.partialEvidence!.causeGapRefs.includes(r))).toBe(true);
    const facts = [...iterFacts(c.scoreTrace.evidenceResponsibility)];
    expect(facts.map((f) => f[5])).toEqual(["U", "U"]);
    expect(facts.map((f) => f[6].map((r) => resolveGap(resp, c, r)))).toEqual([[dG], [dG]]);
    expect(facts.map((f) => f[2] === null ? null : resolveGap(resp, c, f[2]))).toEqual([dG, null]);
    expect(c.scoreTrace.evidenceResponsibility.totalFactCount).toBe(2);
    expect(c.scoreTrace.evidenceResponsibility.summaries.find((s) => s.responsibility === "unresearched")?.factCount).toBe(1);
    expect(i.trace.partialEvidence).toBe(pe); expect(pe).toEqual(orig); expect(pe.causeGapIds).not.toContain(dG);
    const rej = CardSchema.safeParse({ ...c, partialEvidence: { ...c.partialEvidence!, causeGapRefs: c.partialEvidence!.causeGapRefs.filter((r) => resolveGap(resp, c, r) !== dG) } });
    expect(rej.success).toBe(false);
    expect(rej.error?.issues).toContainEqual({ code: "custom", path: ["partialEvidence"], message: "Excluded pillar gaps must remain visible in partial evidence" });
  });

  it.each(PILS)("projects post-dependency exclusions while retaining the surviving %s diagnostic", (surv) => {
    const scores = { backing: 92, exit: 90, control: 94 }, diag = { backing: null as number | null, exit: null as number | null, control: null as number | null, [surv]: scores[surv] };
    const i = fx("parent-gap-child", { score: null, grade: null, pillars: diag }), loc = rfx("parent-gap-child");
    Object.assign(i, { backing: loc.backing, exit: loc.exit, control: loc.control, display: loc.display });
    if (surv !== "backing") i.backing = { ...i.backing!, score: 35, contributions: [{ ...i.backing!.contributions[0]!, score: 35, weightedScore: 35, cause: "D", causeGapIds: ["parent-gap-child:gap:known-local-risk"], scoringDisposition: "measured-adverse" }] };
    const resp = publish([i], meta("parent-gap-test")), c = rt(resp).cards[0]!;
    expect(c).toMatchObject({ ratingStatus: "pipeline-gap", score: null, grade: null });
    for (const p of PILS) expect(c.breakdowns![p]).toMatchObject({ aggregationWeight: 0, evaluatedScore: p === surv ? scores[p] : null, publishedScore: p === surv ? scores[p] : null, adjustments: [] });
    if (surv !== "backing") {
      const kr = c.breakdowns!.backing.components[0]!;
      expect(kr).toMatchObject({ score: 35, cause: "D", effectiveScoringWeight: 0, weightedContribution: 0, wholeAssetWeight: 1 });
      expect(resolveGap(resp, c, kr.causeGapRefs![0]!)).toBe("parent-gap-child:gap:known-local-risk");
    }
    if (surv !== "control") expect(c.breakdowns!.control.components[0]!).toMatchObject({ score: 94, effectiveScoringWeight: 0, binding: false });
    if (surv !== "exit") { expect(c.breakdowns!.exit.primaryRoute).toBeNull(); expect(c.breakdowns!.exit.diversification).toBeNull(); expect(c.breakdowns!.exit.alternatives[0]!).toMatchObject({ score: 90 }); }
  });

  it("discloses provider-row identity proof and numerator-only scope, omitting absent or empty records byte-for-byte", () => {
    const i = fx70("frax-frax"), base = js(pc(i));
    i.providerRowExclusions = []; expect(js(pc(i))).toBe(base);
    const review = ExclSchema.parse(FRAX_EXCL);
    i.providerRowExclusions = [{ review, deploymentRouteKey: "unmatched-chain:frax-frax:fraxtal", supplyShare: 0.097 }];
    const c = CardSchema.parse(pc(i));
    expect(c.scoreTrace.providerRowExclusions).toEqual([{ review, deploymentRouteKey: "unmatched-chain:frax-frax:fraxtal", supplyShare: 0.097 }]);
    expect(c.score).toBe(70); expect(c.supply).toEqual(jp(base).supply);
    expect(c.scoreTrace.providerRowExclusions![0]!.review).toMatchObject({ belongsToAssetId: "frxusd-frax", providerChainLabel: "Fraxtal", contractAddress: "0xfc00000000000000000000000000000000000001" });
  });

  it("publishes effective weighted signatures without turning unknown key bypasses into quorum credit", () => {
    const i = fx70("alpha"), w = weightedQuorum([...Array<number>(8).fill(24), ...Array<number>(18).fill(1)], 25);
    const ctrl = mkCtrl("control:mint", "mint", { authority: { authorityKey: w.deployment, model: "multisig", threshold: null, weightedQuorum: w } });
    i.control = { ...i.control!, components: [{ ...i.control!.components[0]!, controlKeys: [ctrl.controlKey] }], controlFacts: [ctrl] };
    const det = () => { const b = CardSchema.parse(pc(i)).breakdowns!.control; return resCtrl(b, b.components[0]!)[0]!; };
    expect(det().minimumCryptographicSignatures).toBe(2);
    ctrl.authority!.weightedQuorum = { ...w, masterKey: "enabled" }; expect(det().minimumCryptographicSignatures).toBe(1);
    ctrl.authority!.weightedQuorum = { ...w, regularKey: { state: "unknown" } }; expect(det().minimumCryptographicSignatures).toBeNull();
  });

  it("publishes only the owning execution path on each path-scoped control component", () => {
    const pr = (n: number) => {
      const i = fx70("alpha"), path = reviewedScope().paths[0]!;
      const scope = reviewedScope({ paths: Array.from({ length: n }, (_, k) => ({ ...path, id: `path-${String(k).padStart(2, "0")}` })) });
      const ctrls = scope.paths.map((p) => Object.assign(mkCtrl(`control:mint:path:${p.id}`, "mint", { executionScope: scope, executionScopeComplete: true }), { executionPathId: p.id }));
      i.control = { ...i.control!, controlFacts: ctrls, components: ctrls.map((c) => ({ ...i.control!.components[0]!, componentKey: c.controlKey, controlKeys: [c.controlKey] })) };
      const bd = resolveW(CardSchema.parse(pc(i))).breakdowns!.control;
      return bd.components.map((c) => ({ ...c, controlDetails: resCtrl(bd, c) }));
    };
    const sm = pr(2), lg = pr(40);
    for (const c of lg) expect(c.controlDetails![0]!.executionPaths).toEqual([{ id: c.key.split(":path:")[1], targetDeployment: reviewedScope().controllerDeployment, entrypointKind: "evm-selector", entrypoints: ["0x40c10f19"], activation: "active", reach: "root", capabilities: ["mint"] }]);
    expect([js(lg[0]), js(lg[1])]).toEqual([js(sm[0]), js(sm[1])]);
  });

  it("preserves certificate and contributor paths for controls without a path scope", () => {
    const i = fx70("alpha"), scope = reviewedScope(), contrib = reviewedScope({ paths: [{ ...scope.paths[0]!, id: "upgrade", capabilities: ["upgrade"] }] });
    const ctrl = mkCtrl("control:mint", "mint", { executionScope: scope, executionScopeContributors: [{ authorityKey: contrib.controllerDeployment, scope: contrib }] });
    i.control = { ...i.control!, components: [{ ...i.control!.components[0]!, controlKeys: [ctrl.controlKey] }], controlFacts: [ctrl] };
    const bd = CardSchema.parse(pc(i)).breakdowns!.control;
    expect(resCtrl(bd, bd.components[0]!)[0]!.executionPaths.map((p) => [p.id, p.capabilities])).toEqual([["issuance", ["mint"]], ["upgrade", ["upgrade"]]]);
  });

  it("tells same-label control rows apart by execution path, then authority, then deployment", () => {
    const i = fx70("alpha"), auth = { authorityKey: "ethereum:0xc71104001a3ccda1bef1177d765831bd1bfe8ee6", model: "eoa" as const, threshold: null };
    const facts = [
      mkCtrl("mint-meta:alpha:gov:path:minority-veto", "governance", { deploymentKey: "asset:alpha", authority: auth, executionPathId: "minority-veto" }),
      mkCtrl("mint-meta:alpha:gov:path:token-burn", "governance", { deploymentKey: "asset:alpha", authority: auth, executionPathId: "token-burn" }),
      mkCtrl("mint-meta:alpha:sol-a", "mint", { deploymentKey: "asset:alpha", authority: { authorityKey: "solana:FeNxBnWpakMhvk1nL1h2sqvbH1tY8z8T2MpA6UhcFi9s", model: "eoa", threshold: null } }),
      mkCtrl("mint-meta:alpha:sol-b", "mint", { deploymentKey: "asset:alpha", authority: { authorityKey: "solana:3WNoR4QJDbehTb6aA6fGz6qVk2b8XtqS1hZ5yFZXwDWc", model: "eoa", threshold: null } }),
    ];
    const comp = i.control!.components[0]!;
    i.control = { ...i.control!, controlFacts: facts, components: [comp, ...facts.map((f) => ({ ...comp, componentKey: `mint:deployment:${f.controlKey}`, binding: false, controlKeys: [f.controlKey] }))] };
    const labels = resolveW(CardSchema.parse(pc(i))).breakdowns!.control.components.flatMap((r) => (r.key.startsWith("mint:deployment:") ? [r.label] : []));
    expect(labels).toEqual(["Ethereum governance authority · minority veto", "Ethereum governance authority · token burn", "Solana mint authority · FeNxBn…Fi9s", "Solana mint authority · 3WNoR4…wDWc"]);
  });

  it("names single-control mint and bridge rows after the chain and role of the fact that scored them", () => {
    const i = fx70("alpha"), nat = mkCtrl("mint-meta:alpha:upgrade", "upgrade", { deploymentKey: "asset:alpha", authority: { authorityKey: "xlayer:0x86a2b15f6ef67af32a6b7c43903cdecb1f540ec1", model: "eoa", threshold: null } });
    const iss = mkCtrl("mint-meta:alpha:issuer", "mint", { deploymentKey: "asset:alpha", authority: { authorityKey: "issuer-backend:alpha", model: "issuer-backend", threshold: null } });
    const br = mkCtrl("bridge-meta:alpha:taiko", "bridge", { deploymentKey: "taiko:0x07d83526730c7438048d55a4fc0b850e2aab6f0b" });
    const sent = mkCtrl("bridge-meta:alpha:group", "bridge", { deploymentKey: "representation-group:alpha" }), b = i.control!.components[0]!;
    i.control = { ...i.control!, controlFacts: [nat, iss, br, sent], components: [
      { ...b, componentKey: "mint", controlKeys: [nat.controlKey] },
      { ...b, componentKey: "mint:deployment:issuer", binding: false, controlKeys: [iss.controlKey] },
      { ...b, componentKey: "mint:bridge:bridge-meta:alpha:taiko", binding: false, controlKeys: [br.controlKey] },
      { ...b, kind: "bridge", posture: "external-lock-mint", componentKey: "bridge:taiko:0x07d83526730c7438048d55a4fc0b850e2aab6f0b:bridge-meta:alpha:taiko", binding: false, controlKeys: [br.controlKey] },
      { ...b, componentKey: "mint:bridge:bridge-meta:alpha:group", binding: false, controlKeys: [sent.controlKey] },
      { ...b, componentKey: "mint:upgrade", controlKeys: [] },
    ] };
    expect(Object.fromEntries(resolveW(CardSchema.parse(pc(i))).breakdowns!.control.components.map((r) => [r.key, r.label]))).toEqual({
      mint: "Native mint authority", "mint:deployment:issuer": "Mint authority", "mint:bridge:bridge-meta:alpha:taiko": "Taiko bridged-token mint",
      "bridge:taiko:0x07d83526730c7438048d55a4fc0b850e2aab6f0b:bridge-meta:alpha:taiko": "Taiko bridge",
      "mint:bridge:bridge-meta:alpha:group": "Bridged-token mint", "mint:upgrade": i.display?.labels?.["mint:upgrade"] ?? "Mint authority",
    });
  });

  it("shares complete control details across semantic components and rejects invalid or unused references", () => {
    const i = fx70("alpha"), fact = mkCtrl("control:shared", "mint", { executionScope: reviewedScope() });
    i.control = { ...i.control!, controlFacts: [fact], components: ["mint", "mint:bridge:shared"].map((componentKey) => ({ ...i.control!.components[0]!, componentKey, controlKeys: [fact.controlKey] })) };
    const c = resolveW(CardSchema.parse(pc(i))), ctrl = c.breakdowns!.control;
    expect(ctrl.controlDetails).toHaveLength(1); expect(ctrl.components.map((x) => x.controlDetailRefs)).toEqual([[0], [0]]);
    expect(resCtrl(ctrl, ctrl.components[0]!)).toEqual(resCtrl(ctrl, ctrl.components[1]!));
    for (const mut of [
      (x: typeof c) => { x.breakdowns!.control.components[0]!.controlDetailRefs = [1]; },
      (x: typeof c) => { x.breakdowns!.control.components.forEach((comp) => { delete comp.controlDetailRefs; }); },
      (x: typeof c) => { x.breakdowns!.control.controlDetails!.push(sc(ctrl.controlDetails![0]!)); x.breakdowns!.control.components[1]!.controlDetailRefs = [1]; },
    ]) { const bad = sc(c); mut(bad); expect(ok(bad)).toBe(false); }
    const { controlDetails: _t, ...legCtrl } = ctrl, { routeId: _r, lane: _l, ...legRoute } = c.breakdowns!.exit.primaryRoute!;
    const legacy = { ...c.breakdowns!, exit: { ...c.breakdowns!.exit, primaryRoute: { ...legRoute, eligibilityMultiplier: 1 } }, control: { ...legCtrl, components: ctrl.components.map(({ controlDetailRefs: _refs, ...f }) => ({ ...f, controlDetails: resCtrl(ctrl, { ...f, controlDetailRefs: [0] }) })) } };
    expect(() => HistBdSchema.parse(legacy)).not.toThrow(); expect(ok({ ...c, breakdowns: legacy })).toBe(false);
  });

  it("publishes wrapper forms only on wrapper claims, not sibling mechanism claims", () => {
    const i = fx("dependent", { score: 64, grade: "C+", caps: [cap("parent", 64, "parent", "Parent limit.", true)], dependency: { assetId: "dependent", basket: [], cycleBlocked: false, serial: [{ upstreamAssetId: "mechanism", score: 67, blocked: false }, { upstreamAssetId: "wrapper", score: 67, blocked: false }] } });
    i.dependencyTypes = new Map([["serial:mechanism", "mechanism"], ["serial:wrapper", "wrapper"]]);
    i.trace.wrapperParentLimit = { schemaVersion: 1, parentScore: 67, form: "pure", appliedDiscount: 3, limit: 64 };
    expect(pc(i).dependencies.serial).toMatchObject([{ upstreamAssetId: "mechanism", dependencyType: "mechanism", wrapperForm: null }, { upstreamAssetId: "wrapper", dependencyType: "wrapper", wrapperForm: "pure" }]);
  });

  it("reconciles concentrated collateral separately without relaxing serial-parent validation", () => {
    const i = fx("concentrated", { score: 64, grade: "C+", caps: [cap("parent", 64, "parent", "Collateral parent limit.", true)], dependency: { assetId: "concentrated", serial: [], cycleBlocked: false, basket: [{ upstreamAssetId: "collateral", weight: 0.99, score: 95, boundedUnknown: false }] } });
    i.trace.wrapperParentLimit = { schemaVersion: 1, parentKind: "concentrated-collateral", parentAssetId: "collateral", parentScore: 67, form: "pure", appliedDiscount: 3, limit: 64 };
    const c = pc(i);
    expect(c.dependencies.basket[0]).toMatchObject({ score: 95, collateralParentScore: 67 }); expect(ok(c)).toBe(true);
    expect(attrParent(c, "parent:collateral:incident", "Required parent collateral: incident")).toMatchObject({ upstreamAssetId: "collateral", score: 67, blocked: false });
    expect(attrParent(c, "parent:other:incident", "Required parent other: incident")).toBeNull();
    const mis = sc(c); mis.dependencies.basket[0]!.collateralParentScore = 68;
    expect(attrParent(mis, "parent:collateral:incident", "Required parent collateral: incident")).toBeNull();
    for (const mut of [
      (b: typeof c) => { b.scoreTrace!.wrapperParentLimit!.parentKind = "serial"; delete b.scoreTrace!.wrapperParentLimit!.parentAssetId; },
      (b: typeof c) => { b.dependencies.basket[0]!.weight = 0.98; },
      (b: typeof c) => { b.dependencies.basket[0]!.collateralParentScore = 68; },
      (b: typeof c) => { b.scoreTrace!.wrapperParentLimit!.parentAssetId = "other"; },
    ]) { const bad = sc(c); mut(bad); expect(ok(bad)).toBe(false); }
  });

  it("projects cap-bound, pillar-bound, and withheld top drivers from the card", () => {
    const capB = pc(fx("cap-bound", { score: 49, grade: "D", caps: [cap("active-depeg:d", 49, "active-depeg", "A current severe depeg binds.", true)] }));
    expect(topDrv(capB)).toEqual({ kind: "cap-bound", label: "active-depeg:d", value: 49, reason: "A current severe depeg binds.", evidenceFreshness: "current" });
    const pilB = pc(rfx("pillar-bound"));
    expect(topDrv(pilB)).toEqual({ kind: "pillar-bound", label: "exit", value: 90, reason: "Exit is the weakest pillar at 90/100.", evidenceFreshness: "current" });
    const pegS = { aggregatedQualityScore: 52, pegMultiplier: 0.51, baseAssetScore: 26.52 };
    const pegB = sc(pilB); Object.assign(pegB.scoreTrace.stages, pegS);
    expect(topDrv(pegB)).toMatchObject({ kind: "peg-bound", label: "peg", value: 0.51, quality: 52 });
    const pegW = sc(pilB); Object.assign(pegW.scoreTrace.stages, { ...pegS, baseAssetScore: 51 }); expect(topDrv(pegW)?.kind).toBe("pillar-bound");
    const capP = sc(capB); Object.assign(capP.scoreTrace.stages, pegS); expect(topDrv(capP)?.kind).toBe("cap-bound");
    expect(topDrv(pc(fxNr("withheld")))).toEqual({ kind: "withheld", label: null, value: null, reason: "Backing is missing.", evidenceFreshness: "current" });
  });

  it.each(["backing", "exit"] as const)("uses the existing %s pillar reason without borrowing another pillar", (p) => {
    const i = rfx("pillar-reason");
    i.scoreInput.pillars[p].reasons = [{ code: "missing-pillar-evidence", path: p, message: "The scoped evidence remains unresolved.", responsibility: "integration-missing" }];
    const c = pc(i), w = { ...c, weakestPillar: { pillar: p, score: c.pillars[p].score! }, breakdowns: null }, bef = js(w);
    expect(topDrv(w)?.reason).toBe("The scoped evidence remains unresolved.");
    expect(topDrv(resolveW(w))).toEqual(topDrv(w)); expect(js(w)).toBe(bef);
  });

  it.each(["bounded-admin", "immutable-no-mint", "unknown"])("explains a binding %s mint posture even with no reason codes", (posture) => {
    const c = resolveW(pc(rfx("mint-headline")));
    c.weakestPillar = { pillar: "control", score: c.pillars.control.score! };
    c.breakdowns!.control.components[0]!.posture = posture;
    expect(c.reasonCodes).toEqual([]);
    const drv = topDrv(c);
    expect(drv).toMatchObject({ kind: "pillar-bound", label: "control", value: 94 });
    expect(drv?.reason).toBeTruthy(); expect(drv?.reason).not.toBe(posture);
    if (posture === "unknown") expect(drv?.reason).toBe("The mint authority posture remains unresolved.");
  });

  it("does not use a nonbinding or differently scored mint posture as the headline", () => {
    const c = resolveW(pc(rfx("nonbinding-mint")));
    c.weakestPillar = { pillar: "control", score: c.pillars.control.score! };
    const m = c.breakdowns!.control.components[0]!;
    for (const ch of [{ binding: false }, { score: 93 }]) expect(topDrv({ ...c, breakdowns: { ...c.breakdowns!, control: { ...c.breakdowns!.control, components: [{ ...m, ...ch }] } } })?.reason).toBe("Economic Control is the weakest pillar at 94/100.");
  });

  it("names the binding oracle instead of an unrelated Control gap", () => {
    const c = resolveW(pc(fx("binding-oracle", { score: 57, grade: "C" })));
    c.weakestPillar = { pillar: "control", score: 45 };
    c.pillars.control.reasons = [{ code: "unresolved-control-identity", path: "control:mint", message: "A controller identity remains unresolved." }];
    c.breakdowns!.control.components = [{ ...c.breakdowns!.control.components[0]!, kind: "oracle", score: 45, label: "Privileged internal pricing", posture: "privileged-internal-pricing", binding: true }];
    expect(topDrv(c)?.reason).toBe("Privileged internal pricing limits Economic Control to 45/100.");
  });

  it("rounds a fallback headline without rounding the scoring operands", () => {
    const c = pc(fx("fractional-headline", { score: 80, grade: "A-" }));
    c.weakestPillar = { pillar: "control", score: 79.9999891613885 };
    const bef = js(c);
    expect(topDrv(c)?.reason).toBe("Economic Control is the weakest pillar at 80/100.");
    expect(js(c)).toBe(bef);
  });

  it.each([25, 10])("preserves the F-range cap and headline at %s", (limit) => {
    const pCap = POL.policy.semantic.formula.activeDepegCaps.find((c) => c.limit === limit)!;
    const c = resolveW(pc(fx(`depeg-${limit}`, { score: limit, grade: "F", caps: [{ ...pCap, source: "active-depeg", binding: true }] })));
    expect(c.bindingCap).toMatchObject({ limit, kind: "active-depeg:f", reason: pCap.reason });
    expect(topDrv(c)?.reason).toBe(pCap.reason);
    expect(topDrv(c)?.reason).toContain(`to ${limit}, within the F range.`);
  });

  it("humanizes public prose while preserving exact causal identities and ticker labels", () => {
    const orig = { path: "route:redemption:generation:asset:cost", key: "assuranceAndReconciliation", label: "frxUSD", message: "The assuranceAndReconciliation input is unavailable; score 79.9999891613885.", reason: "The cost datum for route redemption:generation:asset:redeem has not been established." };
    expect(readW(orig)).toEqual({ path: orig.path, key: orig.key, label: "frxUSD", message: "The assurance and reconciliation input is unavailable; score 80.", reason: "The cost datum for route (redemption) has not been established." });
    expect(readText("The maturityDaysMax factor and incidentState datum remain unresolved.")).toBe("The maximum reserve maturity factor and control incident status datum remain unresolved.");
    expect(orig.message).toContain("assuranceAndReconciliation");
  });

  it("publishes rated, NR and pipeline-gap cards with disjoint completeness counts", () => {
    const comp = rfx("complete");
    const capped = fx("capped", { score: 49, grade: "D", caps: [cap("track-record:under-24-months", 84, "track-record", "Implementation age is under 24 months.", false), cap("active-depeg:d", 49, "active-depeg", "A current severe depeg binds.", true)] });
    const dep = fx("dependency", { score: 75, grade: "B+", caps: [cap("parent", 75, "parent", "Required parent ceiling.", true)], dependency: { assetId: "dependency", serial: [{ upstreamAssetId: "upstream", score: 75, blocked: false }], basket: [], cycleBlocked: false } });
    const resp = publish([fxNr("not-rated"), dep, comp, capped, fx("pipeline-gap", { score: null, grade: null, pillars: { backing: null, exit: null, control: 94 } })]);
    expect(resp).toMatchObject({ model: "v9-critical-path", schemaVersion: 8, lifecycle: "active" });
    expect(resp.completeness).toEqual({ expectedCount: 5, ratedCount: 3, notRatedCount: 1, notRatedIds: ["not-rated"], pipelineGapCount: 1, pipelineGapIds: ["pipeline-gap"] });
    expect(resp.cards.map((c) => c.id)).toEqual(["capped", "complete", "dependency", "not-rated", "pipeline-gap"]);
    expect(resp.cards[0]?.caps).toHaveLength(2); expect(resp.cards[0]?.bindingCap?.kind).toBe("active-depeg:d");
    expect(resp.cards[1]?.breakdowns).toMatchObject({
      backing: { evaluatedScore: 92, publishedScore: 92, aggregationWeight: 0.4, groups: [{ key: "reserves" }], components: [{ key: "reserve:cash", label: "Cash", score: 92, weightedContribution: 92 }] },
      exit: { evaluatedScore: 90, primaryRoute: { key: "redemption:fixture", label: "Protocol redemption", confidenceFactor: 1 } },
      control: { evaluatedScore: 94, method: "minimum-binding-component" },
    });
    expect(resp.cards[2]?.dependencies.serial[0]?.upstreamAssetId).toBe("upstream"); expect(resp.cards[2]?.bindingCap?.source).toBe("parent");
    expect(resp.cards[3]?.nrReasons).toEqual([{ code: "missing-pillar", field: "pillars.backing", message: "Backing is missing.", origin: "asset" }]);
    expect(resp.resultDigest).toMatch(/^[a-f0-9]{64}$/); expect(resp.cards.every((c) => c.scoreTrace.schemaVersion === 4)).toBe(true);
  });

  it("rejects a backing waterfall that does not reconcile to the evaluated pillar", () => {
    const i = rfx("bad-backing-waterfall");
    i.backing = { ...i.backing!, contributions: i.backing!.contributions.map((c) => ({ ...c, effectiveWeight: 0.5 })) };
    expect(() => pc(i)).toThrow("backing waterfall does not reconcile to its evaluated pillar");
  });

  it("retains role evidence and failure domains without retired numeric role limits", () => {
    const dep: V9ResolvedDependencyInputs = { assetId: "role-dependent", serial: [], basket: [], cycleBlocked: false, roleInputs: [{ assetId: "role-dependent", upstreamAssetId: "operator", edgeKey: "control-operator:mechanism:operator", exposureKey: "control-operator:mechanism:operator", riskEventKey: "dependency-event:mint-control:operator:shared", dependencyType: "mechanism", role: "control-operator", weight: 0.5, inheritedDimensions: ["control"], unavailableDimensions: [], score: 76, boundedUnknown: false, cycleBlocked: false, evidenceRefIds: ["evidence:operator-review"], failureDomains: [{ kind: "mint-control", key: "operator:shared" }] }] };
    const c = pc(fx("role-dependent", { score: 90, grade: "A+", qualityScore: 91.8, pegAdjustedScore: 91.8, dependency: dep }));
    expect(c.dependencies.roles).toEqual([expect.objectContaining({ edgeKey: "control-operator:mechanism:operator", exposureKey: "control-operator:mechanism:operator", riskEventKey: "dependency-event:mint-control:operator:shared", targetPillar: "control", evidenceRefIds: ["evidence:operator-review"], failureDomains: [{ kind: "mint-control", key: "operator:shared" }] })]);
    expect(c.dependencies).not.toHaveProperty("rolePillarLimits"); expect(c.breakdowns?.control.adjustments).toEqual([]);
  });

  it("keeps access unknowns, evidence owners, aggregation, and all score stages explicit", () => {
    const i = rfx("unknown-access");
    i.access = { transfer: "unknown", freezeExposure: "possible", primaryExit: "permissionless", governance: "unknown", unknownFields: ["governance", "transfer"], signals: ["freeze:possible", "governance:unknown", "primary-exit:permissionless", "transfer:unknown"], reasons: [{ code: "unresolved-control-identity", path: "access:governance", message: "Governance is unresolved.", responsibility: "issuer-undisclosed" }] };
    i.freshness = { backing: "current", exit: "stale", control: "current" };
    i.evidenceReasons = [{ code: "historical-critical-input", path: "exit", message: "Exit evidence is stale.", responsibility: "producer-failed" }];
    i.trace.unresolvedFacts = [
      ufact("historical-critical-input", "exit", "Exit evidence is stale.", { responsibility: "producer-failed", cause: "A", causeGapIds: ["asset:gap:exit"], scoringDisposition: "excluded-pipeline" }),
      ufact("unresolved-control-identity", "access:governance", "Governance is unresolved.", { responsibility: "issuer-undisclosed", sourceGapId: "asset:gap:governance", cause: "C", causeGapIds: ["asset:gap:governance"] }),
    ];
    const pr = project(i), { card: c } = pr;
    expect(c).toMatchObject({
      qualityScore: 91.8, pegMultiplier: 1, pegAdjustedScore: 91.8, evidence: { level: "strong", freshness: "stale" }, accessPosture: { unknownFields: ["governance", "transfer"] },
      scoreTrace: {
        schemaVersion: 4, legacyAliases: { qualityScore: "weighted-pillar-mean", pegAdjustedScore: "post-deployment-pre-cap-score", score: "post-cap-public-score" },
        aggregation: { method: "smooth-bounded-headroom", weightedPillarMean: 91.8, score: 91.8 },
        stages: { weightedPillarMean: 91.8, aggregatedQualityScore: 91.8, baseAssetScore: 91.8, deploymentAdjustedScore: 91.8, deploymentAdjustmentPoints: 0, preCapScore: 91.8, publishedScore: 91.8 },
        deploymentRisk: { method: "holder-slice-exposure-weighted-v2", totalAdjustmentPoints: 0, adjustments: [], unresolvedExposures: [] },
        adverseAttribution: { semantics: "causal-measured-adverse-v1", items: [] },
        boundedUncertaintyAttribution: { semantics: "causal-bounded-uncertainty-v1", items: [] },
        evidenceResponsibility: { semantics: "limiting-fact-cause-v2", totalFactCount: 2 },
      },
    });
    expect(c.scoreTrace.evidenceResponsibility.summaries.filter((s) => (s.factCount ?? 0) > 0)).toEqual([{ responsibility: "issuer-undisclosed", factCount: 1, reasonCodes: ["unresolved-control-identity"] }, { responsibility: "producer-failed", factCount: 1, reasonCodes: ["historical-critical-input"] }]);
    const fact = [...iterFacts(c.scoreTrace.evidenceResponsibility)].find((r) => r[0] === "unresolved-control-identity")!;
    expect(fact).toMatchObject({ 0: "unresolved-control-identity", 1: "access:governance", 3: "issuer-undisclosed", 4: false, 5: "C" });
    expect(resolveGap(pr, c, fact[2]!)).toBe("asset:gap:governance");
    expect(fact[6].map((r) => resolveGap(pr, c, r))).toEqual(["asset:gap:governance"]);
    expect(c.reasonCodes).toEqual(["historical-critical-input", "unresolved-control-identity"]);
  });

  it.each([0, 0.021, 0.158, 0.4999, 0.5, 1])("shows deployment incident attribution only from half a score point (%s points)", (loss) => {
    const i = fx("incident-materiality", { score: 90, grade: "A+" }), sk = "signal:active-control-incident:critical:legacy-bridge";
    i.trace.deploymentAdjustedScore = i.trace.preCapScore = 91.8 - loss;
    i.trace.deploymentAdjustments = [{ signalKey: sk, sourceSignalKeys: [sk], exposureKey: "deployment:legacy-bridge", riskEventKey: "incident:legacy-bridge", failureDomainKey: "legacy-bridge", nominalExposureShare: 0.02, exposureShare: 0.02, exposedScore: 91.8 - loss / 0.02, scoreBefore: 91.8, scoreAfter: 91.8 - loss, adjustmentPoints: loss, reason: "A legacy bridge deployment is impaired." }];
    i.trace.adverseAttribution = [{ source: "structural-signal", path: "structural:active-control-incident:critical", message: "An active compromise incident affects a deployment.", responsibility: "measured-adverse" }];
    const bef = js(i.trace), c = resolveW(pc(i));
    expect(c.scoreTrace.adverseAttribution.items).toHaveLength(loss >= 0.5 ? 1 : 0);
    if (loss >= 0.5) expect(c.scoreTrace.adverseAttribution.items[0]!.message).toMatch(/^Deployment-scoped incident:/);
    expect(c.score).toBe(i.trace.finalScore); expect(c.scoreTrace.deploymentRisk.adjustments[0]!.adjustmentPoints).toBe(loss); expect(js(i.trace)).toBe(bef);
  });

  it("keeps a directly binding compromised authority incident without a deployment loss", () => {
    const i = fx("compromised-authority", { score: 39, grade: "F", pillars: { backing: 92, exit: 90, control: 25 }, qualityScore: 74.55, pegAdjustedScore: 74.55 });
    i.trace.weakestPillar = { pillar: "control", score: 25 }; Object.assign(i.trace.aggregation!, { weakestPillar: "control", weakestScore: 25 });
    i.control!.components[0]!.posture = "compromised";
    i.trace.adverseAttribution = [{ source: "structural-signal", path: "structural:active-control-incident:critical", message: "The economic authority is compromised.", responsibility: "measured-adverse" }];
    expect(pc(i).scoreTrace.adverseAttribution.items).toHaveLength(1);
  });

  it("attributes exposure-weighted deployment loss and causal adverse evidence", () => {
    const i = fx("deployment-risk", { score: 80, grade: "A-" });
    Object.assign(i.trace, {
      baseAssetScore: 91.8, deploymentAdjustedScore: 88.8, preCapScore: 88.8, finalScore: 80,
      deploymentAdjustments: [{ signalKey: "signal:material-bridge:high:bridge-a", sourceSignalKeys: ["signal:material-bridge:high:bridge-a"], exposureKey: "deployment:bridge-a", riskEventKey: "bridge-failure:a", failureDomainKey: "bridge-a", nominalExposureShare: 0.1, exposureShare: 0.1, exposedScore: 61.8, scoreBefore: 91.8, scoreAfter: 88.8, adjustmentPoints: 3, reason: "Ten percent of supply inherits bridge failure risk." }],
      unresolvedDeploymentSignals: [{ signalKey: "signal:material-bridge:medium:bridge-b", exposureKey: "deployment:bridge-b", riskEventKey: "bridge-failure:b", failureDomainKeys: ["bridge-b"], economicLossScope: "deployment", exposedScore: 75, exposureShare: null, reason: "Bridge supply share is unresolved." }],
      adverseAttribution: [{ source: "structural-signal", path: "structural:material-bridge:high", message: "The measured bridge exposure lowers holder safety.", responsibility: "measured-adverse" }],
    });
    const c = pc(i);
    expect(c.scoreTrace.deploymentRisk).toEqual({ method: "holder-slice-exposure-weighted-v2", totalAdjustmentPoints: 3, adjustments: [{ ...i.trace.deploymentAdjustments[0], modeledLossPoints: 3 }], unresolvedExposures: i.trace.unresolvedDeploymentSignals });
    expect(c.scoreTrace.adverseAttribution).toEqual({ semantics: "causal-measured-adverse-v1", items: i.trace.adverseAttribution });
  });

  it("projects the native USDT premium as an explicit score stage", () => {
    const i = fx("usdt-tether", { score: 87, grade: "A+", pillars: { backing: 95, exit: 95, control: 95 }, qualityScore: 95, pegAdjustedScore: 87, caps: [] });
    Object.assign(i.trace, { baseAssetScore: 83, deploymentAdjustedScore: 83, inheritableScore: 83, scoreAdjustments: [{ source: "asset-premium", kind: "market-anchor-longevity", label: "#1 & Longevity Premium", configuredPoints: 12, appliedPoints: 4, scoreBefore: 83, scoreAfter: 87, publishedScoreBefore: 83, publishedScoreAfter: 87 }] });
    const c = pc(i);
    expect(c.scoreTrace.stages).toMatchObject({ deploymentAdjustedScore: 83, preCapScore: 87, publishedScore: 87 });
    expect(c.scoreTrace.scoreAdjustments).toEqual(i.trace.scoreAdjustments);
  });

  it.each(["C", "U"] as const)("publishes adverse mint quality with its own %s reconciliation gap without relabelling uncertainty as D", (cause) => {
    const id = `adverse-${cause.toLowerCase()}`, g = `${id}:gap:mint:reconciliation`, own = cause === "C" ? ("issuer-undisclosed" as const) : ("unresearched" as const);
    const i = fx(id, { score: 59, grade: "C", qualityScore: 74.55, pillars: { backing: 92, exit: 90, control: 25 } });
    i.trace.weakestPillar = { pillar: "control", score: 25 }; i.trace.aggregation = { ...i.trace.aggregation!, weakestPillar: "control", weakestScore: 25 };
    i.control = { ...i.control!, components: [{ ...i.control!.components[0]!, posture: "unbounded-adverse", score: 25, ...unk(cause, g) }] };
    i.trace.unresolvedFacts = [ufact("unresolved-control-identity", "control:mint:reconciliation", "Whole-supply reconciliation remains unanswered.", { responsibility: own, sourceGapId: g, cause, causeGapIds: [g] })];
    i.trace.adverseAttribution = [{ source: "structural-signal", path: "structural:centralized-mint:high", message: "Known economically unbounded issuer mint authority.", responsibility: "measured-adverse" }];
    const resp = RespSchema.parse(publish([rfx("independent"), i])), c = resolveW(resp.cards.find((e) => e.id === id)!), mint = c.breakdowns!.control.components[0]!;
    expect(mint).toMatchObject({ posture: "unbounded-adverse", score: 25, cause, scoringDisposition: "bounded-uncertainty" });
    expect(mint.causeGapRefs!.map((r) => resolveGap(resp, c, r))).toEqual([g]);
    const [fact] = [...iterFacts(c.scoreTrace.evidenceResponsibility)];
    expect(fact).toMatchObject({ 1: "control:mint:reconciliation", 3: own, 4: false, 5: cause });
    expect(fact![6].map((r) => resolveGap(resp, c, r))).toEqual([g]);
    expect(c.scoreTrace.adverseAttribution.items).toEqual(i.trace.adverseAttribution);
    expect(c.scoreTrace.adverseAttribution.items.some((x) => x.path.includes("reconciliation"))).toBe(false);
    const bad = sc(i); bad.control!.components = [{ ...bad.control!.components[0]!, causeGapIds: [] }];
    let err: ProjErr | undefined;
    try { publish([rfx("independent"), bad]); } catch (e) { if (!(e instanceof ProjErr)) throw e; err = e; }
    expect(err).toBeInstanceOf(ProjErr); expect(err!.failures.map((f) => f.assetId)).toEqual([id]); expect(err!.messageFor(id)).toContain("causal gaps");
    expect(publish([rfx("independent")]).cards.map((e) => e.id)).toEqual(["independent"]);
  });

  it("rejects empty publications", () => { expect(() => publish([])).toThrow(/at least one result/); });

  it("rejects each independently mismatched publication identity", () => {
    const base = rfx("alpha");
    for (const [mut, err] of [
      [{ factSetDigest: "e".repeat(64) }, /mixes fact-set digest/], [{ baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}` }, /mixes base input generation/],
      [{ policyDigest: "e".repeat(64) }, /mixes policy digest/], [{ asOfSec: 999 }, /mixes evidence clock/], [{ sourceGenerations: { dex: "dex:g2", registry: "registry:g1" } }, /mixes source generations/],
    ] as [Partial<Trace>, RegExp][]) {
      const o = fx("beta", { score: 90, grade: "A+" });
      expect(publish([base, o]).cards.map((c) => c.id)).toEqual(["alpha", "beta"]);
      Object.assign(o.trace, mut); expect(() => publish([base, o])).toThrow(err);
    }
  });

  it("canonicalizes source maps and result ordering without losing score changes in the digest", () => {
    const a = rfx("alpha"), b = fx("beta", { score: 90, grade: "A+" }), fwd = publish([a, b]);
    b.trace.sourceGenerations = { registry: "registry:g1", dex: "dex:g1" };
    const rev = publish([b, a]);
    expect(rev.cards).toEqual(fwd.cards); expect(rev.resultDigest).toBe(fwd.resultDigest); expect(rev.sourceGenerations).toEqual({ dex: "dex:g1", registry: "registry:g1" });
    expect(publish([a, fx("beta", { score: 89, grade: "A+" })]).resultDigest).not.toBe(fwd.resultDigest);
  });

  it("deduplicates identical reasons through all projector reason lists", () => {
    const i = rfx("repeated-reasons"), r = { code: "bounded-mechanism-review" as const, path: "backing:mechanism:custody", message: "Reviewed custody." }, sr = { ...r, responsibility: "method-unsupported" as const };
    i.scoreInput.pillars.backing.reasons = [sr, { ...sr }]; i.evidenceReasons = [sr, { ...sr }]; i.access = { ...i.access, reasons: [sr, { ...sr }] };
    const c = resolveW(pc(i));
    expect([c.pillars.backing.reasons, c.evidence.reasons, c.accessPosture.reasons]).toEqual([[r], [r], [r]]);
  });

  it("rejects conflicting renderings but publishes distinct paths for the same reason code", () => {
    const r1 = { code: "bounded-mechanism-review" as const, path: "backing:mechanism:custody", message: "First rendering." }, r2 = { ...r1, message: "Second rendering." };
    const s1 = { ...r1, responsibility: "method-unsupported" as const }, s2 = { ...s1, message: r2.message };
    for (const t of ["pillar", "evidence", "access"] as const) {
      const i = rfx(`conflicting-${t}`), rs = [s1, s2];
      if (t === "pillar") i.scoreInput.pillars.backing.reasons = rs; else if (t === "evidence") i.evidenceReasons = rs; else i.access = { ...i.access, reasons: rs };
      expect(() => pc(i)).toThrow(expect.objectContaining({ issues: [expect.objectContaining({ code: "custom", path: t === "pillar" ? ["pillars", "backing", "reasons", 1] : [t === "evidence" ? "evidence" : "accessPosture", "reasons", 1] })] }));
      rs[1] = { ...s2, path: "backing:mechanism:reserves" };
      const c = resolveW(pc(i)), pub = t === "pillar" ? c.pillars.backing.reasons : t === "evidence" ? c.evidence.reasons : c.accessPosture.reasons;
      expect(pub.map(({ code, path, message }) => ({ code, path, message }))).toEqual([r1, { ...r2, path: "backing:mechanism:reserves" }]);
    }
  });

  it("rejects duplicate assets and mixed evaluator identities", () => {
    const base = rfx("alpha"), mix = fx("beta", { score: 90, grade: "A+" });
    expect(() => publish([base, base])).toThrow(/Duplicate/);
    mix.trace.evaluationBuildDigest = "f".repeat(64); expect(() => publish([base, mix])).toThrow(/mixes evaluation build/);
  });

  it("rejects duplicate code/path identities in every public reason list", () => {
    const reasons = [{ code: "bounded-mechanism-review" as const, message: "First rendering.", path: "backing:mechanism:custody" }, { code: "bounded-mechanism-review" as const, message: "Second rendering.", path: "backing:mechanism:custody" }];
    expect(PillarSchema.safeParse({ score: 70, evidenceLevel: "limited", freshness: "current", components: [], reasons }).success).toBe(false);
    expect(EvSchema.safeParse({ level: "limited", freshness: "current", reasons }).success).toBe(false);
    expect(AccessSchema.safeParse({ ...ACCESS, reasons }).success).toBe(false);
  });
});

describe("Safety Score v9 public NR cap suppression", () => {
  const matCap = cap("active-depeg:d", 49, "active-depeg", "A current severe depeg binds.", true);
  const notRated = () => fxNr("not-rated", [matCap]);

  it("keeps NR cap candidates as diagnostics but suppresses all binding assertions", () => {
    const c = pc(notRated());
    expect(c.score).toBeNull(); expect(c.bindingCap).toBeNull();
    expect(c.caps).toEqual([expect.objectContaining({ kind: matCap.kind, limit: 49, source: matCap.source, binding: false })]);
  });

  it("keeps the rated binding cap unchanged", () => {
    const nb = cap("track-record:under-24-months", 84, "track-record", "Recent implementation.", false), c = pc(rfx("rated", { caps: [nb, matCap] }));
    expect(c.score).not.toBeNull();
    expect(c.caps).toEqual([expect.objectContaining({ kind: nb.kind, source: nb.source, limit: 84, binding: false }), expect.objectContaining({ kind: matCap.kind, source: matCap.source, limit: 49, binding: true })]);
    expect(c.bindingCap).toMatchObject({ kind: matCap.kind, limit: 49, binding: true });
  });

  it("rejects hand-built NR cards with a binding cap or binding candidate", () => {
    const c = pc(notRated());
    expect(ok({ ...c, bindingCap: { ...c.caps[0]!, binding: true } })).toBe(false);
    expect(ok({ ...c, caps: c.caps.map((e) => ({ ...e, binding: true })) })).toBe(false);
  });
});

describe("v10.05 published mint process evidence", () => {
  it("unions compiler/evaluator failures with exact member/path identity and actual/discretionary clocks", () => {
    const ref = "ethereum:0x1234567890123456789012345678901234567890";
    const miss: V1005ProcessDiagnostic = { code: "runtime-unmatched", gate: "H0", controlRef: ref, pathId: "keeper-redo", classId: "keeper-class", memberRef: ref, field: "runtimeHash", evidenceRefIds: ["code-read"] };
    const iss = {
      ref: "modeled-issuance:process",
      governance: { coverage: "incomplete" as const, incompleteReasons: ["runtime-unmatched"], governorAuthorityKey: ref, decisionRule: "affirmative-vote" as const, minUnavoidableDelaySec: 0, votingPower: "lock-escrowed" as const, vetoQuorumBps: null, vetoOverride: null, enumerable: true, nonGovernorUnboundedPathKeys: [], votingControl: mkVote(), diagnostics: [miss] },
      process: mkProc({ coverage: "incomplete", diagnostics: [miss], maxAnnualInterestGrowthPpm: 500001, evidenceRefIds: ["code-read", "source-proof", "observed-rate", "observed-native-supply"] }),
      diagnostics: [{ ...miss, evidenceRefIds: ["source-proof"] }],
    };
    const fact = mkCtrl("mint:process", "mint", { authority: { authorityKey: ref, model: "governance", threshold: null }, capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", issuanceFactsRef: iss.ref, scopeDiagnostics: ["runtime-unmatched:keeper-redo"] });
    const i = fx("process-fixture", { score: 91, grade: "A+" });
    i.control = { ...i.control!, controlFacts: [fact], issuanceFacts: iss, components: [{ ...i.control!.components[0]!, controlKeys: [fact.controlKey] }], processDiagnostics: isGovQual(fact, POL.policy.semantic, iss).diagnostics };
    const ctrl = resolveW(CardSchema.parse(pc(i))).breakdowns!.control, det = resCtrl(ctrl, ctrl.components[0]!)[0]!;
    expect(det.controlRef).toBe(ref); expect(det.diagnostics).toEqual(["runtime-unmatched:keeper-redo"]);
    expect(ctrl.issuanceSummary?.governance?.votingControl.largestSingleControllerShareBps).toBe(6000);
    expect(ctrl.issuanceSummary?.process).toMatchObject({ minOperationalExerciseDelaySec: 0, minDiscretionaryPublicDelaySec: 172800, minEnvelopeRaisePublicDelaySec: 172800, memberCount: 3 });
    expect(ctrl.issuanceSummary?.diagnostics).toContainEqual(expect.objectContaining({ code: "runtime-unmatched", gate: "H0", count: 1, controlRefs: [ref], exemplars: [{ ...miss, evidenceRefIds: ["code-read", "source-proof"], evidenceRefCount: 2 }] }));
    expect(ctrl.issuanceSummary?.diagnostics).toContainEqual(expect.objectContaining({ code: "operational-screen-failed", gate: "H2", controlRefs: [ref], field: "maxAnnualInterestGrowthPpm" }));
    const exact = ctrl.issuanceSummary!.diagnostics.find((d) => d.field === "maxAnnualInterestGrowthPpm")!.exemplars[0]!;
    expect(exact.evidenceRefCount).toBe(4); expect(exact.evidenceRefIds).toEqual([...iss.process.evidenceRefIds].sort().slice(0, 3)); expect(exact).not.toHaveProperty("issuanceFactsRef");
    const stale = i.control.processDiagnostics!.find((d) => d.field === "maxAnnualInterestGrowthPpm")!;
    i.control.processDiagnostics = [{ ...stale, issuanceFactsRef: "different-book" }];
    const unm = resolveW(pc(i)).breakdowns!.control.issuanceSummary!.diagnostics.find((d) => d.field === "maxAnnualInterestGrowthPpm")!.exemplars[0]!;
    expect(unm.evidenceRefCount).toBe(0); expect(unm.evidenceRefIds).toEqual([]); expect(unm).not.toHaveProperty("issuanceFactsRef");
  });
});
