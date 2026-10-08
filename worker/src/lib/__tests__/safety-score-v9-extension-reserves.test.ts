import { describe, expect, it } from "vitest";
import type { ReserveSlice } from "@shared/types/reserves";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { evaluateV9ReserveExposures } from "@shared/lib/safety-score-v9/backing";
import { SCORE_EPSILON } from "@shared/lib/safety-score-v9/backing-primitives";
import {
  buildSafetyScoreV9BaselineExtension,
  buildReviewedReserveClassifications,
  buildSafetyScoreV9ReviewedCuratedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStandaloneReserveRows,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import {
  buildSafetyScoreV9ReserveClassifications,
  dependencyReserveSlices,
  buildSafetyScoreV9ReviewedAuditedFallbackReserveRows,
  buildSafetyScoreV9ReviewedStaticReserveRows,
  addReviewedStaticReserveEvidence,
} from "../safety-score-v9/extension-reserves";
import { buildSafetyScoreV9MechanismReview } from "../safety-score-v9/extension-mechanism";
import { ReviewEvidenceBuilder } from "../safety-score-v9/extension-shared";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import usdtCoin from "@shared/data/stablecoins/coins/usdt-tether.json";
import usdtReserveEnvelope from "@shared/data/stablecoins/domains/reserves/usdt-tether.json";
import usdyCoin from "@shared/data/stablecoins/coins/usdy-ondo-finance.json";
import usdyReserveEnvelope from "@shared/data/stablecoins/domains/reserves/usdy-ondo-finance.json";
import xagmCoin from "@shared/data/stablecoins/coins/xagm-matrixdock.json";
import xagmReserveEnvelope from "@shared/data/stablecoins/domains/reserves/xagm-matrixdock.json";
import mxneCoin from "@shared/data/stablecoins/coins/mxne-real-mxn.json";
import mxneReserveEnvelope from "@shared/data/stablecoins/domains/reserves/mxne-real-mxn.json";
import usdoCoin from "@shared/data/stablecoins/coins/usdo-openeden.json";
import usdoReserveEnvelope from "@shared/data/stablecoins/domains/reserves/usdo-openeden.json";

const CLOCK_SEC = Date.UTC(2026, 6, 14) / 1_000;
const DEPENDENCY_CLOCK_SEC = Date.UTC(2026, 7, 20) / 1_000;

const LIVE_RESERVES_CONFIG: NonNullable<V9ExtensionRegistryMeta["liveReservesConfig"]> = {
  adapter: "curated-validated",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-solana" } },
};

const LINKED_RESERVES: ReserveSlice[] = [
  {
    name: "Beta stablecoin",
    pct: 50,
    risk: "low",
    coinId: "beta",
    depType: "collateral",
    assetClass: "stablecoin",
    issuerOrObligor: "asset:beta",
    riskFactors: ["counterparty"],
    liquidityHorizon: "immediate",
  },
  {
    name: "Custodied cash",
    pct: 50,
    risk: "very-low",
    assetClass: "cash",
    issuerOrObligor: "issuer:alpha",
    riskFactors: ["custody", "counterparty"],
    liquidityHorizon: "immediate",
    maturityDaysMax: 0,
  },
];

function dependencyMeta(reviewedAt: string): V9ExtensionRegistryMeta {
  return {
    id: "alpha",
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
    reserves: LINKED_RESERVES,
    liveReservesConfig: LIVE_RESERVES_CONFIG,
    reserveReview: {
      reviewedAt,
      reviewer: "fixture",
      confidence: "verified",
      sources: [{ label: "Reserve report", url: "https://example.com/reserves" }],
      rationale: "Fixture review",
      compositionBasis: "Fixture report",
      compositionAsOf: reviewedAt,
      scope: "full-composition",
      knownUnknownExposure: "None",
      knownUnknownExposurePct: 0,
    },
  };
}

function dependencyMetaById(reviewedAt: string): Map<string, V9ExtensionRegistryMeta> {
  return new Map([
    ["alpha", dependencyMeta(reviewedAt)],
    [
      "beta",
      {
        id: "beta",
        mechanismArchetype: "fiat-cash",
        launchDate: "2020-01-01",
      },
    ],
  ]);
}

function reviewedMeta(
  reserves: ReserveSlice[],
  overrides: Partial<NonNullable<V9ExtensionRegistryMeta["reserveReview"]>> = {},
): V9ExtensionRegistryMeta {
  return {
    id: "alpha",
    reserves,
    reserveReview: {
      reviewedAt: "2026-07-13",
      reviewer: "fixture",
      confidence: "verified",
      sources: [{ label: "Reserve report", url: "https://example.com/reserves" }],
      rationale: "Fixture review",
      compositionBasis: "Fixture report",
      compositionAsOf: "2026-06-30",
      scope: "full-composition",
      knownUnknownExposure: "None",
      knownUnknownExposurePct: 0,
      ...overrides,
    },
  };
}

describe("v10.01 named reserve reports", () => {
  const asOfSec = Date.parse("2026-06-30T00:00:00Z") / 1000;
  const usdt = { ...usdtCoin, ...usdtReserveEnvelope } as unknown as V9ExtensionRegistryMeta;

  it.each([94 * 86400, 120 * 86400, 120 * 86400 + 1])(
    "uses the same as-of admission and evidence expiry at age %s seconds", (ageSec) => {
      const clockSec = asOfSec + ageSec;
      const meta = structuredClone(usdt);
      meta.liveReservesConfig = undefined;
      const supervised = { ...meta, mintAuthority: { supervision: "prudential" } as V9ExtensionRegistryMeta["mintAuthority"] };
      const admissions = [
        buildSafetyScoreV9ReviewedStaticReserveRows(supervised, clockSec),
        buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clockSec),
        buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, clockSec),
        buildSafetyScoreV9ReviewedCuratedFallbackReserveRows({ ...meta, liveReservesConfig: LIVE_RESERVES_CONFIG }, clockSec),
      ];
      for (const [index, admission] of admissions.entries()) {
        const sourceMeta = index === 0 ? supervised : meta;
        const evidence = new ReviewEvidenceBuilder(meta.id, clockSec);
        addReviewedStaticReserveEvidence(sourceMeta, admission, evidence, clockSec);
        const references = evidence.finish().researchEvidence;
        if (ageSec <= 10368000) {
          expect(admission).not.toBeNull();
          expect(admission!.evidenceClass).toBe(index === 0 ? "issuer-attested" : "static-validated");
          expect(admission!.rows.reduce((sum, row) => sum + row.pct, 0)).toBeCloseTo(100, 9);
          expect(references).toContainEqual(expect.objectContaining({
            observedAtSec: asOfSec, maxAgeSec: 10368000, publishedBy: "issuer",
          }));
        } else {
          expect(admission).toBeNull();
          expect(references).toContainEqual(expect.objectContaining({
            sourceId: "stablecoin-meta.expired-reviewed-static-reserves",
            observedAtSec: asOfSec, maxAgeSec: 10368000,
          }));
        }
      }
    },
  );

  it("admits actual USDT through BDO's report label, not its unrelated curation reviewer", () => {
    const meta = structuredClone(usdt);
    const clockSec = asOfSec + 94 * 86400;
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clockSec)).toMatchObject({
      evidenceClass: "static-validated",
    });
    for (const source of meta.proofOfReserves!.latestReport!.sources) source.label = "Issuer financial figures";
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clockSec)).toBeNull();
  });

  it("admits actual USDY through its explicit Ankura report signer without promoting partial assurance or the BVI tail", () => {
    const meta = { ...usdyCoin, ...usdyReserveEnvelope } as unknown as V9ExtensionRegistryMeta;
    const clockSec = Date.parse(`${meta.proofOfReserves!.latestReport!.periodEnd}T00:00:00Z`) / 1000 + 94 * 86400;
    const admission = buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clockSec);
    expect(admission).toMatchObject({ evidenceClass: "static-validated", provenance: "audited-fallback" });
    expect(admission!.rows.find(row => row.name.includes("BVI"))).toMatchObject({
      pct: 5.9490355116630695, unclassifiedResidual: true,
    });
    const unsigned = structuredClone(meta);
    unsigned.proofOfReserves!.latestReport!.reviewer = "Pharos curation reviewer";
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(unsigned, clockSec)).toBeNull();
    const indexOnly = structuredClone(meta);
    for (const source of indexOnly.proofOfReserves!.latestReport!.sources) source.url = indexOnly.proofOfReserves!.url;
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(indexOnly, clockSec)).toBeNull();
  });
  it.each([
    { ...xagmCoin, ...xagmReserveEnvelope },
    { ...mxneCoin, ...mxneReserveEnvelope },
  ])("retains the actual named $id report despite a direct PDF or issuer-prefixed firm description", (registryMeta) => {
    const meta = registryMeta as unknown as V9ExtensionRegistryMeta;
    const clockSec = Date.parse("2026-10-03T07:16:45Z") / 1000;
    const admission = buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clockSec);
    expect(admission).toMatchObject({
      evidenceClass: "static-validated", provenance: "audited-fallback",
      rows: [expect.objectContaining({ pct: 100 })],
    });
    const unnamed = structuredClone(meta);
    unnamed.proofOfReserves!.provider = "Unnamed independent auditor";
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(unnamed, clockSec)).toBeNull();
  });
  it("does not substitute MXNE's issuer prefix for corroboration of the actual BHR report firm", () => {
    const meta = structuredClone({ ...mxneCoin, ...mxneReserveEnvelope }) as unknown as V9ExtensionRegistryMeta;
    const clockSec = Date.parse("2026-10-03T07:16:45Z") / 1000;
    for (const source of meta.proofOfReserves!.latestReport!.sources) source.label = "Etherfuse issuer figures";
    meta.proofOfReserves!.latestReport!.reviewer = "Pharos curation reviewer";
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clockSec)).toBeNull();
  });


  it("does not treat actual USDO self-verification as a named independent report that blocks curated admission", () => {
    const meta = { ...usdoCoin, ...usdoReserveEnvelope, liveReservesConfig: LIVE_RESERVES_CONFIG } as unknown as V9ExtensionRegistryMeta;
    const reviewDaySec = Date.parse(`${meta.reserveReview!.reviewedAt}T00:00:00Z`) / 1000;
    // A current reviewed disclosure must never be admitted into a prior capture.
    expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(meta, reviewDaySec - 1)).toBeNull();
    const clockSec = reviewDaySec + 86400;
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clockSec)).toBeNull();
    const admission = buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(meta, clockSec);
    expect(admission).toMatchObject({ evidenceClass: "static-validated", provenance: "curated-fallback" });
  });


  it.each(["self", "none", "undisclosed", "name-missing", "firm-not-in-report"] as const)(
    "does not widen an unnamed or uncorroborated %s report to 120 days", (failure) => {
      const meta = structuredClone(usdt);
      meta.liveReservesConfig = undefined;
      if (failure === "name-missing") meta.proofOfReserves!.provider = " ";
      else if (failure === "firm-not-in-report") meta.proofOfReserves!.provider = "Unidentified firm";
      else meta.proofOfReserves!.attestorTier = failure;
      const clockSec = asOfSec + 94 * 86400;
      expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, clockSec)).toBeNull();
      expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, clockSec)).toBeNull();
    },
  );
});

