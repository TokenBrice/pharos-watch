import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { MintAuthorityProfile } from "@shared/types/core";
import { MintAuthorityProfileSchema } from "@shared/types/stablecoin-meta-schemas";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput, normalizeFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9-fact-set";

const AS_OF_SEC = 1_783_944_000;
const OBSERVED_AT_SEC = AS_OF_SEC - 100;
const ASSET_ID = "authoring-example";

/**
 * AUTHORING-CONTRACT REFERENCE — copy this field shape verbatim.
 *
 * Reviewed economic-control facts the Safety Score v9 engine consumes, authored
 * on a coin's `mintAuthority` profile in `shared/data/stablecoins/coins/*.json`.
 * The three fields are optional; when absent the engine keeps its inferred /
 * encoding behavior (fail-closed inertness). Evidence lives in the profile's
 * existing `review.sources` (and each control's `sources`) — the reviewed fields
 * do not carry their own citations.
 *
 *   economicCapSemantics: supersedes the contract-encoding cap. A self-controlled
 *     no-timelock raiseable cap is economically "unbounded"; an independent
 *     timelock / third-party bound may earn "raiseable"; a firm cap is "bounded".
 *     Never edit directMintAbility to express this — economic semantics only.
 *   reconciliation:        supply-vs-reserve attestation cadence ("continuous" |
 *     "periodic"); supersedes the engine's proof-of-reserves inference.
 *   supervision:           prudential-supervision regime ("prudential" for a named
 *     financial regulator per registry evidence, else "attestation-only" | "none").
 */
export const AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE: MintAuthorityProfile = {
  mintPath: "offchain-attested-minter",
  authorityPosture: "concentrated-admin",
  confidence: "verified",
  summary:
    "Issuer-operated mint with a self-controlled raise-authority cap, periodic reserve attestation, and a prudential supervisor.",
  controls: [
    {
      label: "Issuer mint controller",
      role: "minter-admin",
      authorityType: "issuer-backend",
      directMintAbility: "can-authorize",
      canRaiseCap: true,
      chain: "ethereum",
      address: "0x1111111111111111111111111111111111111111",
      sources: [{ label: "Issuer minter documentation", url: "https://example.com/mint-controller" }],
      evidence: "Issuer backend can authorize new minters and raise the mint cap without an independent timelock.",
    },
  ],
  economicCapSemantics: "unbounded",
  reconciliation: "periodic",
  supervision: "prudential",
  review: {
    reviewer: "@example-reviewer",
    reviewedAt: "2026-07-10",
    evidence: "Regulator registry entry and monthly attestation reviewed against the reserve report on 2026-07-10.",
    disposition: "scoreable",
    sources: [
      { label: "Prudential regulator registry", url: "https://example.com/regulator-registry" },
      { label: "Monthly reserve attestation", url: "https://example.com/attestation" },
    ],
  },
};

