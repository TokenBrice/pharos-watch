import { describe, expect, it, vi } from "vitest";
import type mechanismReviewOverlaysAsset from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import { buildSafetyScoreV9BaselineExtension as buildBaseExt, type V9ExtensionRegistryMeta as RegMeta } from "../safety-score-v9/extension";
import { computeSafetyScoreV9ReserveExposureKey as expKey } from "../safety-score-v9/fact-set-schema";
import { compileSafetyScoreV9FactSetFromFixedInput as compileFacts, compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension as compileIso, materializeSafetyScoreV9FactSetExtension as matExt, type SafetyScoreV9FactSetExtensionV2 as ExtV2 } from "../safety-score-v9/fact-set";
import { makeV9Extension as mkExt, makeV9FixedInput as mkFixed, v9Status } from "../../test-helpers/v9-fixed-input";
import { CEILING_BOOKS as CBOOKS, compileCeilingCard as compCeil, eligibleReserveMeta as eligMeta, mintMeta, reviewDatedOn } from "./safety-score-v9-reserve-admission.test-support";
import { buildSafetyScoreV9Candidate as buildCand } from "../safety-score-v9/candidate";
import { createAssetBuildContext as mkCtx, createRuntimeGapVerdict as mkGapVerdict, type AssetBuildContext as BuildCtx } from "../safety-score-v9/fact-set-context";
import { normalizeFixedInput as normFixed } from "../report-cards-fixed-input";
import { normalizeSafetyScoreV9CompilerInput as normComp } from "../safety-score-v9/native-input";
import { buildReserves, reconcileCollateralDependencyMappings as recDeps } from "../safety-score-v9/fact-set-backing";
import { factBuilderContext as fbCtx } from "./safety-score-v9-fact-builders.test-support";
import type { ReserveSlice } from "@shared/types/reserves";
import { ReserveBoundedFactSchema as BoundSchema, type ReserveBoundedFact as BoundFact } from "@shared/types/reserve-bounded-facts";
import { evaluateV9ReserveExposures as evalRes } from "@shared/lib/safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 as POL } from "@shared/lib/safety-score-v9/policy";
import { CompiledV9FactSetV3Schema as SetSchema, V9AssetFactsV3Schema as AssetSchema, V1019LenderBookFactSchema as BookFactSchema } from "@shared/types/safety-score-v9-facts";
import { refineV9CauseContribution as refineCause } from "@shared/types/safety-score-v9-causes";
import { buildLenderBookFact as buildBook } from "../safety-score-v9/fact-set-lender-book";
import { canonicalizeLenderBookObservation as canonBook, deriveLenderBookObservationIdentity as bookId } from "@shared/lib/safety-score-v9/lender-book-registry";
import { getLenderCollateralClassesRegistry as getClassReg } from "@shared/lib/safety-score-v9/lender-collateral-classes";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { LenderBookObservationSchema as BookSchema, LenderCollateralBackingSchema as BackingSchema, type LenderBookObservation as BookObs, type LenderCollateralBacking as ColBacking } from "@shared/types/safety-score-v9-lender-book";
import { LiveReserveSnapshotProvenanceSchema as ProvSchema } from "@shared/lib/safety-score-v9/reserve-provenance";
import { evaluateV1019LenderBook as evalBook } from "@shared/lib/safety-score-v9/lender-book";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC as MAX_AGE } from "../safety-score-v9/consumer-freshness";
import { ACTIVE_META_BY_ID as META } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint as cfgFp } from "@shared/lib/live-reserve-adapters";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { finalizeReserveSyncSuccess as finSync } from "../live-reserves/store-write";
import { loadFreshIndependentLiveReserveMap as loadFreshMap } from "../live-reserves/store-overview";
import { reserveCompositionRow as compRow, reserveSyncRow as syncRow } from "./live-reserves-store.test-support";
import type { ReserveCompositionRecord, ReserveSyncStateRecord } from "../live-reserves/store-shared";
import { LiveReserveSnapshotMetadataSchema as MetaSchema } from "@shared/types/live-reserves";

vi.mock("@shared/data/safety-score-v9/evidence-gap-classifications-v1.json", () => {
  const t = "1970-01-01T01:00:00Z";
  const compScope = { pillar: "backing", componentKey: "reserve-composition", factorKey: null, routeKey: null, exposureId: null, requiredDatum: "reserve-composition" };
  const cEntry = (id: string, assetId: string, reviewedAt: string) => ({
    id, assetId, cause: "C", assertion: "researched-nondisclosure", scope: compScope, reviewedAt, reviewer: "fixture-curator",
    sourcesRefs: ["usdt-report"], searchedSurfacesRefs: ["usdt-report"], rationale: "The current report does not itemize the required holdings.",
  });
  return {
    default: {
      schemaVersion: 1,
      entries: [
        { id: "fixture-public-composition", assetId: "usdc-circle", cause: "B", assertion: "required-data-public", scope: compScope, reviewedAt: t, reviewer: "fixture-curator", sourcesRefs: ["usdc-holdings"] },
        cEntry("fixture-researched-composition", "usdt-tether", t),
        cEntry("fixture-researched-composition-bravo", "bravo", "2026-07-01T00:00:00Z"),
        ...[["reserve:d9ea3402f80c2eba4fa0b228", "fixture-uncurated-maturity"], ["reserve:f56e5d5418b2b742f60e9dd0", "fixture-uncurated-mixed-maturity"]].map(([exposureId, id]) => ({
          id, assetId: "alpha", cause: "B", assertion: "required-data-public",
          scope: { pillar: "backing", componentKey: "reserve-exposure", factorKey: "maturity", routeKey: null, exposureId, requiredDatum: "maturityDaysMax" },
          reviewedAt: t, reviewer: "fixture-curator", sourcesRefs: ["alpha-maturity"],
        })),
      ],
      sourceObservations: [
        { id: "usdc-holdings", value: { url: "https://example.com/usdc-holdings", observedAt: t, datumAsOf: t, location: "current holdings", excerpt: "The current whole-token holdings are itemized.", assertion: "The exact required current composition is public." } },
        { id: "usdt-report", value: { url: "https://example.com/usdt-report", observedAt: t, datumAsOf: null, location: "reserve report", excerpt: "Only a portfolio total is reported.", assertion: "The required itemized composition is not published in the reviewed report." } },
        { id: "alpha-maturity", value: { url: "https://example.com/alpha-maturity", observedAt: t, datumAsOf: t, location: "holdings maturity table", excerpt: "Every deposit's maximum term is listed.", assertion: "The exact required maturity datum is public." } },
      ],
      searchedSurfaceObservations: [{ id: "usdt-report", value: "https://example.com/usdt-report" }],
    },
  };
});

vi.mock("@shared/data/safety-score-v9/mechanism-review-overlays-v1.json", async (orig) => {
  const o = await orig<{ default: typeof mechanismReviewOverlaysAsset }>(), source = { label: "Pinned recovery terms", url: "https://example.com/recovery-terms" };
  return {
    default: {
      ...o.default,
      overlays: [
        ...o.default.overlays,
        ...[["fixture-instant-recovery", "2026-10-20T22:23:27Z"], ["fixture-date-recovery", "2026-10-20"], ["fixture-expired-recovery", "2026-10-18T00:00:00Z"]].map(([assetId, reviewedAt]) => ({
          assetId, archetype: "tbill", reviewedAt: "2026-10-19", sources: [source],
          notes: "A separately timed recovery review does not refresh historical financial assurance.", metrics: {},
          components: { lossRecoveryDesign: { quality: "adequate", review: { reviewedAt, reviewer: "Fixture reviewer", rationale: "Dated regulatory filing establishes a component-scoped recovery commitment.", sources: [source] } } },
        })),
      ],
    },
  };
});