describe("reviewed live unknown residuals", () => {
  const known: ReserveSlice = {
    sourceKey: "fixture:known", name: "Measured adverse credit", pct: 60, risk: "very-high",
    assetClass: "private-credit", issuerOrObligor: "borrower:known", riskFactors: ["credit"],
    liquidityHorizon: "unknown",
  };
  const unknown: ReserveSlice = {
    sourceKey: "fixture:unknown", name: "Unitemized tail", pct: 40, risk: "high",
    assetClass: "other", issuerOrObligor: "issuer:unknown", riskFactors: ["credit"],
    liquidityHorizon: "unknown",
    unclassifiedResidual: true,
    residualReason: "insufficient-evidence",
  };

  function metaFor(rows: ReserveSlice[] = [known, unknown]) {
    return reviewedMeta(rows, {
      knownUnknownExposure: "Unknown tail",
      knownUnknownExposurePct: 40,
      nonLinkDispositions: [{
        reserveIndex: 1, reserveName: unknown.name, pct: 40,
        disposition: "insufficient-evidence", rationale: "No instrument itemization",
      }],
    });
  }

  function compile(rows: ReserveSlice[], meta: V9ExtensionRegistryMeta) {
    const base = makeV9TwoAssetFixedInput({ clockSec: CLOCK_SEC });
    const {
      schemaVersion: _schemaVersion, dexPayloadFingerprint: _dexPayloadFingerprint,
      redemptionPayloadFingerprint: _redemptionPayloadFingerprint, registryFingerprint: _registryFingerprint,
      inputMethodologyVersions: _inputMethodologyVersions, baseInputGenerationId: _baseInputGenerationId,
      ...draft
    } = base;
    const fixed = createReportCardsFixedInput({
      ...draft, liveReserveMap: { ...base.liveReserveMap, alpha: rows },
    });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([["alpha", { ...meta, mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }],
        ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }]]),
    });
    const alpha = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets.find(row => row.assetId === "alpha")!;
    return { alpha, result: evaluateV9ReserveExposures({ ...alpha, resolvedUpstreamExposures: [] }, V9_CANDIDATE_POLICY_V1) };
  }

  it("charges the live tail once, with live weights, while retaining measured adverse credit", () => {
    const { alpha, result } = compile([{ ...known, pct: 63 }, { ...unknown, pct: 37 }], metaFor());
    expect(alpha.reserveExposures.map(row => row.weight)).toEqual([0.63]);
    const residuals = result.contributions.filter(row => row.componentKey.startsWith("reserve:unclassified-residual:"));
    expect(residuals).toHaveLength(1);
    expect(residuals[0]).toMatchObject({
      normalizedWeight: 0.37, observationState: "bounded-unknown",
      score: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.boundedUnknownQuality,
      failureDomains: [],
    });
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      pathKey: expect.stringContaining("reserve:unclassified-residual:"), cause: "U", treatment: "pillar",
    }));
    expect(result.structuralReasons.some(row => row.responsibility === "measured-adverse")).toBe(true);
    expect(result.structuralReasons.some(row => row.pathKey.includes("fixture:unknown"))).toBe(false);
  });

  it.each([false, true])("keeps a wholly unknown book bounded, including an empty known category (%s)", (zeroKnown) => {
    const meta = metaFor();
    const rows = zeroKnown ? [{ ...known, pct: 0 }, { ...unknown, pct: 100 }] : [{ ...unknown, pct: 100 }];
    const { alpha, result } = compile(rows, meta);
    expect(alpha.reserveStatus.observationState).toBe("bounded-unknown");
    expect(alpha.reserveExposures).toEqual([]);
    expect(result.contributions.filter(row => row.componentKey.startsWith("reserve:unclassified-residual:"))).toEqual([
      expect.objectContaining({
        normalizedWeight: 1, observationState: "bounded-unknown",
        score: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.boundedUnknownQuality,
      }),
    ]);
    expect(result.structuralReasons).toEqual([]);
    expect(result.rateability).toBe("rateable");
  });

  it.each(["missing-live", "missing-reviewed", "different-key", "duplicate-live", "duplicate-reviewed", "duplicate-disposition"] as const)(
    "does not turn %s identity into an unclassified residual",
    (kind) => {
      const rows = [known, { ...unknown }];
      const meta = metaFor([known, { ...unknown }]);
      if (kind === "missing-live") delete rows[1]!.sourceKey;
      if (kind === "missing-reviewed") delete meta.reserves![1]!.sourceKey;
      if (kind === "different-key") rows[1]!.sourceKey = "fixture:different";
      if (kind === "duplicate-live") rows.push({ ...unknown, pct: 0 });
      if (kind === "duplicate-reviewed") meta.reserves!.push({ ...unknown, pct: 0 });
      if (kind === "duplicate-disposition") meta.reserveReview!.nonLinkDispositions!.push({ ...meta.reserveReview!.nonLinkDispositions![0]! });
      const { alpha, result } = compile(rows, meta);
      expect(alpha.reserveExposures.reduce((sum, row) => sum + row.weight, 0)).toBe(1);
      expect(result.contributions.some(row => row.componentKey.startsWith("reserve:unclassified-residual:"))).toBe(false);
    },
  );

  it("requires an approved unresolved disposition before treating a live row as an unidentified remainder", () => {
    const meta = metaFor();
    const withoutDisposition = { ...meta, reserveReview: { ...meta.reserveReview!, nonLinkDispositions: undefined } };
    const classes = buildReviewedReserveClassifications([known, unknown], withoutDisposition, CLOCK_SEC);
    expect(classes.every(row => row.unclassifiedResidual === undefined)).toBe(true);
    const other = metaFor();
    other.reserveReview!.nonLinkDispositions![0]!.disposition = "untracked-exogenous-asset";
    const { alpha, result } = compile([known, unknown], other);
    expect(alpha.reserveExposures.map(row => row.weight).sort()).toEqual([0.4, 0.6]);
    expect(result.contributions.some(row => row.componentKey.startsWith("reserve:unclassified-residual:"))).toBe(false);
  });

  it("keeps an unmarked exact joined insufficient-evidence slice unchanged", () => {
    const { unclassifiedResidual: _marker, residualReason: _reason, ...unmarked } = unknown;
    const meta = metaFor();
    const classifications = buildReviewedReserveClassifications([known, unmarked], meta, CLOCK_SEC);
    expect(classifications.every(row => row.unclassifiedResidual === undefined)).toBe(true);
    const { alpha, result } = compile([known, unmarked], meta);
    expect(alpha.reserveExposures.map(row => row.weight).sort()).toEqual([0.4, 0.6]);
    expect(result.contributions.some(row => row.componentKey.startsWith("reserve:unclassified-residual:"))).toBe(false);
  });

  const classifiedShapes: Partial<ReserveSlice>[] = [
    { assetClass: "private-credit", issuerOrObligor: "Measured defaulting borrower", risk: "very-high" },
    { assetClass: "private-credit", issuerOrObligor: "Measured borrower" },
    { risk: "very-high", issuerOrObligor: "Measured adverse obligor" },
    { coinId: "beta" },
    { depType: "collateral" },
  ];
  for (const shapeOwner of ["live", "reviewed"] as const) {
    it.each(classifiedShapes)(`does not soften a ${shapeOwner} classified exposure marked unknown (%j)`, (shape) => {
      const adverse = { ...unknown, ...shape };
      const liveRows = [known, shapeOwner === "live" ? adverse : unknown];
      const meta = metaFor([known, shapeOwner === "reviewed" ? adverse : unknown]);
      const classifications = buildReviewedReserveClassifications(liveRows, meta, CLOCK_SEC);
      expect(classifications.every(row => row.unclassifiedResidual === undefined)).toBe(true);
      const { alpha, result } = compile(liveRows, meta);
      expect(alpha.reserveExposures.find(row => row.name === unknown.name)).toMatchObject({
        weight: 0.4, status: { observationState: "known" },
      });
      expect(result.contributions.some(row => row.componentKey.startsWith("reserve:unclassified-residual:"))).toBe(false);
      if (shapeOwner === "live" && shape.assetClass === "private-credit") {
        expect(alpha.reserveExposures.find(row => row.name === unknown.name)).toMatchObject({
          assetClass: "private-credit", issuerOrObligorKey: shape.issuerOrObligor,
        });
      }
    });
  }
});