function fixedInput() {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [ASSET_ID],
    capturedAt: "2026-07-13T00:00:00.000Z",
    sourceGeneration: `report-cards:fixture:${ASSET_ID}`,
    dexGenerationId: `dex-liquidity-${OBSERVED_AT_SEC}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: AS_OF_SEC,
    updatedAt: AS_OF_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: OBSERVED_AT_SEC, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {
      [ASSET_ID]: {
        id: ASSET_ID,
        symbol: "EXMPL",
        name: "Authoring Example",
        pegType: "peggedUSD",
        pegCurrency: "USD",
        governance: "centralized",
        currentDeviationBps: 1,
        pegScore: 99,
        priceSource: "fixture-price",
        priceObservedAt: OBSERVED_AT_SEC,
        pegPct: 99,
        severityScore: 0,
        spreadPenalty: 0,
        eventCount: 0,
        worstDeviationBps: 1,
        activeDepeg: false,
        lastEventAt: null,
        trackingSpanDays: 365,
        methodologyVersion: "peg:fixture-v1",
      },
    },
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      [ASSET_ID]: {
        liquidityScore: 12,
        concentrationHhi: 0.5,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: 1_000_000,
        balanceMeasuredTvlUsd: 1_000_000,
        organicMeasuredTvlUsd: 1_000_000,
        exitRouteObservations: [],
        methodologyVersion: "dex:fixture-v1",
        updatedAt: OBSERVED_AT_SEC,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { [ASSET_ID]: false },
    liveReserveMap: {
      [ASSET_ID]: [
        {
          name: "Custodied cash",
          pct: 100,
          risk: "very-low",
          assetClass: "cash",
          issuerOrObligor: "issuer:example",
          riskFactors: ["custody", "counterparty"],
          liquidityHorizon: "immediate",
          maturityDaysMax: 0,
        },
      ],
    },
    liveReserveProvenanceMap: {
      [ASSET_ID]: { source: "fixture-reserve-api", fetchedAt: OBSERVED_AT_SEC },
    },
    chainCirculatingById: {
      [ASSET_ID]: {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function metaWith(profile: MintAuthorityProfile | undefined) {
  return new Map([[ASSET_ID, { id: ASSET_ID, mechanismArchetype: "fiat-cash" as const, mintAuthority: profile }]]);
}

function mintReviewFor(profile: MintAuthorityProfile | undefined) {
  const extension = buildSafetyScoreV9BaselineExtension(fixedInput(), { metaById: metaWith(profile) });
  const asset = extension.assets[0]!;
  const review = asset.economicControlReview!.mint;
  const controlReview = asset.controlReview;
  const controls = controlReview && "controls" in controlReview ? controlReview.controls : [];
  const mintControl = controls.find((control) => control.controlKey === review.controlKey) ?? null;
  return { review, mintControl };
}

describe("Safety Score v9 mint authoring contract (authoring-contract batch, owner rulings Batch 3)", () => {
  it("accepts the reference profile shape against the strict MintAuthorityProfile schema", () => {
    expect(() => MintAuthorityProfileSchema.parse(AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE)).not.toThrow();
  });

  it("lets reviewed fields supersede the inferred / encoding behavior", () => {
    const { review, mintControl } = mintReviewFor(AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE);
    expect(review.supervision).toBe("prudential");
    // Inferred reconciliation would be "unknown" (issuer-backend, no proof-of-reserves);
    // the reviewed "periodic" wins.
    expect(review.reconciliation).toBe("periodic");
    // Encoding-derived capSemantics would be "raiseable" (can-authorize + canRaiseCap);
    // the reviewed economicCapSemantics "unbounded" supersedes it.
    expect(mintControl?.capSemantics.kind).toBe("unbounded");
  });

  it("stays byte-identical to today when the reviewed fields are absent (fail-closed inertness)", () => {
    const { economicCapSemantics, reconciliation, supervision, ...withoutReviewedFields } =
      AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE;
    void economicCapSemantics;
    void reconciliation;
    void supervision;
    const { review, mintControl } = mintReviewFor(withoutReviewedFields);
    expect(review.supervision).toBe("unknown");
    expect(review.reconciliation).toBe("unknown");
    expect(mintControl?.capSemantics.kind).toBe("raiseable");
  });

  it("applies R3 to a prudential reconciled mint without a centralized-mint cap", () => {
    const input = fixedInput();
    const extension = buildSafetyScoreV9BaselineExtension(input, {
      metaById: metaWith(AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE),
    });
    const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(input), extension);
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
    const asset = evaluated.assets.find((candidate) => candidate.assetId === ASSET_ID)!;

    const mintComponent = asset.control.components.find((component) => component.kind === "mint");
    expect(mintComponent).toMatchObject({ posture: "unbounded-reconciled", score: 80 });
    expect(asset.control.structuralFailures).not.toContainEqual(expect.objectContaining({ kind: "centralized-mint" }));
  });

  it("compiles LUSD's reviewed immutable mint logic without an unresolved mint-authority reason", () => {
    const lusd = ACTIVE_META_BY_ID.get("lusd-liquity");
    if (!lusd?.mintAuthority) throw new Error("expected the LUSD mint-authority review");
    expect(lusd.mintAuthority.upgradeability).toMatchObject({
      model: "immutable",
      canChangeMintLogic: false,
    });

    // The authoring fixture clock predates the registry review. Rebind only
    // its observation dates so this test isolates compilation semantics.
    const mintAuthority = structuredClone(lusd.mintAuthority);
    mintAuthority.review.reviewedAt = "1970-01-01";
    if (mintAuthority.upgradeability) mintAuthority.upgradeability.observedAt = "1970-01-01";
    const input = fixedInput();
    const extension = buildSafetyScoreV9BaselineExtension(input, {
      metaById: new Map([
        [
          ASSET_ID,
          {
            id: ASSET_ID,
            mechanismArchetype: "cdp" as const,
            mintAuthority,
          },
        ],
      ]),
    });
    const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(input), extension);
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;

    expect(extension.assets[0]!.economicControlReview?.mint).toMatchObject({
      status: { observationState: "known" },
      controlKey: null,
      reconciliation: "not-applicable",
      upgrade: { state: "immutable", controlKey: null },
    });
    expect(compiled.assets[0]!.controlStatus.observationState).toBe("known");
    expect(evaluated.control.reasons.map((reason) => reason.code)).not.toContain("unresolved-mint-authority");
  });
});
