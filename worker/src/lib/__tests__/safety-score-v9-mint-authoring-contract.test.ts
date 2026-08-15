import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { MintAuthorityProfile } from "@shared/types/core";
import { MintAuthorityProfileSchema } from "@shared/types/stablecoin-meta-schemas";
import { describe, expect, it } from "vitest";
import { createReportCardsFixedInput, normalizeFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9-fact-set";

const AS_OF_SEC = 1_785_456_000;
const REGISTRY_FIXTURE_CAPTURED_AT = "2026-08-15T00:00:00.000Z";
const REGISTRY_FIXTURE_CLOCK_SEC = Date.parse(REGISTRY_FIXTURE_CAPTURED_AT) / 1_000;
const ASSET_ID = "authoring-example";
const REVIEWED_INHERITED_WRAPPERS = [
  { assetId: "stusds-sky", parentId: "usds-sky" },
  { assetId: "sgho-aave", parentId: "gho-aave" },
  { assetId: "said-gaib", parentId: "aid-gaib" },
  { assetId: "eearn-ember", parentId: "usdc-circle" },
] as const;
const UNRESOLVED_INHERITED_WRAPPER = {
  assetId: "syzusd-yuzu",
  parentId: "yzusd-yuzu",
} as const;

/**
 * AUTHORING-CONTRACT REFERENCE — an explicit *unresolved* inherited mint path.
 *
 * A wrapper whose reviewer records the parent's permissioned issuer mint as a
 * local control, without establishing a reconciliation cadence for it. The V9
 * mint selector must prefer this control over the wrapper's zero-capability
 * share-accounting control, and grading must raise `mint-control-question`
 * (`shared/lib/safety-score-v9/control.ts:801-808`: claim-affecting control +
 * `issuer-backend` authority + unresolved reconciliation).
 *
 * Authored here rather than borrowed from a coin file on purpose. This shape is
 * transcribed from the control `syzusd-yuzu` carried until `d4efe6c59`, which
 * removed it as a duplicate of the exact yzUSD dependency edge — the second time
 * curation moved this test's anchor. No active coin reproduces the shape today
 * (scan of all 404 registry entries, 2026-08-08: 30 wrappers pair share
 * accounting with a mint-capable control, none of them unresolved), so pinning
 * the invariant to authored facts is what keeps it exercised at all.
 */
const UNRESOLVED_INHERITED_MINT_CONTROL = {
  label: "Inherited parent permissioned mint authority",
  role: "direct-minter",
  authorityType: "issuer-backend",
  directMintAbility: "direct",
  canRaiseCap: "unknown",
  evidence:
    "Underlying parent primary mint/redeem is gated to KYC'ed eligible investors 1:1 with the reserve asset, with collateral managed in an MPC workspace. The wrapper inherits this concentrated-admin posture from the parent, and no reconciliation cadence is established for it.",
} as const satisfies NonNullable<MintAuthorityProfile["controls"]>[number];

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

function fixedInput(
  activeAssetIds: readonly string[] = [ASSET_ID],
  supplyUsdById: Readonly<Record<string, number>> = {},
  options: { clockSec?: number; capturedAt?: string } = {},
) {
  const clockSec = options.clockSec ?? AS_OF_SEC;
  const observedAtSec = clockSec - 100;
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [...activeAssetIds],
    capturedAt: options.capturedAt ?? "2026-07-13T00:00:00.000Z",
    sourceGeneration: `report-cards:fixture:${ASSET_ID}`,
    dexGenerationId: `dex-liquidity-${observedAtSec}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: clockSec,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: observedAtSec, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: Object.fromEntries(
      activeAssetIds.map((assetId) => [
        assetId,
        {
          id: assetId,
          symbol: "EXMPL",
          name: "Authoring Example",
          pegType: "peggedUSD",
          pegCurrency: "USD",
          governance: "centralized",
          currentDeviationBps: 1,
          pegScore: 99,
          priceSource: "fixture-price",
          priceObservedAt: observedAtSec,
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
      ]),
    ),
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(
      activeAssetIds.map((assetId) => [
        assetId,
        {
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
          updatedAt: observedAtSec,
        },
      ]),
    ),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(activeAssetIds.map((assetId) => [assetId, false])),
    liveReserveMap: Object.fromEntries(
      activeAssetIds.map((assetId) => [
        assetId,
        [
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
      ]),
    ),
    liveReserveProvenanceMap: Object.fromEntries(
      activeAssetIds.map((assetId) => [
        assetId,
        { source: "fixture-reserve-api", fetchedAt: observedAtSec },
      ]),
    ),
    chainCirculatingById: Object.fromEntries(
      activeAssetIds.map((assetId) => [
        assetId,
        {
          ethereum: {
            current: supplyUsdById[assetId] ?? 10_000_000,
            circulatingPrevDay: supplyUsdById[assetId] ?? 10_000_000,
            circulatingPrevWeek: supplyUsdById[assetId] ?? 10_000_000,
            circulatingPrevMonth: supplyUsdById[assetId] ?? 10_000_000,
          },
        },
      ]),
    ),
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

  // Premise rewritten, not re-valued: the 2026-08-08 C-wave review resolved both
  // questions this test used to hold open (the RecoveryModeTriggerModule
  // representation and the scoped historical mint-incident review), so DUSD's
  // profile is now `confidence: "probable"` / `disposition: "scoreable"` and the
  // compiled control facts are `known` with no gap IDs. The invariant worth
  // guarding moved with it: the curated five-control array must compile to the
  // same five keys, and the recovery module must stay represented as a narrow
  // bypass surface on the governance control rather than as a mint-capable one —
  // which the review evidence states explicitly ("adding it as an economically
  // mint-capable control would overstate its scope").
  it("compiles DUSD's resolved control review with the recovery module as a bypass surface, not a mint path", () => {
    const assetId = "dusd-dialectic";
    const activeAssetIds = [assetId, "usdc-circle"];
    const metaById = new Map(
      activeAssetIds.map((id) => {
        const meta = ACTIVE_META_BY_ID.get(id);
        if (!meta) throw new Error(`expected registry metadata for ${id}`);
        return [id, meta] as const;
      }),
    );
    const profile = metaById.get(assetId)!.mintAuthority!;
    // Clock kept ahead of the usdc-circle parent's 2026-08-08 mint-authority
    // review, which the scoring-clock guard would otherwise reject as future.
    const input = fixedInput(activeAssetIds, {}, {
      clockSec: REGISTRY_FIXTURE_CLOCK_SEC,
      capturedAt: REGISTRY_FIXTURE_CAPTURED_AT,
    });
    const extension = buildSafetyScoreV9BaselineExtension(input, { metaById });
    const asset = extension.assets.find((candidate) => candidate.assetId === assetId)!;
    const controlReview = asset.controlReview;
    if (!controlReview || !("controls" in controlReview)) {
      throw new Error("expected DUSD's reviewed controls");
    }
    const mintControls = controlReview.controls.filter((control) =>
      control.controlKey.startsWith(`mint-meta:${assetId}:`),
    );
    const expectedControlKeys = [
      "mint-meta:dusd-dialectic:0:0753a29722c02f5eb3f2",
      "mint-meta:dusd-dialectic:1:53c5cf56b4e8d9e0facf",
      "mint-meta:dusd-dialectic:2:8a504a683206276bfc65",
      "mint-meta:dusd-dialectic:3:1e5d1009d534d5ffa1b9",
      "mint-meta:dusd-dialectic:4:307f52514a8019019079",
    ];

    expect(profile).toMatchObject({
      confidence: "probable",
      upgradeability: {
        controlRef: "Makina DAO - 3-of-5 Safe (ADMIN_ROLE 0)",
      },
      review: {
        disposition: "scoreable",
        evidence: expect.stringContaining("RecoveryModeTriggerModule"),
      },
    });
    expect(profile.review.unresolvedQuestions).toBeUndefined();
    expect(profile.controls?.[3]).toMatchObject({
      label: "Makina DAO - 3-of-5 Safe (ADMIN_ROLE 0)",
      timelockDelaySec: 172800,
      evidence: expect.stringContaining("ADMIN_ROLE 0"),
    });
    expect(profile.controls?.[4]).toMatchObject({
      timelockDelaySec: 0,
      failureDomainKeys: [
        "eoa:ethereum:0xaa1e36165b3ac105f25549c06e1f06d573a40be3",
        "module:ethereum:0xeec7919bab68876e14737970fe4965ab9737cd29",
        "safe:ethereum:0x89faa3b02ef5ab185b8ace489af62748acb50afc",
      ],
      bypassSurfaces: [expect.stringContaining("only to request setRecoveryMode(true)")],
    });
    expect(controlReview.state).toBe("reviewed-controls");
    expect(mintControls.map((control) => control.controlKey)).toEqual(expectedControlKeys);
    // The scoped historical review establishes incident absence positively, so no
    // control is left at the fail-closed "unknown" incident state.
    expect(mintControls.map((control) => control.incidentState)).toEqual(
      Array.from({ length: expectedControlKeys.length }, () => "none"),
    );
    expect(asset.economicControlReview?.mint.status.observationState).toBe("known");
    // Mint selection lands on the fee-share dilution control (index 1) and the
    // upgrade path on the DAO proxy admin (index 3); the Security Council's
    // recovery-module control (index 4) carries only parameter-change capability.
    expect(asset.economicControlReview?.mint.controlKey).toBe(expectedControlKeys[1]);
    expect(asset.economicControlReview?.mint.upgrade).toMatchObject({
      state: "reviewed",
      controlKey: expectedControlKeys[3],
    });
    const councilControl = mintControls.find((control) => control.controlKey === expectedControlKeys[4])!;
    expect(councilControl.capabilities).toEqual(["parameter-change"]);
    expect(councilControl.capabilities).not.toContain("mint");

    const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(input), extension);
    const compiledAsset = compiled.assets.find((candidate) => candidate.assetId === assetId)!;
    const compiledMintControls = compiledAsset.controls.filter((control) =>
      control.controlKey.startsWith(`mint-meta:${assetId}:`),
    );
    expect(compiledAsset.controlStatus).toMatchObject({
      observationState: "known",
      gapIds: [],
    });
    expect(compiledMintControls.map((control) => control.status)).toEqual(
      expectedControlKeys.map(() =>
        expect.objectContaining({
          observationState: "known",
          gapIds: [],
        }),
      ),
    );
  });

  it.each(["lusd-liquity", "bold-liquity"])(
    "compiles %s's reviewed immutable mint logic and governance posture",
    (stablecoinId) => {
      const meta = ACTIVE_META_BY_ID.get(stablecoinId);
      if (!meta?.mintAuthority) throw new Error(`expected the ${stablecoinId} mint-authority review`);
      expect(meta.mintAuthority.upgradeability).toMatchObject({
        model: "immutable",
        canChangeMintLogic: false,
      });

      // Rebind the registry observation dates to the fixture clock so this test
      // isolates compilation semantics from review freshness.
      const mintAuthority = structuredClone(meta.mintAuthority);
      const fixtureReviewDate = new Date(AS_OF_SEC * 1_000).toISOString().slice(0, 10);
      mintAuthority.review.reviewedAt = fixtureReviewDate;
      if (mintAuthority.upgradeability) mintAuthority.upgradeability.observedAt = fixtureReviewDate;
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
      expect(evaluated.access.governance).toBe("immutable");
    },
  );

  it("binds reviewed inherited wrappers to local share accounting without dropping parent or upgrade controls", () => {
    const relationships = [...REVIEWED_INHERITED_WRAPPERS, UNRESOLVED_INHERITED_WRAPPER];
    const activeAssetIds = [
      ...new Set(relationships.flatMap(({ assetId, parentId }) => [assetId, parentId])),
    ];
    const metaById = new Map(
      activeAssetIds.map((assetId) => {
        const meta = ACTIVE_META_BY_ID.get(assetId);
        if (!meta) throw new Error(`expected registry metadata for ${assetId}`);
        return [assetId, meta] as const;
      }),
    );
    const input = fixedInput(activeAssetIds, {}, {
      clockSec: REGISTRY_FIXTURE_CLOCK_SEC,
      capturedAt: REGISTRY_FIXTURE_CAPTURED_AT,
    });
    const extension = buildSafetyScoreV9BaselineExtension(input, { metaById });
    const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(input), extension);
    const evaluatedById = new Map(
      evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets.map((asset) => [asset.assetId, asset]),
    );

    for (const { assetId, parentId } of REVIEWED_INHERITED_WRAPPERS) {
      const profile = metaById.get(assetId)!.mintAuthority!;
      const asset = extension.assets.find((candidate) => candidate.assetId === assetId)!;
      const controlReview = asset.controlReview;
      if (!controlReview || !("controls" in controlReview)) {
        throw new Error(`expected reviewed controls for ${assetId}`);
      }
      const shareControl = controlReview.controls.find(
        (control) =>
          control.controlKind === "mint" &&
          control.capabilities.length === 0 &&
          control.claimImpairment === "none" &&
          control.economicLossScope === "access-only",
      );
      const localMintControls = controlReview.controls.filter((control) =>
        control.controlKey.startsWith(`mint-meta:${assetId}:`),
      );
      const upgradeControls = localMintControls.filter((control) =>
        control.capabilities.includes("upgrade"),
      );
      const expectedUpgradeCount = (profile.controls ?? []).filter(
        (control) => control.directMintAbility === "upgrade-only",
      ).length;

      expect(asset.dependencies?.edges).toContainEqual(
        expect.objectContaining({
          dependencyType: "wrapper",
          economicRole: "serial-claim",
          upstreamAssetId: parentId,
          weight: 1,
          failureDomains: [{ kind: "mint-control", key: `asset:${parentId}` }],
        }),
      );
      expect(shareControl).toBeDefined();
      expect(asset.economicControlReview?.mint).toMatchObject({
        status: { observationState: "known" },
        controlKey: shareControl!.controlKey,
        reconciliation: "not-applicable",
        upgrade: { state: "reviewed" },
      });
      expect(upgradeControls).toHaveLength(expectedUpgradeCount);
      expect(upgradeControls).not.toHaveLength(0);
      expect(localMintControls).toHaveLength(profile.controls?.length ?? 0);
      const selectedUpgradeControlKey = asset.economicControlReview!.mint.upgrade.controlKey!;
      expect(
        evaluatedById.get(assetId)!.control.components.find((component) => component.kind === "mint"),
      ).toMatchObject({
        posture: "none-resolved",
        controlKeys: expect.arrayContaining([shareControl!.controlKey, selectedUpgradeControlKey]),
      });
      expect(evaluatedById.get(assetId)!.control.reasons.map((reason) => reason.code)).not.toContain(
        "missing-mint-authority",
      );
    }
  });

  it("keeps syzUSD supply local while attributing one serial claim to yzUSD", () => {
    const { assetId, parentId } = UNRESOLVED_INHERITED_WRAPPER;
    const activeAssetIds = [assetId, parentId];
    const metaById = new Map(
      activeAssetIds.map((id) => {
        const meta = ACTIVE_META_BY_ID.get(id);
        if (!meta) throw new Error(`expected registry metadata for ${id}`);
        return [id, meta] as const;
      }),
    );
    const localSupplyUsd = 48_488_933;
    const parentSupplyUsd = 45_340_688.25;
    const input = fixedInput(
      activeAssetIds,
      {
        [assetId]: localSupplyUsd,
        [parentId]: parentSupplyUsd,
      },
      {
        clockSec: REGISTRY_FIXTURE_CLOCK_SEC,
        capturedAt: REGISTRY_FIXTURE_CAPTURED_AT,
      },
    );
    const extension = buildSafetyScoreV9BaselineExtension(input, { metaById });
    const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(
      normalizeFixedInput(input),
      extension,
    );
    const compiledById = new Map(
      compiled.assets.map((asset) => [asset.assetId, asset]),
    );
    const evaluatedById = new Map(
      evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets.map(
        (asset) => [asset.assetId, asset],
      ),
    );
    const childFacts = compiledById.get(assetId)!;
    const parentFacts = compiledById.get(parentId)!;
    const child = evaluatedById.get(assetId)!;

    expect(childFacts.supply.circulatingUsd).toBe(localSupplyUsd);
    expect(parentFacts.supply.circulatingUsd).toBe(parentSupplyUsd);
    expect(childFacts.supply.circulatingUsd).not.toBe(
      localSupplyUsd + parentSupplyUsd,
    );
    expect(
      childFacts.dependencies.edges.filter(
        (edge) => edge.economicRole === "serial-claim",
      ),
    ).toEqual([
      expect.objectContaining({
        dependencyType: "wrapper",
        upstreamAssetId: parentId,
        weight: 1,
      }),
    ]);
    expect(child.dependencyInputs.basket).toEqual([]);
    expect(child.dependencyInputs.roleInputs).toContainEqual(
      expect.objectContaining({
        role: "serial-claim",
        upstreamAssetId: parentId,
        weight: 1,
      }),
    );
  });

  it("does not substitute share accounting for an explicit unresolved inherited mint path", () => {
    const { assetId, parentId } = UNRESOLVED_INHERITED_WRAPPER;
    const activeAssetIds = [assetId, parentId];
    const metaById = new Map(
      activeAssetIds.map((id) => {
        const meta = ACTIVE_META_BY_ID.get(id);
        if (!meta) throw new Error(`expected registry metadata for ${id}`);
        return [id, meta] as const;
      }),
    );
    // The wrapper's real variant graph and share-accounting control stay
    // registry-derived; only the inherited mint path is authored, appended after
    // the curated controls so no existing control key shifts index.
    const anchorMeta = structuredClone(metaById.get(assetId)!);
    const anchorProfile = anchorMeta.mintAuthority;
    if (!anchorProfile?.controls) throw new Error(`expected reviewed mint controls for ${assetId}`);
    anchorProfile.controls = [...anchorProfile.controls, UNRESOLVED_INHERITED_MINT_CONTROL];
    metaById.set(assetId, anchorMeta);
    const input = fixedInput(activeAssetIds, {}, {
      clockSec: REGISTRY_FIXTURE_CLOCK_SEC,
      capturedAt: REGISTRY_FIXTURE_CAPTURED_AT,
    });
    const extension = buildSafetyScoreV9BaselineExtension(input, { metaById });
    const asset = extension.assets.find((candidate) => candidate.assetId === assetId)!;
    const controlReview = asset.controlReview;
    if (!controlReview || !("controls" in controlReview)) {
      throw new Error(`expected reviewed controls for ${assetId}`);
    }
    const shareControl = controlReview.controls.find(
      (control) => control.controlKind === "mint" && control.capabilities.length === 0,
    )!;
    const selectedControl = controlReview.controls.find(
      (control) => control.controlKey === asset.economicControlReview?.mint.controlKey,
    )!;

    expect(asset.dependencies?.edges).toContainEqual(
      expect.objectContaining({
        dependencyType: "wrapper",
        economicRole: "serial-claim",
        upstreamAssetId: parentId,
        failureDomains: [{ kind: "mint-control", key: `asset:${parentId}` }],
      }),
    );
    expect(selectedControl.controlKey).not.toBe(shareControl.controlKey);
    expect(selectedControl.capabilities).toContain("mint");

    const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(input), extension);
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets.find(
      (candidate) => candidate.assetId === assetId,
    )!;
    expect(evaluated.control.reasons.map((reason) => reason.code)).toContain("mint-control-question");
  });
});