describe("reviewed curated reserve admission", () => {
  const opaqueRows: ReserveSlice[] = [
    { name: "Opaque basket", pct: 40, risk: "medium" },
    { name: "Treasury bills", pct: 60, risk: "very-low" },
  ];
  const unresolvedReview = {
    knownUnknownExposure: "Opaque basket constituents are not fully split.",
    knownUnknownExposurePct: 40,
    nonLinkDispositions: [
      {
        reserveIndex: 0,
        reserveName: "Opaque basket",
        pct: 40,
        disposition: "basket-needs-split" as const,
        rationale: "The basket weights are unresolved.",
      },
    ],
  };

  it("retains identified reserve quality with a separately marked unsplit basket tail", () => {
    const fallbackMeta = reviewedMeta(opaqueRows, unresolvedReview);
    fallbackMeta.liveReservesConfig = {
      adapter: "curated-validated",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-solana" } },
    };

    for (const admission of [
      buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(fallbackMeta, CLOCK_SEC),
      buildSafetyScoreV9ReviewedStandaloneReserveRows(reviewedMeta(opaqueRows, unresolvedReview), CLOCK_SEC),
    ]) {
      expect(admission!.rows.find(row => row.name === "Opaque basket")).toMatchObject({
        pct: 40, unclassifiedResidual: true, residualReason: "insufficient-evidence",
      });
      expect(admission!.rows.find(row => row.name === "Treasury bills")!.pct).toBe(60);
    }
  });

  it("admits complete current verified fallback and standalone reserve evidence", () => {
    const rows = [{ name: "Treasury bills", pct: 100, risk: "very-low" as const }];
    const fallbackMeta = reviewedMeta(rows);
    fallbackMeta.liveReservesConfig = {
      adapter: "curated-validated",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-solana" } },
    };

    expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(fallbackMeta, CLOCK_SEC)).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "curated-fallback",
      rows,
    });
    expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(reviewedMeta(rows), CLOCK_SEC)).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "curated",
      rows,
    });
  });

  function residualMeta(residualPct: number, portfolio: boolean): V9ExtensionRegistryMeta {
    const meta = reviewedMeta([
      { sourceKey: "fixture:cash", name: "Cash", pct: 100 - residualPct, risk: "very-low", assetClass: "cash",
        issuerOrObligor: "issuer:alpha", liquidityHorizon: "immediate", maturityDaysMax: 0 },
      { sourceKey: "fixture:tail", name: "Unclassified residual", pct: residualPct, risk: "high", assetClass: "other",
        issuerOrObligor: "Unidentified assets", liquidityHorizon: "unknown",
        ...(residualPct > 0 ? { unclassifiedResidual: true, residualReason: "insufficient-evidence" as const } : {}) },
    ], {
      reviewedAt: "2026-07-13", compositionAsOf: "2026-07-12",
      knownUnknownExposurePct: residualPct,
      knownUnknownExposure: "An explicitly unidentified residual.",
      nonLinkDispositions: residualPct === 0 ? [] : [{
        reserveIndex: 1, reserveName: "Unclassified residual", pct: residualPct,
        disposition: "insufficient-evidence", rationale: "Unidentified positions and rounding.",
      }],
    });
    if (portfolio) {
      const observedAtSec = Date.UTC(2026, 6, 12) / 1_000;
      const reviewedAtSec = Date.UTC(2026, 6, 13) / 1_000;
      meta.reserveReview!.observations = [{
        kind: "portfolio-observation", scopeId: "fixture-portfolio", liabilityBookKey: "fixture-book",
        deploymentRefs: [], reviewer: "fixture", confidence: "verified",
        sources: [{ url: "https://example.com/reserves", accessedAtSec: reviewedAtSec, sha256: "a".repeat(64) }],
        reviewedAtSec, observedAtSec, expiresAtSec: CLOCK_SEC + 86400,
        sourceGeneration: "fixture-source", sourceSha256: "a".repeat(64), completeness: "complete", obligations: [],
        wholeAssetDenominator: { amount: "100", asOfSec: observedAtSec, unitBasis: "USD", sourceSha256: "a".repeat(64) },
      }];
    }
    return meta;
  }

  it.each(["omitted", "unresolved"] as const)("does not bypass %s portfolio obligations through ordinary curated admission", (disposition) => {
    const meta = residualMeta(0, true);
    meta.reserveReview!.observations![0]!.obligations.push({ key: "missing-book", disposition, reason: "Unknown asset scope" });
    expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows({ ...meta, liveReservesConfig: LIVE_RESERVES_CONFIG }, CLOCK_SEC)).toBeNull();
  });

  function attestedResidualMeta(residualPct: number, prudential: boolean): V9ExtensionRegistryMeta {
    const meta = residualMeta(residualPct, false);
    if (prudential) meta.mintAuthority = { supervision: "prudential" } as V9ExtensionRegistryMeta["mintAuthority"];
    meta.proofOfReserves = { type: "independent-audit", url: "https://example.com/reports", provider: "Independent examiner", attestorTier: "niche",
      latestReport: { periodEnd: "2026-07-12", publishedAt: "2026-07-13", assuranceMethod: "examination",
        scope: "assets-and-liabilities", liabilityReconciliation: "full", confidence: "verified", reviewer: "fixture",
        sources: [{ label: "Independent examiner report", url: "https://example.com/reserves" }] } };
    return meta;
  }

  it.each([0, 0.1, 0.100001, 5.9490355116630695, 11.98, 100])(
    "v10.01 retains identified weights and disjoint %s percent tails in every admitted envelope", (residualPct) => {
      for (const portfolio of [false, true]) {
        const meta = residualMeta(residualPct, portfolio);
        const fixed = makeV9TwoAssetFixedInput({ omitAlphaReserve: true, clockSec: CLOCK_SEC });
        const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: new Map([
          ["alpha", { ...meta, mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }],
          ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }],
        ]) });
        const admitted = extension.assets.find(row => row.assetId === "alpha")!.reviewedStaticReserveRows!;
        expect(admitted.rows.reduce((sum, row) => sum + row.pct, 0)).toBeCloseTo(100, 12);
        const alpha = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets.find(row => row.assetId === "alpha")!;
        expect(alpha.reserveExposures.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(1 - residualPct / 100, 12);
        expect(alpha.reserveResiduals.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(residualPct / 100, 12);
        const result = evaluateV9ReserveExposures({ ...alpha, resolvedUpstreamExposures: [] }, V9_CANDIDATE_POLICY_V1);
        const tails = result.contributions.filter(row => row.componentKey.startsWith("reserve:unclassified-residual:"));
        expect(tails.reduce((sum, row) => sum + row.wholeAssetWeight!, 0)).toBeCloseTo(residualPct / 100, 12);
        for (const tail of tails) expect(tail).toMatchObject({
          score: 35 * 0.8, cause: "U", scoringDisposition: "bounded-uncertainty", failureDomains: [],
        });
        if (residualPct === 100) expect(result.score).toBeLessThanOrEqual(35);
      }
      for (const prudential of [false, true]) {
        const meta = attestedResidualMeta(residualPct, prudential);
        const admit = prudential ? buildSafetyScoreV9ReviewedStaticReserveRows : buildSafetyScoreV9ReviewedAuditedFallbackReserveRows;
        const admitted = admit(meta, CLOCK_SEC)!;
        expect(admitted.rows.filter(row => !row.unclassifiedResidual).reduce((sum, row) => sum + row.pct, 0)).toBeCloseTo(100 - residualPct, 12);
        expect(admitted.rows.filter(row => row.unclassifiedResidual).reduce((sum, row) => sum + row.pct, 0)).toBeCloseTo(residualPct, 12);
      }
    },
  );

  it.each([false, true])("v10.01 retains denominator, identity and chronology rejection guards, portfolio=%s", (portfolio) => {
    const missing = residualMeta(5.9490355116630695, portfolio);
    missing.reserveReview!.nonLinkDispositions = [];
    const mismatched = residualMeta(5.9490355116630695, portfolio);
    mismatched.reserveReview!.nonLinkDispositions![0]!.pct /= 2;
    const classified = residualMeta(5.9490355116630695, portfolio);
    classified.reserves![1]!.assetClass = "cash";
    const undated = residualMeta(5.9490355116630695, portfolio);
    undated.reserveReview!.reviewedAt = "2026-07-11";
    const duplicate = residualMeta(5.9490355116630695, portfolio);
    duplicate.reserveReview!.nonLinkDispositions!.push({ ...duplicate.reserveReview!.nonLinkDispositions![0]! });
    const incomplete = residualMeta(5.9490355116630695, portfolio);
    incomplete.reserves![0]!.pct -= 1;
    for (const meta of [missing, mismatched, classified, undated, duplicate, incomplete]) {
      expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, CLOCK_SEC)).toBeNull();
      expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows({
        ...meta, liveReservesConfig: LIVE_RESERVES_CONFIG,
      }, CLOCK_SEC)).toBeNull();
    }
  });

  it("v10.01 preserves positive dust instead of discarding identified reserves", () => {
    const meta = residualMeta(SCORE_EPSILON * 50, false);
    const rows = buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, CLOCK_SEC)!.rows;
    expect(rows.find(row => row.unclassifiedResidual)!.pct).toBe(SCORE_EPSILON * 50);
    expect(rows.find(row => !row.unclassifiedResidual)!.pct).toBe(100 - SCORE_EPSILON * 50);
  });

  it.each([false, true])("keeps zero-residual admission and weights unchanged, portfolio=%s", (portfolio) => {
    const meta = residualMeta(0, portfolio);
    expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, CLOCK_SEC)).toMatchObject({
      rows: expect.arrayContaining(meta.reserves!), evidenceClass: "static-validated", provenance: "curated",
    });
  });

  it("admits reserve composition inside the 31-day base window", () => {
    const rows = [{ name: "Treasury bills", pct: 100, risk: "very-low" as const }];
    const clockSec = Date.UTC(2026, 7, 31) / 1_000;
    const meta = reviewedMeta(rows, {
      reviewedAt: "2026-08-31",
      compositionAsOf: "2026-07-31",
    });

    expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, clockSec)).not.toBeNull();
  });

  it("admits reserve composition past 31 days but inside the seven-day reporting grace", () => {
    const rows = [{ name: "Treasury bills", pct: 100, risk: "very-low" as const }];
    const clockSec = Date.UTC(2026, 8, 7) / 1_000;
    const meta = reviewedMeta(rows, {
      reviewedAt: "2026-09-07",
      compositionAsOf: "2026-07-31",
    });

    expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, clockSec)).not.toBeNull();
  });

  it("rejects reserve composition past the 31-day window and seven-day reporting grace", () => {
    const rows = [{ name: "Treasury bills", pct: 100, risk: "very-low" as const }];
    const clockSec = Date.UTC(2026, 8, 8) / 1_000;
    const meta = reviewedMeta(rows, {
      reviewedAt: "2026-09-08",
      compositionAsOf: "2026-07-31",
    });

    expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(meta, clockSec)).toBeNull();
  });

  it("admits independent adapter dates only as composition evidence, never as audited assurance", () => {
    const rows = [{ name: "Cash", pct: 100, risk: "very-low" as const }];
    const meta = reviewedMeta(rows, { compositionSource: "live-adapter" });
    meta.liveReservesConfig = LIVE_RESERVES_CONFIG;
    meta.proofOfReserves = {
      type: "independent-audit",
      url: "https://example.com/reports",
      provider: "Independent examiner",
      attestorTier: "niche",
      latestReport: {
        periodEnd: "2026-05-31",
        publishedAt: "2026-06-10",
        assuranceMethod: "examination",
        scope: "assets-and-liabilities",
        liabilityReconciliation: "full",
        confidence: "verified",
        reviewer: "fixture",
        sources: [{ label: "May report", url: "https://example.com/may" }],
      },
    };
    expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(meta, CLOCK_SEC)).toMatchObject({
      rows, evidenceClass: "static-validated", provenance: "curated-fallback",
    });
    const evidence = new ReviewEvidenceBuilder(meta.id, CLOCK_SEC);
    addReviewedStaticReserveEvidence(
      meta, buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(meta, CLOCK_SEC), evidence, CLOCK_SEC,
    );
    expect(evidence.finish().researchEvidence).toMatchObject([{
      sourceId: "stablecoin-meta.reviewed-curated-fallback-reserves",
      observedAtSec: Date.UTC(2026, 5, 30) / 1_000,
      publishedAtSec: null,
      publishedBy: "unknown",
      url: "https://example.com/reserves",
    }]);
    expect(buildSafetyScoreV9ReviewedAuditedFallbackReserveRows(meta, CLOCK_SEC)).toBeNull();
    expect(buildSafetyScoreV9ReviewedStaticReserveRows({
      ...meta, mintAuthority: { supervision: "prudential" } as V9ExtensionRegistryMeta["mintAuthority"],
    }, CLOCK_SEC)).toBeNull();
    for (const candidate of [
      { ...meta, liveReservesConfig: undefined },
      { ...meta, reserveReview: { ...meta.reserveReview!, compositionSource: undefined } },
      { ...meta, proofOfReserves: { ...meta.proofOfReserves, latestReport: { ...meta.proofOfReserves.latestReport!, confidence: "unknown" as const } } },
      { ...meta, proofOfReserves: { ...meta.proofOfReserves, latestReport: { ...meta.proofOfReserves.latestReport!, publishedAt: undefined } } },
      { ...meta, proofOfReserves: { ...meta.proofOfReserves, latestReport: { ...meta.proofOfReserves.latestReport!, publishedAt: "2026-07-15" } } },
    ]) {
      expect(buildSafetyScoreV9ReviewedStandaloneReserveRows(candidate, CLOCK_SEC)).toBeNull();
      expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(candidate, CLOCK_SEC)).toBeNull();
    }
    const expired = reviewedMeta(rows, { compositionSource: "live-adapter", compositionAsOf: "2026-05-31" });
    expired.liveReservesConfig = LIVE_RESERVES_CONFIG;
    expired.proofOfReserves = meta.proofOfReserves;
    expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(expired, CLOCK_SEC)).toBeNull();
  });
});

