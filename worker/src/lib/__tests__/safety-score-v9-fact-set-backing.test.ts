import { describe, expect, it, vi } from "vitest";
import {
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9/extension";
import { computeSafetyScoreV9ReserveExposureKey } from "../safety-score-v9/fact-set-schema";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  materializeSafetyScoreV9FactSetExtension,
} from "../safety-score-v9/fact-set";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { eligibleReserveMeta, mintMeta } from "./safety-score-v9-reserve-admission.test-support";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";

import { createRuntimeGapVerdict } from "../safety-score-v9/fact-set-context";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { buildReserves } from "../safety-score-v9/fact-set-backing";
import { factBuilderContext } from "./safety-score-v9-fact-builders.test-support";

import type { ReserveSlice } from "@shared/types/reserves";
import { ReserveBoundedFactSchema, type ReserveBoundedFact } from "@shared/types/reserve-bounded-facts";
import { evaluateV9ReserveExposures } from "@shared/lib/safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9AssetFactsV3Schema } from "@shared/types/safety-score-v9-facts";
import { refineV9CauseContribution } from "@shared/types/safety-score-v9-causes";
import { buildLenderBookFact } from "../safety-score-v9/fact-set-lender-book";
import { canonicalizeLenderBookObservation, deriveLenderBookObservationIdentity } from "@shared/lib/safety-score-v9/lender-book-registry";
import { LenderBookObservationSchema, LenderCollateralBackingSchema, type LenderBookObservation, type LenderCollateralBacking } from "@shared/types/safety-score-v9-lender-book";
import { LiveReserveSnapshotProvenanceSchema } from "@shared/lib/safety-score-v9/reserve-provenance";
import { V1019LenderBookFactSchema } from "@shared/types/safety-score-v9-facts";
import type { AssetBuildContext } from "../safety-score-v9/fact-set-context";
import { evaluateV1019LenderBook } from "@shared/lib/safety-score-v9/lender-book";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../safety-score-v9/consumer-freshness";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { finalizeReserveSyncSuccess } from "../live-reserves/store-write";
import { loadFreshIndependentLiveReserveMap } from "../live-reserves/store-overview";
import { reserveCompositionRow, reserveSyncRow } from "./live-reserves-store.test-support";
import type { ReserveCompositionRecord, ReserveSyncStateRecord } from "../live-reserves/store-shared";
import { LiveReserveSnapshotMetadataSchema } from "@shared/types/live-reserves";
vi.mock("@shared/data/safety-score-v9/evidence-gap-classifications-v1.json", () => ({
  default: { schemaVersion: 1, entries: [
    {
      id: "fixture-public-composition", assetId: "usdc-circle", cause: "B", assertion: "required-data-public",
      scope: { pillar: "backing", componentKey: "reserve-composition", factorKey: null,
        routeKey: null, exposureId: null, requiredDatum: "reserve-composition" },
      reviewedAt: "1970-01-01T01:00:00Z", reviewer: "fixture-curator",
      sources: [{ url: "https://example.com/usdc-holdings", observedAt: "1970-01-01T01:00:00Z",
        datumAsOf: "1970-01-01T01:00:00Z", location: "current holdings",
        excerpt: "The current whole-token holdings are itemized.", assertion: "The exact required current composition is public." }],
    },
    {
      id: "fixture-researched-composition", assetId: "usdt-tether", cause: "C", assertion: "researched-nondisclosure",
      scope: { pillar: "backing", componentKey: "reserve-composition", factorKey: null,
        routeKey: null, exposureId: null, requiredDatum: "reserve-composition" },
      reviewedAt: "1970-01-01T01:00:00Z", reviewer: "fixture-curator",
      sources: [{ url: "https://example.com/usdt-report", observedAt: "1970-01-01T01:00:00Z",
        datumAsOf: null, location: "reserve report", excerpt: "Only a portfolio total is reported.",
        assertion: "The required itemized composition is not published in the reviewed report." }],
      searchedSurfaces: ["https://example.com/usdt-report"], rationale: "The current report does not itemize the required holdings.",
    },
    ...[["reserve:d9ea3402f80c2eba4fa0b228", "fixture-uncurated-maturity"], ["reserve:f56e5d5418b2b742f60e9dd0", "fixture-uncurated-mixed-maturity"]]
      .map(([exposureId, id]) => ({
        id, assetId: "alpha", cause: "B", assertion: "required-data-public",
        scope: { pillar: "backing", componentKey: "reserve-exposure", factorKey: "maturity",
          routeKey: null, exposureId, requiredDatum: "maturityDaysMax" },
        reviewedAt: "1970-01-01T01:00:00Z", reviewer: "fixture-curator",
        sources: [{ url: "https://example.com/alpha-maturity", observedAt: "1970-01-01T01:00:00Z",
          datumAsOf: "1970-01-01T01:00:00Z", location: "holdings maturity table",
          excerpt: "Every deposit's maximum term is listed.", assertion: "The exact required maturity datum is public." }],
      })),
  ] },
}));
const ASSET_ID = "alpha";
/** Far past the fixture composition, so its published evidence has expired. */
const EXPIRED_HISTORY_CLOCK_SEC = Date.UTC(2027, 7, 1) / 1_000;
const NO_HISTORY_CLOCK_SEC = Date.UTC(2026, 7, 1) / 1_000;

function baseMeta(): V9ExtensionRegistryMeta {
  return mintMeta(ASSET_ID, {
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
  });
}

function expiredReserveMeta(): V9ExtensionRegistryMeta {
  const meta = eligibleReserveMeta({
    id: ASSET_ID,
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
  });
  const proof = meta.proofOfReserves;
  if (!proof?.latestReport) throw new Error("Expected named assurance report fixture");
  return { ...meta, proofOfReserves: { ...proof, latestReport: { ...proof.latestReport,
    sources: proof.latestReport.sources.map((source) => ({ ...source, label: "Independent LLP signed report" })),
  } } };
}

function compileWithEmptyLiveReserves(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
) {
  const fixed = makeV9FixedInput({
    assetId: ASSET_ID,
    clockSec,
    reserves: [],
  });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: new Map([[ASSET_ID, meta]]),
  });
  const context = factBuilderContext(fixed, extension);
  return {
    fixed,
    extension,
    asset: {
      ...buildReserves(context),
      gaps: [...context.gaps.values()],
      evidence: [...context.evidence.values()],
    },
  };
}

describe("Safety Score v9 backing fact-set reserve history", () => {
  it("retains keyed zero-balance classifications without emitting zero-weight backing facts or quarantining the asset", () => {
    const rows = [
      { sourceKey: "fixture:cash", name: "Custodied cash", pct: 100, risk: "very-low" as const, assetClass: "cash" as const, issuerOrObligor: "issuer:alpha", riskFactors: ["custody" as const], liquidityHorizon: "immediate" as const, maturityDaysMax: 0 },
      { sourceKey: "fixture:residual", name: "Residual allowance", pct: 0, risk: "low" as const, assetClass: "other" as const, issuerOrObligor: "issuer:alpha", riskFactors: ["custody" as const], liquidityHorizon: "unknown" as const },
    ];
    const fixedInput = makeV9FixedInput({ assetId: ASSET_ID, clockSec: NO_HISTORY_CLOCK_SEC, reserves: rows });
    const meta = { ...baseMeta(), reserves: rows };
    const extension = buildSafetyScoreV9BaselineExtension(fixedInput, { metaById: new Map([[ASSET_ID, meta]]) });
    const result = buildSafetyScoreV9Candidate({ fixedInput, extension, publishedAtSec: fixedInput.clockSec + 10 });
    expect(result.quarantines.filter((quarantine) => quarantine.assetId === ASSET_ID)).toEqual([]);
    expect(result.compiledFacts.assets[0]!.reserveExposures.map((exposure) => ({ name: exposure.name, weight: exposure.weight }))).toEqual([{ name: "Custodied cash", weight: 1 }]);
    expect(result.fixedInput.liveReserveMap[ASSET_ID]).toEqual(rows);
  });

  it("reports expired published reserve composition evidence as stale", () => {
    const { fixed, asset } = compileWithEmptyLiveReserves(
      expiredReserveMeta(),
      EXPIRED_HISTORY_CLOCK_SEC,
    );
    expect(fixed.liveReserveMap[ASSET_ID]).toEqual([]);

    const reserveGap = asset.gaps.find((gap) => gap.reasonCode === "missing-reserve-composition");
    expect(reserveGap).toMatchObject({
      reasonCode: "missing-reserve-composition",
      observationState: "stale",
      causeProof: { cause: "U" },
    });
    expect(asset.reserveStatus).toMatchObject({
      observationState: "stale",
      evidenceRefIds: reserveGap!.evidenceRefIds,
    });
    for (const evidenceRefId of reserveGap!.evidenceRefIds) {
      expect(asset.evidence.find((evidence) => evidence.evidenceId === evidenceRefId)?.freshness.state).toBe("stale");
    }
  });

  it("reports a generic missing reserve composition when no history exists", () => {
    const { fixed, extension, asset } = compileWithEmptyLiveReserves(baseMeta(), NO_HISTORY_CLOCK_SEC);
    expect(fixed.liveReserveMap[ASSET_ID]).toEqual([]);
    expect(extension.assets[0]!.componentEvidence).not.toContainEqual(
      expect.objectContaining({ componentKey: "reserve-composition-history" }),
    );

    const reserveGap = asset.gaps.find((gap) => gap.reasonCode === "missing-reserve-composition");
    expect(reserveGap).toMatchObject({
      reasonCode: "missing-reserve-composition",
      observationState: "missing",
      causeProof: { cause: "U", evidenceRefIds: [] },
      evidenceRefIds: [],
    });
    expect(asset.reserveStatus).toMatchObject({
      observationState: "missing",
      evidenceRefIds: [],
    });
  });

});

