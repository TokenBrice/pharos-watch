import { describe, expect, it, vi } from "vitest";
import { evaluateV9ReserveExposures } from "../safety-score-v9/backing";
import {
  createUnavailableV9BackingResult,
  evaluateV9ArchetypeBacking,
} from "../safety-score-v9/archetypes/evaluation";
import {
  assertV9BackingPolicy,
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
    expect(result.contributions.find(entry => entry.componentKey === "reserve:gold")).toMatchObject({
      score: 40, wholeAssetWeight: 1, effectiveScoringWeight: 1, cause, causeGapIds: ["gap:liquidity", "gap:maturity"],
    });
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
      evidenceLevel: "strong" as const, reasonCodes: [], failureDomains: [], traceDigest: "parent", cause: null, causeGapIds: [] };
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
  it("validates the explicit candidate policy", () => {
    expect(() => assertV9BackingPolicy(V9_CANDIDATE_POLICY_V1)).not.toThrow();
    expect(V9_CANDIDATE_POLICY_V1.semanticDigest).toMatch(/^[a-f0-9]{64}$/);
  });

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

  it("bounds missing serial components at their ordinary minimum", () => {
    const { gap, fact: missingClaim } = missingMechanism(
      "claim-and-segregation", "gap:serial-claim", "fiat.claim.required", "The direct reserve claim is unresolved.",
    );
    const strongFact = (key: string) => ({
      status: knownStatus(`mechanism:${key}`),
      quality: "strong" as const,
      failureDomains: [],
    });
    const result = evaluateV9ArchetypeBacking(
      {
        archetype: "fiat-cash",
        asset: asset([exposure({ key: "cash", weight: 1 })], [gap]),
        components: [
          { componentKey: "claim-and-segregation", fact: missingClaim },
          { componentKey: "custody-continuity", fact: strongFact("custody") },
          { componentKey: "assurance-and-reconciliation", fact: strongFact("assurance") },
        ],
      },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result).toMatchObject({ rateability: "rateable", pillarCeiling: null });
    expect(result.unresolved).toContainEqual(expect.objectContaining({ code: "critical-unresolved", treatment: "pillar" }));
    expect(result.contributions.find(row => row.componentKey === "mechanism:claim-and-segregation")!.score).toBe(35);
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

  it("does not apply a second backing discount to a staked/vault layer", () => {
    const result = evaluateV9ReserveExposures(
      missingReserveAsset({
        parentAssetId: "parent",
        parentBackingScore: 75,
        weight: 1,
        tier: "wrapped",
        failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(result.score).toBeCloseTo(75, 6);
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