describe("curated reserve dependency admission", () => {
  it.each([undefined, "collateral"] as const)(
    "publishes reviewed native mechanism as a serial claim or withholds a conflict (%s)",
    (nativeType) => {
      const base = makeV9TwoAssetFixedInput({ clockSec: DEPENDENCY_CLOCK_SEC });
      const {
        schemaVersion: _schemaVersion, dexPayloadFingerprint: _dexPayloadFingerprint,
        redemptionPayloadFingerprint: _redemptionPayloadFingerprint, registryFingerprint: _registryFingerprint,
        inputMethodologyVersions: _inputMethodologyVersions, baseInputGenerationId: _baseInputGenerationId,
        ...draft
      } = base;
      const metaById = dependencyMetaById("2026-08-19");
      metaById.get("alpha")!.reserves = [{
        sourceKey: "fixture:beta", name: "Beta reserve", pct: 100, risk: "low",
        coinId: "beta", depType: "mechanism",
      }];
      const fixed = createReportCardsFixedInput({
        ...draft,
        liveReserveMap: { ...base.liveReserveMap, alpha: [{
          sourceKey: "fixture:beta", name: "Beta live reserve", pct: 100, risk: "low", coinId: "beta",
          ...(nativeType ? { depType: nativeType } : {}),
        }] },
      });
      const dependency = buildSafetyScoreV9BaselineExtension(fixed, { metaById })
        .assets.find((asset) => asset.assetId === "alpha")!.dependencies;
      expect(dependency).not.toBeNull();
      if (dependency === null) throw new Error("Expected alpha dependency admission facts");
      if (nativeType) {
        expect(dependency.edges).toEqual([]);
        expect(dependency.diagnostics.graphState).toBe("invalid");
        expect(dependency.diagnostics.issueCodes).toContain("reviewed-dependency-type-conflict");
      } else {
        expect(dependency.edges).toEqual([expect.objectContaining({
          upstreamAssetId: "beta", dependencyType: "mechanism", weight: 1, economicRole: "serial-claim",
        })]);
      }
    },
  );

  it.each(["no-match", "expired", "non-link"] as const)(
    "does not restore curated weights after a live %s rejection",
    (reason) => {
      const base = makeV9TwoAssetFixedInput({ clockSec: DEPENDENCY_CLOCK_SEC });
      const {
        schemaVersion: _schemaVersion, dexPayloadFingerprint: _dexPayloadFingerprint,
        redemptionPayloadFingerprint: _redemptionPayloadFingerprint, registryFingerprint: _registryFingerprint,
        inputMethodologyVersions: _inputMethodologyVersions, baseInputGenerationId: _baseInputGenerationId,
        ...draft
      } = base;
      const metaById = dependencyMetaById(reason === "expired" ? "2025-01-01" : "2026-08-19");
      const meta = metaById.get("alpha")!;
      meta.reserves = [{
        sourceKey: "fixture:beta", name: "Beta exposure", pct: 100, risk: "low", coinId: "beta",
      }];
      if (reason === "non-link") {
        meta.reserveReview!.nonLinkDispositions = [{
          reserveIndex: 0, reserveName: "Beta exposure", pct: 100,
          disposition: "untracked-exogenous-asset", rationale: "Reference only, not a claim.",
        }];
      }
      const fixed = createReportCardsFixedInput({
        ...draft,
        liveReserveMap: { ...base.liveReserveMap, alpha: [{
          sourceKey: reason === "no-match" ? "fixture:other" : "fixture:beta",
          name: "Beta exposure", pct: 100, risk: "low",
          ...(reason === "non-link" ? { coinId: "beta" } : {}),
        }] },
      });
      const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById });
      const expected = {
        source: "live-unmapped", edges: [],
        rejectionReasons: [{ sliceIndex: 0, reason }],
      };
      expect(extension.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject(expected);
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
      expect(compiled.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject(expected);
    },
  );

  it("drops curated basket edges when the reserve review is expired", () => {
    const fixed = makeV9TwoAssetFixedInput({
      omitAlphaReserve: true,
      liveToFallbackCoins: ["alpha"],
      clockSec: DEPENDENCY_CLOCK_SEC,
    });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: dependencyMetaById("2026-01-01"),
    });
    const alpha = extension.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [],
    });

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    const compiledAlpha = compiled.assets.find((asset) => asset.assetId === "alpha")!;
    expect(compiledAlpha.reserveStatus.observationState).toBe("missing");
    expect(compiledAlpha.gaps).toContainEqual(
      expect.objectContaining({ reasonCode: "missing-reserve-composition" }),
    );
    expect(
      evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");
  });

  it("keeps curated basket edges when the review is admissible", () => {
    const fixed = makeV9TwoAssetFixedInput({
      omitAlphaReserve: true,
      liveToFallbackCoins: ["alpha"],
      clockSec: DEPENDENCY_CLOCK_SEC,
    });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: dependencyMetaById("2026-08-19"),
    });
    const alpha = extension.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "curated-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
    expect(
      evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyReasons.map((reason) => reason.code),
    ).not.toContain("unreviewed-dependency-relationships");
  });

  it("leaves live-derived edges unchanged even when the curated review is expired", () => {
    const fixed = makeV9TwoAssetFixedInput({
      mapAlphaCollateral: true,
      clockSec: DEPENDENCY_CLOCK_SEC,
    });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: dependencyMetaById("2026-01-01"),
    });
    const alpha = extension.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "live-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.5 }],
    });
  });

  // Regression for ODR-E2: `lisusd-lista`'s live-reserve GemJoin branches
  // named a `coinId` upstream with `depType: "mechanism"` at dust weight.
  // `defaultV9DependencyEconomicRole` maps any non-"collateral" type to
  // "serial-claim", which requires weight === 1 and drops any lesser weight
  // as `invalid-serial-weight`, poisoning the whole graph to `"invalid"`.
  // A dust-weight coinId slice declares "collateral" explicitly so it lands
  // as a valid basket-exposure edge rather than an untyped withheld link.
  it("keeps a live-reserve branch with a dust-weight coinId slice as a valid basket edge", () => {
    const base = makeV9TwoAssetFixedInput({
      omitAlphaReserve: true,
      clockSec: DEPENDENCY_CLOCK_SEC,
    });
    const {
      schemaVersion: _schemaVersion,
      activeAssetIds: _activeAssetIds,
      dexPayloadFingerprint: _dexPayloadFingerprint,
      redemptionPayloadFingerprint: _redemptionPayloadFingerprint,
      registryFingerprint: _registryFingerprint,
      inputMethodologyVersions: _inputMethodologyVersions,
      baseInputGenerationId: _baseInputGenerationId,
      ...draft
    } = base;
    const fixed = createReportCardsFixedInput({
      ...draft,
      activeAssetIds: ["alpha", "beta"],
      liveReserveMap: {
        ...base.liveReserveMap,
        alpha: [
          {
            name: "Beta stablecoin GemJoin",
            pct: 0.0068,
            risk: "low" as const,
            coinId: "beta",
            depType: "collateral" as const,
          },
          {
            name: "Custodied cash",
            pct: 99.9932,
            risk: "very-low" as const,
            assetClass: "cash" as const,
            issuerOrObligor: "issuer:alpha",
            riskFactors: ["custody" as const, "counterparty" as const],
            liquidityHorizon: "immediate" as const,
            maturityDaysMax: 0,
          },
        ],
      },
    });
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        ["alpha", { id: "alpha", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }],
        ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }],
      ]),
    });
    const alpha = extension.assets.find((asset) => asset.assetId === "alpha")!;
    expect(alpha.dependencies).toMatchObject({
      source: "live-reserve",
      diagnostics: { graphState: "valid", issueCodes: [] },
      edges: [{ upstreamAssetId: "beta", dependencyType: "collateral", weight: 0.000068 }],
    });
  });
});

