import { describe, expect, it, vi } from "vitest";
import { evaluateV9ReserveExposures } from "../safety-score-v9/backing";
import {
  createUnavailableV9BackingResult,
  evaluateV9ArchetypeBacking,
} from "../safety-score-v9/archetypes/evaluation";
import {
  type V9BackingAssetInput,
  v9StructuralSignalSharePct,
} from "../safety-score-v9/backing-primitives";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type {
  V9AssetFactsV2,
  V9FactGapV2,
  V9FactGapV3,
  V9ReserveExposureFactV2,
} from "../../types/safety-score-v9-facts";
import type { V1019LenderBookFact } from "../../types/safety-score-v9-facts";
import type {
  LenderCollateralClass, LenderDeploymentObservation,
} from "../../types/safety-score-v9-lender-book";
import { evaluateV1019LenderBook } from "../safety-score-v9/lender-book";
import { lenderMarketKey } from "../safety-score-v9/lender-book-registry";
import { verifiedLiveInheritedExposures } from "../safety-score-v9/backing-inheritance";

import { asset, exposure, knownStatus, missingMechanism } from "./safety-score-v9-backing.test-support";
import { resolveV9EvidenceCause } from "../safety-score-v9/evidence";
import { V9CauseContributionSchema } from "../../types/safety-score-v9-causes";

function factorGap(key: string, cause: "A" | "B" | "C" | "U"): V9FactGapV3 {
  const envelope = key === "reserve-composition";
  const scope = { pillar: "backing" as const, componentKey: envelope ? key : `reserve:gold:${key}`,
    factorKey: envelope ? null : key, exposureId: envelope ? null : "gold", routeKey: null, requiredDatum: key };
  const resolution = resolveV9EvidenceCause({
    assetId: "asset", scope, asOfSec: Date.parse("2026-10-03T00:00:00Z") / 1000,
    sourceGenerationId: "test:g1", evidenceReferences: [],
    ...(cause === "C" ? { typedReview: {
      id: `research:${key}`, assetId: "asset", scope, cause,
      reviewedAt: "2026-10-01", sources: ["https://example.com/report"],
      assertion: "researched-nondisclosure", rationale: "The exact required factor was researched in the current report.",
    } } : cause === "B" ? { classification: {
      id: `research:${key}`, assetId: "asset", scope, cause, assertion: "required-data-public",
      reviewedAt: "2026-10-01T00:00:00Z", reviewer: "fixture",
      sources: [{ url: "https://example.com/report", observedAt: "2026-10-01T00:00:00Z", datumAsOf: "2026-10-01",
        location: "Reserve factors", excerpt: `The ${key} is disclosed.`,
        assertion: `The exact ${key} is public but uncurated.` }],
    } } : {}),
  });
  const legacy = missingMechanism(key, `gap:${key}`, "backing.required", "Missing exact reserve factor").gap;
  const causeProof = cause === "A" ? {
    cause: "A" as const, producerState: "producer-failed" as const, sourceId: "factor-reader",
    sourceGenerationId: "test:g1", observedAtSec: 1, rejectionCode: "read-failed", evidenceRefIds: ["attempt:g1"],
  } : resolution.causeProof;
  return { ...legacy, causeProof, responsibility: cause === "A" ? "producer-failed" : resolution.responsibility };
}