describe("v10.01 cause compilation reserve proof boundaries", () => {
  it("binds failed reserve collection and the whole-asset remainder to the same A proof", () => {
    const original = makeV9FixedInput({ omitLiveReserve: true });
    const failure = createRuntimeGapVerdict({
      assetId: "alpha", scope: { pillar: "backing", componentKey: "reserve-composition",
        factorKey: null, routeKey: null, exposureId: null, requiredDatum: "reserve-composition" },
      sourceId: "fixture-reserves", sourceGenerationId: "fixture-attempt:1",
      observedAtSec: original.clockSec, asOfSec: original.clockSec, producerState: "config-mismatch",
      rejectionCode: "reserve.admission.rejected-config", reason: "The configured generation was rejected.",
    });
    const fixed = normalizeFixedInput({
      ...original, baseInputGenerationId: undefined, pipelineGapByAssetId: { alpha: [failure] },
    });
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, makeV9Extension({
      registryFingerprint: fixed.registryFingerprint,
    })).assets[0]!;
    const gap = asset.gaps.find((row) => row.causeScope?.componentKey === "reserve-composition")!;
    expect(gap.causeProof).toMatchObject({ cause: "A", producerState: "config-mismatch",
      sourceGenerationId: "fixture-attempt:1" });
    expect(asset.reserveResiduals).toMatchObject([{ weight: 1, status: { gapIds: [gap.gapId] } }]);
    expect(asset.evidence.find((row) => row.evidenceId === failure.evidence.evidenceId)).toEqual(failure.evidence);
  });

  it.each([
    { assetClass: "bank-deposit" as const, expectedState: "known", expectedQuality: 91.9 },
    { assetClass: undefined, expectedState: "bounded-unknown", expectedQuality: 35 },
  ])("keeps missing obligor uncertainty scoped to concentration: $assetClass", ({ assetClass, expectedState, expectedQuality }) => {
    const fixed = makeV9FixedInput({ reserves: [{
      sourceKey: "fixture:holding", name: "Captured holding", pct: 100, risk: "low",
      ...(assetClass === undefined ? {} : { assetClass }), liquidityHorizon: "immediate", maturityDaysMax: 30,
    }] });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, makeV9Extension({
      registryFingerprint: fixed.registryFingerprint,
    })).assets[0]!;
    const row = compiled.reserveExposures[0]!;
    expect(row.status.observationState).toBe(expectedState);
    expect(row.factorStatuses?.assetClass?.observationState).toBe(assetClass === undefined ? "missing" : "known");
    expect(row.factorStatuses?.liquidity?.observationState).toBe("known");
    expect(row.factorStatuses?.maturity?.observationState).toBe("known");
    const obligorGap = compiled.gaps.find(gap => gap.gapId === row.factorStatuses?.obligorConcentration?.gapIds[0])!;
    expect(obligorGap.causeProof.cause).toBe("U");
    expect(obligorGap.causeScope).toMatchObject({
      pillar: "backing", componentKey: "reserve-exposure", factorKey: "obligorConcentration",
      exposureId: row.exposureKey, requiredDatum: "issuerOrObligorKey",
    });
    const backing = evaluateV9ReserveExposures({
      ...compiled, resolvedUpstreamExposures: [],
    }, V9_CANDIDATE_POLICY_V1);
    expect(backing.contributions.find(entry => entry.componentKey === `reserve:${row.exposureKey}`)!.score)
      .toBeCloseTo(expectedQuality, 12);
    expect(backing.contributions.find(entry => entry.componentKey === `reserve:${row.exposureKey}`)!.cause)
      .toBe(assetClass === undefined ? "U" : null);
    expect(backing.contributions.find(entry => entry.componentKey === "reserve:concentration"))
      .toMatchObject({ score: 35, cause: "U" });
    if (assetClass !== undefined) {
      expect(V9AssetFactsV3Schema.safeParse({ ...compiled, reserveExposures: [{
        ...row, issuerOrObligorKey: "identified-bank",
      }] }).success).toBe(false);
      const { obligorConcentration: _unknownObligor, ...factorStatuses } = row.factorStatuses!;
      expect(V9AssetFactsV3Schema.safeParse({ ...compiled, reserveExposures: [{
        ...row, factorStatuses,
      }] }).success).toBe(false);
    }
  });

  function compileSingleReserve(row: Partial<ReserveSlice>) {
    const fixed = makeV9FixedInput({ reserves: [{
      sourceKey: "fixture:holding", name: "Holding", pct: 100, risk: "very-low", issuerOrObligor: "custodian:alpha", ...row,
    }] });
    return compileSafetyScoreV9FactSetFromFixedInput(fixed, makeV9Extension({
      registryFingerprint: fixed.registryFingerprint,
    })).assets[0]!;
  }

  it("does not hide unknown reserve factors behind a known whole row", () => {
    const asset = compileSingleReserve({ assetClass: "bank-deposit", liquidityHorizon: "unknown" });
    const exposure = asset.reserveExposures[0]!;
    expect(exposure.status.observationState).toBe("known");
    for (const [factorKey, requiredDatum] of [["liquidity", "liquidityHorizon"], ["maturity", "maturityDaysMax"]] as const) {
      const status = exposure.factorStatuses![factorKey]!;
      const gap = asset.gaps.find((row) => row.gapId === status.gapIds[0])!;
      expect(gap.causeProof.cause).toBe("U");
      expect(gap.causeScope).toEqual({ pillar: "backing", componentKey: "reserve-exposure",
        factorKey, routeKey: null, exposureId: exposure.exposureKey, requiredDatum });
    }
    expect(asset.reserveResiduals).toEqual([]);
    expect(exposure.weight).toBe(1);
  });

  it.each(V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve.maturityNotApplicableClasses)(
    "publishes maturity as not-applicable, not a researchable gap, for admitted %s reserves", (assetClass) => {
      const asset = compileSingleReserve({ assetClass, liquidityHorizon: "immediate" });
      const exposure = asset.reserveExposures[0]!;
      expect(exposure.factorStatuses!.maturity).toMatchObject({
        observationState: "known", gapIds: [], applicability: { state: "not-applicable" },
      });
      expect(asset.gaps.filter((gap) => gap.causeScope?.requiredDatum === "maturityDaysMax")).toEqual([]);
      expect(V9AssetFactsV3Schema.safeParse(asset).success).toBe(true);
      // The policy still scores the factor at its best rung, so it remains an included contribution.
      const backing = evaluateV9ReserveExposures({ ...asset, resolvedUpstreamExposures: [] }, V9_CANDIDATE_POLICY_V1);
      const factor = backing.contributions.find(entry => entry.componentKey === `reserve:${exposure.exposureKey}`)!
        .factors!.find(entry => entry.componentKey === `reserve:${exposure.exposureKey}:maturity`)!;
      expect(factor).toMatchObject({ cause: null, causeGapIds: [], scoringDisposition: "included" });
      expect(factor.score).toBeGreaterThan(0);
      expect(factor.effectiveScoringWeight).toBeGreaterThan(0);
    });

  it.each([
    { label: "maturity-applicable class", assetClass: "bank-deposit" as const },
    { label: "unadmitted class", assetClass: undefined },
  ])("keeps the unknown maturity gap for a $label", ({ assetClass }) => {
    const asset = compileSingleReserve({ ...(assetClass === undefined ? {} : { assetClass }), liquidityHorizon: "immediate" });
    const exposure = asset.reserveExposures[0]!;
    expect(exposure.assetClass).toBe(assetClass ?? null);
    const status = exposure.factorStatuses!.maturity!;
    expect(status.applicability.state).toBe("required");
    const gap = asset.gaps.find((row) => row.gapId === status.gapIds[0])!;
    expect(gap.causeProof.cause).toBe("U");
    expect(gap.causeScope).toMatchObject({ factorKey: "maturity", requiredDatum: "maturityDaysMax" });
  });

  function maturityApplicability(overrides: Record<string, unknown> = {}): ReserveBoundedFact {
    return ReserveBoundedFactSchema.parse({
      factKey: "fixture:maturity-applicability", kind: "maturity-applicability",
      scope: { kind: "exposure", exposureKey: "fixture:holding" }, asOfSec: NO_HISTORY_CLOCK_SEC - 2 * 86_400,
      publisher: "issuer", sourceUrls: ["https://example.com/prospectus"], assertion: "Open-ended shares have no maturity date",
      contentDigest: "a".repeat(64), provenance: { kind: "reviewed-research", reviewer: "fixture", reviewedAt: "2026-07-30", confidence: "high" },
      claimId: "fund-share", conclusion: "not-applicable", governingInstrument: "Fund prospectus", allInScope: true, ...overrides,
    });
  }
  function compileWithMaturityBound(fact: ReserveBoundedFact) {
    const fixed = makeV9FixedInput({ clockSec: NO_HISTORY_CLOCK_SEC, reserves: [{
      sourceKey: "fixture:holding", name: "Holding", pct: 100, risk: "low", issuerOrObligor: "fund:alpha",
      assetClass: "fund-share", liquidityHorizon: "immediate",
    }] });
    const extension = makeV9Extension({ clockSec: NO_HISTORY_CLOCK_SEC, registryFingerprint: fixed.registryFingerprint });
    extension.assets[0]!.reserveBoundFacts = [fact];
    return compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
  }

  it("publishes maturity as not-applicable when an admitted whole-exposure bound fact concludes so", () => {
    const asset = compileWithMaturityBound(maturityApplicability());
    const exposure = asset.reserveExposures[0]!;
    expect(asset.reserveBoundFacts![0]!.rejectionReason).toBeNull();
    expect(exposure.factorStatuses!.maturity).toMatchObject({
      observationState: "known", gapIds: [], applicability: { state: "not-applicable" },
    });
    expect(exposure.factorStatuses!.maturity!.evidenceRefIds).toContain("alpha:reserve-bound:fixture:maturity-applicability");
    expect(asset.gaps.filter((gap) => gap.causeScope?.requiredDatum === "maturityDaysMax")).toEqual([]);
    expect(V9AssetFactsV3Schema.safeParse(asset).success).toBe(true);
    // The evaluator still covers the whole factor with the admitted bound at 100.
    const backing = evaluateV9ReserveExposures({ ...asset, resolvedUpstreamExposures: [], asOfSec: NO_HISTORY_CLOCK_SEC }, V9_CANDIDATE_POLICY_V1);
    const factors = backing.contributions.find(entry => entry.componentKey === `reserve:${exposure.exposureKey}`)!.factors!
      .filter(entry => entry.componentKey.startsWith(`reserve:${exposure.exposureKey}:maturity`));
    expect(factors).toEqual([expect.objectContaining({
      componentKey: `reserve:${exposure.exposureKey}:maturity:covered`, score: 100, cause: null, scoringDisposition: "included",
    })]);
  });

  it("publishes an applicable open-ended claim at the longest maturity band without inventing a finite term", () => {
    const asset = compileWithMaturityBound(maturityApplicability({ conclusion: "open-ended", governingInstrument: "Exact Class A share" }));
    const exposure = asset.reserveExposures[0]!;
    expect(exposure.maturityDaysMax).toBeNull();
    expect(exposure.factorStatuses!.maturity).toMatchObject({
      observationState: "known", gapIds: [], applicability: { state: "required" },
    });
    expect(asset.gaps.filter(gap => gap.causeScope?.requiredDatum === "maturityDaysMax")).toEqual([]);
    expect(V9AssetFactsV3Schema.safeParse(asset).success).toBe(true);
    expect(V9AssetFactsV3Schema.safeParse({ ...asset, reserveBoundFacts: [] }).success).toBe(false);
    const unbound = { ...asset, reserveExposures: [{ ...exposure, factorStatuses: {
      ...exposure.factorStatuses, maturity: { ...exposure.factorStatuses!.maturity!, evidenceRefIds: [] },
    } }] };
    expect(V9AssetFactsV3Schema.safeParse(unbound).success).toBe(false);
    const backing = evaluateV9ReserveExposures({ ...asset, resolvedUpstreamExposures: [], asOfSec: NO_HISTORY_CLOCK_SEC }, V9_CANDIDATE_POLICY_V1);
    const factors = backing.contributions.find(entry => entry.componentKey === `reserve:${exposure.exposureKey}`)!.factors!
      .filter(entry => entry.componentKey.startsWith(`reserve:${exposure.exposureKey}:maturity`));
    expect(factors).toEqual([expect.objectContaining({ score: 48, cause: null, scoringDisposition: "included" })]);
  });

  it.each([
    { label: "stale", overrides: { asOfSec: NO_HISTORY_CLOCK_SEC - 400 * 86_400 } },
    { label: "wrong exposure", overrides: { scope: { kind: "exposure", exposureKey: "fixture:other" } } },
    { label: "partial exposure", overrides: { allInScope: false } },
  ])("keeps open-ended maturity unknown when $label", ({ overrides }) => {
    const asset = compileWithMaturityBound(maturityApplicability({ conclusion: "open-ended", ...overrides }));
    const status = asset.reserveExposures[0]!.factorStatuses!.maturity!;
    expect(status.observationState).not.toBe("known");
    expect(status.applicability.state).toBe("required");
    expect(asset.gaps.find(gap => gap.gapId === status.gapIds[0])!.causeProof.cause).toBe("U");
  });

  it.each([
    { label: "an unelapsed review day", fact: () => maturityApplicability({ provenance: { kind: "reviewed-research", reviewer: "fixture", reviewedAt: "2026-08-01", confidence: "high" } }) },
    { label: "an expired snapshot", fact: () => maturityApplicability({ asOfSec: NO_HISTORY_CLOCK_SEC - 400 * 86_400 }) },
    { label: "a partial-scope conclusion", fact: () => maturityApplicability({ allInScope: false }) },
    { label: "a sub-instrument scope", fact: () => maturityApplicability({ scope: { kind: "sub-instrument", exposureKey: "fixture:holding",
      instrumentId: "class-a", coveredShare: 0.5, coverageAsOfSec: NO_HISTORY_CLOCK_SEC - 2 * 86_400 } }) },
    { label: "a non-matching exposure key", fact: () => maturityApplicability({ scope: { kind: "exposure", exposureKey: "fixture:other" } }) },
  ])("keeps the unknown maturity gap for $label", ({ fact }) => {
    const asset = compileWithMaturityBound(fact());
    const status = asset.reserveExposures[0]!.factorStatuses!.maturity!;
    expect(status.applicability.state).toBe("required");
    const gap = asset.gaps.find((row) => row.gapId === status.gapIds[0])!;
    expect(gap.causeProof.cause).toBe("U");
    expect(gap.causeScope).toMatchObject({ factorKey: "maturity", requiredDatum: "maturityDaysMax" });
  });

  function scoredContributionIssues(row: Parameters<typeof refineV9CauseContribution>[0]): string[] {
    const issues: string[] = [];
    refineV9CauseContribution(row, { addIssue: (issue) => { issues.push(typeof issue === "string" ? issue : String(issue.message)); } });
    return issues;
  }

  it("publishes a B reserve factor as excluded-uncurated without failing its row or concentration", () => {
    const fixed = makeV9FixedInput({ reserves: [
      { sourceKey: "fixture:uncurated-b", name: "Curated-later deposit", pct: 40, risk: "very-low",
        assetClass: "bank-deposit", liquidityHorizon: "immediate", issuerOrObligor: "bank:alpha" },
      { sourceKey: "fixture:uncurated-mixed", name: "Mixed deposit", pct: 35, risk: "very-low",
        assetClass: "bank-deposit", liquidityHorizon: "unknown", issuerOrObligor: "bank:beta" },
      { sourceKey: "fixture:unresearched-u", name: "Unresearched deposit", pct: 25, risk: "very-low",
        assetClass: "bank-deposit", liquidityHorizon: "immediate", maturityDaysMax: 30, issuerOrObligor: "bank:gamma" },
    ] });
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, makeV9Extension({
      registryFingerprint: fixed.registryFingerprint,
    })).assets[0]!;
    const backing = evaluateV9ReserveExposures({ ...asset, resolvedUpstreamExposures: [] }, V9_CANDIDATE_POLICY_V1);
    const row = (sourceKey: string) => backing.contributions.find(entry =>
      entry.componentKey === `reserve:${computeSafetyScoreV9ReserveExposureKey({ sourceKey, name: "x", pct: 1, risk: "low" })}`)!;
    const reserve = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve;
    const weights = reserve.factorWeights;

    // B alone: the factor is diagnostic; the row stays scored over its included factors.
    const uncurated = row("fixture:uncurated-b");
    expect(uncurated).toMatchObject({ cause: null, scoringDisposition: "included", effectiveScoringWeight: 0.4 });
    expect(uncurated.score).toBeCloseTo((reserve.assetClassQuality["bank-deposit"] * weights.assetQuality +
      reserve.liquidityQuality.immediate * weights.liquidity) / (weights.assetQuality + weights.liquidity), 12);
    expect(uncurated.factors!.find(factor => factor.componentKey.endsWith(":maturity"))).toMatchObject({
      score: null, cause: "B", scoringDisposition: "excluded-uncurated", effectiveScoringWeight: 0,
      causeGapIds: [expect.stringContaining(":maturity")],
    });
    // B beside U in one row: U controls the scored row, B stays excluded on its factor.
    const mixed = row("fixture:uncurated-mixed");
    expect(mixed).toMatchObject({ cause: "U", scoringDisposition: "bounded-uncertainty" });
    expect(mixed.factors!.map(factor => [factor.componentKey, factor.cause, factor.scoringDisposition]))
      .toEqual([[`${mixed.componentKey}:assetClass`, null, "included"], [`${mixed.componentKey}:liquidity`, "U", "bounded-uncertainty"],
        [`${mixed.componentKey}:maturity`, "B", "excluded-uncurated"]]);
    expect(row("fixture:unresearched-u")).toMatchObject({ cause: null, scoringDisposition: "included" });

    for (const contribution of backing.contributions) {
      expect(scoredContributionIssues(contribution), contribution.componentKey).toEqual([]);
      for (const factor of contribution.factors ?? []) expect(scoredContributionIssues(factor), factor.componentKey).toEqual([]);
    }
  });

  function compileLivePartition(rows: ReserveSlice[]) {
    const fixed = makeV9FixedInput({ assetId: ASSET_ID, clockSec: NO_HISTORY_CLOCK_SEC, reserves: rows });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([[ASSET_ID, { ...baseMeta(), reserves: rows }]]),
    });
    const tails = new Set(rows.filter(row => row.unclassifiedResidual).map(computeSafetyScoreV9ReserveExposureKey));
    const asset = baseline.assets[0]!;
    const extension = {
      ...baseline,
      assets: [{
        ...asset,
        reserveClassifications: asset.reserveClassifications.map((classification) =>
          tails.has(classification.exposureKey) ? { ...classification, unclassifiedResidual: true as const } : classification),
      }],
    };
    const input = normalizeSafetyScoreV9CompilerInput(fixed);
    return compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(input,
      materializeSafetyScoreV9FactSetExtension(input, extension));
  }

  it("reconciles accepted live rounding overshoot without erasing dust or a disjoint explicit remainder", () => {
    const rows: ReserveSlice[] = [
      { sourceKey: "fixture:cash", name: "Cash", pct: 99.9998, risk: "very-low", assetClass: "cash", issuerOrObligor: "bank:alpha" },
      { sourceKey: "fixture:dust", name: "Dust holding", pct: 0.00000001, risk: "very-low", assetClass: "cash", issuerOrObligor: "bank:dust" },
      { sourceKey: "fixture:tail", name: "Unclassified reserve share", pct: 0.00029874702072, risk: "high",
        unclassifiedResidual: true, residualReason: "insufficient-evidence" },
    ];
    const result = compileLivePartition(rows);
    expect(result.quarantines).toEqual([]);
    const compiled = result.factSet.assets[0]!;
    expect(compiled.reserveExposures.find(row => row.name === "Dust holding")!.weight).toBe(1e-10);
    expect(compiled.reserveResiduals[0]!.weight).toBe(rows[2]!.pct / 100);
    const wholeWeight = compiled.reserveExposures.reduce((sum, row) => sum + row.weight, 0) +
      compiled.reserveResiduals.reduce((sum, row) => sum + row.weight, 0);
    expect(wholeWeight).toBeCloseTo(1, 15);
    expect(rows[0]!.pct).toBe(99.9998);
  });

  it("keeps a true overfull reserve frame unavailable instead of normalizing away the producer failure", () => {
    const result = compileLivePartition([
      { sourceKey: "fixture:cash", name: "Cash", pct: 60, risk: "very-low", assetClass: "cash", issuerOrObligor: "bank:alpha" },
      { sourceKey: "fixture:tail", name: "Unclassified reserve share", pct: 41, risk: "high",
        unclassifiedResidual: true, residualReason: "insufficient-evidence" },
    ]);
    const compiled = result.factSet.assets[0]!;
    expect(compiled.gaps).toContainEqual(expect.objectContaining({
      causeProof: expect.objectContaining({ cause: "A", rejectionCode: "fact-build-failed" }),
      causeScope: expect.objectContaining({ componentKey: "asset-compilation" }),
    }));
    expect(compiled.reserveExposures).toEqual([]);
    expect(compiled.reserveResiduals).toEqual([]);
  });


  it.each([
    { pct: 99.9999, remainder: 1e-6 },
    { pct: 99.999999, remainder: 1e-8 },
  ])("retains a genuine $remainder rounding remainder without erasing identified holdings", ({ pct, remainder }) => {
    const asset = compileSingleReserve({ name: "Cash", pct, assetClass: "cash", liquidityHorizon: "immediate", maturityDaysMax: 0 });
    expect(asset.reserveExposures[0]!.weight).toBeCloseTo(1 - remainder, 12);
    expect(asset.reserveResiduals[0]!.weight).toBeCloseTo(remainder, 12);
    expect(asset.reserveExposures[0]!.weight + asset.reserveResiduals[0]!.weight).toBe(1);
    const gap = asset.gaps.find((row) => row.gapId === asset.reserveResiduals[0]!.status.gapIds[0])!;
    expect(gap.causeProof.cause).toBe("U");
    expect(gap.causeScope?.requiredDatum).toBe("reserveCompositionRemainder");
  });

  it("treats a float-accumulation shortfall as a complete composition, not an unidentified remainder", () => {
    const asset = compileSingleReserve({ name: "Cash", pct: 99.99999999999999, assetClass: "cash", liquidityHorizon: "immediate" });
    const dust = 1 - asset.reserveExposures[0]!.weight;
    expect(dust).toBeGreaterThan(0);
    expect(dust).toBeLessThan(1e-15);
    expect(asset.reserveResiduals).toEqual([]);
    expect(asset.gaps.filter((gap) => gap.causeScope?.requiredDatum === "reserveCompositionRemainder")).toEqual([]);
    expect(asset.reserveStatus).toMatchObject({ observationState: "known", gapIds: [] });
    expect(V9AssetFactsV3Schema.safeParse(asset).success).toBe(true);
  });

  it.each([false, true])("uses only the admitted envelope for an all-unknown tail when live=%s", (withLive) => {
    const tail = { ...(withLive ? { sourceKey: "fixture:tail" } : {}), name: "Unclassified remainder",
      pct: 100, risk: "high" as const, unclassifiedResidual: true as const, residualReason: "insufficient-evidence" as const };
    const fixed = makeV9FixedInput({ reserves: [tail], omitLiveReserve: !withLive });
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    const inputAsset = extension.assets[0]!;
    inputAsset.reserveClassifications = withLive ? [{
      exposureKey: computeSafetyScoreV9ReserveExposureKey(tail), classificationKey: "fixture-unclassified-tail",
      assetClass: null, issuerOrObligorKey: null, riskFactors: [], liquidityHorizon: null,
      maturityDaysMax: null, failureDomains: [], unclassifiedResidual: true,
    }] : [];
    inputAsset.reviewedStaticReserveRows = {
      rows: [tail], evidenceClass: "independent", provenance: "audited-fallback",
    };
    inputAsset.researchEvidence.push({
      evidenceKey: "fixture-current-composition", sourceId: "fixture-composition-report",
      observedAtSec: fixed.clockSec - 1, publishedAtSec: fixed.clockSec - 1, publishedBy: "issuer",
      url: "https://example.com/current-composition", contentSha256: "1".repeat(64),
      confidence: "verified", maxAgeSec: 3600,
    });
    inputAsset.componentEvidence.push({
      componentKey: "reviewed-static-reserves", evidenceKeys: ["fixture-current-composition"],
    });
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    expect(asset.reserveExposures).toEqual([]);
    expect(asset.reserveResiduals).toMatchObject([{ weight: 1 }]);
    expect(asset.reserveCompositionProvenance).toBe(withLive ? "live" : "audited-fallback");
    expect(asset.reserveCompositionEvidenceClass).toBe(withLive ? undefined : "independent");
    const gap = asset.gaps.find((row) => row.gapId === asset.reserveResiduals[0]!.status.gapIds[0])!;
    expect(gap.causeProof.cause).toBe("U");
  });

  it("preserves stale captured holdings without granting current envelope strength or quarantining them", () => {
    const original = makeV9FixedInput({ reserves: [{
      sourceKey: "fixture:cash", name: "Cash", pct: 100, risk: "very-low", assetClass: "cash",
      liquidityHorizon: "immediate", issuerOrObligor: "custodian:alpha", maturityDaysMax: 0,
    }] });
    const fixed = normalizeFixedInput({ ...original, baseInputGenerationId: undefined,
      liveReserveProvenanceMap: { alpha: { source: "fixture-reserve-api", fetchedAt: 1 } } });
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    extension.sources.liveReserves.maxAgeSec = 1;
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    expect(asset.reserveExposures[0]).toMatchObject({ weight: 1, status: { observationState: "stale" } });
    expect(asset.reserveCompositionEvidenceClass).toBeUndefined();
    expect(asset.reserveCompositionProvenance).toBeUndefined();
    expect(asset.gaps.some((gap) => gap.causeScope?.componentKey === "asset-compilation")).toBe(false);
    const staleGaps = asset.gaps.filter(gap => gap.observationState === "stale" &&
      gap.causeScope?.componentKey === "reserve-exposure");
    expect(staleGaps).toHaveLength(5);
    for (const gap of staleGaps) {
      expect(gap).toMatchObject({
        responsibility: "producer-failed",
        causeProof: { cause: "A", producerState: "stale-producer", rejectionCode: "reserve-fetch-stale" },
      });
      for (const evidenceId of gap.causeProof.evidenceRefIds) {
        expect(asset.evidence.find(row => row.evidenceId === evidenceId)).toMatchObject({
          disposition: "rejected", causeBinding: { assetId: "alpha", scope: gap.causeScope },
        });
      }
    }
  });

  it("does not turn an uncurated subfield into a producer failure when the holding is stale", () => {
    const original = makeV9FixedInput({ reserves: [{
      sourceKey: "fixture:cash", name: "Cash", pct: 100, risk: "very-low", assetClass: "cash",
      liquidityHorizon: "immediate", issuerOrObligor: "custodian:alpha",
    }] });
    const fixed = normalizeFixedInput({ ...original, baseInputGenerationId: undefined,
      liveReserveProvenanceMap: { alpha: { source: "fixture-reserve-api", fetchedAt: 1 } } });
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    extension.sources.liveReserves.maxAgeSec = 1;
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    expect(asset.gaps.find(gap => gap.causeScope?.factorKey === "maturity")).toMatchObject({
      observationState: "missing", responsibility: "unresearched", causeProof: { cause: "U" },
    });
    expect(asset.gaps.find(gap => gap.causeScope?.factorKey === "assetClass")?.causeProof.cause).toBe("A");
  });

  it("does not infer a stale producer from a null fetch budget", () => {
    const original = makeV9FixedInput({ reserves: [{
      sourceKey: "fixture:bill", name: "Treasury bills", pct: 100, risk: "very-low", assetClass: "treasury-bill",
      liquidityHorizon: "immediate", issuerOrObligor: "custodian:alpha",
    }] });
    const fixed = normalizeFixedInput({ ...original, baseInputGenerationId: undefined,
      liveReserveProvenanceMap: { alpha: { source: "fixture-reserve-api", fetchedAt: 1 } } });
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    extension.sources.liveReserves.maxAgeSec = null;
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    expect(asset.evidence.find(row => row.evidenceId.startsWith("alpha:reserve:"))!.freshness)
      .toMatchObject({ state: "not-assessed", maxAgeSec: null });
    expect(asset.gaps.find(gap => gap.causeScope?.factorKey === "maturity")!.causeProof.cause).toBe("U");
    expect(asset.gaps.some(gap => gap.causeProof.cause === "A")).toBe(false);
  });

  it("does not invent a reserve failure from provenance without captured holdings", () => {
    const original = makeV9FixedInput({ omitLiveReserve: true });
    const fixed = normalizeFixedInput({ ...original, baseInputGenerationId: undefined,
      liveReserveProvenanceMap: { alpha: { source: "fixture-reserve-api", fetchedAt: 1 } } });
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    extension.sources.liveReserves.maxAgeSec = 1;
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    expect(asset.reserveExposures).toEqual([]);
    expect(asset.gaps.find(gap => gap.causeScope?.componentKey === "reserve-composition")!.causeProof.cause).toBe("U");
  });
});