describe("buildReviewedReserveClassifications", () => {
  it.each([
    { sourceKey: "fixture:beta", name: "Renamed live row" },
    { sourceKey: undefined, name: "Beta reserve" },
  ])("inherits reviewed mechanism on native coinId rows with matching identity: %j", (identity) => {
    const intermediary = { kind: "vault-share" as const, label: "DSR", verified: true };
    const reviewed = reviewedMeta([{
      sourceKey: identity.sourceKey, name: "Beta reserve", pct: 100, risk: "low",
      coinId: "beta", depType: "mechanism", intermediary,
    }]);
    const mapping = dependencyReserveSlices([{
      ...identity, pct: 100, risk: "low", coinId: "beta",
    }], reviewed, CLOCK_SEC);
    expect(mapping.rejectionReasons).toEqual([]);
    expect(deriveEffectiveDependencySet(reviewed, {
      liveReserveSlices: mapping.slices, rejectionReasons: mapping.rejectionReasons,
    }).dependencies).toEqual([{ id: "beta", weight: 1, type: "mechanism", intermediary }]);
  });

  it.each([
    { coinId: "beta", depType: "collateral" as const, reason: "reviewed-dependency-type-conflict" },
    { coinId: "other", depType: "mechanism" as const, reason: "reviewed-dependency-identity-conflict" },
  ])("withholds a native reviewed conflict with a named reason: %j", ({ coinId, depType, reason }) => {
    const reviewed = reviewedMeta([{
      sourceKey: "fixture:beta", name: "Beta reserve", pct: 100, risk: "low",
      coinId: "beta", depType: "mechanism",
    }]);
    const mapping = dependencyReserveSlices([{
      sourceKey: "fixture:beta", name: "Beta reserve", pct: 100, risk: "low", coinId, depType,
    }], reviewed, CLOCK_SEC);
    expect(mapping.slices[0].coinId).toBeUndefined();
    expect(mapping.slices[0].depType).toBeUndefined();
    expect(mapping.rejectionReasons).toEqual([{
      sliceIndex: 0, reason, upstreamAssetId: coinId, reviewedUpstreamAssetId: "beta",
    }]);
    expect(deriveEffectiveDependencySet(reviewed, {
      liveReserveSlices: mapping.slices, rejectionReasons: mapping.rejectionReasons,
    }).dependencies).toEqual([]);
  });

  const classifiedCash: ReserveSlice = {
    name: "Cash",
    pct: 100,
    risk: "very-low",
    assetClass: "bank-deposit",
    issuerOrObligor: "Reserve bank",
  };

  it("admits a reviewed reserve classification inside 365 days", () => {
    const clockSec = Date.UTC(2026, 7, 20) / 1_000;
    const classifications = buildReviewedReserveClassifications(
      [{ name: "Cash", pct: 100, risk: "very-low" }],
      reviewedMeta([classifiedCash], { reviewedAt: "2025-08-21", compositionAsOf: "2025-08-21" }),
      clockSec,
    );

    expect(classifications[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^registry-reviewed:/),
      assetClass: "bank-deposit",
    });
  });

  it("rejects a reviewed reserve classification past 365 days", () => {
    const clockSec = Date.UTC(2026, 7, 20) / 1_000;
    const classifications = buildReviewedReserveClassifications(
      [{ name: "Cash", pct: 100, risk: "very-low" }],
      reviewedMeta([classifiedCash], { reviewedAt: "2025-08-19", compositionAsOf: "2025-08-19" }),
      clockSec,
    );

    expect(classifications[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });
  });

  it("does not let a live adapter mask an expired reviewed classification", () => {
    const clockSec = Date.UTC(2026, 7, 20) / 1_000;
    const classifications = buildReviewedReserveClassifications(
      [{ sourceKey: "fixture:cash", name: "Current cash", pct: 100, risk: "very-low" }],
      reviewedMeta(
        [{ ...classifiedCash, sourceKey: "fixture:cash" }],
        { reviewedAt: "2025-08-19", compositionAsOf: "2025-08-19" },
      ),
      clockSec,
    );

    expect(classifications[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
      issuerOrObligorKey: null,
    });
  });

  it("classifies exact tracked-asset slices without guessing from vague labels", () => {
    const classifications = buildSafetyScoreV9ReserveClassifications([
      { name: "Parent shares", pct: 80, risk: "low", coinId: "parent-stablecoin", depType: "wrapper" },
      { name: "Solana", pct: 20, risk: "medium" },
    ]);

    expect(classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetClass: "stablecoin",
          issuerOrObligorKey: "asset:parent-stablecoin",
          failureDomains: [{ kind: "reserve-issuer", key: "asset:parent-stablecoin" }],
        }),
        expect.objectContaining({
          assetClass: null,
          issuerOrObligorKey: null,
          failureDomains: [],
        }),
      ]),
    );
  });

  it("fills missing live classification fields from one normalized name and rounded weight match", () => {
    const classifications = buildReviewedReserveClassifications(
      [{ name: "U.S. Treasury Bills", pct: 61.2, risk: "very-low" }],
      reviewedMeta([
        {
          name: "US Treasury bills",
          pct: 61.03,
          risk: "very-low",
          assetClass: "treasury-bill",
          issuerOrObligor: "United States Treasury",
          riskFactors: ["duration", "liquidity", "custody"],
          liquidityHorizon: "one-day",
          maturityDaysMax: 90,
        },
      ]),
      CLOCK_SEC,
    );

    expect(classifications).toHaveLength(1);
    expect(classifications[0]).toMatchObject({
      assetClass: "treasury-bill",
      issuerOrObligorKey: "United States Treasury",
      riskFactors: ["custody", "duration", "liquidity"],
      liquidityHorizon: "one-day",
      maturityDaysMax: 90,
      failureDomains: [{ kind: "reserve-issuer", key: "United States Treasury" }],
    });
    expect(classifications[0]!.classificationKey).toMatch(/^registry-reviewed:reserve:/);
  });

  it("matches legacy rows by unique name regardless of weight and rejects ambiguity or invalid review state", () => {
    const live = [{ name: "Cash", pct: 15, risk: "very-low" as const }];
    const structuredCash: ReserveSlice = {
      name: "Cash",
      pct: 22,
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Reserve bank",
      riskFactors: ["counterparty", "custody"],
      liquidityHorizon: "immediate",
    };
    expect(buildReviewedReserveClassifications(live, reviewedMeta([structuredCash]), CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^registry-reviewed:/),
      assetClass: "bank-deposit",
      issuerOrObligorKey: "Reserve bank",
    });

    const ambiguous = reviewedMeta([
      { ...structuredCash, pct: 14.8 },
      { ...structuredCash, pct: 15.2 },
    ]);
    expect(buildReviewedReserveClassifications(live, ambiguous, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });

    const unknownReview = reviewedMeta([{ ...structuredCash, pct: 15 }], { confidence: "unknown" });
    expect(buildReviewedReserveClassifications(live, unknownReview, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });

    const futureReview = reviewedMeta([{ ...structuredCash, pct: 15 }], { reviewedAt: "2026-07-15" });
    expect(buildReviewedReserveClassifications(live, futureReview, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });

    const futureComposition = reviewedMeta([{ ...structuredCash, pct: 15 }], { compositionAsOf: "2026-07-15" });
    expect(buildReviewedReserveClassifications(live, futureComposition, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });
  });

  it("matches only the exact Bitcoin identity in the current USDT live/reviewed shapes", () => {
    const live: ReserveSlice[] = [
      { name: "Direct & indirect U.S. Treasury Bills", pct: 73.5, risk: "very-low" },
      {
        name: "Other reserves (cash & equivalents, secured loans, corporate bonds, other investments)",
        pct: 12.4,
        risk: "medium",
      },
      { name: "Physical gold bars", pct: 10.4, risk: "very-low" },
      { name: "Bitcoin", pct: 3.7, risk: "medium" },
    ];
    const reviewed: ReserveSlice[] = [
      {
        name: "U.S. Treasury bills",
        pct: 61.03,
        risk: "very-low",
        assetClass: "treasury-bill",
        issuerOrObligor: "United States Treasury",
        riskFactors: ["duration", "liquidity", "custody"],
        liquidityHorizon: "one-day",
      },
      {
        name: "Precious metals",
        pct: 10.34,
        risk: "medium",
        assetClass: "other",
        issuerOrObligor: "Physical gold inventory",
        riskFactors: ["market", "custody", "liquidity"],
        liquidityHorizon: "seven-days",
      },
      {
        name: "Bitcoin",
        pct: 3.45,
        risk: "high",
        assetClass: "cryptoasset",
        riskFactors: ["market", "custody", "liquidity"],
        liquidityHorizon: "seven-days",
      },
    ];

    const classifications = buildReviewedReserveClassifications(live, reviewedMeta(reviewed), CLOCK_SEC);
    expect(classifications.filter((row) => row.classificationKey.startsWith("registry-reviewed:"))).toHaveLength(1);
    expect(classifications.find((row) => row.assetClass === "cryptoasset")).toMatchObject({
      issuerOrObligorKey: null,
      riskFactors: ["custody", "liquidity", "market"],
      liquidityHorizon: "seven-days",
    });
  });

  it("keeps reviewed classifications joined across arbitrary live composition drift", () => {
    const reviewed = reviewedMeta([
      {
        name: "<3-Month U.S. Treasuries",
        pct: 73.7,
        risk: "very-low",
        assetClass: "treasury-bill",
        issuerOrObligor: "United States Treasury",
      },
      {
        name: "Other Bank Deposits",
        pct: 14.8,
        risk: "very-low",
        assetClass: "bank-deposit",
        issuerOrObligor: "Other regulated financial institutions",
      },
    ]);
    const drifted = buildReviewedReserveClassifications(
      [
        { name: "<3-Month U.S. Treasuries", pct: 71.7, risk: "very-low" },
        { name: "Other Bank Deposits", pct: 15.9, risk: "very-low" },
      ],
      reviewed,
      CLOCK_SEC,
    );
    expect(drifted).toMatchObject([
      { classificationKey: expect.stringMatching(/^registry-reviewed:/), assetClass: "treasury-bill" },
      { classificationKey: expect.stringMatching(/^registry-reviewed:/), assetClass: "bank-deposit" },
    ]);

    const grosslyDifferent = buildReviewedReserveClassifications(
      [{ name: "<3-Month U.S. Treasuries", pct: 62, risk: "very-low" }],
      reviewed,
      CLOCK_SEC,
    );
    expect(grosslyDifferent).toMatchObject([
      { classificationKey: expect.stringMatching(/^registry-reviewed:/), assetClass: "treasury-bill" },
    ]);
  });

  it("uses explicit source keys across label and weight changes and fails closed on key mismatch", () => {
    const reviewed = reviewedMeta([{
      sourceKey: "circle:usdc:treasuries-under-3m",
      name: "<3-Month U.S. Treasuries",
      pct: 71.9,
      risk: "very-low",
      assetClass: "treasury-bill",
      issuerOrObligor: "United States Treasury",
      coinId: "treasury-proxy",
    }]);
    const matchedLive: ReserveSlice[] = [{
      sourceKey: "circle:usdc:treasuries-under-3m",
      name: "Treasury securities under 93 days",
      pct: 12,
      risk: "very-low",
    }];

    expect(buildReviewedReserveClassifications(matchedLive, reviewed, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^registry-reviewed:/),
      assetClass: "treasury-bill",
      issuerOrObligorKey: "United States Treasury",
    });
    expect(dependencyReserveSlices(matchedLive, reviewed, CLOCK_SEC).slices[0]).toMatchObject({
      coinId: "treasury-proxy",
    });

    const mismatchedLive = [{
      ...matchedLive[0]!,
      sourceKey: "circle:usdc:different-slice",
      name: "<3-Month U.S. Treasuries",
    }];
    expect(buildReviewedReserveClassifications(mismatchedLive, reviewed, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
    });
    expect(dependencyReserveSlices(mismatchedLive, reviewed, CLOCK_SEC).slices[0]!.coinId).toBeUndefined();
  });

  it("rejects duplicate explicit source keys on either side", () => {
    const sourceKey = "fixture:alpha:cash";
    const reviewed = reviewedMeta([{
      sourceKey,
      name: "Cash",
      pct: 100,
      risk: "very-low",
      assetClass: "bank-deposit",
    }]);
    const duplicateLive = [
      { sourceKey, name: "Cash A", pct: 50, risk: "very-low" as const },
      { sourceKey, name: "Cash B", pct: 50, risk: "very-low" as const },
    ];
    // Both source-key rows share one exposure identity, but ambiguity must
    // prevent the reviewed bank-deposit classification from being attached.
    expect(buildReviewedReserveClassifications(duplicateLive, reviewed, CLOCK_SEC)).toMatchObject([
      { classificationKey: "source-native:reserve:8450f631d74b8b6ac00b13cd", assetClass: null },
    ]);

    const duplicateReviewed = reviewedMeta([
      ...reviewed.reserves!,
      { ...reviewed.reserves![0]!, name: "Duplicate cash" },
    ]);
    expect(buildReviewedReserveClassifications([duplicateLive[0]!], duplicateReviewed, CLOCK_SEC)[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
    });
  });

  it("strips an inferred dependency link when the review dispositions the slice as a non-link", () => {
    const reviewed = reviewedMeta(
      [
        {
          sourceKey: "fixture:alpha:beta-exposure",
          name: "Beta stablecoin",
          pct: 100,
          risk: "low",
          coinId: "beta",
          depType: "collateral",
        },
      ],
      {
        nonLinkDispositions: [
          {
            reserveIndex: 0,
            reserveName: "Beta stablecoin",
            pct: 100,
            disposition: "untracked-exogenous-asset",
            rationale: "The exposure is a price reference, not a redemption claim on beta.",
          },
        ],
      },
    );
    const live: ReserveSlice[] = [
      {
        sourceKey: "fixture:alpha:beta-exposure",
        name: "Beta exposure",
        pct: 100,
        risk: "low",
        coinId: "beta",
        depType: "collateral",
      },
    ];

    const { slices: [slice] } = dependencyReserveSlices(live, reviewed, CLOCK_SEC);
    expect(slice).toMatchObject({ name: "Beta exposure", pct: 100 });
    expect(slice!.coinId).toBeUndefined();
    expect(slice!.depType).toBeUndefined();
  });

  it("keeps a reviewed dependency link when no disposition covers the slice", () => {
    const reviewed = reviewedMeta([
      {
        sourceKey: "fixture:alpha:beta-exposure",
        name: "Beta stablecoin",
        pct: 100,
        risk: "low",
        coinId: "beta",
        depType: "collateral",
      },
    ]);
    const live: ReserveSlice[] = [
      { sourceKey: "fixture:alpha:beta-exposure", name: "Beta exposure", pct: 100, risk: "low" },
    ];

    expect(dependencyReserveSlices(live, reviewed, CLOCK_SEC).slices[0]).toMatchObject({
      coinId: "beta",
      depType: "collateral",
    });
  });

  it("refuses the curated fallback composition for an asset with no live-reserve producer", () => {
    const withoutLiveProducer = reviewedMeta([
      { name: "Cash", pct: 100, risk: "very-low", assetClass: "cash", issuerOrObligor: "issuer:alpha" },
    ]);
    expect(withoutLiveProducer.liveReservesConfig).toBeUndefined();
    expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(withoutLiveProducer, CLOCK_SEC)).toBeNull();

    const withLiveProducer: V9ExtensionRegistryMeta = {
      ...withoutLiveProducer,
      liveReservesConfig: LIVE_RESERVES_CONFIG,
    };
    expect(buildSafetyScoreV9ReviewedCuratedFallbackReserveRows(withLiveProducer, CLOCK_SEC)).toMatchObject({
      provenance: "curated-fallback",
      evidenceClass: "static-validated",
    });
  });

  it("keeps the current USDC reserve repartition classified by stable source key", () => {
    const live: ReserveSlice[] = [
      { sourceKey: "circle:usdc:treasuries-under-3m", name: "<3-Month U.S. Treasuries", pct: 65.7, risk: "very-low" },
      { sourceKey: "circle:usdc:sifi-deposits", name: "Deposits at Systemically Important Institutions", pct: 18.6, risk: "very-low" },
      { sourceKey: "circle:usdc:other-bank-deposits", name: "Other Bank Deposits", pct: 14.1, risk: "very-low" },
      { sourceKey: "circle:usdc:overnight-reverse-treasury-repo", name: "Overnight Reverse Treasury Repo", pct: 1.6, risk: "very-low" },
    ];
    const reviewed = reviewedMeta([
      { ...live[0]!, pct: 71.93275, assetClass: "treasury-bill", issuerOrObligor: "United States Treasury" },
      { ...live[1]!, pct: 12.491316, assetClass: "bank-deposit", issuerOrObligor: "Systemically important financial institutions" },
      { ...live[2]!, pct: 13.852994, assetClass: "bank-deposit", issuerOrObligor: "Other regulated financial institutions" },
      { ...live[3]!, pct: 1.72294, assetClass: "repo", issuerOrObligor: "Leading global banks" },
    ]);

    expect(buildReviewedReserveClassifications(live, reviewed, CLOCK_SEC)
      .sort((left, right) => left.issuerOrObligorKey!.localeCompare(right.issuerOrObligorKey!))).toMatchObject([
      { classificationKey: expect.stringMatching(/^registry-reviewed:/), assetClass: "repo", issuerOrObligorKey: "Leading global banks" },
      { classificationKey: expect.stringMatching(/^registry-reviewed:/), assetClass: "bank-deposit", issuerOrObligorKey: "Other regulated financial institutions" },
      { classificationKey: expect.stringMatching(/^registry-reviewed:/), assetClass: "bank-deposit", issuerOrObligorKey: "Systemically important financial institutions" },
      { classificationKey: expect.stringMatching(/^registry-reviewed:/), assetClass: "treasury-bill", issuerOrObligorKey: "United States Treasury" },
    ]);
  });

  it("rejects the current USDC repartition and USD1 aggregate basket as non-identical", () => {
    const usdc = buildReviewedReserveClassifications(
      [
        { name: "<3-Month U.S. Treasuries", pct: 73.7, risk: "very-low" },
        { name: "Other Bank Deposits", pct: 14.8, risk: "very-low" },
        { name: "Deposits at Systemically Important Institutions", pct: 10.2, risk: "very-low" },
        { name: "Overnight Reverse Treasury Repo", pct: 1.3, risk: "very-low" },
      ],
      reviewedMeta([
        {
          name: "U.S. Treasury securities",
          pct: 29.04,
          risk: "very-low",
          assetClass: "treasury-bill",
          issuerOrObligor: "United States Treasury",
        },
        {
          name: "Overnight U.S. Treasury repurchase agreements",
          pct: 59.46,
          risk: "very-low",
          assetClass: "repo",
          issuerOrObligor: "Global financial institutions",
        },
        {
          name: "Cash and net settlement balances",
          pct: 11.5,
          risk: "very-low",
          assetClass: "bank-deposit",
          issuerOrObligor: "Regulated financial institutions",
        },
      ]),
      CLOCK_SEC,
    );
    expect(usdc).toMatchObject([
      { classificationKey: expect.stringMatching(/^source-native:/), assetClass: null },
      { classificationKey: expect.stringMatching(/^source-native:/), assetClass: null },
      { classificationKey: expect.stringMatching(/^source-native:/), assetClass: null },
      { classificationKey: expect.stringMatching(/^source-native:/), assetClass: null },
    ]);

    const usd1 = buildReviewedReserveClassifications(
      [{ name: "U.S. Treasury Bills, Money Market Funds & Cash", pct: 100, risk: "very-low" }],
      reviewedMeta([
        {
          name: "Fidelity Government Portfolio (FRGXX)",
          pct: 85,
          risk: "low",
          assetClass: "money-market-fund",
          issuerOrObligor: "Fidelity Investments Money Market Government Portfolio",
        },
        {
          name: "Cash and cash equivalents in demand deposit accounts",
          pct: 15,
          risk: "very-low",
          assetClass: "bank-deposit",
          issuerOrObligor: "U.S. commercial banks",
        },
      ]),
      CLOCK_SEC,
    );
    expect(usd1[0]).toMatchObject({
      classificationKey: expect.stringMatching(/^source-native:/),
      assetClass: null,
      issuerOrObligorKey: null,
    });
  });
});