describe("v10.01 cause-aware reserve quality", () => {
  it("never labels USDT gold's unknown horizons unsafe, while independently unsafe known evidence still fires", () => {
    const gold = { ...exposure({ key: "gold", weight: 1, assetClass: "other" }),
      liquidityHorizon: "unknown" as const, maturityDaysMax: null };
    const unknown = evaluateV9ReserveExposures(asset([gold]), V9_CANDIDATE_POLICY_V1);
    expect(unknown.contributions.find(row => row.componentKey === "reserve:gold")!.score).toBeCloseTo(
      40 * 0.55 + 55 * 0.3 + 48 * 0.15, 12);
    expect(unknown.structuralReasons.filter(row => row.kind === "unsafe-backing")).toEqual([]);
    const measured = evaluateV9ReserveExposures(asset([{
      ...gold, assetClass: "private-credit", issuerOrObligorKey: "borrower",
      liquidityHorizon: "over-seven-days", maturityDaysMax: 1000,
    }]), V9_CANDIDATE_POLICY_V1);
    expect(measured.structuralReasons).toContainEqual(expect.objectContaining({
      kind: "unsafe-backing", responsibility: "measured-adverse",
    }));
  });

  it.each(["C", "U"] as const)("refining %s horizons to any ordinary disclosed rung cannot lower quality", (cause) => {
    const gaps = [factorGap("liquidity", cause), factorGap("maturity", cause)];
    const status = (index: number) => ({ ...knownStatus("report"), observationState: "bounded-unknown" as const,
      gapIds: [gaps[index]!.gapId] });
    const row = { ...exposure({ key: "gold", weight: 1, assetClass: "other" }),
      liquidityHorizon: "unknown" as const, maturityDaysMax: null,
      factorStatuses: { liquidity: status(0), maturity: status(1) } };
    const baseline = evaluateV9ReserveExposures({ ...asset([row]), gaps }, V9_CANDIDATE_POLICY_V1).score!;
    for (const horizon of ["immediate", "one-day", "seven-days", "over-seven-days"] as const) {
      for (const maturityDaysMax of [0, 30, 90, 365, 1000]) {
        const result = evaluateV9ReserveExposures({ ...asset([{ ...row, liquidityHorizon: horizon, maturityDaysMax,
          factorStatuses: { liquidity: knownStatus("liquidity"), maturity: knownStatus("maturity") } }]), gaps },
        V9_CANDIDATE_POLICY_V1);
        expect(result.score).toBeGreaterThanOrEqual(baseline);
      }
    }
  });

  it.each(["A", "B"] as const)("excludes %s horizon factors without changing whole-asset exposure", (cause) => {
    const gaps = [factorGap("liquidity", cause), factorGap("maturity", cause)];
    const row = { ...exposure({ key: "gold", weight: 1, assetClass: "other" }),
      liquidityHorizon: "unknown" as const, maturityDaysMax: null,
      factorStatuses: { liquidity: { ...knownStatus("report"), observationState: "missing" as const, gapIds: [gaps[0]!.gapId] },
        maturity: { ...knownStatus("report"), observationState: "missing" as const, gapIds: [gaps[1]!.gapId] } } };
    const result = evaluateV9ReserveExposures({ ...asset([row]), gaps }, V9_CANDIDATE_POLICY_V1);
    const contribution = result.contributions.find(entry => entry.componentKey === "reserve:gold")!;
    // Excluded factors leave the row scored on its class, so A/B does not control the row.
    expect(contribution).toMatchObject({
      score: 40, wholeAssetWeight: 1, effectiveScoringWeight: 1, cause: null, scoringDisposition: "included",
      causeGapIds: ["gap:liquidity", "gap:maturity"],
    });
    expect(contribution.factors!.filter(factor => factor.score === null)).toEqual([
      expect.objectContaining({ componentKey: "reserve:gold:liquidity", cause, effectiveScoringWeight: 0,
        scoringDisposition: cause === "A" ? "excluded-pipeline" : "excluded-uncurated" }),
      expect.objectContaining({ componentKey: "reserve:gold:maturity", cause, effectiveScoringWeight: 0,
        scoringDisposition: cause === "A" ? "excluded-pipeline" : "excluded-uncurated" }),
    ]);
    expect(result.structuralReasons.filter(entry => entry.kind === "unsafe-backing")).toEqual([]);
  });
  it("retains supplied stale classifications without converting their uncertainty into measured adversity", () => {
    const keys = ["assetClass", "liquidity", "maturity", "obligorConcentration"] as const;
    const gaps = keys.map(key => factorGap(key, "U"));
    const known = exposure({ key: "gold", weight: 1 });
    const stale = {
      ...known, status: { ...known.status, observationState: "stale" as const, gapIds: gaps.map(gap => gap.gapId) },
      factorStatuses: Object.fromEntries(keys.map((key, index) => [key,
        { ...known.status, observationState: "stale" as const, gapIds: [gaps[index]!.gapId] }])),
    };
    const result = evaluateV9ReserveExposures(asset([stale], gaps), V9_CANDIDATE_POLICY_V1);
    const knownResult = evaluateV9ReserveExposures(asset([known]), V9_CANDIDATE_POLICY_V1);
    expect(result.contributions.find(row => row.componentKey === "reserve:gold")).toMatchObject({
      score: knownResult.contributions.find(row => row.componentKey === "reserve:gold")!.score,
      cause: "U", scoringDisposition: "bounded-uncertainty",
    });
    expect(result.structuralReasons.filter(row => row.kind === "unsafe-backing")).toEqual([]);
  });

  it.each(["C", "U"] as const)("never invents diversification when the %s issuer census is wholly unidentified", (cause) => {
    const gap = factorGap("obligorConcentration", cause);
    const row = { ...exposure({ key: "gold", weight: 1 }), failureDomains: [],
      factorStatuses: { obligorConcentration: { ...knownStatus("captured-position"),
        observationState: "bounded-unknown" as const, gapIds: [gap.gapId] } } };
    const result = evaluateV9ReserveExposures(asset([row], [gap]), V9_CANDIDATE_POLICY_V1);
    expect(result.contributions.find(entry => entry.componentKey === "reserve:concentration")).toMatchObject({
      score: 35, cause, causeGapIds: ["gap:obligorConcentration"], scoringDisposition: "bounded-uncertainty",
    });
    expect(result.structuralReasons.filter(entry => entry.kind === "unsafe-backing")).toEqual([]);
  });

  it("preserves identified concentration when an independent remainder has unknown obligor research", () => {
    const known = exposure({ key: "known", weight: 0.6, issuer: "bank:a", custodian: "bank:a" });
    const remainder = exposure({ key: "gold", weight: 0.4, issuer: "bank:b", custodian: "bank:b" });
    const disclosed = evaluateV9ReserveExposures(asset([known, remainder]), V9_CANDIDATE_POLICY_V1);
    const gap = factorGap("obligorConcentration", "U");
    const partial = evaluateV9ReserveExposures(asset([known, {
      ...remainder, issuerOrObligorKey: null, failureDomains: [],
      factorStatuses: { obligorConcentration: { ...knownStatus("captured-position"),
        observationState: "bounded-unknown" as const, gapIds: [gap.gapId] } },
    }], [gap]), V9_CANDIDATE_POLICY_V1);
    expect(partial.contributions.find(entry => entry.componentKey === "reserve:concentration")!.score)
      .toBe(disclosed.contributions.find(entry => entry.componentKey === "reserve:concentration")!.score);
  });

  it("does not invent an issuer-strength discount when an expired envelope supplies no admitted composition", () => {
    const gap = factorGap("reserve-composition", "U");
    const status = { ...knownStatus("expired-report"), observationState: "stale" as const, gapIds: [gap.gapId] };
    const result = evaluateV9ReserveExposures({
      ...asset([], [gap], status), reserveResiduals: [{ residualId: "unidentified", weight: 1, status }],
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.contributions.find(row => row.componentKey === "reserve:unclassified-residual:unidentified"))
      .toMatchObject({ score: 35, cause: "U", causeGapIds: [gap.gapId] });
  });

  it("uses available parent quality instead of local C/U floors, but retains independently measured local danger", () => {
    const gap = factorGap("assetClass", "U");
    const row = { ...exposure({ key: "gold", weight: 1, assetClass: "stablecoin", trackedAssetId: "parent" }),
      status: { ...knownStatus("old-position"), observationState: "stale" as const, gapIds: [gap.gapId] },
      liquidityHorizon: "unknown" as const };
    const upstream = { exposureKey: "gold", upstreamAssetId: "parent", score: 90,
      evidenceLevel: "strong" as const, reasonCodes: [], failureDomains: [], cause: null, causeGapIds: [] };
    const uncertain = evaluateV9ReserveExposures({
      ...asset([row], [gap]), resolvedUpstreamExposures: [upstream],
    }, V9_CANDIDATE_POLICY_V1);
    expect(uncertain.contributions.find(entry => entry.componentKey === "reserve:gold"))
      .toMatchObject({ score: 90, cause: "U", causeGapIds: [gap.gapId] });
    const measured = evaluateV9ReserveExposures({
      ...asset([{ ...row, status: knownStatus("current-credit"), assetClass: "private-credit",
        liquidityHorizon: "over-seven-days", maturityDaysMax: 1000 }]),
      resolvedUpstreamExposures: [upstream],
    }, V9_CANDIDATE_POLICY_V1);
    expect(measured.contributions.find(entry => entry.componentKey === "reserve:gold")!.score).toBeLessThan(45);
    expect(measured.structuralReasons).toContainEqual(expect.objectContaining({
      kind: "unsafe-backing", responsibility: "measured-adverse",
    }));
  });

  it.each([
    { assetClass: "protocol-position" as const, liquidityHorizon: "unknown" as const, expected: 80.15 },
    { assetClass: "stablecoin" as const, liquidityHorizon: "immediate" as const, expected: 85.65 },
  ])("preserves ordinary local reserve quality under parent inheritance: $assetClass", ({ assetClass, liquidityHorizon, expected }) => {
    const gap = factorGap("liquidity", "U");
    const row = { ...exposure({ key: "gold", weight: 1, assetClass, trackedAssetId: "parent", provenance: "live" }),
      liquidityHorizon };
    const result = evaluateV9ReserveExposures({
      ...asset([row], liquidityHorizon === "unknown" ? [gap] : []),
      resolvedUpstreamExposures: [{ exposureKey: "gold", upstreamAssetId: "parent", score: 88.92,
        evidenceLevel: "strong", reasonCodes: [], failureDomains: [] }],
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.contributions.find(entry => entry.componentKey === "reserve:gold")!.score).toBeCloseTo(expected, 12);
    expect(result.structuralReasons.filter(entry => entry.kind === "unsafe-backing")).toEqual([]);
  });

  it("preserves independently weaker source strength on known local reserve quality under parent inheritance", () => {
    const row = { ...exposure({ key: "gold", weight: 1, assetClass: "stablecoin", trackedAssetId: "parent" }),
      evidenceClass: "static-validated" as const, liquidityHorizon: "one-day" as const };
    const result = evaluateV9ReserveExposures({
      ...asset([row]),
      resolvedUpstreamExposures: [{ exposureKey: "gold", upstreamAssetId: "parent", score: 88.92,
        evidenceLevel: "strong", reasonCodes: [], failureDomains: [] }],
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.contributions.find(entry => entry.componentKey === "reserve:gold")!.score).toBeCloseTo(67.08, 12);
  });

  it("keeps the compiled reserve witness on inherited quality and concentration without verified live holdings", () => {
    const gap: V9FactGapV3 = {
      gapId: "hbusdt-hyperbeat:gap:reserve-composition",
      reasonCode: "missing-reserve-composition",
      ownerDomain: "backing",
      policyRuleId: "v9.backing.reserve-composition",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "reserve-composition" },
      message: "No reserve composition is present in the exact fixed input.",
      evidenceRefIds: [],
      responsibility: "unresearched",
      causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] },
      causeScope: {
        pillar: "backing", componentKey: "reserve-composition", factorKey: null,
        routeKey: null, exposureId: null, requiredDatum: "reserve-composition",
      },
    };
    const reserveStatus = {
      ...knownStatus("unused", gap.policyRuleId),
      observationState: "missing" as const,
      evidenceRefIds: [],
      gapIds: [gap.gapId],
    };
    const result = evaluateV9ArchetypeBacking({
      archetype: "fiat-cash",
      asset: {
        assetId: "hbusdt-hyperbeat", reserveStatus, reserveExposures: [],
        reserveResiduals: [{ residualId: "unidentified", weight: 1, status: reserveStatus }],
        gaps: [gap], resolvedUpstreamExposures: [],
        inheritedStablecoinBacking: {
          parentAssetId: "usdt-tether", parentBackingScore: 75, weight: 1,
          tier: "wrapped", failureDomains: [{ kind: "reserve-issuer", key: "asset:usdt-tether" }],
        },
      },
      components: Object.keys(V9_CANDIDATE_POLICY_V1.policy.semantic.backing.archetypes["fiat-cash"].componentWeights).map(componentKey => ({
        componentKey,
        fact: { quality: "strong" as const, status: knownStatus(`evidence:${componentKey}`), failureDomains: [] },
      })),
    }, V9_CANDIDATE_POLICY_V1);
    const inherited = result.contributions.filter(row => row.source !== "mechanism");
    expect(inherited.map(row => row.componentKey)).toEqual([
      "reserve:concentration", "reserve:inherited-backing:usdt-tether",
    ]);
    for (const row of inherited) {
      expect(V9CauseContributionSchema.parse({
        score: row.score, cause: row.cause, causeGapIds: row.causeGapIds,
        scoringDisposition: row.scoringDisposition, effectiveScoringWeight: row.effectiveScoringWeight,
      })).toMatchObject({ score: 75, cause: "U", causeGapIds: [gap.gapId], scoringDisposition: "bounded-uncertainty" });
    }
    expect(result.contributions.reduce((sum, row) => sum + (row.score ?? 0) * row.effectiveScoringWeight, 0))
      .toBeCloseTo(result.score!, 12);
    expect(result.causeGapIds).toEqual([gap.gapId]);
    expect(result.limitedEvidenceCauses).toEqual(["U"]);
  });
});