describe("v10.01 scoped authored reserve causes", () => {
  it.each([["usdc-circle", "B"], ["usdt-tether", "C"]] as const)(
    "binds %s missing composition to current researched %s without manufacturing holdings", (assetId, cause) => {
      const fixed = makeV9FixedInput({ assetId, omitLiveReserve: true });
      const extension = makeV9Extension({ assetId, registryFingerprint: fixed.registryFingerprint });
      const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
      const gap = asset.gaps.find((row) => row.causeScope?.componentKey === "reserve-composition")!;
      expect(gap.causeProof.cause).toBe(cause);
      expect(asset.reserveExposures).toEqual([]);
      expect(asset.reserveResiduals).toMatchObject([{ weight: 1, status: { gapIds: [gap.gapId] } }]);
      const evidence = asset.evidence.find((row) => row.evidenceId === gap.causeProof.evidenceRefIds[0])!;
      expect(evidence.causeBinding).toMatchObject({ assetId, scope: gap.causeScope });
    },
  );
});

describe("direct backing reserve builder", () => {
  it("uses the fresh fetch clock for its budget without redating the retained portfolio observation", () => {
    const original = makeV9FixedInput();
    const sourceAsOf = original.clockSec - 600;
    const fixed = normalizeFixedInput({ ...original, baseInputGenerationId: undefined,
      liveReserveProvenanceMap: { alpha: {
        source: "fixture-reserve-api", fetchedAt: original.clockSec - 1,
        reserveObservation: {
          kind: "portfolio-observation", scopeId: "fixture:portfolio", liabilityBookKey: "fixture:alpha",
          deploymentRefs: [], reviewer: "fixture", confidence: "verified",
          sources: [{ url: "https://example.com/portfolio", accessedAtSec: original.clockSec - 1, sha256: "a".repeat(64) }],
          reviewedAtSec: original.clockSec - 1, expiresAtSec: original.clockSec + 1,
          sourceGeneration: "fixture:unchanged-portfolio", sourceSha256: "a".repeat(64),
          completeness: "complete", obligations: [], observedAtSec: sourceAsOf,
          wholeAssetDenominator: { amount: "100", asOfSec: sourceAsOf, unitBasis: "USD", sourceSha256: "a".repeat(64) },
        },
      } },
    });
    const context = factBuilderContext(fixed);
    const result = buildReserves(context);
    expect(result.reserveExposures[0]!.status.observationState).toBe("known");
    expect(context.evidence.get(result.reserveExposures[0]!.status.evidenceRefIds[0]!)).toMatchObject({
      observedAtSec: original.clockSec - 1, freshness: { state: "current" },
    });
    expect(fixed.liveReserveProvenanceMap.alpha!.reserveObservation!.observedAtSec).toBe(sourceAsOf);
  });

  it.each([100, 70])("preserves a %s percent holding and leaves unidentified notional explicit", (pct) => {
    const fixed = makeV9FixedInput();
    const cash = { ...fixed.liveReserveMap.alpha![0]!, pct };
    const context = factBuilderContext(makeV9FixedInput({ reserves: [cash] }));
    const result = buildReserves(context);
    expect(result.reserveExposures).toHaveLength(1);
    expect(result.reserveExposures[0]).toMatchObject({
      name: "Custodied cash", weight: pct / 100,
      status: { observationState: "known" },
    });
    if (pct === 100) {
      expect(result.reserveStatus.observationState).toBe("known");
      expect(result.reserveResiduals).toEqual([]);
    } else {
      expect(result.reserveStatus.observationState).toBe("bounded-unknown");
      expect(result.reserveResiduals).toHaveLength(1);
      expect(result.reserveResiduals[0]).toMatchObject({ residualId: "unidentified" });
      expect(result.reserveResiduals[0]!.weight).toBeCloseTo(0.3);
    }
    const evidence = context.evidence.get(result.reserveExposures[0]!.status.evidenceRefIds[0]!);
    expect(evidence).toMatchObject({
      sourceId: "fixture-reserve-api",
      sourceGenerationId: context.extension.sources.liveReserves.generationId,
      freshness: { state: "current" },
    });
  });

  it("retains a stale holding but does not label its composition current", () => {
    const fixed = makeV9FixedInput();
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    extension.sources.liveReserves.maxAgeSec = 99;
    const context = factBuilderContext(fixed, extension);
    const result = buildReserves(context);
    expect(result.reserveExposures[0]).toMatchObject({ weight: 1, status: { observationState: "stale" } });
    expect(result.reserveStatus.observationState).toBe("bounded-unknown");
    expect([...context.gaps.values()]).toContainEqual(expect.objectContaining({
      reasonCode: "partial-reserve-review", observationState: "stale",
    }));
    expect(result.reserveCompositionProvenance).toBeUndefined();
  });

  it("rejects reserve weights exceeding the whole-asset denominator", () => {
    const fixed = makeV9FixedInput();
    const rows = [
      { ...fixed.liveReserveMap.alpha![0]!, name: "Cash A", pct: 60 },
      { ...fixed.liveReserveMap.alpha![0]!, name: "Cash B", pct: 60 },
    ];
    expect(() => buildReserves(factBuilderContext(makeV9FixedInput({ reserves: rows }))))
      .toThrow(/exceed the whole-asset denominator/);
  });
});