const AID = "alpha", DAY = 86_400, INF = Number.MAX_SAFE_INTEGER, js = JSON.stringify, jp = JSON.parse;
const utc = (...a: Parameters<typeof Date.UTC>) => Date.UTC(...a) / 1e3;
const iso = (s: string) => Date.parse(s) / 1e3;
const EXP_CLK = utc(2027, 7, 1), NO_HIST_CLK = utc(2026, 7, 1);
const baseMeta = (): RegMeta => mintMeta(AID, { mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" });
const mMap = (id: string, m: RegMeta) => ({ metaById: new Map([[id, m]]) });
const okAsset = (a: unknown) => AssetSchema.safeParse(a).success;
const okSet = (f: unknown) => SetSchema.safeParse(f).success;
const okBook = (f: unknown) => BookFactSchema.safeParse(f).success;
const comp0 = (f: ReturnType<typeof mkFixed>, e = mkExt({ registryFingerprint: f.registryFingerprint })) => compileFacts(f, e).assets[0]!;
const evRes = (a: Omit<Parameters<typeof evalRes>[0], "resolvedUpstreamExposures">, ex?: Partial<Parameters<typeof evalRes>[0]>) => evalRes({ ...a, resolvedUpstreamExposures: [], ...ex }, POL);

function unclassifiedTail(tail: ReserveSlice) {
  return {
    exposureKey: expKey(tail), classificationKey: "fixture-unclassified-tail", assetClass: null,
    issuerOrObligorKey: null, riskFactors: [], liquidityHorizon: null, maturityDaysMax: null,
    failureDomains: [], unclassifiedResidual: true as const,
  };
}

function expiredMeta(): RegMeta {
  const m = eligMeta({ id: AID, mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }), p = m.proofOfReserves;
  if (!p?.latestReport) throw new Error("Expected named assurance report fixture");
  return { ...m, proofOfReserves: { ...p, latestReport: { ...p.latestReport, sources: p.latestReport.sources.map((s) => ({ ...s, label: "Independent LLP signed report" })) } } };
}

function compEmpty(m: RegMeta, clockSec: number) {
  const fixed = mkFixed({ assetId: AID, clockSec, reserves: [] }), extension = buildBaseExt(fixed, mMap(AID, m)), ctx = fbCtx(fixed, extension);
  return { fixed, extension, asset: { ...buildReserves(ctx), gaps: [...ctx.gaps.values()], evidence: [...ctx.evidence.values()] } };
}

describe("mechanism component evidence clocks and diagnostic history", () => {
  function compRec(assetId: string, clock: string) {
    const fixed = mkFixed({ assetId, clockSec: iso(clock), reserves: [] }), ext = buildBaseExt(fixed, mMap(assetId, eligMeta({ id: assetId, mechanismArchetype: "tbill" })));
    const asset = comp0(fixed, ext);
    if (asset.mechanismRiskReview.review?.archetype !== "tbill") throw new Error("Expected T-bill mechanism fixture");
    return { extension: ext.assets[0]!, asset, recovery: asset.mechanismRiskReview.review.lossRecoveryDesign };
  }

  it.each([["fixture-instant-recovery", "missing"], ["fixture-date-recovery", "unsupported"]] as const)(
    "retains report history without credit or an orphan for an inadmissible %s review",
    (id, state) => {
      const { asset, recovery } = compRec(id, "2026-10-20T22:23:26Z");
      expect(recovery).toMatchObject({ quality: null, status: { observationState: state, evidenceRefIds: [] } });
      const gap = asset.gaps.find((r) => r.gapId === `${id}:gap:mechanism-review:lossRecoveryDesign`)!;
      const rep = asset.evidence.filter((r) => r.sourceId === "stablecoin.proof-of-reserves.latest-report");
      expect(rep).not.toHaveLength(0);
      expect(gap.evidenceHistory?.evidenceRefIds).toEqual(expect.arrayContaining(rep.map((r) => r.evidenceId)));
      expect(asset.evidence.some((r) => r.sourceId === "safety-score-v9.mechanism-review-overlay:lossRecoveryDesign")).toBe(false);
    },
  );

  it.each([["fixture-instant-recovery", "2026-10-20T22:23:27Z"], ["fixture-date-recovery", "2026-10-21T00:00:00Z"]] as const)(
    "lets the current explicit %s review govern without stale-report poisoning",
    (id, clock) => {
      const { extension, asset, recovery } = compRec(id, clock);
      expect(recovery).toMatchObject({ quality: "adequate", status: { observationState: "known", gapIds: [] } });
      const rep = extension.researchEvidence.find((r) => r.sourceId === "stablecoin.proof-of-reserves.latest-report")!;
      expect(rep).toBeDefined();
      expect(extension.componentEvidence.find((r) => r.componentKey === "mechanism-risk-review-history")?.evidenceKeys).toContain(rep.evidenceKey);
      expect(extension.componentEvidence.find((r) => r.componentKey === "mechanism-risk-review:lossRecoveryDesign")?.evidenceKeys).not.toContain(rep.evidenceKey);
      expect(recovery.status.evidenceRefIds.every((x) => asset.evidence.find((r) => r.evidenceId === x)?.freshness.state === "current")).toBe(true);
      expect(asset.gaps.some((r) => r.gapId === `${id}:gap:mechanism-review:lossRecoveryDesign`)).toBe(false);
    },
  );

  it("withdraws an expired explicit review without orphaning its historical report", () => {
    const { asset, recovery } = compRec("fixture-expired-recovery", "2027-10-18T00:00:00Z");
    expect(recovery).toMatchObject({ quality: null, status: { observationState: "stale" } });
    const rep = asset.evidence.filter((r) => r.sourceId === "stablecoin.proof-of-reserves.latest-report");
    expect(rep).not.toHaveLength(0);
    expect(recovery.status.evidenceRefIds).toEqual(expect.arrayContaining(rep.map((r) => r.evidenceId)));
  });

  it("rebinds each admitted scoped assurance fragment to its own evidence clock", () => {
    const c = NO_HIST_CLK, fixed = mkFixed({ assetId: AID, clockSec: c, reserves: [] }), ext = mkExt({ clockSec: c, registryFingerprint: fixed.registryFingerprint }), ea = ext.assets[0]!;
    if (ea.mechanismRiskReview!.archetype !== "fiat-cash") throw new Error("Expected fiat-cash fixture");
    const ms = (observationState: "known" | "bounded-unknown", evidenceRefIds: string[], gapIds: string[] = []) => ({
      applicability: { state: "required" as const, policyRuleId: "v9.backing.mechanism-review", rationale: null, gapId: null }, observationState, evidenceRefIds, gapIds,
    });
    ea.mechanismRiskReview!.assuranceAndReconciliation = {
      status: ms("bounded-unknown", ["fixture:assurance-evidence"], ["fixture:assurance-gap"]), quality: null, failureDomains: [],
      scopedAssessments: [
        { scopeId: "fixture-trust", share: 0.25, quality: "strong", status: ms("known", ["fixture:scoped-assurance"]) },
        { scopeId: "fixture-remainder", share: 0.75, quality: null, status: ms("bounded-unknown", ["fixture:assurance-evidence"], ["fixture:assurance-gap"]) },
      ],
    };
    ea.researchEvidence.push({ evidenceKey: "fixture-scoped-assurance", sourceId: "fixture-scoped-assurance", observedAtSec: c - 1, publishedAtSec: c - 1, publishedBy: "issuer", url: "https://example.com/scoped-assurance", contentSha256: "3".repeat(64), confidence: "verified", maxAgeSec: 3600 });
    ea.componentEvidence.push({ componentKey: "reserve-scope:fixture-trust", evidenceKeys: ["fixture-scoped-assurance"] });
    const cr = comp0(fixed, ext).mechanismRiskReview.review, a = cr && "assuranceAndReconciliation" in cr ? cr.assuranceAndReconciliation : undefined;
    if (!a) throw new Error("Expected compiled assurance");
    expect(a.quality).toBeNull();
    expect(a.scopedAssessments).toMatchObject([{ scopeId: "fixture-trust", quality: "strong", status: { observationState: "known", evidenceRefIds: [`${AID}:research:fixture-scoped-assurance`] } }, { scopeId: "fixture-remainder", quality: null }]);
    expect(a.scopedAssessments![1]!.status).toEqual(a.status);
  });

  it("publishes expired mechanism-review history as a stale bounded gap", () => {
    const c = NO_HIST_CLK, fixed = mkFixed({ assetId: AID, clockSec: c, reserves: [] }), ext = mkExt({ clockSec: c, registryFingerprint: fixed.registryFingerprint }), ea = ext.assets[0]!;
    ea.mechanismRiskReview = null;
    ea.researchEvidence.push({ evidenceKey: "fixture-expired-mechanism-review", sourceId: "fixture-mechanism-review", observedAtSec: c - 100, publishedAtSec: c - 100, publishedBy: "issuer", url: "https://example.com/expired-mechanism-review", contentSha256: "2".repeat(64), confidence: "verified", maxAgeSec: 50 });
    ea.componentEvidence.push({ componentKey: "mechanism-risk-review-history", evidenceKeys: ["fixture-expired-mechanism-review"] });
    const a = comp0(fixed, ext), he = a.evidence.find((r) => r.evidenceId === `${AID}:research:fixture-expired-mechanism-review`)!;
    expect(a.mechanismRiskReview).toMatchObject({ review: null, status: { observationState: "stale" } });
    expect(he.freshness.state).toBe("stale");
    expect(a.mechanismRiskReview.status.evidenceRefIds).toEqual([he.evidenceId]);
    expect(a.gaps.find((r) => r.gapId === `${AID}:gap:mechanism-risk-review`)).toMatchObject({ reasonCode: "bounded-mechanism-review", observationState: "stale" });
  });
});

describe("Safety Score v9 backing fact-set reserve history", () => {
  it("retains keyed zero-balance classifications without emitting zero-weight backing facts or quarantining the asset", () => {
    const rows = [
      { sourceKey: "fixture:cash", name: "Custodied cash", pct: 100, risk: "very-low" as const, assetClass: "cash" as const, issuerOrObligor: "issuer:alpha", riskFactors: ["custody" as const], liquidityHorizon: "immediate" as const, maturityDaysMax: 0 },
      { sourceKey: "fixture:residual", name: "Residual allowance", pct: 0, risk: "low" as const, assetClass: "other" as const, issuerOrObligor: "issuer:alpha", riskFactors: ["custody" as const], liquidityHorizon: "unknown" as const },
    ];
    const fixedInput = mkFixed({ assetId: AID, clockSec: NO_HIST_CLK, reserves: rows }), extension = buildBaseExt(fixedInput, mMap(AID, { ...baseMeta(), reserves: rows }));
    const res = buildCand({ fixedInput, extension, publishedAtSec: fixedInput.clockSec + 10 });
    expect(res.quarantines.filter((q) => q.assetId === AID)).toEqual([]);
    expect(res.compiledFacts.assets[0]!.reserveExposures.map((e) => ({ name: e.name, weight: e.weight }))).toEqual([{ name: "Custodied cash", weight: 1 }]);
    expect(res.fixedInput.liveReserveMap[AID]).toEqual(rows);
  });

  it("reports expired published reserve composition evidence as stale", () => {
    const { fixed, asset } = compEmpty(expiredMeta(), EXP_CLK);
    expect(fixed.liveReserveMap[AID]).toEqual([]);
    const g = asset.gaps.find((x) => x.reasonCode === "expired-reviewed-reserve-composition")!;
    expect(g).toMatchObject({ reasonCode: "expired-reviewed-reserve-composition", observationState: "stale", causeProof: { cause: "U" } });
    expect(asset.reserveStatus).toMatchObject({ observationState: "stale", evidenceRefIds: g.evidenceRefIds });
    for (const id of g.evidenceRefIds) expect(asset.evidence.find((e) => e.evidenceId === id)?.freshness.state).toBe("stale");
  });

  it("reports a generic missing reserve composition when no history exists", () => {
    const { fixed, extension, asset } = compEmpty(baseMeta(), NO_HIST_CLK);
    expect(fixed.liveReserveMap[AID]).toEqual([]);
    expect(extension.assets[0]!.componentEvidence).not.toContainEqual(expect.objectContaining({ componentKey: "reserve-composition-history" }));
    expect(asset.gaps.find((g) => g.reasonCode === "missing-reserve-composition")).toMatchObject({ reasonCode: "missing-reserve-composition", observationState: "missing", causeProof: { cause: "U", evidenceRefIds: [] }, evidenceRefIds: [] });
    expect(asset.reserveStatus).toMatchObject({ observationState: "missing", evidenceRefIds: [] });
  });
});

describe("v10.48 age-only expired composition attribution", () => {
  const AGE_CLK = utc(2026, 7, 15), FRESH_SEC = utc(2026, 6, 21);
  const bMeta = (mut = (m: RegMeta) => m) => mut(CBOOKS.strong());
  function compBravo(m: RegMeta, clockSec: number) {
    const fixed = mkFixed({ assetId: "bravo", clockSec, reserves: [] }), ctx = fbCtx(fixed, buildBaseExt(fixed, mMap("bravo", m)));
    return { fixed, context: ctx, asset: { ...buildReserves(ctx), gaps: [...ctx.gaps.values()] } };
  }

  it("attributes an age-only rejection to expired published evidence, not nondisclosure", () => {
    const { asset } = compBravo(bMeta(), AGE_CLK);
    expect(asset.gaps.map((g) => g.reasonCode)).toEqual(["expired-reviewed-reserve-composition"]);
    expect(asset.gaps[0]).toMatchObject({ observationState: "missing", causeProof: { cause: "U", evidenceRefIds: [] }, message: "The reviewed whole-book reserve composition is older than the v9 age budget." });
  });

  it.each([
    ["old and unverified", (m: RegMeta) => ({ ...m, reserveReview: { ...m.reserveReview!, confidence: "probable" as const } })],
    ["selected-slices and undated", (m: RegMeta) => ({ ...m, reserveReview: { ...m.reserveReview!, scope: "selected-slices" as const, compositionAsOf: undefined } })],
    ["no review", (m: RegMeta) => ({ ...m, reserveReview: undefined })],
  ] as const)("keeps today's missing-composition gap for %s", (_l, mut) => {
    const { asset } = compBravo(bMeta(mut), AGE_CLK);
    expect(asset.gaps.map((g) => g.reasonCode)).toEqual(["missing-reserve-composition"]);
    expect(asset.gaps[0]!.causeProof.cause).toBe("C");
  });

  it("prices the whole-reserve fallback at the U bound with published-evidence-expired ownership", () => {
    const fixedInput = mkFixed({ assetId: "bravo", clockSec: AGE_CLK, reserves: [] }), registry = mMap("bravo", bMeta());
    const off = buildCand({ fixedInput, registry, publishedAtSec: AGE_CLK + 10 }), on = buildCand({ fixedInput, registry, publishedAtSec: AGE_CLK + 10, includeReserveCompositionAdmission: true });
    const { reserveCompositionAdmission: diag, ...cardOn } = on.candidate.cards[0]!;
    expect(off.candidate.cards[0]).toEqual(cardOn); expect(diag).toMatchObject({ reasons: ["beyond-age-budget"] });
    const c = on.candidate.cards[0]!;
    expect(c.pillars.backing.reasons).toContainEqual(expect.objectContaining({ code: "expired-reviewed-reserve-composition", cause: "U" }));
    expect(c.scoreTrace.evidenceResponsibility.summaries.find((r) => r.responsibility === "unresearched")?.reasonCodes).toContain("expired-reviewed-reserve-composition");
  });

  it.each([["strong", 0, "static-validated", false], ["weak", 0, "static-validated", true], ["ownLiability", 1, "static-validated", true], ["named", 0, "independent", false]] as const)(
    "caps a %s expired book",
    (book, own, evCls, binds) => {
      const fresh = compCeil(CBOOKS[book](), FRESH_SEC);
      expect([fresh.reserves < 50, fresh.facts.reserveExposures.filter((r) => r.selfReferential).length, fresh.facts.reserveCompositionEvidenceClass]).toEqual([binds, own, evCls]);
      const exp = compCeil(CBOOKS[book](), AGE_CLK);
      expect(exp.residual).toMatchObject({ score: expect.closeTo(Math.min(50, fresh.reserves), 6), admittedScoreCeiling: expect.closeTo(fresh.reserves, 6) });
      expect(exp.components.filter((r) => r.source !== "mechanism").every((r) => r.admittedScoreCeiling !== undefined)).toBe(binds);
    },
  );

  it("keeps origin treatment when report coverage would narrow a fresh review", () => {
    const sec = utc(2026, 9, 15), fresh = compCeil(reviewDatedOn(CBOOKS.owedExclusion(), "2026-10-13"), sec), exp = compCeil(CBOOKS.owedExclusion(), sec);
    expect([fresh.card.reserveCompositionAdmission?.reasons, exp.card.reserveCompositionAdmission?.reasons, exp.facts.expiredReviewedAdmittedReserveScore]).toEqual([["report-scope-not-whole-book"], ["beyond-age-budget"], undefined]);
  });

  it("keeps origin treatment, rows and edges for a tracked-asset book", () => {
    const [fresh, exp, bare] = ([[FRESH_SEC, {}], [AGE_CLK, {}], [AGE_CLK, { reserveReview: undefined }]] as const).map(([sec, patch]) => compCeil({ ...CBOOKS.tracked(), ...patch }, sec).facts);
    expect(fresh!.dependencies.diagnostics.issueCodes).toContain("outside-active-set:usdc-circle");
    expect(exp).toMatchObject({ reserveExposures: [], dependencies: { edges: bare!.dependencies.edges, diagnostics: bare!.dependencies.diagnostics }, gaps: expect.arrayContaining([expect.objectContaining({ reasonCode: "missing-reserve-composition" })]) });
    const split = compCeil({ ...CBOOKS.tracked(), reserveReview: { ...CBOOKS.tracked().reserveReview!, nonLinkDispositions: [{ reserveIndex: 0, reserveName: "USDC held in reserve", pct: 50, disposition: "basket-needs-split", rationale: "Split pending." }] } }, AGE_CLK).facts;
    expect([split.expiredReviewedAdmittedReserveScore, split.gaps.some((g) => g.reasonCode === "missing-reserve-composition")]).toEqual([undefined, true]);
  });

  it("keeps origin treatment when the admitted rows cannot compile", () => {
    const { context: base, asset } = compBravo(bMeta(), AGE_CLK), m = base.asset.expiredReviewedReserveComposition!;
    const ctx = mkCtx(base.fixedInput, base.extension, { ...base.asset, expiredReviewedReserveComposition: { ...m, admittedReserveRows: { ...m.admittedReserveRows, rows: [{ ...m.admittedReserveRows.rows[0]!, name: " " }] } } }, base.researchPayloadSha256);
    expect([asset.expiredReviewedAdmittedReserveScore! > 50, buildReserves(ctx).expiredReviewedAdmittedReserveScore]).toEqual([true, undefined]);
    expect([...ctx.gaps.values()].map((g) => [g.reasonCode, g.causeProof.cause])).toEqual([["missing-reserve-composition", "C"]]);
  });
});

describe("fail-closed reserve frame admission", () => {
  const cashSlice = (name: string, pct: number, extra: Partial<ReserveSlice> = {}): ReserveSlice => ({
    sourceKey: `fixture:${name.toLowerCase().replaceAll(" ", "-")}`, name, pct, risk: "very-low", assetClass: "cash",
    issuerOrObligor: `issuer:${name.toLowerCase().replaceAll(" ", "-")}`, liquidityHorizon: "immediate", maturityDaysMax: 0, ...extra,
  });
  function compFail(reserves: ReserveSlice[], mut: (a: ExtV2["assets"][number]) => void, omitLiveReserve = false) {
    const fixed = mkFixed({ assetId: AID, clockSec: NO_HIST_CLK, reserves, omitLiveReserve }), ext = mkExt({ clockSec: NO_HIST_CLK, registryFingerprint: fixed.registryFingerprint });
    mut(ext.assets[0]!);
    const compiled = comp0(fixed, ext), gap = compiled.gaps.find((r) => r.gapId === `${AID}:gap:asset-compilation`)!;
    return { compiled, gap, reason: compiled.evidence.find((r) => r.evidenceId === gap.evidenceRefIds[0])!.rejection?.reason };
  }

  it("refuses not-applicable reserve applicability when a live frame was captured", () => {
    const { compiled, gap, reason } = compFail([cashSlice("Cash", 100)], (a) => { a.reserveApplicability = { state: "not-applicable", rationale: "Fixture claim without reserves." }; });
    expect(compiled.reserveExposures).toEqual([]); expect(gap.causeProof).toMatchObject({ cause: "A", rejectionCode: "fact-build-failed" });
    expect(reason).toBe(`Reserve applicability for ${AID} conflicts with captured reserve rows`);
  });

  it("refuses reviewed static rows that were never bound to research evidence", () => {
    const { gap, reason } = compFail([], (a) => { a.reviewedStaticReserveRows = { rows: [cashSlice("Cash", 100)], evidenceClass: "independent", provenance: "audited-fallback" }; }, true);
    expect(gap.causeProof).toMatchObject({ cause: "A", rejectionCode: "fact-build-failed" });
    expect(reason).toBe(`Reviewed static reserve admission has no bound evidence for ${AID}`);
  });

  it("refuses two captured rows that share an exposure identity but disagree", () => {
    const { gap, reason } = compFail([cashSlice("Cash", 50), cashSlice("Cash counterparty", 50, { sourceKey: "fixture:cash" })], () => {});
    expect(gap.causeProof).toMatchObject({ cause: "A", rejectionCode: "fact-build-failed" });
    expect(reason).toMatch(new RegExp(`^Reserve exposure identity reserve:[a-f0-9]{24} is ambiguous for ${AID}$`));
  });

  it("refuses a classification with no captured exposure", () => {
    const key = "reserve:000000000000000000000000";
    const { gap, reason } = compFail([cashSlice("Cash", 100)], (a) => { a.reserveClassifications = [{ exposureKey: key, classificationKey: "fixture-unmatched", assetClass: null, issuerOrObligorKey: null, riskFactors: [], liquidityHorizon: null, maturityDaysMax: null, failureDomains: [] }]; });
    expect(gap.causeProof).toMatchObject({ cause: "A", rejectionCode: "fact-build-failed" });
    expect(reason).toBe(`Reserve classifications do not match captured exposures for ${AID}: ${key}`);
  });

  it("names an omitted curated-reserve envelope as a method limit when no producer exists", () => {
    const fixed = mkFixed({ assetId: AID, clockSec: NO_HIST_CLK, omitLiveReserve: true }), ctx = fbCtx(fixed, mkExt({ clockSec: NO_HIST_CLK, registryFingerprint: fixed.registryFingerprint }));
    const deps = { source: "curated-reserve", edges: [{ upstreamAssetId: "usdc-circle", weight: 1, economicRole: "basket-exposure" }], status: v9Status("known", "v9.dependencies.edge-exposure"), diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] } } as unknown as Parameters<typeof recDeps>[1];
    const res = recDeps(ctx, deps, []);
    expect(res).toMatchObject({ diagnostics: { graphState: "unresolved", issueCodes: ["collateral-edge-exposure-unmapped:usdc-circle"] }, status: { observationState: "bounded-unknown" } });
    expect(ctx.gaps.get(res.status.gapIds[0]!)!).toMatchObject({ reasonCode: "unreviewed-dependency-relationships", observationState: "bounded-unknown", message: expect.stringContaining("no live-reserve adapter is configured for this asset") });
  });

  it("reconciles an overfull frame against the residual when no exposure row can absorb it", () => {
    const tail = cashSlice("Unclassified remainder", 100, { unclassifiedResidual: true, residualReason: "insufficient-evidence" });
    const rows = ["A", "B", "C", "D", "E"].map((c) => cashSlice(`Cash ${c}`, 0.05)).concat(tail);
    const fixed = mkFixed({ assetId: AID, clockSec: NO_HIST_CLK, reserves: rows }), ext = mkExt({ clockSec: NO_HIST_CLK, registryFingerprint: fixed.registryFingerprint });
    ext.assets[0]!.reserveClassifications = [unclassifiedTail(tail)];
    const a = comp0(fixed, ext);
    expect(a.reserveExposures).toHaveLength(5); expect(a.reserveResiduals).toMatchObject([{ residualId: expKey(tail), weight: 0.9975 }]);
    expect(a.reserveExposures.reduce((s, r) => s + r.weight, 0) + a.reserveResiduals.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 12);
  });
});