function unavailableReview(
  gap: V9FactGapV2,
  archetype: V9AssetFactsV2["archetype"] = "fiat-cash",
): Pick<V9AssetFactsV2, "archetype" | "mechanismRiskReview"> {
  return {
    archetype,
    mechanismRiskReview: {
      status: {
        applicability: {
          state: "required",
          policyRuleId: "v9.backing.mechanism-review",
          rationale: null,
          gapId: null,
        },
        observationState: "missing",
        evidenceRefIds: [],
        gapIds: [gap.gapId],
      },
      review: null,
    },
  };
}

describe("Safety Score v9 backing exposure primitives", () => {
  it("clamps only percentage-scale floating noise and names the asset and field", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const share = 1.0000000000308;

    expect(
      v9StructuralSignalSharePct(
        "onyc-onre",
        "structuralSignals[0].materialSharePct",
        share,
      ),
    ).toBe(100);
    expect(warn).toHaveBeenCalledWith(
      "safety_score_v9_structural_signal_percentage_clamped",
      {
        assetId: "onyc-onre",
        fieldPath: "structuralSignals[0].materialSharePct",
        rawValue: share * 100,
        arithmetic: `${share} * 100`,
      },
    );

    warn.mockClear();
    expect(v9StructuralSignalSharePct("alpha", "structuralSignals[0].materialSharePct", 0.731)).toBe(73.1);
    expect(v9StructuralSignalSharePct("alpha", "structuralSignals[0].materialSharePct", 1.01)).toBe(101);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("weights an ordinary weak slice proportionally without making it a global minimum", () => {
    const strong = evaluateV9ReserveExposures(
      asset([exposure({ key: "cash", weight: 0.99 }), exposure({ key: "small", weight: 0.01 })]),
      V9_CANDIDATE_POLICY_V1,
    );
    const weak = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "cash", weight: 0.99 }),
        exposure({ key: "small", weight: 0.01, assetClass: "private-credit" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(strong.score).not.toBeNull();
    expect(weak.score).not.toBeNull();
    expect(strong.score! - weak.score!).toBeGreaterThan(0);
    expect(strong.score! - weak.score!).toBeLessThan(2);
    expect(weak.structuralReasons).toEqual([]);
  });

  it("emits a structural ceiling for material speculative credit", () => {
    const result = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "cash", weight: 0.8 }),
        exposure({ key: "credit", weight: 0.2, assetClass: "private-credit", issuer: "borrower" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.structuralReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "speculative-credit",
          severity: "high",
          responsibility: "measured-adverse",
          ceiling: 59,
          materialShare: 0.2,
        }),
      ]),
    );
  });

  it("does not label the same bounded-unknown reserve classification as measured adverse", () => {
    const unknownCredit = exposure({
      key: "credit",
      weight: 0.2,
      assetClass: "private-credit",
      issuer: "borrower",
    });
    unknownCredit.status = {
      ...unknownCredit.status,
      observationState: "bounded-unknown",
      evidenceRefIds: [],
    };
    const result = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "cash", weight: 0.8 }),
        unknownCredit,
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.structuralReasons.some(reason => reason.kind === "speculative-credit")).toBe(false);
    expect(result.structuralReasons.some((reason) => reason.responsibility === "measured-adverse")).toBe(false);
  });

  it("uses the injected upstream result as an exposure-bounded loss", () => {
    const input = asset([
      exposure({ key: "cash", weight: 0.8 }),
      exposure({ key: "upstream", weight: 0.2, assetClass: "stablecoin", trackedAssetId: "parent" }),
    ]);
    const strong = evaluateV9ReserveExposures(
      {
        ...input,
        resolvedUpstreamExposures: [
          {
            exposureKey: "upstream",
            upstreamAssetId: "parent",
            score: 90,
            evidenceLevel: "strong",
            reasonCodes: [],
            failureDomains: [{ kind: "reserve-issuer", key: "parent" }],
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    const weak = evaluateV9ReserveExposures(
      {
        ...input,
        resolvedUpstreamExposures: [
          {
            exposureKey: "upstream",
            upstreamAssetId: "parent",
            score: 20,
            evidenceLevel: "limited",
            reasonCodes: ["missing-reserve-composition"],
            failureDomains: [{ kind: "reserve-issuer", key: "parent" }],
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(strong.score! - weak.score!).toBeGreaterThan(8);
    expect(weak.unresolved).toContainEqual(
      expect.objectContaining({
        code: "missing-reserve-composition",
        pathKey: "reserve:upstream",
        treatment: "pillar",
      }),
    );
  });

  it("does not promote a rateable minority upstream ceiling to the whole basket child", () => {
    const result = evaluateV9ReserveExposures(
      {
        ...asset([
          exposure({ key: "cash", weight: 0.86 }),
          exposure({
            key: "buidl-like",
            weight: 0.14,
            assetClass: "stablecoin",
            trackedAssetId: "buidl-like",
          }),
        ]),
        resolvedUpstreamExposures: [
          {
            exposureKey: "buidl-like",
            upstreamAssetId: "buidl-like",
            score: 50.4,
            evidenceLevel: "limited",
            reasonCodes: ["missing-reserve-composition"],
            failureDomains: [{ kind: "reserve-issuer", key: "buidl-like" }],
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.contributions.find((entry) => entry.componentKey === "reserve:buidl-like")).toMatchObject({
      score: 50.4,
      normalizedWeight: 0.14,
      upstreamAssetId: "buidl-like",
    });
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      code: "missing-reserve-composition",
      pathKey: "reserve:buidl-like",
      treatment: "pillar",
    }));
  });

  it("retains distinct upstream gap provenance without reviving removed missing-data ceilings", () => {
    const result = evaluateV9ReserveExposures(
      {
        ...asset([
          exposure({
            key: "parent",
            weight: 1,
            assetClass: "stablecoin",
            trackedAssetId: "parent",
          }),
        ]),
        resolvedUpstreamExposures: [
          {
            exposureKey: "parent",
            upstreamAssetId: "parent",
            score: 50,
            evidenceLevel: "limited",
            reasonCodes: [
              "partial-reserve-review",
              "unreviewed-reserve-envelope",
            ],
            reasons: [
              {
                code: "partial-reserve-review",
                path: "backing:same-path",
                responsibility: "issuer-undisclosed",
              },
              {
                code: "unreviewed-reserve-envelope",
                path: "backing:same-path",
                responsibility: "producer-failed",
              },
            ],
            failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.unresolved.map(reason => ({ code: reason.code, responsibility: reason.responsibility, treatment: reason.treatment }))).toEqual([
      { code: "partial-reserve-review", responsibility: "issuer-undisclosed", treatment: "pillar" },
      { code: "unreviewed-reserve-envelope", responsibility: "producer-failed", treatment: "pillar" },
    ]);
  });

  it("is order invariant while retaining provenance in the trace", () => {
    const left = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "b", weight: 0.5, provenance: "live" }),
        exposure({ key: "a", weight: 0.5, provenance: "curated" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );
    const right = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "a", weight: 0.5, provenance: "curated" }),
        exposure({ key: "b", weight: 0.5, provenance: "live" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(right).toEqual(left);
    expect(left.contributions.find((entry) => entry.componentKey === "reserve:b")?.provenance).toBe("live");
  });

  it("does not consume an authored legacy reserve risk field", () => {
    const base = exposure({ key: "cash", weight: 1 });
    const low = { ...base, risk: "very-low" } as unknown as V9ReserveExposureFactV2;
    const high = { ...base, risk: "very-high" } as unknown as V9ReserveExposureFactV2;

    expect(evaluateV9ReserveExposures(asset([low]), V9_CANDIDATE_POLICY_V1)).toEqual(
      evaluateV9ReserveExposures(asset([high]), V9_CANDIDATE_POLICY_V1),
    );
  });

  it("identifies a reviewed common-mode concentration across separate exposures", () => {
    const result = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "a", weight: 0.2, custodian: "shared" }),
        exposure({ key: "b", weight: 0.2, custodian: "shared" }),
        exposure({ key: "c", weight: 0.3 }),
        exposure({ key: "d", weight: 0.3 }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.structuralReasons).toContainEqual(
      expect.objectContaining({
        kind: "unsafe-backing",
        severity: "moderate",
        responsibility: "measured-adverse",
        materialShare: 0.4,
      }),
    );
  });

  it("exempts allocated-commodity issuer domains while retaining custodian concentration", () => {
    const separateCustodians = evaluateV9ReserveExposures(
      asset([
        exposure({
          key: "gold-a",
          weight: 0.5,
          assetClass: "commodity-allocated",
          issuer: "physical-gold",
          custodian: "vault-a",
        }),
        exposure({
          key: "gold-b",
          weight: 0.5,
          assetClass: "commodity-allocated",
          issuer: "physical-gold",
          custodian: "vault-b",
        }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );
    const sharedCustodian = evaluateV9ReserveExposures(
      asset([
        exposure({
          key: "gold-a",
          weight: 0.5,
          assetClass: "commodity-allocated",
          issuer: "physical-gold",
          custodian: "shared-vault",
        }),
        exposure({
          key: "gold-b",
          weight: 0.5,
          assetClass: "commodity-allocated",
          issuer: "physical-gold",
          custodian: "shared-vault",
        }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );
    const ordinaryIssuer = evaluateV9ReserveExposures(
      asset([
        exposure({ key: "cash-a", weight: 0.5, issuer: "bank", custodian: "bank-vault-a" }),
        exposure({ key: "cash-b", weight: 0.5, issuer: "bank", custodian: "bank-vault-b" }),
      ]),
      V9_CANDIDATE_POLICY_V1,
    );

    const separateConcentration = separateCustodians.contributions.find(
      (entry) => entry.componentKey === "reserve:concentration",
    );
    const sharedConcentration = sharedCustodian.contributions.find(
      (entry) => entry.componentKey === "reserve:concentration",
    );
    const ordinaryConcentration = ordinaryIssuer.contributions.find(
      (entry) => entry.componentKey === "reserve:concentration",
    );

    expect(separateConcentration).toMatchObject({ score: 75 });
    expect(separateConcentration?.failureDomains).toEqual(
      expect.arrayContaining([
        { kind: "reserve-custodian", key: "vault-a" },
        { kind: "reserve-custodian", key: "vault-b" },
      ]),
    );
    expect(separateConcentration?.failureDomains).not.toContainEqual({
      kind: "reserve-issuer",
      key: "physical-gold",
    });
    expect(sharedConcentration).toMatchObject({ score: 35 });
    expect(ordinaryConcentration).toMatchObject({ score: 35 });
    expect(separateCustodians.contributions.find((entry) => entry.componentKey === "reserve:gold-a")?.score).toBe(
      93.9,
    );
  });

  it("preserves known reserves while charging an absent mechanism review at authored component weights", () => {
    const gap: V9FactGapV2 = {
      gapId: "gap:mechanism-review",
      reasonCode: "bounded-mechanism-review",
      ownerDomain: "backing",
      policyRuleId: "v9.backing.mechanism-review",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-risk-review" },
      message: "No policy-independent mechanism review is present.",
      evidenceRefIds: [],
    };
    const backingAsset = asset(
      ["a", "b", "c", "d"].map((key) => exposure({ key, weight: 0.25 })),
      [gap],
    );
    const reserve = evaluateV9ReserveExposures(backingAsset, V9_CANDIDATE_POLICY_V1);
    const result = createUnavailableV9BackingResult(backingAsset, unavailableReview(gap), V9_CANDIDATE_POLICY_V1);
    const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.backing;
    const archetypePolicy = policy.archetypes["fiat-cash"];
    const mechanismWeight = 1 - archetypePolicy.reserveWeight;
    const mechanismContributions = result.contributions.filter((entry) => entry.source === "mechanism");

    expect(result).toMatchObject({ rateability: "rateable", pillarCeiling: null });
    expect(result.score).toBeCloseTo(reserve.score! * archetypePolicy.reserveWeight + 35 * mechanismWeight, 12);
    expect(result.score).toBeGreaterThan(35);
    expect(mechanismContributions.map((entry) => entry.componentKey)).toEqual([
      "mechanism:assurance-and-reconciliation",
      "mechanism:claim-and-segregation",
      "mechanism:custody-continuity",
    ]);
    for (const contribution of mechanismContributions) {
      const componentKey = contribution.componentKey.replace("mechanism:", "");
      expect(contribution.score).toBe(policy.boundedUnknownQuality);
      expect(contribution.observationState).toBe("missing");
      expect(contribution.evidenceRefIds).toEqual([]);
      expect(contribution.normalizedWeight * mechanismWeight).toBeCloseTo(
        archetypePolicy.componentWeights[componentKey],
        12,
      );
    }
    expect(result.unresolved).toHaveLength(3);
    expect(result.unresolved).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "bounded-mechanism-review", treatment: "pillar" })]),
    );
  });

  it("bounds proof-free unavailable reviews without relabelling them issuer silence or direct NR", () => {
    const integrityGap: V9FactGapV2 = {
      gapId: "gap:integrity",
      reasonCode: "missing-pillar-evidence",
      ownerDomain: "evidence",
      policyRuleId: "v9.backing.mechanism-review",
      observationState: "unsupported",
      path: { kind: "local-component", componentKey: "mechanism-risk-review" },
      message: "The mechanism review design is unsupported.",
      evidenceRefIds: [],
    };
    const archetypeGap: V9FactGapV2 = {
      gapId: "gap:archetype",
      reasonCode: "missing-archetype",
      ownerDomain: "methodology",
      policyRuleId: "v9.backing.mechanism-review",
      observationState: "missing",
      path: { kind: "methodology", componentKey: "mechanism-risk-review" },
      message: "The mechanism archetype is unresolved.",
      evidenceRefIds: [],
    };
    const exposures = [exposure({ key: "cash", weight: 1 })];
    const integrity = createUnavailableV9BackingResult(
      asset(exposures, [integrityGap]),
      unavailableReview(integrityGap),
      V9_CANDIDATE_POLICY_V1,
    );
    const unresolvedArchetype = createUnavailableV9BackingResult(
      asset(exposures, [archetypeGap]),
      unavailableReview(archetypeGap, "unresolved"),
      V9_CANDIDATE_POLICY_V1,
    );

    expect(integrity).toMatchObject({ rateability: "rateable" });
    expect(integrity.contributions.filter(row => row.source === "mechanism").every(row => row.score === 35 && row.cause === "U")).toBe(true);
    expect(integrity.unresolved).toContainEqual(expect.objectContaining({ code: "missing-pillar-evidence" }));
    expect(unresolvedArchetype).toMatchObject({ rateability: "rateable" });
    expect(unresolvedArchetype.unresolved).toContainEqual(expect.objectContaining({ code: "missing-archetype" }));
  });

  it("uses inclusive maturity bands and bounds missing maturity for treasury bills", () => {
    const scores = [30, 31, null].map((maturityDaysMax) => {
      const result = evaluateV9ReserveExposures(asset([{
        ...exposure({ key: "bill", weight: 1, assetClass: "treasury-bill", issuer: "sovereign" }),
        maturityDaysMax,
      }]), V9_CANDIDATE_POLICY_V1);
      return result.contributions.find((entry) => entry.componentKey === "reserve:bill")!.score;
    });
    expect(scores[0]).toBeCloseTo(96.3, 8);
    expect(scores[1]).toBeCloseTo(95.1, 8);
    expect(scores[2]).toBeCloseTo(96 * 0.55 + 98 * 0.3 + 48 * 0.15, 8);
  });

  it("ignores maturity for exempt cash but bounds an unknown liquidity horizon", () => {
    const cash = exposure({ key: "cash", weight: 1 });
    const evaluate = (overrides: Partial<V9ReserveExposureFactV2>) =>
      evaluateV9ReserveExposures(asset([{ ...cash, ...overrides }]), V9_CANDIDATE_POLICY_V1);
    expect(evaluate({ maturityDaysMax: 366 })).toEqual(evaluate({ maturityDaysMax: null }));
    expect(evaluate({ liquidityHorizon: null }).contributions.find((entry) => entry.componentKey === "reserve:cash")!.score)
      .toBeCloseTo(98 * 0.55 + 55 * 0.3 + 100 * 0.15, 8);
    expect(evaluate({ liquidityHorizon: "immediate" }).contributions.find((entry) => entry.componentKey === "reserve:cash")!.score)
      .toBeCloseTo(98.3, 8);
  });
});

describe("Safety Score v9 wrapper backing inheritance", () => {
  const backing = V9_CANDIDATE_POLICY_V1.policy.semantic.backing;
  const missingReserveAsset = (
    inherited: NonNullable<V9BackingAssetInput["inheritedStablecoinBacking"]>,
  ): V9BackingAssetInput => ({
    assetId: "wrapper",
    reserveStatus: {
      applicability: { state: "required", policyRuleId: "v9.backing.reserve-composition", rationale: null, gapId: null },
      observationState: "missing",
      evidenceRefIds: [],
      gapIds: ["wrapper:gap:reserve-composition"],
    },
    reserveExposures: [],
    gaps: [
      {
        ...factorGap("reserve-composition", "C"),
        gapId: "wrapper:gap:reserve-composition",
        reasonCode: "missing-reserve-composition",
        policyRuleId: "v9.backing.reserve-composition",
        path: { kind: "local-component", componentKey: "reserve-composition" },
      },
    ],
    resolvedUpstreamExposures: [],
    inheritedStablecoinBacking: inherited,
  });

  it("inherits a pure 1:1 parent's backing pillar without re-pricing the wrapper layer", () => {
    const result = evaluateV9ReserveExposures(
      missingReserveAsset({
        parentAssetId: "parent",
        parentBackingScore: 75,
        weight: 1,
        tier: "pure",
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBeCloseTo(75, 6);
    expect(result.rateability).toBe("rateable");
    expect(result.contributions).toContainEqual(
      expect.objectContaining({ componentKey: "reserve:inherited-backing:parent", upstreamAssetId: "parent" }),
    );
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        code: "partial-reserve-review",
        treatment: "pillar",
        responsibility: "issuer-undisclosed",
        cause: "C",
        causeGapIds: ["wrapper:gap:reserve-composition"],
      }),
    ]);
  });

  it("preserves every explicit owner on an inherited partial reserve", () => {
    const base = missingReserveAsset({
      parentAssetId: "parent",
      parentBackingScore: 75,
      weight: 1,
      tier: "pure",
      failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
    });
    const result = evaluateV9ReserveExposures(
      {
        ...base,
        reserveStatus: {
          ...base.reserveStatus,
          gapIds: ["wrapper:gap:issuer", "wrapper:gap:producer"],
        },
        gaps: [
          {
            ...base.gaps[0]!,
            ...factorGap("reserve-composition", "C"),
            gapId: "wrapper:gap:issuer",
            responsibility: "issuer-undisclosed",
          },
          {
            ...base.gaps[0]!,
            ...factorGap("reserve-composition", "A"),
            gapId: "wrapper:gap:producer",
            responsibility: "producer-failed",
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(
      result.unresolved
        .filter((reason) => reason.code === "partial-reserve-review")
        .map((reason) => reason.responsibility),
    ).toEqual(["issuer-undisclosed", "producer-failed"]);
  });

  it("propagates an unavailable upstream's causal owner into the dependency reason", () => {
    const result = evaluateV9ReserveExposures(
      {
        ...asset([
          exposure({
            key: "parent",
            weight: 1,
            assetClass: "stablecoin",
            trackedAssetId: "parent",
            issuer: "asset:parent",
          }),
        ]),
        resolvedUpstreamExposures: [
          {
            exposureKey: "parent",
            upstreamAssetId: "parent",
            score: null,
            evidenceLevel: "insufficient",
            reasonCodes: ["missing-reserve-composition"],
            reasons: [
              {
                code: "missing-reserve-composition",
                responsibility: "issuer-undisclosed",
              },
            ],
            failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.unresolved).toContainEqual(
      expect.objectContaining({
        code: "material-dependency-unavailable",
        responsibility: "issuer-undisclosed",
      }),
    );
  });

  it("attributes an unprojectable tracked reserve to the method unless an explicit gap owner wins", () => {
    const input = asset([
      exposure({
        key: "parent",
        weight: 1,
        assetClass: "stablecoin",
        trackedAssetId: "parent",
        issuer: "asset:parent",
      }),
    ]);
    const methodOwned = evaluateV9ReserveExposures(input, V9_CANDIDATE_POLICY_V1);
    const producerOwned = evaluateV9ReserveExposures(
      {
        ...input,
        unresolvedUpstreamProjectionAttributions: [
          {
            causalKey: "gap:dependency-projection:producer",
            responsibility: "producer-failed",
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );
    const mixedOwned = evaluateV9ReserveExposures(
      {
        ...input,
        unresolvedUpstreamProjectionAttributions: [
          {
            causalKey: "gap:dependency-projection:issuer",
            responsibility: "issuer-undisclosed",
          },
          {
            causalKey: "gap:dependency-projection:producer",
            responsibility: "producer-failed",
          },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(methodOwned.unresolved).toContainEqual(
      expect.objectContaining({
        code: "material-dependency-unavailable",
        responsibility: "method-unsupported",
      }),
    );
    expect(producerOwned.unresolved).toContainEqual(
      expect.objectContaining({
        code: "material-dependency-unavailable",
        responsibility: "producer-failed",
      }),
    );
    expect(
      mixedOwned.unresolved
        .filter((reason) => reason.code === "material-dependency-unavailable")
        .map((reason) => reason.responsibility),
    ).toEqual(["issuer-undisclosed", "producer-failed"]);
  });

  it("uses verified live parent backing without rerunning the child archetype", () => {
    const liveAsset: V9BackingAssetInput = {
      ...asset([
        exposure({
          key: "parent",
          weight: 1,
          assetClass: "stablecoin",
          trackedAssetId: "parent",
          issuer: "asset:parent",
          provenance: "live",
        }),
      ]),
      assetId: "wrapper",
      inheritedStablecoinBacking: {
        parentAssetId: "parent",
        parentBackingScore: 82,
        weight: 1,
        tier: "wrapped",
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      },
    };
    const failedFact = (key: string) => ({
      status: knownStatus(`mechanism:${key}`),
      quality: "failed" as const,
      failureDomains: [{ kind: "reserve-issuer" as const, key: `child:${key}` }],
    });
    const result = evaluateV9ArchetypeBacking(
      {
        archetype: "fiat-cash",
        asset: liveAsset,
        components: [
          { componentKey: "claim-and-segregation", fact: failedFact("claim") },
          { componentKey: "custody-continuity", fact: failedFact("custody") },
          { componentKey: "assurance-and-reconciliation", fact: failedFact("assurance") },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.score).toBe(82);
    expect(result.contributions).toEqual([
      expect.objectContaining({
        componentKey: "reserve:concentration",
        observationState: "known",
        provenance: "live",
      }),
      expect.objectContaining({
        componentKey: "reserve:inherited-backing:parent",
        observationState: "known",
        provenance: "live",
        upstreamAssetId: "parent",
      }),
    ]);
    expect(result.contributions.some((entry) => entry.source === "mechanism")).toBe(false);
    expect(result.unresolved).toEqual([]);
  });

  it("keeps sub-1 residual at the bounded-unknown quality", () => {
    const result = evaluateV9ReserveExposures(
      missingReserveAsset({
        parentAssetId: "parent",
        parentBackingScore: 90,
        weight: 0.99,
        tier: "pure",
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBeCloseTo(90 * 0.99 + backing.boundedUnknownQuality * 0.01, 6);
  });

  it.each([
    { name: "threshold", weight: 0.99, verified: true },
    { name: "below threshold", weight: 0.989999, verified: false },
    { name: "curated", provenance: "curated" as const, verified: false },
    { name: "wrong parent", trackedAssetId: "other", verified: false },
    { name: "multiple or unknown exposures", invalidShape: true, verified: false },
  ])("requires verified single-parent live evidence: $name", ({ weight = 1, provenance = "live" as const, trackedAssetId = "parent", invalidShape, verified }) => {
    const parent = exposure({ key: "parent", weight, provenance, trackedAssetId, assetClass: "stablecoin" });
    const variants = invalidShape
      ? [[{ ...parent, weight: 0.99 }, exposure({ key: "other", weight: 0.01 })],
        [{ ...parent, status: { ...parent.status, observationState: "bounded-unknown" as const } }]]
      : [[parent]];
    for (const reserveExposures of variants) {
      const result = evaluateV9ReserveExposures({
        ...asset(reserveExposures),
        inheritedStablecoinBacking: {
          parentAssetId: "parent", parentBackingScore: 82, weight: 1, tier: "pure", failureDomains: [],
        },
      }, V9_CANDIDATE_POLICY_V1);
      expect(result.contributions.find((entry) => entry.componentKey === "reserve:inherited-backing:parent"))
        .toMatchObject({ score: 82, provenance: verified ? "live" : null, observationState: verified ? "known" : "bounded-unknown" });
      expect(result.unresolved).toEqual(verified ? [] : [
        expect.objectContaining({ code: "partial-reserve-review", treatment: "pillar" }),
      ]);
    }
  });

  it.each([34, 35, 35.001])("uses the bounded floor unless parent quality %s exceeds it", (parentBackingScore) => {
    const result = evaluateV9ReserveExposures(missingReserveAsset({
      parentAssetId: "parent",
      parentBackingScore,
      weight: 1,
      tier: "wrapped",
      failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
    }), V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBeCloseTo(Math.max(35, parentBackingScore), 6);
    if (parentBackingScore <= 35) {
      expect(result.contributions.map((entry) => entry.componentKey)).toEqual([
        "reserve:unclassified-residual", "reserve:concentration",
      ]);
      expect(result.unresolved).toContainEqual(expect.objectContaining({
        code: "missing-reserve-composition", pathKey: "reserve-envelope",
      }));
    } else {
      expect(result.contributions).toContainEqual(expect.objectContaining({
        componentKey: "reserve:inherited-backing:parent", score: 35.001,
      }));
      expect(result.unresolved).toContainEqual(expect.objectContaining({ code: "partial-reserve-review" }));
    }
  });
});

describe("v10.19 allocation-weighted Morpho lender Backing", () => {
  const parentBacking = 90.28629025;
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  type Claim = readonly [amount: string, quality: number, lltv: string, collateralClass: LenderCollateralClass];
  // Raw NAV-accounted claims from block 26191269, not rounded display percentages.
  const primeClaims: readonly Claim[] = [
    ["3129335529826", 85, "860000000000000000", "eth-lst"],
    ["2401512502632", 80, "860000000000000000", "eth-yield-or-restaked"],
    ["12834378526082", 85, "860000000000000000", "btc-wrapper"],
    ["7564078214138", 85, "860000000000000000", "btc-wrapper"],
    ["3026509767996", 85, "860000000000000000", "eth-lst"],
    ["539585442002", 95, "860000000000000000", "native-eth"],
    ["1", 80, "770000000000000000", "eth-yield-or-restaked"],
    ["292316170957", 85, "860000000000000000", "eth-lst"],
  ];
  const yieldClaims: readonly Claim[] = [
    ["55489558", 80, "770000000000000000", "eth-yield-or-restaked"],
    ["455553278361", 59.61669994438998, "860000000000000000", "yield-bearing-stable"],
    ["6198058117175", 52.5, "915000000000000000", "yield-bearing-stable"],
    ["900750407987", 35, "915000000000000000", "structured-credit"],
    ["1312328375771", 55, "915000000000000000", "yield-bearing-stable"],
    ["3387753291335", 64.53752, "915000000000000000", "structured-credit"],
    ["1000607668589", 55, "860000000000000000", "principal-token"],
  ];
  function book(
    claims: readonly Claim[],
    idle = "0",
    assetId = "kpkusdcprime-kpk",
    chain = "ethereum",
    kind: LenderDeploymentObservation["kind"] = "vault-v2",
  ): V1019LenderBookFact {
    const total = (BigInt(idle) + claims.reduce((sum, row) => sum + BigInt(row[0]), 0n)).toString();
    const markets = claims.map(([amount, , lltv], index) => ({
      account: address(2), adapter: address(2), morpho: address(3), marketId: word(index + 1),
      loanToken: address(4), collateralToken: address(index + 10), oracle: address(5), irm: address(6),
      lltvRaw: lltv, supplySharesRaw: amount, positionBorrowSharesRaw: "0", positionCollateralRaw: "0",
      marketSupplyAssetsRaw: amount, marketSupplySharesRaw: amount, marketBorrowAssetsRaw: amount,
      marketBorrowSharesRaw: amount, marketLastUpdateSec: 1791987287, marketFeeRaw: "0",
      includedAssetsRaw: amount, accruedMethod: "adapter-expected-supply-assets" as const,
      collateralMode: "collateralized" as const,
    }));
    return {
      status: knownStatus("lender-book:pin"),
      observation: {
        schemaVersion: 1, assetId, sourceGenerationId: "lender-book:fixture",
        acquiredAtSec: 1791987287, maxAgeSec: 28800, contentSha256: "a".repeat(64),
        status: "ok", censusScope: "complete-nav-accounted-current-book",
        deployments: [{
          chain, vault: address(1), kind,
          pin: { chain, number: 26191269, hash: word(7), timestampSec: 1791987287, finality: "finalized" },
          loanToken: address(4), loanDecimals: 6, totalAssetsRaw: total, totalSupplyRaw: total,
          idleAssetsRaw: idle, reconciledAssetsRaw: total, reconciliationResidualRaw: "0",
          codeHashes: { [address(1)]: word(8) }, selectorsRead: ["totalAssets"], markets,
        }],
      },
      collaterals: markets.map((market, index) => ({
        marketKey: lenderMarketKey(chain, market.morpho, market.marketId, market.account),
        collateralClass: claims[index]![3], trackedAssetId: null, quality: claims[index]![1],
        qualitySource: "authored-class", fallbackReason: null, acceptedPublicationGenerationId: null,
        sourceCause: null, sourceGapIds: [],
      })),
    };
  }
  function inherited(fact?: V1019LenderBookFact, parent = parentBacking): V9BackingAssetInput {
    return {
      ...asset([exposure({ key: "parent", weight: 1, assetClass: "stablecoin", trackedAssetId: "parent", provenance: "live" })]),
      assetId: fact?.observation?.assetId ?? "kpkusdcprime-kpk",
      inheritedStablecoinBacking: {
        parentAssetId: "parent", parentBackingScore: parent, weight: 1, tier: "wrapped",
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      },
      ...(fact === undefined ? {} : { lenderBook: fact }),
    };
  }
  function hybridYield(): V1019LenderBookFact {
    const fact = book(yieldClaims, "0", "kpkusdcyield-kpk");
    const ids: Record<number, string> = { 1: "ftusd-flying-tulip", 2: "savusd-avant", 5: "usd3-3jane" };
    fact.collaterals = fact.collaterals.map((row, index) => ids[index] === undefined ? row : ({
      ...row, trackedAssetId: ids[index]!, qualitySource: "previous-accepted-backing",
      acceptedPublicationGenerationId: "accepted:1791989210",
    }));
    return fact;
  }
  function arithmetic(fact: V1019LenderBookFact, parent = parentBacking) {
    const result = evaluateV1019LenderBook(fact, parent, V9_CANDIDATE_POLICY_V1);
    expect(result).not.toBeNull();
    return result!;
  }

  it.each([0, 35, 85, 100])("caps complete multi-slice reserves at both generic and book quality %s", quality => {
    const fact = book([["100", quality, "1000000000000000000", "other-unknown"]]);
    const base = inherited(fact);
    const input = { ...base, reserveExposures: [
      { ...base.reserveExposures[0]!, exposureKey: "deployed", assetClass: "protocol-position" as const, weight: .95 },
      { ...base.reserveExposures[0]!, exposureKey: "idle", weight: .05 },
    ] };
    const { inheritedStablecoinBacking: _inherited, ...oldInput } = input;
    const generic = evaluateV9ReserveExposures(oldInput, V9_CANDIDATE_POLICY_V1);
    const result = evaluateV9ReserveExposures(input, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBeCloseTo(Math.min(generic.score!, arithmetic(fact).reserveQuality), 8);
    expect(result.structuralReasons).toEqual(generic.structuralReasons);
    expect(result.unresolved).toEqual(generic.unresolved);
    expect(result.contributions.flatMap(row => row.factors ?? []).some(row => row.componentKey.includes(":lender-book:"))).toBe(true);
    expect(result.contributions.find(row => row.source === "reserve-exposure")!.observationState).toBe("known");
    fact.status = { ...fact.status, observationState: "missing" };
    expect(evaluateV9ReserveExposures(input, V9_CANDIDATE_POLICY_V1).score).toBe(generic.score);
  });

  it("requires every multi-slice holding to be exact, live, known and same-parent, without extending non-lenders", () => {
    const base = inherited(book(primeClaims));
    const input = { ...base, reserveExposures: [
      { ...base.reserveExposures[0]!, exposureKey: "deployed", weight: .95 },
      { ...base.reserveExposures[0]!, exposureKey: "idle", weight: .05 },
    ] };
    const parent = input.inheritedStablecoinBacking!;
    expect(verifiedLiveInheritedExposures(input, parent)).toBeUndefined();
    expect(verifiedLiveInheritedExposures(input, parent, true)).toHaveLength(2);
    for (const patch of [
      { trackedAssetId: "other-parent" }, { trackedAssetId: null }, { provenance: "curated" as const },
      { status: { ...knownStatus("unknown"), observationState: "bounded-unknown" as const } },
      { weight: .049 }, { weight: .051 },
    ]) {
      const invalid = { ...input, reserveExposures: [input.reserveExposures[0]!, { ...input.reserveExposures[1]!, ...patch }] };
      expect(verifiedLiveInheritedExposures(invalid, parent, true)).toBeUndefined();
      const { inheritedStablecoinBacking: _inherited, ...oldInput } = invalid;
      expect(evaluateV9ReserveExposures(invalid, V9_CANDIDATE_POLICY_V1))
        .toEqual(evaluateV9ReserveExposures(oldInput, V9_CANDIDATE_POLICY_V1));
    }
    expect(verifiedLiveInheritedExposures({
      ...input, reserveResiduals: [{ residualId: "unknown", weight: .001, status: knownStatus("residual") }],
    }, parent, true)).toBeUndefined();
    const withinTolerance = { ...input, reserveExposures: [
      input.reserveExposures[0]!, { ...input.reserveExposures[1]!, weight: .0500005 },
    ] };
    expect(verifiedLiveInheritedExposures(withinTolerance, parent, true)).toHaveLength(2);
    const nonLender = { ...input, assetId: "unadmitted-wrapper" };
    // A manually supplied legacy inheritance candidate still takes its old
    // bounded-witness path; the new book cannot admit a non-Morpho asset.
    expect(evaluateV9ReserveExposures(nonLender, V9_CANDIDATE_POLICY_V1).score).toBe(parentBacking);
  });

  it("reproduces the exact raw-weighted Prime counterfactual including one-raw-unit weETH", () => {
    const fact = book(primeClaims);
    const result = arithmetic(fact);
    expect(result.deploymentQualities[0]!.bookQuality).toBeCloseTo(88.7418377232, 8);
    expect(result.reserveQuality).toBeCloseTo(80.1217131799, 8);
    const backing = 33.5 + 0.4 * result.reserveQuality;
    expect(backing).toBeCloseTo(65.5486852720, 8);
    const mean = backing * 0.4 + 72 * 0.35 + 45 * 0.25;
    const final = 45 + 20 * Math.tanh((mean - 45) / 20);
    expect(final).toBeCloseTo(59.1631056365, 8);
    expect(Math.round(final)).toBe(59);
    const reserve = evaluateV9ReserveExposures(inherited(fact), V9_CANDIDATE_POLICY_V1);
    expect(reserve.score).toBeCloseTo(result.reserveQuality, 8);
    const factors = reserve.contributions[0]!.factors!;
    expect(factors).toHaveLength(9);
    expect(factors.find(row => row.componentKey.includes(fact.collaterals[6]!.marketKey))!.effectiveScoringWeight)
      .toBeGreaterThan(0);
  });

  it("reproduces hybrid Yield and keeps exact tracked Backing rather than intermediary iUSD", () => {
    const fact = hybridYield();
    const result = arithmetic(fact);
    expect(result.deploymentQualities[0]!.bookQuality).toBeCloseTo(62.8491909074, 8);
    expect(result.reserveQuality).toBeCloseTo(56.7442029224, 8);
    const backing = 33.5 + 0.4 * result.reserveQuality;
    expect(backing).toBeCloseTo(56.1976811690, 8);
    const mean = backing * 0.4 + 70.24 * 0.35 + 45 * 0.25;
    const final = 45 + 20 * Math.tanh((mean - 45) / 20);
    expect(final).toBeCloseTo(56.6422714607, 8);
    expect(Math.round(final)).toBe(57);
    expect(fact.collaterals[4]!.trackedAssetId).toBeNull();
    expect(fact.collaterals[6]!.trackedAssetId).toBeNull();
  });

  it("reproduces the separately labelled accepted-source fallback Yield scenario", () => {
    const fallback = book(yieldClaims.map((row, index): Claim =>
      [row[0], index === 1 || index === 2 ? 55 : index === 5 ? 35 : row[1], row[2], row[3]]),
    "0", "kpkusdcyield-kpk");
    const result = arithmetic(fallback);
    expect(result.deploymentQualities[0]!.bookQuality).toBeCloseTo(57.3901489066, 8);
    expect(result.reserveQuality).toBeCloseTo(51.8154364167, 8);
    const backing = 33.5 + 0.4 * result.reserveQuality;
    expect(backing).toBeCloseTo(54.2261745667, 8);
    const final = 45 + 20 * Math.tanh((backing * 0.4 + 70.24 * 0.35 + 45 * 0.25 - 45) / 20);
    expect(final).toBeCloseTo(56.1089263260, 8);
    expect(Math.round(final)).toBe(56);
  });

  it("preserves 20% idle parent inheritance and all-idle null book quality", () => {
    // Multiply claims by four and use their original sum as idle: exact 20% idle.
    const deployed = book(yieldClaims.map((row): Claim => [(BigInt(row[0]) * 4n).toString(), row[1], row[2], row[3]]),
      "13255106628776", "kpkusdcyield-kpk");
    expect(arithmetic(deployed).reserveQuality).toBeCloseTo(63.4526203879, 8);
    const allIdle = book([], "100");
    expect(arithmetic(allIdle)).toMatchObject({
      reserveQuality: parentBacking,
      deploymentQualities: [{ bookQuality: null, bookAdjusted: null, reserveQuality: parentBacking }],
    });
    const factors = evaluateV9ReserveExposures(inherited(allIdle), V9_CANDIDATE_POLICY_V1).contributions[0]!.factors!;
    expect(factors).toHaveLength(1);
    expect(factors[0]).toMatchObject({ score: parentBacking, normalizedWeight: 1, effectiveScoringWeight: 1 });
  });

  it("weights capped VaultV2 NAV against measured real assets without discarding its buffer", () => {
    const fact = book([["80", 35, "1000000000000000000", "structured-credit"]], "20");
    if (fact.observation?.status !== "ok") throw new Error("Expected measured fixture");
    const deployment = fact.observation.deployments[0]!;
    deployment.totalAssetsRaw = "90";
    deployment.realAssetsRaw = "100";
    deployment.undistributedAssetsRaw = "10";
    const factors = evaluateV9ReserveExposures(inherited(fact, 100), V9_CANDIDATE_POLICY_V1).contributions[0]!.factors!;
    expect(factors.map(row => row.effectiveScoringWeight)).toEqual([0.2, 0.8]);
    expect(factors.reduce((sum, row) => sum + row.effectiveScoringWeight, 0)).toBe(1);
    expect(arithmetic(fact, 100).reserveQuality).toBeCloseTo(48, 10);
    deployment.undistributedAssetsRaw = "9";
    expect(evaluateV1019LenderBook(fact, 100, V9_CANDIDATE_POLICY_V1)).toBeNull();
    deployment.undistributedAssetsRaw = "0";
    deployment.totalAssetsRaw = "101";
    expect(evaluateV1019LenderBook(fact, 100, V9_CANDIDATE_POLICY_V1)).toBeNull();
  });

  it.each([
    ["0", 100], ["860000000000000000", 66.718], ["1000000000000000000", 55],
  ])("uses LLTV squared at %s", (lltv, expected) => {
    expect(arithmetic(book([["100", 55, lltv, "yield-bearing-stable"]]), 100).reserveQuality)
      .toBeCloseTo(expected, 10);
  });

  it("uses full transmission for genuine unsecured lending, not zero-LLTV liquidation credit", () => {
    const fact = book([["100", 35, "0", "structured-credit"]]);
    if (fact.observation?.status !== "ok") throw new Error("fixture");
    fact.observation.deployments[0]!.markets[0]!.collateralMode = "unsecured";
    fact.observation.deployments[0]!.markets[0]!.collateralToken = address(0);
    expect(arithmetic(fact, 100).reserveQuality).toBe(35);
  });

  it("is monotone in collateral quality and inverse-monotone in LLTV, with no parent uplift", () => {
    for (const parent of [0, 1, 20, 35, 90, 100]) {
      let previous = -1;
      for (const quality of [0, 35, 55, 85, 100]) {
        const result = arithmetic(book([["100", quality, "860000000000000000", "other-unknown"]]), parent);
        expect(result.reserveQuality).toBeGreaterThanOrEqual(previous);
        expect(result.reserveQuality).toBeLessThanOrEqual(parent);
        previous = result.reserveQuality;
      }
      previous = 101;
      for (const lltv of ["0", "770000000000000000", "860000000000000000", "915000000000000000", "1000000000000000000"]) {
        const result = arithmetic(book([["100", 35, lltv, "other-unknown"]]), parent);
        expect(result.reserveQuality).toBeLessThanOrEqual(previous);
        previous = result.reserveQuality;
      }
    }
  });

  it.each([0, 35, 90])("retains admitted inherited quality below35 for parent %s", (parent) => {
    const fact = book([["100", 35, "1000000000000000000", "other-unknown"]]);
    const result = evaluateV9ReserveExposures(inherited(fact, parent), V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBeCloseTo(parent * 0.35, 10);
    expect(result.contributions.map(row => row.componentKey)).toEqual([
      "reserve:inherited-backing:parent", "reserve:concentration",
    ]);
  });

  it("weights every claim in Backing even below the independent 1% oracle threshold", () => {
    const fact = book([
      ["999", 100, "1000000000000000000", "native-eth"],
      ["1", 35, "1000000000000000000", "other-unknown"],
    ]);
    expect(arithmetic(fact, 100).reserveQuality).toBeCloseTo(99.935, 12);
  });

  it.each(["missing", "stale", "unsupported"] as const)("retains old inheritance for %s books", (observationState) => {
    const fact = book(primeClaims);
    fact.status = { ...fact.status, observationState, gapIds: ["lender-book:unavailable"] };
    const result = evaluateV9ReserveExposures(inherited(fact), V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(evaluateV9ReserveExposures(inherited(), V9_CANDIDATE_POLICY_V1).score);
    expect(evaluateV1019LenderBook(fact, parentBacking, V9_CANDIDATE_POLICY_V1)).toBeNull();
  });

  it("discloses legacy U with no measured credit and never fabricates attempted-producer A proof", () => {
    const gap = factorGap("lender-book", "U");
    const fact: V1019LenderBookFact = {
      status: { ...knownStatus("legacy:lender-book"), observationState: "missing", gapIds: [gap.gapId] },
      observation: null, collaterals: [],
    };
    const result = evaluateV9ReserveExposures({ ...inherited(fact), gaps: [gap] }, V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(evaluateV9ReserveExposures(inherited(), V9_CANDIDATE_POLICY_V1).score);
    const diagnostic = result.contributions[0]!.factors!.find(row => row.componentKey.endsWith(":unavailable"))!;
    expect(diagnostic).toMatchObject({ cause: "U", score: null, effectiveScoringWeight: 0, scoringDisposition: "not-applicable" });
    expect(V9CauseContributionSchema.safeParse({
      score: diagnostic.score, cause: diagnostic.cause, causeGapIds: diagnostic.causeGapIds,
      effectiveScoringWeight: diagnostic.effectiveScoringWeight, scoringDisposition: diagnostic.scoringDisposition,
    }).success).toBe(true);
  });

  it("keeps unavailable inheritance unchanged with diagnostic zero-weight book factors", () => {
    const gap = factorGap("lender-book", "A");
    const fact: V1019LenderBookFact = {
      status: { ...knownStatus("lender-book:attempt"), observationState: "missing", gapIds: [gap.gapId] },
      observation: null, collaterals: [],
    };
    const input = { ...inherited(fact), gaps: [gap] };
    const result = evaluateV9ReserveExposures(input, V9_CANDIDATE_POLICY_V1);
    const old = evaluateV9ReserveExposures(inherited(), V9_CANDIDATE_POLICY_V1);
    expect(result.score).toBe(old.score);
    expect(evaluateV1019LenderBook(fact, parentBacking, V9_CANDIDATE_POLICY_V1)).toBeNull();
    expect(result.contributions[0]!.factors).toContainEqual(expect.objectContaining({
      componentKey: "reserve:inherited-backing:parent:lender-book:unavailable", score: null,
      effectiveScoringWeight: 0, cause: "A", scoringDisposition: "excluded-pipeline",
    }));
  });

  it("selects the worst of three nonfungible deployments and refuses a missing required deployment", () => {
    const facts = [
      book([["100", 85, "860000000000000000", "btc-wrapper"]], "0", "gtusdcp-gauntlet"),
      book([["100", 55, "860000000000000000", "principal-token"]], "0", "gtusdcp-gauntlet", "base", "metamorpho-v1"),
      book([["100", 35, "915000000000000000", "structured-credit"]], "0", "gtusdcp-gauntlet", "arbitrum", "metamorpho-v1.1"),
    ];
    const fact = facts[0]!;
    if (fact.observation?.status !== "ok") throw new Error("fixture");
    fact.observation.deployments = facts.flatMap(row => row.observation?.status === "ok" ? row.observation.deployments : []);
    fact.collaterals = facts.flatMap(row => row.collaterals);
    const result = arithmetic(fact);
    expect(result.deploymentQualities).toHaveLength(3);
    expect(result.reserveQuality).toBeCloseTo(parentBacking * 0.45580375, 10);
    const factors = evaluateV9ReserveExposures(inherited(fact), V9_CANDIDATE_POLICY_V1).contributions[0]!.factors!;
    expect(factors.every(row => row.componentKey.includes("arbitrum:"))).toBe(true);
    fact.observation.deployments.pop();
    expect(evaluateV1019LenderBook(fact, parentBacking, V9_CANDIDATE_POLICY_V1)).toBeNull();
  });

  it("preserves parent causes, upstream identity, concentration normalization and exact factor sums", () => {
    const fact = hybridYield();
    const source = fact.collaterals[2]!;
    fact.collaterals[2] = { ...source, sourceCause: "U", sourceGapIds: ["accepted:savusd:gap"] };
    const input = inherited(fact);
    const result = evaluateV9ReserveExposures({
      ...input,
      inheritedStablecoinBacking: { ...input.inheritedStablecoinBacking!, cause: "D", causeGapIds: ["parent:adverse"] },
    }, V9_CANDIDATE_POLICY_V1);
    expect(result.structuralReasons).toEqual([]);
    const concentration = result.contributions.find(row => row.source === "reserve-concentration")!;
    expect(concentration.normalizedWeight).toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve.concentrationWeight);
    for (const row of result.contributions) {
      expect(row).toMatchObject({ cause: "D", scoringDisposition: "measured-adverse" });
      expect(row.causeGapIds).toEqual(["accepted:savusd:gap", "parent:adverse"]);
      expect(row.factors!.reduce((sum, factor) => sum + factor.effectiveScoringWeight, 0)).toBeCloseTo(1, 12);
      expect(row.factors!.reduce((sum, factor) => sum + (factor.score ?? 0) * factor.effectiveScoringWeight, 0))
        .toBeCloseTo(row.score!, 8);
    }
    expect(result.contributions.filter(row => row.upstreamAssetId !== null).map(row => row.upstreamAssetId)).toEqual(["parent"]);
    expect(input.resolvedUpstreamExposures).toEqual([]);
  });

  it("retains byte-equivalent non-cohort behavior without creating collateral dependencies", () => {
    const nonLender = { ...inherited(), assetId: "ordinary-wrapper" };
    const before = JSON.stringify(nonLender);
    const first = evaluateV9ReserveExposures(nonLender, V9_CANDIDATE_POLICY_V1);
    expect(JSON.stringify(evaluateV9ReserveExposures({ ...nonLender }, V9_CANDIDATE_POLICY_V1))).toBe(JSON.stringify(first));
    expect(JSON.stringify(nonLender)).toBe(before);
    const notAdmitted = book(primeClaims, "0", "ordinary-wrapper");
    expect(evaluateV1019LenderBook(notAdmitted, parentBacking, V9_CANDIDATE_POLICY_V1)).toBeNull();
  });

  it.each(["zero-nav", "unreconciled", "malformed", "invalid-quality", "invalid-lltv", "unjoined"] as const)
    ("returns unavailable rather than clamping or omitting %s", (reason) => {
      const fact = book([["100", 55, "860000000000000000", "yield-bearing-stable"]]);
      if (fact.observation?.status !== "ok") throw new Error("fixture");
      const deployment = fact.observation.deployments[0]!;
      if (reason === "zero-nav") deployment.totalAssetsRaw = "0";
      if (reason === "unreconciled") deployment.idleAssetsRaw = "1";
      if (reason === "malformed") deployment.markets[0]!.includedAssetsRaw = "-1";
      if (reason === "invalid-quality") fact.collaterals[0]!.quality = Number.NaN;
      if (reason === "invalid-lltv") deployment.markets[0]!.lltvRaw = "1000000000000000001";
      if (reason === "unjoined") fact.collaterals = [];
      expect(evaluateV1019LenderBook(fact, parentBacking, V9_CANDIDATE_POLICY_V1)).toBeNull();
    });
});
