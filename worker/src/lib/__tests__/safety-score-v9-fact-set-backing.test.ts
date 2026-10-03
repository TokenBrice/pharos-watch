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

import type { ReserveSlice } from "@shared/types/reserves";
import { evaluateV9ReserveExposures } from "@shared/lib/safety-score-v9/backing";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { V9AssetFactsV3Schema } from "@shared/types/safety-score-v9-facts";
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
  return {
    fixed,
    extension,
    asset: compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!,
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

  it("does not hide unknown reserve factors behind a known whole row", () => {
    const fixed = makeV9FixedInput({ reserves: [{
      sourceKey: "fixture:cash", name: "Cash", pct: 100, risk: "very-low", assetClass: "cash",
      liquidityHorizon: "unknown", issuerOrObligor: "custodian:alpha",
    }] });
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, makeV9Extension({
      registryFingerprint: fixed.registryFingerprint,
    })).assets[0]!;
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
  function compileLivePartition(rows: ReserveSlice[]) {
    const fixed = makeV9FixedInput({ assetId: ASSET_ID, clockSec: NO_HISTORY_CLOCK_SEC, reserves: rows });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([[ASSET_ID, { ...baseMeta(), reserves: rows }]]),
    });
    const tails = new Set(rows.filter(row => row.unclassifiedResidual).map(computeSafetyScoreV9ReserveExposureKey));
    for (const classification of extension.assets[0]!.reserveClassifications) {
      if (tails.has(classification.exposureKey)) classification.unclassifiedResidual = true;
    }
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


  it("retains a sub-microfraction rounding remainder without erasing identified holdings", () => {
    const fixed = makeV9FixedInput({ reserves: [{
      sourceKey: "fixture:cash", name: "Cash", pct: 99.999999, risk: "very-low", assetClass: "cash",
      liquidityHorizon: "immediate", issuerOrObligor: "custodian:alpha", maturityDaysMax: 0,
    }] });
    const asset = compileSafetyScoreV9FactSetFromFixedInput(fixed, makeV9Extension({
      registryFingerprint: fixed.registryFingerprint,
    })).assets[0]!;
    expect(asset.reserveExposures[0]!.weight).toBeCloseTo(0.99999999, 12);
    expect(asset.reserveResiduals[0]!.weight).toBeCloseTo(0.00000001, 12);
    expect(asset.reserveExposures[0]!.weight + asset.reserveResiduals[0]!.weight).toBe(1);
    const gap = asset.gaps.find((row) => row.gapId === asset.reserveResiduals[0]!.status.gapIds[0])!;
    expect(gap.causeProof.cause).toBe("U");
    expect(gap.causeScope?.requiredDatum).toBe("reserveCompositionRemainder");
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