describe("v10.01 cause compilation reserve proof boundaries", () => {
  const compSingle = (row: Partial<ReserveSlice>) => comp0(mkFixed({ reserves: [{ sourceKey: "fixture:holding", name: "Holding", pct: 100, risk: "very-low", issuerOrObligor: "custodian:alpha", ...row }] }));
  const matApp = (ov: Record<string, unknown> = {}): BoundFact => BoundSchema.parse({
    factKey: "fixture:maturity-applicability", kind: "maturity-applicability", scope: { kind: "exposure", exposureKey: "fixture:holding" },
    asOfSec: NO_HIST_CLK - 2 * DAY, publisher: "issuer", sourceUrls: ["https://example.com/prospectus"], assertion: "Open-ended shares have no maturity date",
    contentDigest: "a".repeat(64), provenance: { kind: "reviewed-research", reviewer: "fixture", reviewedAt: "2026-07-30", confidence: "high" },
    claimId: "fund-share", conclusion: "not-applicable", governingInstrument: "Fund prospectus", allInScope: true, ...ov,
  });
  const compMat = (fact: BoundFact) => {
    const fixed = mkFixed({ clockSec: NO_HIST_CLK, reserves: [{ sourceKey: "fixture:holding", name: "Holding", pct: 100, risk: "low", issuerOrObligor: "fund:alpha", assetClass: "fund-share", liquidityHorizon: "immediate" }] });
    const ext = mkExt({ clockSec: NO_HIST_CLK, registryFingerprint: fixed.registryFingerprint });
    ext.assets[0]!.reserveBoundFacts = [fact];
    return comp0(fixed, ext);
  };
  const compStale = (reserves: ReserveSlice[] | null, maxAgeSec: number | null = 1) => {
    const orig = reserves ? mkFixed({ reserves }) : mkFixed({ omitLiveReserve: true });
    const fixed = normFixed({ ...orig, baseInputGenerationId: undefined, liveReserveProvenanceMap: { alpha: { source: "fixture-reserve-api", fetchedAt: 1 } } });
    const ext = mkExt({ registryFingerprint: fixed.registryFingerprint });
    ext.sources.liveReserves.maxAgeSec = maxAgeSec;
    return comp0(fixed, ext);
  };

  it("binds failed reserve collection and the whole-asset remainder to the same A proof", () => {
    const orig = mkFixed({ omitLiveReserve: true });
    const fail = mkGapVerdict({ assetId: AID, scope: { pillar: "backing", componentKey: "reserve-composition", factorKey: null, routeKey: null, exposureId: null, requiredDatum: "reserve-composition" }, sourceId: "fixture-reserves", sourceGenerationId: "fixture-attempt:1", observedAtSec: orig.clockSec, asOfSec: orig.clockSec, producerState: "config-mismatch", rejectionCode: "reserve.admission.rejected-config", reason: "The configured generation was rejected." });
    const a = comp0(normFixed({ ...orig, baseInputGenerationId: undefined, pipelineGapByAssetId: { alpha: [fail] } }));
    const g = a.gaps.find((r) => r.causeScope?.componentKey === "reserve-composition")!;
    expect(g.causeProof).toMatchObject({ cause: "A", producerState: "config-mismatch", sourceGenerationId: "fixture-attempt:1" });
    expect(a.reserveResiduals).toMatchObject([{ weight: 1, status: { gapIds: [g.gapId] } }]);
    expect(a.evidence.find((r) => r.evidenceId === fail.evidence.evidenceId)).toEqual(fail.evidence);
  });

  it.each([["bank-deposit", "known", 91.9], [undefined, "bounded-unknown", 50 * .55 + 98 * .3 + 94 * .15]] as const)(
    "keeps missing obligor uncertainty scoped to concentration: %s",
    (assetClass, expState, expQual) => {
      const a = comp0(mkFixed({ reserves: [{ sourceKey: "fixture:holding", name: "Captured holding", pct: 100, risk: "low", ...(assetClass === undefined ? {} : { assetClass }), liquidityHorizon: "immediate", maturityDaysMax: 30 }] })), row = a.reserveExposures[0]!;
      expect(row.status.observationState).toBe(expState);
      expect(row.factorStatuses).toMatchObject({ assetClass: { observationState: assetClass === undefined ? "missing" : "known" }, liquidity: { observationState: "known" }, maturity: { observationState: "known" } });
      expect(a.gaps.find((g) => g.gapId === row.factorStatuses?.obligorConcentration?.gapIds[0])).toMatchObject({ causeProof: { cause: "U" }, causeScope: { pillar: "backing", componentKey: "reserve-exposure", factorKey: "obligorConcentration", exposureId: row.exposureKey, requiredDatum: "issuerOrObligorKey" } });
      const back = evRes(a), expRow = back.contributions.find((e) => e.componentKey === `reserve:${row.exposureKey}`)!;
      expect(expRow.score).toBeCloseTo(expQual, 12); expect(expRow.cause).toBe(assetClass === undefined ? "U" : null);
      expect(back.contributions.find((e) => e.componentKey === "reserve:concentration")).toMatchObject({ score: 50, cause: "U" });
      if (assetClass !== undefined) {
        expect(okAsset({ ...a, reserveExposures: [{ ...row, issuerOrObligorKey: "identified-bank" }] })).toBe(false);
        const { obligorConcentration: _drop, ...factorStatuses } = row.factorStatuses!;
        expect(okAsset({ ...a, reserveExposures: [{ ...row, factorStatuses }] })).toBe(false);
      }
    },
  );

  it("does not hide unknown reserve factors behind a known whole row", () => {
    const a = compSingle({ assetClass: "bank-deposit", liquidityHorizon: "unknown" }), exp = a.reserveExposures[0]!;
    expect(exp.status.observationState).toBe("known");
    for (const [factorKey, requiredDatum] of [["liquidity", "liquidityHorizon"], ["maturity", "maturityDaysMax"]] as const) {
      expect(a.gaps.find((r) => r.gapId === exp.factorStatuses![factorKey]!.gapIds[0])).toMatchObject({ causeProof: { cause: "U" }, causeScope: { pillar: "backing", componentKey: "reserve-exposure", factorKey, routeKey: null, exposureId: exp.exposureKey, requiredDatum } });
    }
    expect(a.reserveResiduals).toEqual([]); expect(exp.weight).toBe(1);
  });

  it("does not promote an unclassified parent-denominated strategy to a direct stablecoin holding", () => {
    expect(compSingle({ coinId: "usdc-circle", depType: "wrapper" }).reserveExposures[0]).toMatchObject({ trackedAssetId: "usdc-circle", assetClass: null, status: { observationState: "bounded-unknown" } });
    expect(compSingle({ coinId: "usdc-circle", depType: "wrapper", assetClass: "stablecoin" }).reserveExposures[0]).toMatchObject({ trackedAssetId: "usdc-circle", assetClass: "stablecoin", status: { observationState: "known" } });
  });

  it.each(POL.policy.semantic.backing.reserve.maturityNotApplicableClasses)("publishes maturity as not-applicable, not a researchable gap, for admitted %s reserves", (assetClass) => {
    const a = compSingle({ assetClass, liquidityHorizon: "immediate" }), exp = a.reserveExposures[0]!;
    expect(exp.factorStatuses!.maturity).toMatchObject({ observationState: "known", gapIds: [], applicability: { state: "not-applicable" } });
    expect(a.gaps.filter((g) => g.causeScope?.requiredDatum === "maturityDaysMax")).toEqual([]); expect(okAsset(a)).toBe(true);
    const f = evRes(a).contributions.find((e) => e.componentKey === `reserve:${exp.exposureKey}`)!.factors!.find((e) => e.componentKey === `reserve:${exp.exposureKey}:maturity`)!;
    expect(f).toMatchObject({ cause: null, causeGapIds: [], scoringDisposition: "included" });
    expect(f.score).toBeGreaterThan(0); expect(f.effectiveScoringWeight).toBeGreaterThan(0);
  });

  it.each([["maturity-applicable class", "bank-deposit"], ["unadmitted class", undefined]] as const)("keeps the unknown maturity gap for a %s", (_l, assetClass) => {
    const a = compSingle({ ...(assetClass === undefined ? {} : { assetClass }), liquidityHorizon: "immediate" }), exp = a.reserveExposures[0]!, st = exp.factorStatuses!.maturity!;
    expect(exp.assetClass).toBe(assetClass ?? null); expect(st.applicability.state).toBe("required");
    expect(a.gaps.find((r) => r.gapId === st.gapIds[0])).toMatchObject({ causeProof: { cause: "U" }, causeScope: { factorKey: "maturity", requiredDatum: "maturityDaysMax" } });
  });

  it("publishes maturity as not-applicable when an admitted whole-exposure bound fact concludes so", () => {
    const a = compMat(matApp()), exp = a.reserveExposures[0]!;
    expect(a.reserveBoundFacts![0]!.rejectionReason).toBeNull();
    expect(exp.factorStatuses!.maturity).toMatchObject({ observationState: "known", gapIds: [], applicability: { state: "not-applicable" } });
    expect(exp.factorStatuses!.maturity!.evidenceRefIds).toContain("alpha:reserve-bound:fixture:maturity-applicability");
    expect(a.gaps.filter((g) => g.causeScope?.requiredDatum === "maturityDaysMax")).toEqual([]); expect(okAsset(a)).toBe(true);
    expect(evRes(a, { asOfSec: NO_HIST_CLK }).contributions.find((e) => e.componentKey === `reserve:${exp.exposureKey}`)!.factors!.filter((e) => e.componentKey.startsWith(`reserve:${exp.exposureKey}:maturity`))).toEqual([expect.objectContaining({ componentKey: `reserve:${exp.exposureKey}:maturity:covered`, score: 100, cause: null, scoringDisposition: "included" })]);
  });

  it("publishes an applicable open-ended claim at the longest maturity band without inventing a finite term", () => {
    const a = compMat(matApp({ conclusion: "open-ended", governingInstrument: "Exact Class A share" })), exp = a.reserveExposures[0]!;
    expect(exp.maturityDaysMax).toBeNull();
    expect(exp.factorStatuses!.maturity).toMatchObject({ observationState: "known", gapIds: [], applicability: { state: "required" } });
    expect(a.gaps.filter((g) => g.causeScope?.requiredDatum === "maturityDaysMax")).toEqual([]);
    expect(okAsset(a)).toBe(true); expect(okAsset({ ...a, reserveBoundFacts: [] })).toBe(false);
    expect(okAsset({ ...a, reserveExposures: [{ ...exp, factorStatuses: { ...exp.factorStatuses, maturity: { ...exp.factorStatuses!.maturity!, evidenceRefIds: [] } } }] })).toBe(false);
    expect(evRes(a, { asOfSec: NO_HIST_CLK }).contributions.find((e) => e.componentKey === `reserve:${exp.exposureKey}`)!.factors!.filter((e) => e.componentKey.startsWith(`reserve:${exp.exposureKey}:maturity`))).toEqual([expect.objectContaining({ score: 48, cause: null, scoringDisposition: "included" })]);
  });

  it.each([["stale", { asOfSec: NO_HIST_CLK - 400 * DAY }], ["wrong exposure", { scope: { kind: "exposure", exposureKey: "fixture:other" } }], ["partial exposure", { allInScope: false }]] as const)(
    "keeps open-ended maturity unknown when %s",
    (_l, ov) => {
      const a = compMat(matApp({ conclusion: "open-ended", ...ov })), st = a.reserveExposures[0]!.factorStatuses!.maturity!;
      expect(st.observationState).not.toBe("known"); expect(st.applicability.state).toBe("required");
      expect(a.gaps.find((g) => g.gapId === st.gapIds[0])!.causeProof.cause).toBe("U");
    },
  );

  it.each([
    ["an unelapsed review day", () => matApp({ provenance: { kind: "reviewed-research", reviewer: "fixture", reviewedAt: "2026-08-01", confidence: "high" } })],
    ["an expired snapshot", () => matApp({ asOfSec: NO_HIST_CLK - 400 * DAY })],
    ["a partial-scope conclusion", () => matApp({ allInScope: false })],
    ["a sub-instrument scope", () => matApp({ scope: { kind: "sub-instrument", exposureKey: "fixture:holding", instrumentId: "class-a", coveredShare: 0.5, coverageAsOfSec: NO_HIST_CLK - 2 * DAY } })],
    ["a non-matching exposure key", () => matApp({ scope: { kind: "exposure", exposureKey: "fixture:other" } })],
  ] as const)("keeps the unknown maturity gap for %s", (_l, fact) => {
    const a = compMat(fact()), st = a.reserveExposures[0]!.factorStatuses!.maturity!;
    expect(st.applicability.state).toBe("required");
    expect(a.gaps.find((r) => r.gapId === st.gapIds[0])).toMatchObject({ causeProof: { cause: "U" }, causeScope: { factorKey: "maturity", requiredDatum: "maturityDaysMax" } });
  });

  const causeIssues = (row: Parameters<typeof refineCause>[0]) => { const o: string[] = []; refineCause(row, { addIssue: (i) => { o.push(typeof i === "string" ? i : String(i.message)); } }); return o; };

  it("publishes a B reserve factor as excluded-uncurated without failing its row or concentration", () => {
    const fixed = mkFixed({ reserves: [
      { sourceKey: "fixture:uncurated-b", name: "Curated-later deposit", pct: 40, risk: "very-low", assetClass: "bank-deposit", liquidityHorizon: "immediate", issuerOrObligor: "bank:alpha" },
      { sourceKey: "fixture:uncurated-mixed", name: "Mixed deposit", pct: 35, risk: "very-low", assetClass: "bank-deposit", liquidityHorizon: "unknown", issuerOrObligor: "bank:beta" },
      { sourceKey: "fixture:unresearched-u", name: "Unresearched deposit", pct: 25, risk: "very-low", assetClass: "bank-deposit", liquidityHorizon: "immediate", maturityDaysMax: 30, issuerOrObligor: "bank:gamma" },
    ] });
    const back = evRes(comp0(fixed)), row = (sk: string) => back.contributions.find((e) => e.componentKey === `reserve:${expKey({ sourceKey: sk, name: "x", pct: 1, risk: "low" })}`)!;
    const res = POL.policy.semantic.backing.reserve, w = res.factorWeights, unc = row("fixture:uncurated-b"), mix = row("fixture:uncurated-mixed");
    expect(unc).toMatchObject({ cause: null, scoringDisposition: "included", effectiveScoringWeight: 0.4 });
    expect(unc.score).toBeCloseTo((res.assetClassQuality["bank-deposit"] * w.assetQuality + res.liquidityQuality.immediate * w.liquidity) / (w.assetQuality + w.liquidity), 12);
    expect(unc.factors!.find((f) => f.componentKey.endsWith(":maturity"))).toMatchObject({ score: null, cause: "B", scoringDisposition: "excluded-uncurated", effectiveScoringWeight: 0, causeGapIds: [expect.stringContaining(":maturity")] });
    expect(mix).toMatchObject({ cause: "U", scoringDisposition: "bounded-uncertainty" });
    expect(mix.factors!.map((f) => [f.componentKey, f.cause, f.scoringDisposition])).toEqual([[`${mix.componentKey}:assetClass`, null, "included"], [`${mix.componentKey}:liquidity`, "U", "bounded-uncertainty"], [`${mix.componentKey}:maturity`, "B", "excluded-uncurated"]]);
    expect(row("fixture:unresearched-u")).toMatchObject({ cause: null, scoringDisposition: "included" });
    for (const c of back.contributions) { expect(causeIssues(c), c.componentKey).toEqual([]); for (const f of c.factors ?? []) expect(causeIssues(f), f.componentKey).toEqual([]); }
  });

  function compPart(rows: ReserveSlice[]) {
    const fixed = mkFixed({ assetId: AID, clockSec: NO_HIST_CLK, reserves: rows }), base = buildBaseExt(fixed, mMap(AID, { ...baseMeta(), reserves: rows })), tails = new Set(rows.filter((r) => r.unclassifiedResidual).map(expKey)), a = base.assets[0]!;
    const ext = { ...base, assets: [{ ...a, reserveClassifications: a.reserveClassifications.map((c) => tails.has(c.exposureKey) ? { ...c, unclassifiedResidual: true as const, ...(rows.find((r) => expKey(r) === c.exposureKey)?.publishedResidualCategory ? { publishedResidualCategory: true as const } : {}) } : c) }] };
    const input = normComp(fixed);
    return compileIso(input, matExt(input, ext));
  }

  const bankCash = (pct: number): ReserveSlice => ({
    sourceKey: "fixture:cash", name: "Cash", pct, risk: "very-low", assetClass: "cash", issuerOrObligor: "bank:alpha",
  });
  const publishedResidual = (pct: number): ReserveSlice => ({
    sourceKey: "fixture:published", name: "Other Cash and Cash Equivalents", pct,
    risk: "high", unclassifiedResidual: true, residualReason: "insufficient-evidence",
  });

  it.each([0.0014195216154720709, 1, 1.000001, 10])("retains bounded pricing but applies published residual gate at %s percent", (pct) => {
    const res = compPart([
      bankCash(100 - pct),
      { ...publishedResidual(pct), publishedResidualCategory: true },
    ]);
    expect(res.quarantines).toEqual([]);
    const a = res.factSet.assets[0]!, r0 = a.reserveResiduals[0]!;
    expect(a.gaps.find((r) => r0.status.gapIds.includes(r.gapId))).toMatchObject({ reasonCode: pct <= 1 ? "bounded-unknown-reserve-exposure" : "partial-reserve-review", causeScope: { componentKey: "reserve-residual", requiredDatum: "reserveClassification" } });
    expect(evRes(a).contributions.find((r) => r.componentKey.startsWith("reserve:unclassified-residual:"))).toMatchObject({ score: 50, wholeAssetWeight: pct / 100, cause: "U", scoringDisposition: "bounded-uncertainty" });
  });

  it.each(["unmarked", "split", "incomplete"] as const)("does not exempt %s reserve uncertainty", (kind) => {
    const tail: ReserveSlice = { ...publishedResidual(0.6), ...(kind === "unmarked" ? {} : { publishedResidualCategory: true }) };
    const res = compPart([bankCash(kind === "split" ? 98.8 : kind === "incomplete" ? 99 : 99.4), tail, ...(kind === "split" ? [{ ...tail, sourceKey: "fixture:second", name: "Other Receivables" }] : [])]);
    expect(res.quarantines).toEqual([]);
    const a = res.factSet.assets[0]!;
    for (const r of a.reserveResiduals) expect(a.gaps.find((g) => r.status.gapIds.includes(g.gapId))!.reasonCode).toBe("partial-reserve-review");
  });

  it("reconciles accepted live rounding overshoot without erasing dust or a disjoint explicit remainder", () => {
    const rows: ReserveSlice[] = [
      bankCash(99.9998),
      { sourceKey: "fixture:dust", name: "Dust holding", pct: 0.00000001, risk: "very-low", assetClass: "cash", issuerOrObligor: "bank:dust" },
      { sourceKey: "fixture:tail", name: "Unclassified reserve share", pct: 0.00029874702072, risk: "high", unclassifiedResidual: true, residualReason: "insufficient-evidence" },
    ];
    const res = compPart(rows), a = res.factSet.assets[0]!;
    expect(res.quarantines).toEqual([]); expect(a.reserveExposures.find((r) => r.name === "Dust holding")!.weight).toBe(1e-10);
    expect(a.reserveResiduals[0]!.weight).toBe(rows[2]!.pct / 100);
    expect(a.reserveExposures.reduce((s, r) => s + r.weight, 0) + a.reserveResiduals.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 15);
    expect(rows[0]!.pct).toBe(99.9998);
  });

  it("keeps a true overfull reserve frame unavailable instead of normalizing away the producer failure", () => {
    const a = compPart([bankCash(60), { sourceKey: "fixture:tail", name: "Unclassified reserve share", pct: 41, risk: "high", unclassifiedResidual: true, residualReason: "insufficient-evidence" }]).factSet.assets[0]!;
    expect(a.gaps).toContainEqual(expect.objectContaining({ causeProof: expect.objectContaining({ cause: "A", rejectionCode: "fact-build-failed" }), causeScope: expect.objectContaining({ componentKey: "asset-compilation" }) }));
    expect(a.reserveExposures).toEqual([]); expect(a.reserveResiduals).toEqual([]);
  });

  it.each([[99.9999, 1e-6], [99.999999, 1e-8]] as const)("retains a genuine %s rounding remainder without erasing identified holdings", (pct, rem) => {
    const a = compSingle({ name: "Cash", pct, assetClass: "cash", liquidityHorizon: "immediate", maturityDaysMax: 0 });
    expect(a.reserveExposures[0]!.weight).toBeCloseTo(1 - rem, 12); expect(a.reserveResiduals[0]!.weight).toBeCloseTo(rem, 12);
    expect(a.reserveExposures[0]!.weight + a.reserveResiduals[0]!.weight).toBe(1);
    expect(a.gaps.find((r) => r.gapId === a.reserveResiduals[0]!.status.gapIds[0])).toMatchObject({ causeProof: { cause: "U" }, causeScope: { requiredDatum: "reserveCompositionRemainder" } });
  });

  it("treats a float-accumulation shortfall as a complete composition, not an unidentified remainder", () => {
    const a = compSingle({ name: "Cash", pct: 99.99999999999999, assetClass: "cash", liquidityHorizon: "immediate" }), dust = 1 - a.reserveExposures[0]!.weight;
    expect(dust).toBeGreaterThan(0); expect(dust).toBeLessThan(1e-15);
    expect(a.reserveResiduals).toEqual([]); expect(a.gaps.filter((g) => g.causeScope?.requiredDatum === "reserveCompositionRemainder")).toEqual([]);
    expect(a.reserveStatus).toMatchObject({ observationState: "known", gapIds: [] }); expect(okAsset(a)).toBe(true);
  });

  it.each([false, true])("uses only the admitted envelope for an all-unknown tail when live=%s", (withLive) => {
    const tail = { ...(withLive ? { sourceKey: "fixture:tail" } : {}), name: "Unclassified remainder", pct: 100, risk: "high" as const, unclassifiedResidual: true as const, residualReason: "insufficient-evidence" as const };
    const fixed = mkFixed({ reserves: [tail], omitLiveReserve: !withLive }), ext = mkExt({ registryFingerprint: fixed.registryFingerprint }), ia = ext.assets[0]!;
    ia.reserveClassifications = withLive ? [unclassifiedTail(tail)] : [];
    ia.reviewedStaticReserveRows = { rows: [tail], evidenceClass: "independent", provenance: "audited-fallback" };
    ia.researchEvidence.push({ evidenceKey: "fixture-current-composition", sourceId: "fixture-composition-report", observedAtSec: fixed.clockSec - 1, publishedAtSec: fixed.clockSec - 1, publishedBy: "issuer", url: "https://example.com/current-composition", contentSha256: "1".repeat(64), confidence: "verified", maxAgeSec: 3600 });
    ia.componentEvidence.push({ componentKey: "reviewed-static-reserves", evidenceKeys: ["fixture-current-composition"] });
    const a = comp0(fixed, ext);
    expect(a).toMatchObject({ reserveExposures: [], reserveResiduals: [{ weight: 1 }], reserveCompositionProvenance: withLive ? "live" : "audited-fallback" });
    expect(a.reserveCompositionEvidenceClass).toBe(withLive ? undefined : "independent");
    expect(a.gaps.find((r) => r.gapId === a.reserveResiduals[0]!.status.gapIds[0])!.causeProof.cause).toBe("U");
  });

  it.each([undefined, true] as const)("preserves stale captured holdings without credit (selfReferential=%s)", (sr) => {
    const a = compStale([{ sourceKey: "fixture:cash", name: "Cash", pct: 100, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate", issuerOrObligor: "custodian:alpha", maturityDaysMax: 0, ...(sr ? { selfReferential: sr } : {}) }]);
    expect(a.reserveExposures[0]).toMatchObject({ weight: 1, status: { observationState: "stale" } });
    expect(a.reserveExposures[0]?.selfReferential).toBe(sr);
    expect(a.reserveCompositionEvidenceClass).toBeUndefined(); expect(a.reserveCompositionProvenance).toBeUndefined();
    expect(a.gaps.some((g) => g.causeScope?.componentKey === "asset-compilation")).toBe(false);
    const back = evRes(a);
    expect.soft(back.score).toBeNull();
    expect.soft(back.contributions.map((r) => [r.source, r.score, r.scoringDisposition])).toEqual([["reserve-exposure", null, "excluded-pipeline"], ["reserve-concentration", null, "excluded-pipeline"]]);
    const sg = a.gaps.filter((g) => g.observationState === "stale" && g.causeScope?.componentKey === "reserve-exposure");
    expect(sg).toHaveLength(sr ? 1 : 5);
    for (const g of sg) {
      expect(g).toMatchObject({ responsibility: "producer-failed", causeProof: { cause: "A", producerState: "stale-producer", rejectionCode: "reserve-fetch-stale" } });
      for (const eid of g.causeProof.evidenceRefIds) expect(a.evidence.find((r) => r.evidenceId === eid)).toMatchObject({ disposition: "rejected", causeBinding: { assetId: AID, scope: g.causeScope } });
    }
  });

  it("does not turn an uncurated subfield into a producer failure when the holding is stale", () => {
    const a = compStale([{ sourceKey: "fixture:cash", name: "Cash", pct: 100, risk: "very-low", assetClass: "cash", liquidityHorizon: "immediate", issuerOrObligor: "custodian:alpha" }]);
    expect(a.gaps.find((g) => g.causeScope?.factorKey === "maturity")).toMatchObject({ observationState: "missing", responsibility: "unresearched", causeProof: { cause: "U" } });
    expect(a.gaps.find((g) => g.causeScope?.factorKey === "assetClass")?.causeProof.cause).toBe("A");
  });

  it("does not infer a stale producer from a null fetch budget", () => {
    const a = compStale([{ sourceKey: "fixture:bill", name: "Treasury bills", pct: 100, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "immediate", issuerOrObligor: "custodian:alpha" }], null);
    expect(a.evidence.find((r) => r.evidenceId.startsWith("alpha:reserve:"))!.freshness).toMatchObject({ state: "not-assessed", maxAgeSec: null });
    expect(a.gaps.find((g) => g.causeScope?.factorKey === "maturity")!.causeProof.cause).toBe("U");
    expect(a.gaps.some((g) => g.causeProof.cause === "A")).toBe(false);
  });

  it("does not invent a reserve failure from provenance without captured holdings", () => {
    const a = compStale(null);
    expect(a.reserveExposures).toEqual([]);
    expect(a.gaps.find((g) => g.causeScope?.componentKey === "reserve-composition")!.causeProof.cause).toBe("U");
  });
});

describe("v10.01 scoped authored reserve causes", () => {
  it.each([["usdc-circle", "B"], ["usdt-tether", "C"]] as const)("binds %s missing composition to current researched %s without manufacturing holdings", (assetId, cause) => {
    const fixed = mkFixed({ assetId, omitLiveReserve: true }), a = comp0(fixed, mkExt({ assetId, registryFingerprint: fixed.registryFingerprint }));
    const g = a.gaps.find((r) => r.causeScope?.componentKey === "reserve-composition")!;
    expect(g.causeProof.cause).toBe(cause); expect(a.reserveExposures).toEqual([]);
    expect(a.reserveResiduals).toMatchObject([{ weight: 1, status: { gapIds: [g.gapId] } }]);
    expect(a.evidence.find((r) => r.evidenceId === g.causeProof.evidenceRefIds[0])!.causeBinding).toMatchObject({ assetId, scope: g.causeScope });
  });
});

describe("direct backing reserve builder", () => {
  it("uses the fresh fetch clock for its budget without redating the retained portfolio observation", () => {
    const orig = mkFixed(), sAsOf = orig.clockSec - 600;
    const fixed = normFixed({ ...orig, baseInputGenerationId: undefined, liveReserveProvenanceMap: { alpha: {
      source: "fixture-reserve-api", fetchedAt: orig.clockSec - 1,
      reserveObservation: { kind: "portfolio-observation", scopeId: "fixture:portfolio", liabilityBookKey: "fixture:alpha", deploymentRefs: [], reviewer: "fixture", confidence: "verified", sources: [{ url: "https://example.com/portfolio", accessedAtSec: orig.clockSec - 1, sha256: "a".repeat(64) }], reviewedAtSec: orig.clockSec - 1, expiresAtSec: orig.clockSec + 1, sourceGeneration: "fixture:unchanged-portfolio", sourceSha256: "a".repeat(64), completeness: "complete", obligations: [], observedAtSec: sAsOf, wholeAssetDenominator: { amount: "100", asOfSec: sAsOf, unitBasis: "USD", sourceSha256: "a".repeat(64) } },
    } } });
    const ctx = fbCtx(fixed), res = buildReserves(ctx);
    expect(res.reserveExposures[0]!.status.observationState).toBe("known");
    expect(ctx.evidence.get(res.reserveExposures[0]!.status.evidenceRefIds[0]!)).toMatchObject({ observedAtSec: orig.clockSec - 1, freshness: { state: "current" } });
    expect(fixed.liveReserveProvenanceMap.alpha!.reserveObservation!.observedAtSec).toBe(sAsOf);
  });

  it.each([100, 70])("preserves a %s percent holding and leaves unidentified notional explicit", (pct) => {
    const ctx = fbCtx(mkFixed({ reserves: [{ ...mkFixed().liveReserveMap.alpha![0]!, pct }] })), res = buildReserves(ctx);
    expect(res.reserveExposures).toEqual([expect.objectContaining({ name: "Custodied cash", weight: pct / 100, status: expect.objectContaining({ observationState: "known" }) })]);
    if (pct === 100) expect(res).toMatchObject({ reserveStatus: { observationState: "known" }, reserveResiduals: [] });
    else { expect(res.reserveStatus.observationState).toBe("bounded-unknown"); expect(res.reserveResiduals).toHaveLength(1); expect(res.reserveResiduals[0]).toMatchObject({ residualId: "unidentified" }); expect(res.reserveResiduals[0]!.weight).toBeCloseTo(0.3); }
    expect(ctx.evidence.get(res.reserveExposures[0]!.status.evidenceRefIds[0]!)).toMatchObject({ sourceId: "fixture-reserve-api", sourceGenerationId: ctx.extension.sources.liveReserves.generationId, freshness: { state: "current" } });
  });

  it("retains a stale holding but does not label its composition current", () => {
    const fixed = mkFixed(), ext = mkExt({ registryFingerprint: fixed.registryFingerprint });
    ext.sources.liveReserves.maxAgeSec = 99;
    const ctx = fbCtx(fixed, ext), res = buildReserves(ctx);
    expect(res.reserveExposures[0]).toMatchObject({ weight: 1, status: { observationState: "stale" } });
    expect(res.reserveStatus.observationState).toBe("bounded-unknown");
    expect([...ctx.gaps.values()]).toContainEqual(expect.objectContaining({ reasonCode: "partial-reserve-review", observationState: "stale" }));
    expect(res.reserveCompositionProvenance).toBeUndefined();
    const row = { ...fixed.liveReserveMap.alpha![0]!, sourceKey: "fixture:own-vault", pct: 85 }, partial = mkFixed({ reserves: [row] });
    const date = new Date(partial.clockSec * 1e3).toISOString().slice(0, 10), m = { id: AID, reserves: [{ ...row, pct: 100 }], reserveReview: eligMeta().reserveReview! };
    const comp = (ownLiability: boolean) => {
      const rev = { ...m, reserveReview: { ...m.reserveReview!, reviewedAt: date, compositionAsOf: date, nonLinkDispositions: [{ reserveIndex: 0, reserveName: row.name, pct: 100, disposition: "self-reserve" as const, ...(ownLiability ? { ownLiability: true as const } : {}), rationale: "Vault redeems into the subject liability." }] } };
      const b = buildBaseExt(partial, mMap(AID, rev)); b.sources.liveReserves.maxAgeSec = 99;
      const a = comp0(partial, b);
      return { asset: a, score: evRes(a) };
    };
    const ord = comp(false), own = comp(true);
    expect(own.asset.reserveExposures[0]).toMatchObject({ selfReferential: true, status: { observationState: "stale" } });
    expect(own.asset.reserveCompositionProvenance).toBeUndefined();
    expect(own.score.score).toBe(ord.score.score);
    expect(own.score.contributions.find((r) => r.componentKey === "reserve:unclassified-residual:unidentified")?.score).toBe(40);
  });

  it("rejects reserve weights exceeding the whole-asset denominator", () => {
    const base = mkFixed().liveReserveMap.alpha![0]!;
    expect(() => buildReserves(fbCtx(mkFixed({ reserves: [{ ...base, name: "Cash A", pct: 60 }, { ...base, name: "Cash B", pct: 60 }] })))).toThrow(/exceed the whole-asset denominator/);
  });
});

describe("v10.19 frozen lender-book fact admission", () => {
  const id = "kpkusdcprime-kpk", clk = 1_792_000_000, btc = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`, word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const syncTbls = (metadata: string, fp: string) => [
    { match: "SELECT metadata, config_fingerprint FROM reserve_composition", rows: [{ metadata, config_fingerprint: fp }] },
    ...["INSERT INTO reserve_composition", "UPDATE reserve_sync_state", "INSERT OR IGNORE INTO reserve_composition_history", "INSERT OR IGNORE INTO reserve_sync_attempt_history"].map((match) => ({ match, rows: [], runMeta: { changes: 1 } })),
  ];
  const storedBind = (db: ReturnType<typeof mockD1>) => String(db.getHistory().find((e) => e.sql.includes("INSERT INTO reserve_composition ("))!.binds[5]);
  const reid = <T extends Record<string, unknown>>(p: T) => BookSchema.parse({ ...p, ...bookId(p as never) });
  const book = (o: { age?: number; collateral?: string; idle?: boolean } = {}): BookObs => {
    const at = clk - (o.age ?? 100);
    const p = {
      schemaVersion: 1 as const, assetId: id, acquiredAtSec: at, maxAgeSec: 28_800, status: "ok" as const, censusScope: "complete-nav-accounted-current-book" as const,
      deployments: [{
        chain: "ethereum", vault: addr(1), kind: "vault-v2" as const, pin: { chain: "ethereum", number: 26_191_269, hash: word(1), timestampSec: at, finality: "finalized" as const },
        loanToken: addr(2), loanDecimals: 6, totalAssetsRaw: "1000", totalSupplyRaw: "1000", idleAssetsRaw: o.idle ? "1000" : "0", reconciledAssetsRaw: "1000", reconciliationResidualRaw: "0",
        codeHashes: { [addr(1)]: word(2), [addr(3)]: word(3), [addr(4)]: word(4) }, selectorsRead: ["asset()", "market(bytes32)", "totalAssets()"],
        markets: o.idle ? [] : [{ account: addr(3), adapter: addr(3), morpho: addr(4), marketId: word(5), loanToken: addr(2), collateralToken: o.collateral ?? btc, oracle: addr(6), irm: addr(7), lltvRaw: "860000000000000000", supplySharesRaw: "1000000000", positionBorrowSharesRaw: "0", positionCollateralRaw: "0", marketSupplyAssetsRaw: "1000", marketSupplySharesRaw: "1000000000", marketBorrowAssetsRaw: "500", marketBorrowSharesRaw: "500000000", marketLastUpdateSec: at, marketFeeRaw: "0", includedAssetsRaw: "1000", accruedMethod: "adapter-expected-supply-assets" as const, collateralMode: "collateralized" as const }],
      }],
    };
    return BookSchema.parse(canonBook({ ...p, ...bookId(p) }));
  };
  const unavail = (reason: Extract<BookObs, { status: "unavailable" }>["reason"]): BookObs => reid({ schemaVersion: 1 as const, assetId: id, acquiredAtSec: clk - 100, maxAgeSec: 28_800, status: "unavailable" as const, reason, failedDeploymentKey: "ethereum:failed-vault", deployments: null });
  const src = (ctx: BuildCtx, rows: Partial<ColBacking> = {}): ColBacking => BackingSchema.parse({
    schemaVersion: 1, status: "ok", reason: null, publicationGenerationId: "report-cards:v9:fixture", publishedAtSec: clk - 50,
    policyDigest: "a".repeat(64), evaluationBuildDigest: "b".repeat(64), registryFingerprint: ctx.fixedInput.registryFingerprint, maxAgeSec: MAX_AGE, tokenToAssetId: {}, byAssetId: {}, ...rows,
  });
  const context = (obs?: BookObs, bnd?: ColBacking, scClk = clk): BuildCtx => {
    const fixed = mkFixed({ assetId: id, clockSec: scClk, reserves: [{ name: "Parent-denominated lender assets", pct: 100, risk: "low", coinId: "usdc-circle", depType: "collateral", assetClass: "stablecoin", issuerOrObligor: "asset:usdc-circle", liquidityHorizon: "immediate" }] });
    const r = fbCtx(fixed, mkExt({ assetId: id, clockSec: scClk, registryFingerprint: fixed.registryFingerprint }));
    return { ...r, fixedInput: { ...r.fixedInput, liveReserveProvenanceMap: { [id]: { source: "onchain", fetchedAt: clk - 100, ...(obs ? { lenderBookObservation: obs } : {}) } }, ...(bnd ? { lenderCollateralBacking: bnd } : {}) } };
  };
  const withAtt = (ctx: BuildCtx, f: unknown): BuildCtx => ({ ...ctx, fixedInput: { ...ctx.fixedInput, liveReserveProvenanceMap: { [id]: { ...ctx.fixedInput.liveReserveProvenanceMap[id]!, lenderBookLatestAttemptFailure: f as Extract<BookObs, { status: "unavailable" }> } } } });
  const compState = (attemptId: string, obs: BookObs) => {
    const meta = META.get(id)!, config = meta.liveReservesConfig!, fp = cfgFp(config), metadata = { freshnessMode: "not-applicable" as const, lenderBookObservation: obs };
    return { meta, config, fp,
      comp: { stablecoinId: id, slices: meta.reserves!, fetchedAt: clk, source: config.adapter, attemptId, configFingerprint: fp, metadata, warningCount: 0, warnings: [], adapterSourceModel: "dynamic-mix" as const, adapterEvidenceClass: "independent" as const } satisfies ReserveCompositionRecord,
      state: { stablecoinId: id, adapterKey: config.adapter, breakerKey: "fixture", lastAttemptedAt: clk, lastSuccessAt: clk, lastStatus: "ok" as const, warningCount: 0, warnings: [], lastError: null, metadata, lastAttemptId: attemptId, configFingerprint: fp } satisfies ReserveSyncStateRecord,
    };
  };
  const usdcParent = { parentAssetId: "usdc-circle", parentBackingScore: 90, weight: 1, tier: "wrapped" as const, failureDomains: [] };

  it("omits the lane without an admitted observation or supported adapter", () => expect(buildBook(fbCtx())).toBeUndefined());

  it.each([0, 28_800])("admits complete class-proxy books at inclusive age %s", (age) => {
    const ctx = context(book({ age })), fact = buildBook(ctx)!;
    expect(okBook(fact)).toBe(true); expect(fact.status.observationState).toBe("known");
    expect(fact.collaterals[0]).toMatchObject({ quality: 85, qualitySource: "authored-class", collateralClass: "btc-wrapper" });
    expect(evalBook(fact, 90, POL)?.reserveQuality).toBeCloseTo(80.0154, 8);
    expect(ctx.fixedInput.liveReserveMap[id]).toBeDefined();
    expect(fact.status.evidenceRefIds.every((x) => ctx.evidence.has(x))).toBe(true);
  });

  it("binds class evidence to the reviewed data registry rather than methodology policy", () => {
    const ctx = context(book()), fact = buildBook(ctx)!, reg = getClassReg();
    expect(fact.status.evidenceRefIds.map((x) => ctx.evidence.get(x)!).find((r) => r.sourceId === reg.registry.registryId)).toMatchObject({ sourceId: "safety-score-v9.lender-collateral-classes.v1", sourceGenerationId: reg.digest, observedAtSec: iso("2026-10-14") });
    expect(fact.collaterals[0]).toMatchObject({ quality: 85, collateralClass: "btc-wrapper" });
  });

  it("retains the original future-review guard after moving token reviews out of policy", () => {
    expect(() => buildBook(context(book({ collateral: "0x7f47c3e6b2c00fc4eb4d5ae50d0ab0ab6888eb4d" })))).toThrow("Future lender collateral class review");
  });

  it.each([["0x232128844e5af56fd4b3f8bf97e08ab477282ab5", "yield-bearing-stable"], ["0x7f47c3e6b2c00fc4eb4d5ae50d0ab0ab6888eb4d", "principal-token"]])(
    "compiles reviewed exact receipt %s from the data registry after its original review date",
    (collateral, collateralClass) => {
      const at = iso("2026-10-21T00:00:00Z");
      expect(buildBook(context(book({ collateral, age: clk - at + 100 }), undefined, at))!.collaterals[0]).toMatchObject({ quality: 55, collateralClass, qualitySource: "authored-class" });
    },
  );

  it.each(["rpc-unavailable", "unreconciled", "deadline"] as const)("retains admitted Backing after %s until the original eight-hour budget expires", async (reason) => {
    const meas = book(); if (meas.status !== "ok") throw new Error("Expected measured fixture");
    const failed = reid({ ...unavail(reason), acquiredAtSec: clk });
    const { meta, config, fp, comp, state } = compState("failed-book-successful-reserve", failed);
    const good = reid({ ...meas, deployments: meas.deployments.map((d) => ({ ...d, vault: meta.contracts!.find((c) => c.chain === d.chain)!.address.toLowerCase() })) });
    const origQ = evalBook(buildBook(context(good))!, 90, POL)!.reserveQuality;
    let stored = js({ lenderBookObservation: good });
    const db = mockD1(syncTbls(stored, fp));
    expect(await finSync(db, comp, state, INF)).toEqual({ finalized: true });
    stored = storedBind(db);
    expect(MetaSchema.parse(jp(stored))).toMatchObject({ lenderBookObservation: good, lenderBookLatestAttemptFailure: failed });
    const srcDb = mockD1([
      { match: "FROM reserve_composition", rows: [compRow({ stablecoin_id: id, slices: js(meta.reserves), metadata: stored, source: config.adapter, fetched_at: clk, attempt_id: comp.attemptId, config_fingerprint: fp, adapter_source_model: "dynamic-mix", adapter_evidence_class: "independent" })] },
      { match: "FROM reserve_sync_state", rows: [syncRow({ stablecoin_id: id, last_success_at: clk, last_attempted_at: clk, last_success_attempt_id: comp.attemptId, config_fingerprint: fp })] },
    ]);
    const prov = (await loadFreshMap(srcDb, clk)).provenanceById.get(id)!;
    expect(prov).toMatchObject({ lenderBookObservation: good, lenderBookLatestAttemptFailure: failed });
    const budget = POL.policy.semantic.backing.lenderCollateralBook.observationMaxAgeSec;
    for (const age of [budget, budget + 1]) {
      const at = meas.acquiredAtSec + age, retry = reid({ ...failed, acquiredAtSec: at }), rdb = mockD1(syncTbls(stored, fp));
      await finSync(rdb, { ...comp, fetchedAt: at, metadata: { ...comp.metadata, lenderBookObservation: retry } }, { ...state, lastAttemptedAt: at, lastSuccessAt: at }, INF);
      const rm = MetaSchema.parse(jp(storedBind(rdb)));
      expect(rm.lenderBookObservation).toEqual(age > budget ? retry : good);
      expect(rm.lenderBookLatestAttemptFailure).toEqual(age > budget ? undefined : retry);
    }
    const failDb = mockD1([{ match: "SELECT metadata, config_fingerprint FROM reserve_composition", rows: [], throwError: new Error("Prior book read unavailable") }]);
    await expect(finSync(failDb, comp, state, INF)).rejects.toThrow("Prior book read unavailable");
    expect(failDb.getHistory().every((e) => !e.sql.includes("INSERT INTO"))).toBe(true);
    for (const age of [100, budget, budget + 1]) {
      const bc = context(good, undefined, meas.acquiredAtSec + age), ctx = { ...bc, fixedInput: { ...bc.fixedInput, liveReserveProvenanceMap: { [id]: { ...prov, fetchedAt: bc.fixedInput.clockSec } } } };
      const fact = buildBook(ctx)!;
      expect(okBook(fact)).toBe(true); expect(fact).toMatchObject({ observation: good, latestAttemptFailure: failed });
      const compRes = compileIso(ctx.fixedInput, ctx.extension);
      expect(compRes.quarantines).toEqual([]);
      const ev = evRes(compRes.factSet.assets[0]!, { inheritedStablecoinBacking: usdcParent });
      expect(ev.score).toBeCloseTo(age > budget ? 90 : origQ, 8);
      expect(ev.contributions[0]!.factors!.find((f) => f.componentKey.endsWith(":latest-attempt"))).toMatchObject({ score: null, effectiveScoringWeight: 0, cause: "A", scoringDisposition: "excluded-pipeline" });
      expect(ctx.gaps.get(fact.latestAttemptStatus!.gapIds[0]!)!.causeProof).toMatchObject({ cause: "A", rejectionCode: reason, sourceGenerationId: failed.sourceGenerationId });
      if (age > budget) { expect(fact.status.observationState).toBe("stale"); expect(ctx.gaps.get(fact.status.gapIds[0]!)!.causeProof).toMatchObject({ cause: "A", rejectionCode: "stale" }); }
    }
  });

  it("persists the failed read without retaining a book from corrupt prior metadata", async () => {
    const failed = unavail("rpc-unavailable"), { fp, comp, state } = compState("corrupt-prior-book", failed), db = mockD1(syncTbls('{"lenderBookObservation":', fp));
    expect(await finSync(db, comp, state, INF)).toEqual({ finalized: true });
    const stored = MetaSchema.parse(jp(storedBind(db)));
    expect(stored.lenderBookObservation).toEqual(failed); expect(stored.lenderBookLatestAttemptFailure).toBeUndefined();
    const ctx = context(stored.lenderBookObservation), fact = buildBook(ctx)!;
    expect(fact.collaterals).toEqual([]); expect(evalBook(fact, 90, POL)).toBeNull();
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof).toMatchObject({ cause: "A", rejectionCode: "rpc-unavailable" });
  });

  it.each([
    ["wrong asset", { assetId: "gtusdcp-gauntlet" }, true], ["content digest mismatch", { contentSha256: "d".repeat(64) }, false],
    ["source generation mismatch", { sourceGenerationId: "morpho-lender-book:v1:invalid" }, false], ["wrong freshness budget", { maxAgeSec: 28_801 }, true],
    ["future attempt", { acquiredAtSec: clk + 1 }, true], ["attempt older than retained book", { acquiredAtSec: clk - 101 }, true],
  ] as const)("rejects a retained failure with %s instead of emitting a trusted diagnostic", (_l, ov, reId) => {
    const ctx = context(book()), orig = unavail("rpc-unavailable"); if (orig.status !== "unavailable") throw new Error("Expected failed fixture");
    const p = { ...orig, ...ov }, att = withAtt(ctx, { ...p, ...(reId ? bookId(p) : {}) }), denom = buildReserves(att);
    expect(() => buildBook(att)).toThrow(`Invalid retained lender-book attempt for ${id}`);
    expect([...ctx.gaps.values()].some((g) => g.causeScope?.componentKey === "lender-book-latest-attempt")).toBe(false);
    expect(buildReserves(att)).toEqual(denom);
  });

  it("admits and digest-binds the exact capped-NAV real-assets denominator", () => {
    const obs = book(); if (obs.status !== "ok") throw new Error("Expected measured fixture");
    const capped = reid({ ...obs, deployments: obs.deployments.map((d) => ({ ...d, totalAssetsRaw: "900", realAssetsRaw: "1000", undistributedAssetsRaw: "100" })) });
    if (capped.status !== "ok") throw new Error("Expected admitted capped book");
    expect(capped.contentSha256).not.toBe(obs.contentSha256);
    const fact = buildBook(context(capped))!;
    expect(fact.status.observationState).toBe("known"); expect(fact.observation).toEqual(capped);
    expect(evalBook(fact, 90, POL)?.reserveQuality).toBeCloseTo(80.0154, 8);
    for (const bad of [{ undistributedAssetsRaw: "99" }, { realAssetsRaw: undefined }, { totalAssetsRaw: "1001" }]) {
      expect(BookSchema.safeParse({ ...capped, deployments: capped.deployments.map((d) => ({ ...d, ...bad })) }).success).toBe(false);
    }
  });

  it.each([28_801, -1])("rejects stale/future source age %s without admitting partial quality", (age) => {
    const ctx = context(book({ age })), fact = buildBook(ctx)!, reason = age > 0 ? "stale" : "future-dated", g = ctx.gaps.get(fact.status.gapIds[0]!)!;
    expect(fact.collaterals).toEqual([]); expect(evalBook(fact, 90, POL)).toBeNull();
    expect(g).toMatchObject({ causeProof: { cause: "A", rejectionCode: reason }, observationState: fact.status.observationState, message: expect.stringContaining(`reason=${reason}`) });
    const comp = compileIso(ctx.fixedInput, ctx.extension);
    expect(comp.quarantines).toEqual([]); expect(okSet(comp.factSet)).toBe(true);
  });

  it.each([28_800, 28_801])("judges the older pin age %s rather than acquisition or prepare time", (age) => {
    const obs = book(); if (obs.status !== "ok") throw new Error("Expected measured fixture");
    const pinAt = clk - age;
    const ctx = context(reid({ ...obs, deployments: obs.deployments.map((d) => ({ ...d, pin: { ...d.pin, timestampSec: pinAt }, markets: d.markets.map((m) => ({ ...m, marketLastUpdateSec: pinAt })) })) })), fact = buildBook(ctx)!, comp = compileIso(ctx.fixedInput, ctx.extension);
    expect(fact.status.observationState).toBe(age === 28_800 ? "known" : "stale");
    expect(comp.quarantines).toEqual([]); expect(okSet(comp.factSet)).toBe(true);
    if (age === 28_800) expect(evalBook(fact, 90, POL)).not.toBeNull();
    else { expect(fact.collaterals).toEqual([]); expect(evalBook(fact, 90, POL)).toBeNull(); expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof).toMatchObject({ cause: "A", rejectionCode: "stale" }); }
  });

  it.each(["rpc-unavailable", "unreconciled", "incomplete-census", "zero-nav", "census-limit"] as const)("preserves producer reason %s while keeping independent denomination facts", (reason) => {
    const ctx = context(unavail(reason)), bef = buildReserves(ctx), fact = buildBook(ctx)!;
    expect(fact.observation).toMatchObject({ status: "unavailable", reason, deployments: null });
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof).toMatchObject({ cause: "A", rejectionCode: reason });
    expect(evalBook(fact, 90, POL)).toBeNull(); expect(buildReserves(ctx)).toEqual(bef);
  });

  it("does not fabricate a lender subject or a successful empty book when no observation exists", () => expect(buildBook(context())).toBeUndefined());

  it("admits successful exhaustive all-idle reads without pretending missing positions are zero", () => {
    const fact = buildBook(context(book({ idle: true })))!, res = evalBook(fact, 90, POL)!;
    expect(fact.status.observationState).toBe("known"); expect(res.reserveQuality).toBe(90); expect(res.deploymentQualities[0]!.bookQuality).toBeNull();
  });

  it("unknown exact collateral contributes U50, not source failure A or score zero", () => {
    const ctx = context(book({ collateral: addr(99) })), fact = buildBook(ctx)!;
    expect(fact.status.observationState).toBe("bounded-unknown");
    expect(fact.collaterals[0]).toMatchObject({ quality: 50, qualitySource: "bounded-unknown", sourceCause: "U", fallbackReason: "unmapped-collateral" });
    expect(fact.collaterals[0]!.sourceGapIds.every((x) => ctx.gaps.get(x)?.causeProof.cause === "U")).toBe(true);
    expect(evalBook(fact, 90, POL)).not.toBeNull();
  });

  it.each(["C", "U", "D"] as const)("retains frozen accepted Backing and portable %s proxy cause IDs", (cause) => {
    const ctx = context(book()), bnd = src(ctx, { tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" }, byAssetId: { "fixture-collateral": { assetId: "fixture-collateral", backingScore: 52.5, cardSha256: "c".repeat(64), sourceCause: cause, sourceGapIds: [`fixture-collateral:gap:stable-${cause}`] } } });
    const cap = { ...ctx, fixedInput: { ...ctx.fixedInput, lenderCollateralBacking: bnd } }, fact = buildBook(cap)!;
    expect(fact.collaterals[0]).toMatchObject({ quality: 52.5, qualitySource: "previous-accepted-backing", sourceCause: cause, sourceGapIds: [`fixture-collateral:gap:stable-${cause}`], acceptedPublicationGenerationId: bnd.publicationGenerationId });
    expect(fact.status.evidenceRefIds.map((x) => cap.evidence.get(x))).toContainEqual(expect.objectContaining({ sourceId: "previous-accepted-backing:fixture-collateral", sourceGenerationId: bnd.publicationGenerationId }));
    expect(buildBook(cap)).toEqual(fact);
  });

  it("source staleness uses class fallback and a separate zero-weight A diagnostic", () => {
    const ctx = context(book()), bnd = src(ctx, { publishedAtSec: clk - MAX_AGE - 1, tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" } });
    const fixed = { ...ctx.fixedInput, lenderCollateralBacking: bnd }, fact = buildBook({ ...ctx, fixedInput: fixed })!, comp = compileIso(fixed, ctx.extension);
    expect(comp.quarantines).toEqual([]); expect(comp.factSet.assets[0]!.lenderBook).toEqual(fact); expect(okSet(comp.factSet)).toBe(true);
    expect(fact).toMatchObject({ status: { observationState: "known", gapIds: [] }, collaterals: [{ quality: 85, qualitySource: "authored-class", fallbackReason: "accepted-source-stale" }], acceptedSourceStatus: { observationState: "stale", gapIds: [`${id}:gap:lender-collateral-accepted-source`] } });
    expect([...ctx.gaps.values()]).toContainEqual(expect.objectContaining({ causeProof: expect.objectContaining({ cause: "A", rejectionCode: "accepted-source-stale" }) }));
    const g = ctx.gaps.get(fact.acceptedSourceStatus!.gapIds[0]!)!;
    expect(g).toMatchObject({ observationState: "stale", evidenceRefIds: fact.acceptedSourceStatus!.evidenceRefIds });
    expect(fact.acceptedSourceStatus!.evidenceRefIds.map((x) => ctx.evidence.get(x)!).filter((e) => e.freshness.state === "stale")).toEqual([expect.objectContaining({ sourceId: "previous-accepted-backing", sourceGenerationId: bnd.publicationGenerationId, disposition: "published", observedAtSec: bnd.publishedAtSec, publishedAtSec: bnd.publishedAtSec, contentSha256: domainDigest("safety-score-v10.19.accepted-collateral-source.v1", bnd), freshness: { state: "stale", ageSec: MAX_AGE + 1, maxAgeSec: MAX_AGE } })]);
    expect(evalBook(fact, 90, POL)).not.toBeNull();
  });

  it.each(["accepted-source-unavailable", "accepted-source-held", "accepted-source-stale", "future-dated"] as const)("keeps unavailable accepted source %s distinct from book unavailability", (reason) => {
    const ctx = context(book()), bnd = src(ctx, { status: "unavailable", reason, publicationGenerationId: null, publishedAtSec: null, policyDigest: null, evaluationBuildDigest: null, tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" } });
    const fixed = { ...ctx.fixedInput, lenderCollateralBacking: bnd }, fact = buildBook({ ...ctx, fixedInput: fixed })!, comp = compileIso(fixed, ctx.extension);
    expect(fact).toMatchObject({ status: { observationState: "known", gapIds: [] }, collaterals: [{ quality: 85, fallbackReason: reason, qualitySource: "authored-class" }], acceptedSourceStatus: { observationState: "missing", gapIds: [`${id}:gap:lender-collateral-accepted-source`] } });
    expect(evalBook(fact, 90, POL)).not.toBeNull();
    expect([...ctx.gaps.values()]).toContainEqual(expect.objectContaining({ causeProof: expect.objectContaining({ cause: "A", rejectionCode: reason }) }));
    expect(comp.quarantines).toEqual([]); expect(okSet(comp.factSet)).toBe(true);
    expect(ctx.gaps.get(fact.acceptedSourceStatus!.gapIds[0]!)!.observationState).toBe("missing");
    expect(comp.factSet.assets[0]!.lenderBook).toMatchObject({ status: { observationState: "known", gapIds: fact.status.gapIds }, acceptedSourceStatus: fact.acceptedSourceStatus, collaterals: fact.collaterals });
    const ev = evRes(comp.factSet.assets[0]!, { inheritedStablecoinBacking: usdcParent });
    expect(ev.score).toBeCloseTo(evalBook(fact, 90, POL)!.reserveQuality, 8);
    const fs = ev.contributions[0]!.factors!;
    expect(fs.find((f) => f.componentKey.endsWith(":accepted-source"))).toMatchObject({ score: null, normalizedWeight: 0, effectiveScoringWeight: 0, cause: "A", causeGapIds: fact.acceptedSourceStatus!.gapIds, scoringDisposition: "excluded-pipeline" });
    expect(fs.filter((f) => f.effectiveScoringWeight > 0).every((f) => f.cause === null)).toBe(true);
  });

  it("uses class fallback for future publication and absent/NR/excluded score cards", () => {
    const ctx = context(book());
    for (const publishedAtSec of [clk + 1, clk - 50]) {
      const bnd = src(ctx, { publishedAtSec, tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" } });
      expect(buildBook({ ...ctx, evidence: new Map(ctx.evidence), gaps: new Map(), fixedInput: { ...ctx.fixedInput, lenderCollateralBacking: bnd } })!.collaterals[0]).toMatchObject({ quality: 85, qualitySource: "authored-class", fallbackReason: publishedAtSec > clk ? "future-dated" : "accepted-card-ineligible" });
      const comp = compileIso({ ...ctx.fixedInput, lenderCollateralBacking: bnd }, ctx.extension);
      expect(comp.quarantines).toEqual([]); expect(okSet(comp.factSet)).toBe(true);
      expect(comp.factSet.assets[0]!.lenderBook?.acceptedSourceStatus?.observationState).toBe(publishedAtSec > clk ? "missing" : undefined);
    }
  });

  it("keeps synthetic missing-observation availability U rather than claiming a failed actual read", () => {
    const ctx = context(unavail("missing-observation")), fact = buildBook(ctx)!;
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof.cause).toBe("U");
    expect(fact.status.evidenceRefIds).toEqual([]); expect(evalBook(fact, 90, POL)).toBeNull();
  });

  it("retains the producer reason when the compiler independently rejects its acquisition age", () => {
    const ctx = context(reid({ ...unavail("unreconciled"), acquiredAtSec: clk - 28_801 })), fact = buildBook(ctx)!;
    expect(fact.observation).toMatchObject({ status: "unavailable", reason: "unreconciled" });
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof).toMatchObject({ cause: "A", rejectionCode: "stale" });
  });

  it.each(["stale", "accepted-source-stale", "missing-observation", "legacy-unobserved", "unreconciled"] as const)("keeps stale/missing failed observations schema-valid for %s", (reason) => {
    for (const age of [100, 28_801]) {
      const ctx = context(reid({ ...unavail(reason), acquiredAtSec: clk - age })), fact = buildBook(ctx)!, g = ctx.gaps.get(fact.status.gapIds[0]!)!;
      const exp = age > 28_800 && reason !== "missing-observation" && reason !== "legacy-unobserved" ? "stale" : "missing";
      expect(fact.status.evidenceRefIds.some((x) => ctx.evidence.get(x)?.freshness.state === "stale")).toBe(exp === "stale");
      expect([fact.status.observationState, g.observationState, fact.collaterals]).toEqual([exp, exp, []]);
      const comp = compileIso(ctx.fixedInput, ctx.extension);
      expect(comp.quarantines).toEqual([]); expect(okSet(comp.factSet)).toBe(true);
    }
  });

  it.each(["stale", "accepted-source-stale"] as const)("keeps a latest-attempt %s diagnostic missing without stale last-known source data", (reason) => {
    const ctx = context(book()), failed = unavail(reason); if (failed.status !== "unavailable") throw new Error("Expected failed fixture");
    const att = withAtt(ctx, failed), fact = buildBook(att)!, comp = compileIso(att.fixedInput, att.extension);
    expect([fact.latestAttemptStatus?.observationState, ctx.gaps.get(fact.latestAttemptStatus!.gapIds[0]!)!.observationState, fact.status.observationState]).toEqual(["missing", "missing", "known"]);
    expect(comp.quarantines).toEqual([]); expect(okSet(comp.factSet)).toBe(true);
  });

  it("canonicalizes reordered producer inventories without repairing duplicate identities", () => {
    const m = book(); if (m.status !== "ok") throw new Error("Expected measured fixture");
    expect(ProvSchema.parse({ source: "onchain", fetchedAt: clk - 100, lenderBookObservation: { ...m, deployments: m.deployments.map((d) => ({ ...d, selectorsRead: [...d.selectorsRead].reverse() })) } }).lenderBookObservation).toEqual(m);
    expect(ProvSchema.parse({ source: "onchain", fetchedAt: clk - 100, lenderBookObservation: { ...m, deployments: m.deployments.map((d) => ({ ...d, markets: [...d.markets, ...d.markets] })) } }).lenderBookObservationFailure).toBeDefined();
  });

  it("recompiles identical frozen inputs and binds lender facts into the compiled digest", () => {
    const first = context(book()), rep = compileIso(first.fixedInput, first.extension), retry = compileIso(first.fixedInput, first.extension);
    expect(rep.quarantines).toEqual([]);
    expect(rep.factSet.assets[0]!.lenderBook?.observation).toEqual(first.fixedInput.liveReserveProvenanceMap[id]!.lenderBookObservation);
    expect(retry.factSet).toEqual(rep.factSet);
    const chg = compileIso({ ...first.fixedInput, lenderCollateralBacking: src(first, { tokenToAssetId: { [`ethereum:${btc}`]: id } }) }, first.extension);
    expect(chg.quarantines).toEqual([]); expect(chg.factSet.sourceFingerprints).toEqual(rep.factSet.sourceFingerprints);
    expect(chg.factSet.assets[0]!.lenderBook?.collaterals[0]?.fallbackReason).toBe("self-collateral");
    expect(chg.factSet.v9FactSetDigest).not.toBe(rep.factSet.v9FactSetDigest);
  });

  it("accepted score bytes change fact identity even when publication generation stays fixed", () => {
    const digs = [52.5, 53].map((backingScore) => {
      const ctx = context(book()), bnd = src(ctx, { tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" }, byAssetId: { "fixture-collateral": { assetId: "fixture-collateral", backingScore, cardSha256: "c".repeat(64), sourceCause: null, sourceGapIds: [] } } });
      const r = compileIso({ ...ctx.fixedInput, lenderCollateralBacking: bnd }, ctx.extension);
      expect(r.quarantines).toEqual([]);
      return r.factSet.v9FactSetDigest;
    });
    expect(digs[0]).not.toBe(digs[1]);
  });

  it("routes invalid admitted source identity through asset-local quarantine, not a cohort throw", () => {
    const ctx = context(book()), out = compileIso({ ...ctx.fixedInput, lenderCollateralBacking: src(ctx, { registryFingerprint: "d".repeat(64) }) }, ctx.extension);
    expect(out.quarantines).toEqual([expect.objectContaining({ assetId: id, code: "fact-build-failed" })]);
    expect(out.factSet.assets).toHaveLength(1); expect(out.factSet.assets[0]!.reserveStatus.observationState).toBe("missing");
  });

  it("does not recursively score self collateral", () => {
    const ctx = context(book());
    expect(buildBook({ ...ctx, fixedInput: { ...ctx.fixedInput, lenderCollateralBacking: src(ctx, { tokenToAssetId: { [`ethereum:${btc}`]: id } }) } })!.collaterals[0]).toMatchObject({ trackedAssetId: null, quality: 85, fallbackReason: "self-collateral" });
  });

  it("retains malformed present producer bytes as a digest-bound local rejection", () => {
    const ctx = context(), prov = ProvSchema.parse({ source: "onchain", fetchedAt: clk - 100, lenderBookObservation: { status: "ok", deployments: [] } });
    expect(prov.lenderBookObservation).toBeUndefined();
    expect(prov.lenderBookObservationFailure).toMatchObject({ code: "producer-failed", reason: "malformed-lender-book-observation" });
    const fact = buildBook({ ...ctx, fixedInput: { ...ctx.fixedInput, liveReserveProvenanceMap: { [id]: prov } } })!;
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof).toMatchObject({ cause: "A", rejectionCode: "malformed" });
  });

  it("rejects identity-inconsistent facts within the existing asset boundary", () => {
    const ctx = context(book());
    expect(() => buildBook({ ...ctx, fixedInput: { ...ctx.fixedInput, lenderCollateralBacking: src(ctx, { registryFingerprint: "d".repeat(64) }) } })).toThrow(/registry fingerprint mismatch/);
    expect(() => buildBook(context({ ...book(), contentSha256: "d".repeat(64) }))).toThrow(/Invalid lender book/);
  });

  it("rejects an incomplete measured book instead of fabricating the omitted allocation", () => {
    const m = book(); if (m.status !== "ok") throw new Error("Expected measured fixture");
    const p = { ...m, deployments: m.deployments.map((r) => ({ ...r, markets: [] })) };
    expect(() => buildBook(context({ ...p, ...bookId(p) }))).toThrow(/Invalid lender book/);
  });
});