describe("v10.19 frozen lender-book fact admission", () => {
  const assetId = "kpkusdcprime-kpk";
  const clockSec = 1_792_000_000;
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const btc = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";

  function book(options: { age?: number; collateral?: string; idle?: boolean } = {}): LenderBookObservation {
    const at = clockSec - (options.age ?? 100);
    const payload = {
      schemaVersion: 1 as const, assetId, acquiredAtSec: at, maxAgeSec: 28_800,
      status: "ok" as const, censusScope: "complete-nav-accounted-current-book" as const,
      deployments: [{
        chain: "ethereum", vault: address(1), kind: "vault-v2" as const,
        pin: { chain: "ethereum", number: 26_191_269, hash: word(1), timestampSec: at, finality: "finalized" as const },
        loanToken: address(2), loanDecimals: 6, totalAssetsRaw: "1000", totalSupplyRaw: "1000",
        idleAssetsRaw: options.idle ? "1000" : "0", reconciledAssetsRaw: "1000", reconciliationResidualRaw: "0",
        codeHashes: { [address(1)]: word(2), [address(3)]: word(3), [address(4)]: word(4) },
        selectorsRead: ["asset()", "market(bytes32)", "totalAssets()"],
        markets: options.idle ? [] : [{
          account: address(3), adapter: address(3), morpho: address(4), marketId: word(5),
          loanToken: address(2), collateralToken: options.collateral ?? btc, oracle: address(6), irm: address(7),
          lltvRaw: "860000000000000000", supplySharesRaw: "1000000000", positionBorrowSharesRaw: "0", positionCollateralRaw: "0",
          marketSupplyAssetsRaw: "1000", marketSupplySharesRaw: "1000000000", marketBorrowAssetsRaw: "500",
          marketBorrowSharesRaw: "500000000", marketLastUpdateSec: at, marketFeeRaw: "0", includedAssetsRaw: "1000",
          accruedMethod: "adapter-expected-supply-assets" as const, collateralMode: "collateralized" as const,
        }],
      }],
    };
    return LenderBookObservationSchema.parse(canonicalizeLenderBookObservation({
      ...payload, ...deriveLenderBookObservationIdentity(payload),
    }));
  }

  function unavailable(reason: Extract<LenderBookObservation, { status: "unavailable" }>["reason"]): LenderBookObservation {
    const payload = { schemaVersion: 1 as const, assetId, acquiredAtSec: clockSec - 100, maxAgeSec: 28_800,
      status: "unavailable" as const, reason, failedDeploymentKey: "ethereum:failed-vault", deployments: null };
    return LenderBookObservationSchema.parse({ ...payload, ...deriveLenderBookObservationIdentity(payload) });
  }

  function source(context: AssetBuildContext, rows: Partial<LenderCollateralBacking> = {}): LenderCollateralBacking {
    return LenderCollateralBackingSchema.parse({
      schemaVersion: 1, status: "ok", reason: null,
      publicationGenerationId: "report-cards:v9:fixture", publishedAtSec: clockSec - 50,
      policyDigest: "a".repeat(64), evaluationBuildDigest: "b".repeat(64),
      registryFingerprint: context.fixedInput.registryFingerprint, maxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
      tokenToAssetId: {}, byAssetId: {}, ...rows,
    });
  }

  function context(observation?: LenderBookObservation, bundle?: LenderCollateralBacking, scoringClockSec = clockSec): AssetBuildContext {
    const fixed = makeV9FixedInput({ assetId, clockSec: scoringClockSec });
    const result = factBuilderContext(fixed, makeV9Extension({ assetId, clockSec: scoringClockSec, registryFingerprint: fixed.registryFingerprint }));
    return { ...result, fixedInput: { ...result.fixedInput,
      liveReserveProvenanceMap: { [assetId]: { source: "onchain", fetchedAt: clockSec - 100,
        ...(observation ? { lenderBookObservation: observation } : {}) } },
      ...(bundle ? { lenderCollateralBacking: bundle } : {}),
    } };
  }

  it("omits the lane for non-cohort assets", () => {
    expect(buildLenderBookFact(factBuilderContext())).toBeUndefined();
  });

  it.each([0, 28_800])("admits complete class-proxy books at inclusive age %s", (age) => {
    const ctx = context(book({ age }));
    const fact = buildLenderBookFact(ctx)!;
    expect(V1019LenderBookFactSchema.safeParse(fact).success).toBe(true);
    expect(fact.status.observationState).toBe("known");
    expect(fact.collaterals[0]).toMatchObject({ quality: 85, qualitySource: "authored-class", collateralClass: "btc-wrapper" });
    expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)?.reserveQuality).toBeCloseTo(80.0154, 8);
    expect(ctx.fixedInput.liveReserveMap[assetId]).toBeDefined();
    expect(fact.status.evidenceRefIds.every((id) => ctx.evidence.has(id))).toBe(true);
  });

  it.each(["rpc-unavailable", "unreconciled", "deadline"] as const)(
    "retains admitted Backing after %s until the original eight-hour budget expires", async reason => {
      const meta = ACTIVE_META_BY_ID.get(assetId)!;
      const config = meta.liveReservesConfig!;
      const fingerprint = computeLiveReserveConfigFingerprint(config);
      const measured = book();
      if (measured.status !== "ok") throw new Error("Expected measured fixture");
      const payload = { ...measured, deployments: measured.deployments.map(deployment => ({
        ...deployment, vault: meta.contracts!.find(contract => contract.chain === deployment.chain)!.address.toLowerCase(),
      })) };
      const good = LenderBookObservationSchema.parse({ ...payload, ...deriveLenderBookObservationIdentity(payload) });
      const failurePayload = { ...unavailable(reason), acquiredAtSec: clockSec };
      const failed = LenderBookObservationSchema.parse({ ...failurePayload, ...deriveLenderBookObservationIdentity(failurePayload) });
      const originalContext = context(good);
      const originalFact = buildLenderBookFact(originalContext)!;
      const originalQuality = evaluateV1019LenderBook(originalFact, 90, V9_CANDIDATE_POLICY_V1)!.reserveQuality;
      let storedMetadata = JSON.stringify({ lenderBookObservation: good });
      const composition: ReserveCompositionRecord = {
        stablecoinId: assetId, slices: meta.reserves!, fetchedAt: clockSec, source: config.adapter,
        attemptId: "failed-book-successful-reserve", configFingerprint: fingerprint,
        metadata: { freshnessMode: "not-applicable", lenderBookObservation: failed },
        warningCount: 0, warnings: [], adapterSourceModel: "dynamic-mix", adapterEvidenceClass: "independent",
      };
      const state: ReserveSyncStateRecord = {
        stablecoinId: assetId, adapterKey: config.adapter, breakerKey: "fixture",
        lastAttemptedAt: clockSec, lastSuccessAt: clockSec, lastStatus: "ok",
        warningCount: 0, warnings: [], lastError: null, metadata: composition.metadata,
        lastAttemptId: composition.attemptId, configFingerprint: fingerprint,
      };
      const db = mockD1([
        { match: "SELECT metadata, config_fingerprint FROM reserve_composition",
          rows: [{ metadata: storedMetadata, config_fingerprint: fingerprint }] },
        { match: "INSERT INTO reserve_composition", rows: [], runMeta: { changes: 1 } },
        { match: "UPDATE reserve_sync_state", rows: [], runMeta: { changes: 1 } },
        { match: "INSERT OR IGNORE INTO reserve_composition_history", rows: [], runMeta: { changes: 1 } },
        { match: "INSERT OR IGNORE INTO reserve_sync_attempt_history", rows: [], runMeta: { changes: 1 } },
      ]);
      expect(await finalizeReserveSyncSuccess(db, composition, state, Number.MAX_SAFE_INTEGER)).toEqual({ finalized: true });
      storedMetadata = String(db.getHistory().find(entry => entry.sql.includes("INSERT INTO reserve_composition ("))!.binds[5]);
      const stored = LiveReserveSnapshotMetadataSchema.parse(JSON.parse(storedMetadata));
      expect(stored.lenderBookObservation).toEqual(good);
      expect(stored.lenderBookLatestAttemptFailure).toEqual(failed);
      const sourceDb = mockD1([
        { match: "FROM reserve_composition", rows: [reserveCompositionRow({
          stablecoin_id: assetId, slices: JSON.stringify(meta.reserves), metadata: storedMetadata,
          source: config.adapter, fetched_at: clockSec, attempt_id: composition.attemptId,
          config_fingerprint: fingerprint, adapter_source_model: "dynamic-mix", adapter_evidence_class: "independent",
        })] },
        { match: "FROM reserve_sync_state", rows: [reserveSyncRow({
          stablecoin_id: assetId, last_success_at: clockSec, last_attempted_at: clockSec,
          last_success_attempt_id: composition.attemptId, config_fingerprint: fingerprint,
        })] },
      ]);
      const live = await loadFreshIndependentLiveReserveMap(sourceDb, clockSec);
      const provenance = live.provenanceById.get(assetId)!;
      expect(provenance.lenderBookObservation).toEqual(good);
      expect(provenance.lenderBookLatestAttemptFailure).toEqual(failed);
      const budget = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.lenderCollateralBook.observationMaxAgeSec;
      for (const age of [budget, budget + 1]) {
        const attemptedAt = measured.acquiredAtSec + age;
        const retryPayload = { ...failed, acquiredAtSec: attemptedAt };
        const retry = LenderBookObservationSchema.parse({ ...retryPayload, ...deriveLenderBookObservationIdentity(retryPayload) });
        const retryDb = mockD1([
          { match: "SELECT metadata, config_fingerprint FROM reserve_composition",
            rows: [{ metadata: storedMetadata, config_fingerprint: fingerprint }] },
          { match: "INSERT INTO reserve_composition", rows: [], runMeta: { changes: 1 } },
          { match: "UPDATE reserve_sync_state", rows: [], runMeta: { changes: 1 } },
          { match: "INSERT OR IGNORE INTO reserve_composition_history", rows: [], runMeta: { changes: 1 } },
          { match: "INSERT OR IGNORE INTO reserve_sync_attempt_history", rows: [], runMeta: { changes: 1 } },
        ]);
        await finalizeReserveSyncSuccess(retryDb, {
          ...composition, fetchedAt: attemptedAt, metadata: { ...composition.metadata, lenderBookObservation: retry },
        }, { ...state, lastAttemptedAt: attemptedAt, lastSuccessAt: attemptedAt }, Number.MAX_SAFE_INTEGER);
        const retryMetadata = LiveReserveSnapshotMetadataSchema.parse(JSON.parse(String(
          retryDb.getHistory().find(entry => entry.sql.includes("INSERT INTO reserve_composition ("))!.binds[5],
        )));
        expect(retryMetadata.lenderBookObservation).toEqual(age > budget ? retry : good);
        expect(retryMetadata.lenderBookLatestAttemptFailure).toEqual(age > budget ? undefined : retry);
      }
      const readFailedDb = mockD1([
        { match: "SELECT metadata, config_fingerprint FROM reserve_composition",
          rows: [], throwError: new Error("Prior book read unavailable") },
      ]);
      await expect(finalizeReserveSyncSuccess(readFailedDb, composition, state, Number.MAX_SAFE_INTEGER))
        .rejects.toThrow("Prior book read unavailable");
      expect(readFailedDb.getHistory().every(entry => !entry.sql.includes("INSERT INTO"))).toBe(true);
      for (const age of [100, budget, budget + 1]) {
        const baseContext = context(good, undefined, measured.acquiredAtSec + age);
        const ctx = { ...baseContext, fixedInput: { ...baseContext.fixedInput,
          liveReserveProvenanceMap: { [assetId]: provenance } } };
        const fact = buildLenderBookFact(ctx)!;
        expect(V1019LenderBookFactSchema.safeParse(fact).success).toBe(true);
        expect(fact.observation).toEqual(good);
        expect(fact.latestAttemptFailure).toEqual(failed);
        const compiled = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(ctx.fixedInput, ctx.extension);
        expect(compiled.quarantines).toEqual([]);
        const evaluated = evaluateV9ReserveExposures({
          ...compiled.factSet.assets[0]!, resolvedUpstreamExposures: [],
          inheritedStablecoinBacking: { parentAssetId: "usdc-circle", parentBackingScore: 90,
            weight: 1, tier: "wrapped", failureDomains: [] },
        }, V9_CANDIDATE_POLICY_V1);
        expect(evaluated.score).toBeCloseTo(age > budget ? 90 : originalQuality, 8);
        expect(evaluated.contributions[0]!.factors!.find(factor => factor.componentKey.endsWith(":latest-attempt"))).toMatchObject({
          score: null, effectiveScoringWeight: 0, cause: "A", scoringDisposition: "excluded-pipeline",
        });
        expect(ctx.gaps.get(fact.latestAttemptStatus!.gapIds[0]!)!.causeProof).toMatchObject({
          cause: "A", rejectionCode: reason, sourceGenerationId: failed.sourceGenerationId,
        });
        if (age > budget) {
          expect(fact.status.observationState).toBe("stale");
          expect(ctx.gaps.get(fact.status.gapIds[0]!)!.causeProof).toMatchObject({ cause: "A", rejectionCode: "stale" });
        }
      }
    },
  );

  it("admits and digest-binds the exact capped-NAV real-assets denominator", () => {
    const observed = book();
    if (observed.status !== "ok") throw new Error("Expected measured fixture");
    const payload = { ...observed, deployments: observed.deployments.map(deployment => ({
      ...deployment, totalAssetsRaw: "900", realAssetsRaw: "1000", undistributedAssetsRaw: "100",
    })) };
    const observation = LenderBookObservationSchema.parse({ ...payload, ...deriveLenderBookObservationIdentity(payload) });
    if (observation.status !== "ok") throw new Error("Expected admitted capped book");
    expect(observation.contentSha256).not.toBe(observed.contentSha256);
    const fact = buildLenderBookFact(context(observation))!;
    expect(fact.status.observationState).toBe("known");
    expect(fact.observation).toEqual(observation);
    expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)?.reserveQuality).toBeCloseTo(80.0154, 8);
    const invalid = { ...observation, deployments: observation.deployments.map(deployment => ({
      ...deployment, undistributedAssetsRaw: "99",
    })) };
    expect(LenderBookObservationSchema.safeParse(invalid).success).toBe(false);
    expect(LenderBookObservationSchema.safeParse({ ...observation, deployments: observation.deployments.map(deployment => ({
      ...deployment, realAssetsRaw: undefined,
    })) }).success).toBe(false);
    expect(LenderBookObservationSchema.safeParse({ ...observation, deployments: observation.deployments.map(deployment => ({
      ...deployment, totalAssetsRaw: "1001",
    })) }).success).toBe(false);
  });

  it.each([28_801, -1])("rejects stale/future source age %s without admitting partial quality", (age) => {
    const ctx = context(book({ age }));
    const fact = buildLenderBookFact(ctx)!;
    const reason = age > 0 ? "stale" : "future-dated";
    expect(fact.collaterals).toEqual([]);
    expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)).toBeNull();
    const gap = ctx.gaps.get(fact.status.gapIds[0]!)!;
    expect(gap.causeProof).toMatchObject({ cause: "A", rejectionCode: reason });
    expect(gap.message).toContain(`reason=${reason}`);
  });

  it.each([28_800, 28_801])("judges the older pin age %s rather than acquisition or prepare time", (age) => {
    const observed = book();
    if (observed.status !== "ok") throw new Error("Expected measured fixture");
    const pinAtSec = clockSec - age;
    const payload = { ...observed, deployments: observed.deployments.map((deployment) => ({ ...deployment,
      pin: { ...deployment.pin, timestampSec: pinAtSec },
      markets: deployment.markets.map((market) => ({ ...market, marketLastUpdateSec: pinAtSec })),
    })) };
    const observation = LenderBookObservationSchema.parse({ ...payload, ...deriveLenderBookObservationIdentity(payload) });
    const ctx = context(observation);
    const fact = buildLenderBookFact(ctx)!;
    expect(fact.status.observationState).toBe(age === 28_800 ? "known" : "stale");
    if (age === 28_800) {
      expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)).not.toBeNull();
    } else {
      expect(fact.collaterals).toEqual([]);
      expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)).toBeNull();
      expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof).toMatchObject({ cause: "A", rejectionCode: "stale" });
    }
  });

  it.each(["rpc-unavailable", "unreconciled", "incomplete-census", "zero-nav", "census-limit"] as const)(
    "preserves producer reason %s while keeping independent denomination facts", (reason) => {
      const ctx = context(unavailable(reason));
      const before = buildReserves(ctx);
      const fact = buildLenderBookFact(ctx)!;
      expect(fact.observation).toMatchObject({ status: "unavailable", reason, deployments: null });
      expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof).toMatchObject({ cause: "A", rejectionCode: reason });
      expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)).toBeNull();
      expect(buildReserves(ctx)).toEqual(before);
    },
  );

  it("names retained capture absence legacy-unobserved rather than a successful empty book", () => {
    const ctx = context();
    const fact = buildLenderBookFact(ctx)!;
    expect(fact.observation).toBeNull();
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.message).toContain("legacy-unobserved");
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof.cause).toBe("U");
  });

  it("admits successful exhaustive all-idle reads without pretending missing positions are zero", () => {
    const fact = buildLenderBookFact(context(book({ idle: true })))!;
    const result = evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)!;
    expect(fact.status.observationState).toBe("known");
    expect(result.reserveQuality).toBe(90);
    expect(result.deploymentQualities[0]!.bookQuality).toBeNull();
  });

  it("unknown exact collateral is a contributing U35, not source failure A or score zero", () => {
    const ctx = context(book({ collateral: address(99) }));
    const fact = buildLenderBookFact(ctx)!;
    expect(fact.status.observationState).toBe("bounded-unknown");
    expect(fact.collaterals[0]).toMatchObject({ quality: 35, qualitySource: "bounded-unknown", sourceCause: "U", fallbackReason: "unmapped-collateral" });
    expect(fact.collaterals[0]!.sourceGapIds.every((id) => ctx.gaps.get(id)?.causeProof.cause === "U")).toBe(true);
    expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)).not.toBeNull();
  });

  it.each(["C", "U", "D"] as const)("retains frozen accepted Backing and portable %s proxy cause IDs", (cause) => {
    const ctx = context(book());
    const bundle = source(ctx, { tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" },
      byAssetId: { "fixture-collateral": { assetId: "fixture-collateral", backingScore: 52.5,
        cardSha256: "c".repeat(64), sourceCause: cause, sourceGapIds: [`fixture-collateral:gap:stable-${cause}`] } } });
    const captured = { ...ctx, fixedInput: { ...ctx.fixedInput, lenderCollateralBacking: bundle } };
    const fact = buildLenderBookFact(captured)!;
    expect(fact.collaterals[0]).toMatchObject({ quality: 52.5, qualitySource: "previous-accepted-backing", sourceCause: cause,
      sourceGapIds: [`fixture-collateral:gap:stable-${cause}`], acceptedPublicationGenerationId: bundle.publicationGenerationId });
    expect(fact.status.evidenceRefIds.map((id) => captured.evidence.get(id))).toContainEqual(expect.objectContaining({
      sourceId: "previous-accepted-backing:fixture-collateral", sourceGenerationId: bundle.publicationGenerationId,
    }));
    expect(buildLenderBookFact(captured)).toEqual(fact);
  });

  it("source staleness uses class fallback and a separate zero-weight A diagnostic", () => {
    const ctx = context(book());
    const bundle = source(ctx, { publishedAtSec: clockSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1,
      tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" } });
    const fact = buildLenderBookFact({ ...ctx, fixedInput: { ...ctx.fixedInput, lenderCollateralBacking: bundle } })!;
    expect(fact.status.observationState).toBe("known");
    expect(fact.collaterals[0]).toMatchObject({ quality: 85, qualitySource: "authored-class", fallbackReason: "accepted-source-stale" });
    expect([...ctx.gaps.values()]).toContainEqual(expect.objectContaining({ causeProof: expect.objectContaining({ cause: "A", rejectionCode: "accepted-source-stale" }) }));
    expect(fact.status.gapIds).toEqual([]);
    expect(fact.acceptedSourceStatus).toMatchObject({
      observationState: "stale", gapIds: [`${assetId}:gap:lender-collateral-accepted-source`],
    });
    expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)).not.toBeNull();
  });

  it.each(["accepted-source-unavailable", "accepted-source-held"] as const)(
    "keeps unavailable accepted source %s distinct from book unavailability", (reason) => {
      const ctx = context(book());
      const bundle = source(ctx, { status: "unavailable", reason, publicationGenerationId: null,
        publishedAtSec: null, policyDigest: null, evaluationBuildDigest: null,
        tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" } });
      const fact = buildLenderBookFact({ ...ctx, fixedInput: { ...ctx.fixedInput, lenderCollateralBacking: bundle } })!;
      expect(fact.status.observationState).toBe("known");
      expect(fact.collaterals[0]).toMatchObject({ quality: 85, fallbackReason: reason, qualitySource: "authored-class" });
      expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)).not.toBeNull();
      expect([...ctx.gaps.values()]).toContainEqual(expect.objectContaining({ causeProof: expect.objectContaining({ cause: "A", rejectionCode: reason }) }));
      expect(fact.status.gapIds).toEqual([]);
      expect(fact.acceptedSourceStatus).toMatchObject({
        observationState: "missing", gapIds: [`${assetId}:gap:lender-collateral-accepted-source`],
      });
      const compiled = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension({
        ...ctx.fixedInput, lenderCollateralBacking: bundle,
      }, ctx.extension);
      expect(compiled.quarantines).toEqual([]);
      expect(compiled.factSet.assets[0]!.lenderBook).toMatchObject({
        status: { observationState: "known", gapIds: fact.status.gapIds },
        acceptedSourceStatus: fact.acceptedSourceStatus,
        collaterals: fact.collaterals,
      });
      const evaluated = evaluateV9ReserveExposures({
        ...compiled.factSet.assets[0]!, resolvedUpstreamExposures: [],
        inheritedStablecoinBacking: {
          parentAssetId: "usdc-circle", parentBackingScore: 90, weight: 1,
          tier: "wrapped", failureDomains: [],
        },
      }, V9_CANDIDATE_POLICY_V1);
      expect(evaluated.score).toBeCloseTo(80.0154, 8);
      const factors = evaluated.contributions[0]!.factors!;
      expect(factors.find((factor) => factor.componentKey.endsWith(":accepted-source"))).toMatchObject({
        score: null, normalizedWeight: 0, effectiveScoringWeight: 0, cause: "A",
        causeGapIds: fact.acceptedSourceStatus!.gapIds, scoringDisposition: "excluded-pipeline",
      });
      expect(factors.filter((factor) => factor.effectiveScoringWeight > 0).every((factor) => factor.cause === null)).toBe(true);
    },
  );

  it("uses class fallback for future publication and absent/NR/excluded score cards", () => {
    const ctx = context(book());
    for (const publishedAtSec of [clockSec + 1, clockSec - 50]) {
      const bundle = source(ctx, { publishedAtSec, tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" } });
      const fact = buildLenderBookFact({ ...ctx, evidence: new Map(ctx.evidence), gaps: new Map(),
        fixedInput: { ...ctx.fixedInput, lenderCollateralBacking: bundle } })!;
      expect(fact.collaterals[0]).toMatchObject({ quality: 85, qualitySource: "authored-class",
        fallbackReason: publishedAtSec > clockSec ? "future-dated" : "accepted-card-ineligible" });
    }
  });

  it("keeps synthetic missing-observation availability U rather than claiming a failed actual read", () => {
    const ctx = context(unavailable("missing-observation"));
    const fact = buildLenderBookFact(ctx)!;
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof.cause).toBe("U");
    expect(fact.status.evidenceRefIds).toEqual([]);
    expect(evaluateV1019LenderBook(fact, 90, V9_CANDIDATE_POLICY_V1)).toBeNull();
  });

  it("retains the producer reason when the compiler independently rejects its acquisition age", () => {
    const original = unavailable("unreconciled");
    const payload = { ...original, acquiredAtSec: clockSec - 28_801 };
    const ctx = context({ ...payload, ...deriveLenderBookObservationIdentity(payload) });
    const fact = buildLenderBookFact(ctx)!;
    expect(fact.observation).toMatchObject({ status: "unavailable", reason: "unreconciled" });
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof).toMatchObject({ cause: "A", rejectionCode: "stale" });
  });

  it("canonicalizes reordered producer inventories without repairing duplicate identities", () => {
    const measured = book();
    if (measured.status !== "ok") throw new Error("Expected measured fixture");
    const reversed = { ...measured, deployments: measured.deployments.map((deployment) => ({
      ...deployment, selectorsRead: [...deployment.selectorsRead].reverse(),
    })) };
    const canonical = LiveReserveSnapshotProvenanceSchema.parse({ source: "onchain", fetchedAt: clockSec - 100,
      lenderBookObservation: reversed });
    expect(canonical.lenderBookObservation).toEqual(measured);
    const duplicate = { ...measured, deployments: measured.deployments.map((deployment) => ({
      ...deployment, markets: [...deployment.markets, ...deployment.markets],
    })) };
    expect(LiveReserveSnapshotProvenanceSchema.parse({ source: "onchain", fetchedAt: clockSec - 100,
      lenderBookObservation: duplicate }).lenderBookObservationFailure).toBeDefined();
  });

  it("recompiles identical frozen inputs and binds lender facts into the compiled digest", () => {
    const first = context(book());
    const repeated = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(first.fixedInput, first.extension);
    const retry = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(first.fixedInput, first.extension);
    expect(repeated.quarantines).toEqual([]);
    expect(repeated.factSet.assets[0]!.lenderBook?.observation).toEqual(first.fixedInput.liveReserveProvenanceMap[assetId]!.lenderBookObservation);
    expect(retry.factSet).toEqual(repeated.factSet);
    const other = context(book({ collateral: address(99) }));
    const changed = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(other.fixedInput, other.extension);
    expect(changed.quarantines).toEqual([]);
    expect(changed.factSet.v9FactSetDigest).not.toBe(repeated.factSet.v9FactSetDigest);
  });

  it("accepted score bytes change fact identity even when publication generation stays fixed", () => {
    const digests = [52.5, 53].map((backingScore) => {
      const ctx = context(book());
      const bundle = source(ctx, { tokenToAssetId: { [`ethereum:${btc}`]: "fixture-collateral" },
        byAssetId: { "fixture-collateral": { assetId: "fixture-collateral", backingScore,
          cardSha256: "c".repeat(64), sourceCause: null, sourceGapIds: [] } } });
      const result = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension({
        ...ctx.fixedInput, lenderCollateralBacking: bundle,
      }, ctx.extension);
      expect(result.quarantines).toEqual([]);
      return result.factSet.v9FactSetDigest;
    });
    expect(digests[0]).not.toBe(digests[1]);
  });

  it("routes invalid admitted source identity through asset-local quarantine, not a cohort throw", () => {
    const ctx = context(book());
    const outcome = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension({ ...ctx.fixedInput,
      lenderCollateralBacking: source(ctx, { registryFingerprint: "d".repeat(64) }) }, ctx.extension);
    expect(outcome.quarantines).toEqual([expect.objectContaining({ assetId, code: "fact-build-failed" })]);
    expect(outcome.factSet.assets).toHaveLength(1);
    expect(outcome.factSet.assets[0]!.reserveStatus.observationState).toBe("missing");
  });

  it("does not recursively score self collateral", () => {
    const ctx = context(book());
    const bundle = source(ctx, { tokenToAssetId: { [`ethereum:${btc}`]: assetId } });
    expect(buildLenderBookFact({ ...ctx, fixedInput: { ...ctx.fixedInput, lenderCollateralBacking: bundle } })!.collaterals[0])
      .toMatchObject({ trackedAssetId: null, quality: 85, fallbackReason: "self-collateral" });
  });

  it("retains malformed present producer bytes as a digest-bound local rejection", () => {
    const ctx = context();
    const provenance = LiveReserveSnapshotProvenanceSchema.parse({ source: "onchain", fetchedAt: clockSec - 100,
      lenderBookObservation: { status: "ok", deployments: [] } });
    expect(provenance.lenderBookObservation).toBeUndefined();
    expect(provenance.lenderBookObservationFailure).toMatchObject({ code: "producer-failed", reason: "malformed-lender-book-observation" });
    const fact = buildLenderBookFact({ ...ctx, fixedInput: { ...ctx.fixedInput,
      liveReserveProvenanceMap: { [assetId]: provenance } } })!;
    expect(ctx.gaps.get(fact.status.gapIds[0]!)?.causeProof).toMatchObject({ cause: "A", rejectionCode: "malformed" });
  });

  it("rejects identity-inconsistent facts within the existing asset boundary", () => {
    const ctx = context(book());
    expect(() => buildLenderBookFact({ ...ctx, fixedInput: { ...ctx.fixedInput,
      lenderCollateralBacking: source(ctx, { registryFingerprint: "d".repeat(64) }) } }))
      .toThrow(/registry fingerprint mismatch/);
    const valid = book();
    expect(() => buildLenderBookFact(context({ ...valid, contentSha256: "d".repeat(64) }))).toThrow(/Invalid lender book/);
  });

  it("cannot silently admit one successful deployment of a required three-deployment book", () => {
    const ctx = context(book());
    const payload = { ...book(), assetId: "gtusdcp-gauntlet" };
    const incompleteBook = { ...payload, ...deriveLenderBookObservationIdentity(payload) };
    const partial = { ...ctx, asset: { ...ctx.asset, assetId: "gtusdcp-gauntlet" },
      fixedInput: { ...ctx.fixedInput, liveReserveProvenanceMap: { "gtusdcp-gauntlet": {
        source: "onchain", fetchedAt: clockSec - 100, lenderBookObservation: incompleteBook,
      } } } };
    expect(() => buildLenderBookFact(partial)).toThrow(/Invalid lender book/);
  });
});