describe("assurance report freshness", () => {
  it.each([
    { publishedAt: "2026-01-02", expectedState: "known", expectedQuality: "strong" },
    { publishedAt: undefined, expectedState: "bounded-unknown", expectedQuality: null },
  ] as const)("credits a signed stand-in only with its sourced date: %j", ({ publishedAt, expectedState, expectedQuality }) => {
    const fixedInput = makeV9TwoAssetFixedInput({ clockSec: Date.UTC(2026, 0, 10) / 1_000 });
    const review = buildSafetyScoreV9MechanismReview(fixedInput, {
      id: "alpha",
      proofOfReserves: {
        type: "independent-audit",
        url: "https://example.com/report",
        latestReport: {
          periodEnd: "2026-01-01",
          publishedAt,
          publishedAtBasis: publishedAt ? "signed-date-standin" : undefined,
          assuranceMethod: "examination",
          scope: "assets-and-liabilities",
          liabilityReconciliation: "full",
          reviewer: "fixture",
          confidence: "verified",
          sources: [{ label: "Signed report", url: "https://example.com/report.pdf" }],
        },
      },
    }, "fiat-cash");
    if (!review || review.archetype !== "fiat-cash") throw new Error("expected fiat-cash review");
    expect(review.assuranceAndReconciliation).toMatchObject({
      status: { observationState: expectedState },
      quality: expectedQuality,
    });
  });

  it.each([undefined, "explicit", "signed-date-standin"] as const)(
    "does not keep an over-age latest report known (%s)",
    (publishedAtBasis) => {
      const maxAgeSec =
        V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.assuranceReportMaxAgeSec;
      const periodEnd = "2026-01-01";
      const periodEndSec = Date.parse(`${periodEnd}T00:00:00Z`) / 1_000;
      const fixedInput = makeV9TwoAssetFixedInput({ clockSec: periodEndSec + maxAgeSec + 1 });
      const review = buildSafetyScoreV9MechanismReview(
        fixedInput,
        {
          id: "alpha",
          proofOfReserves: {
            type: "attestation",
            url: "https://example.com/report",
            latestReport: {
              periodEnd,
              publishedAt: "2026-01-02",
              publishedAtBasis,
              assuranceMethod: "examination",
              scope: "assets-and-liabilities",
              liabilityReconciliation: "full",
              reviewer: "fixture",
              confidence: "verified",
              sources: [{ label: "Report", url: "https://example.com/report.pdf" }],
            },
          },
        },
        "fiat-cash",
      );

      expect(review?.archetype).toBe("fiat-cash");
      if (!review || review.archetype !== "fiat-cash") throw new Error("expected fiat-cash review");
      expect(review.assuranceAndReconciliation.status.observationState).toBe("stale");
      expect(review.assuranceAndReconciliation.quality).toBeNull();
    },
  );
});
