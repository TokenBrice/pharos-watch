import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { MintAuthorityControl, MintAuthorityProfile } from "@shared/types/core";
import { reviewedScope, SCOPE_CLOCK, SCOPE_CONTROLLER } from "@shared/lib/__tests__/safety-score-v9-control-scope.test-support";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension-shared";
import { describe, expect, it } from "vitest";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9/fact-set";
import { makeV9FixedInput, v9TestClockSec } from "../../test-helpers/v9-fixed-input";

const AS_OF_SEC = 1_785_456_000;
// Derived, never hardcoded: the extension rejects a reviewedAt later than the
// scoring clock, so a literal goes stale the moment any authoring pass lands a
// newer review date. `v9TestClockSec()` tracks the registry's own latest review.
const REGISTRY_FIXTURE_CLOCK_SEC = v9TestClockSec();
const REGISTRY_FIXTURE_CAPTURED_AT = new Date(REGISTRY_FIXTURE_CLOCK_SEC * 1_000).toISOString();
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
  // The wrapper's own canonical deployment: inherited parent authority still governs local issuance.
  deploymentRefs: ["plasma:0xc8a8df9b210243c55d31c73090f06787ad0a1bf6"],
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
 *   economicCapSemantics: supersedes the contract-encoding cap. A root able to
 *     create durable unbacked supply is economically "unbounded" (D14).
 *     Bounded, raiseable and collateral-gated issuance powers require a sourced
 *     capSemanticsReview. Never edit directMintAbility to express this.
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
  options: { clockSec?: number; capturedAt?: string; omitLiveReserveIds?: readonly string[] } = {},
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
      activeAssetIds.filter((assetId) => !options.omitLiveReserveIds?.includes(assetId)).map((assetId) => [
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
  // Reviewed profiles name the deployments their controls govern; mirror those refs as authored
  // contracts so the fixture satisfies the mint/bridge ownership contract like a real catalog entry.
  const refs = new Set<string>([
    ...(profile?.controls ?? []).flatMap((control) => control.deploymentRefs ?? []),
    ...(profile?.upgradeability?.deploymentRefs ?? []),
  ]);
  const contracts = [...refs].map((ref) => {
    const separator = ref.indexOf(":");
    return { chain: ref.slice(0, separator), address: ref.slice(separator + 1), decimals: 18 };
  });
  return new Map([
    [
      ASSET_ID,
      {
        id: ASSET_ID,
        mechanismArchetype: "fiat-cash" as const,
        mintAuthority: profile,
        ...(contracts.length > 0 ? { contracts } : {}),
      },
    ],
  ]);
}

function mintReviewFor(profile: MintAuthorityProfile | undefined) {
  const extension = buildSafetyScoreV9BaselineExtension(fixedInput(), { metaById: metaWith(profile) });
  const asset = extension.assets[0]!;
  const review = asset.economicControlReview!.mint;
  const controlReview = asset.controlReview;
  const controls = controlReview && "controls" in controlReview ? controlReview.controls : [];
  const mintControl = controls.find((control) => control.controlKey === review.controlKey) ?? null;
  return { review, mintControl, controls };
}

describe("Safety Score v9 mint authoring contract (authoring-contract batch, owner rulings Batch 3)", () => {
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

  it("maps reviewed economicCapSemantics collateral-gated onto cap kind collateral-gated (9.32)", () => {
    const profile: MintAuthorityProfile = {
      ...AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE,
      economicCapSemantics: "collateral-gated",
      reconciliation: "periodic",
      supervision: "none",
      capSemanticsReview: {
        verdict: "bounded-by-construction",
        rationale: "The verified issuance path requires matching collateral deposits before any authorized minter can create new circulating supply.",
        reviewedAt: "2026-07-10",
        reviewer: "@example-reviewer",
        sources: [{ label: "Verified mint implementation", url: "https://example.com/mint-controller" }],
      },
    };
    const { review, mintControl } = mintReviewFor(profile);
    expect(mintControl?.capSemantics.kind).toBe("collateral-gated");
    expect(review.reconciliation).toBe("periodic");
    expect(review.supervision).toBe("none");
  });

  it("lets reviewed reconciliation none supersede inference (9.32)", () => {
    const profile: MintAuthorityProfile = {
      ...AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE,
      economicCapSemantics: "unbounded",
      reconciliation: "none",
      supervision: "none",
    };
    const { review, mintControl } = mintReviewFor(profile);
    // Inferred reconciliation would be "unknown" without proof-of-reserves;
    // the reviewed "none" (confirmed absence) wins over inference.
    expect(review.reconciliation).toBe("none");
    expect(review.supervision).toBe("none");
    expect(mintControl?.capSemantics.kind).toBe("unbounded");
  });

  it("passes a reviewer's explicit unknown reconciliation through on a direct non-backend mint control (9.32)", () => {
    const profile: MintAuthorityProfile = {
      ...AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE,
      controls: [
        {
          ...AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE.controls![0]!,
          authorityType: "multisig",
          directMintAbility: "direct",
        },
      ],
      economicCapSemantics: "unbounded",
      reconciliation: "unknown",
      supervision: "none",
    };
    const { review, mintControl } = mintReviewFor(profile);
    // Pre-9.32 the not-applicable inference swallowed the reviewer's explicit
    // "unknown"; it now passes through so the evaluator can price the
    // unbounded-reconciliation-unknown rung instead of the confirmed floor.
    expect(review.reconciliation).toBe("unknown");
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
    // Control keys derive from stable control identity, not array position, so reordering the
    // reviewed `controls` array cannot change compiled identities. Look controls up by their
    // on-chain authority instead of by index.
    const controlKeyByAuthority = new Map(
      mintControls.map((control) => [control.authority?.authorityKey ?? "", control.controlKey] as const),
    );
    const FEE_SHARE_AUTHORITY = "ethereum:0xa7f0121375dc52028e333f02715183a1d1a690a7";
    const DAO_PROXY_ADMIN_AUTHORITY = "ethereum:0x62244c74e1d09b3d86ef7342d354b5d7770bde10";
    const SECURITY_COUNCIL_AUTHORITY = "ethereum:0x89faa3b02ef5ab185b8ace489af62748acb50afc";

    expect(profile).toMatchObject({
      confidence: "probable",
      review: {
        disposition: "scoreable",
      },
    });
    expect(profile.review.unresolvedQuestions).toBeUndefined();
    expect(profile.controls?.find((control) => `${control.chain}:${control.address}` === DAO_PROXY_ADMIN_AUTHORITY)).toMatchObject({
      timelockDelaySec: 86400,
    });
    expect(profile.controls?.find((control) => `${control.chain}:${control.address}` === SECURITY_COUNCIL_AUTHORITY)).toMatchObject({
      timelockDelaySec: 0,
      failureDomainKeys: [
        "eoa:ethereum:0xaa1e36165b3ac105f25549c06e1f06d573a40be3",
        "module:ethereum:0xeec7919bab68876e14737970fe4965ab9737cd29",
        "safe:ethereum:0x89faa3b02ef5ab185b8ace489af62748acb50afc",
      ],
    });
    expect(controlReview.state).toBe("reviewed-controls");
    const feeTimelockControl = mintControls.find((control) =>
      control.authority?.authorityKey === "ethereum:0x38542447c49d24e617fc06113295d7aaa3bec4b6",
    );
    expect(feeTimelockControl).toMatchObject({
      capabilities: ["parameter-change"],
      economicLossScope: "global-claim",
    });
    // The scoped historical review establishes incident absence positively, so no
    // control is left at the fail-closed "unknown" incident state.
    expect(mintControls.map((control) => control.incidentState)).toEqual(
      Array.from({ length: mintControls.length }, () => "none"),
    );
    expect(asset.economicControlReview?.mint.status.observationState).toBe("known");
    expect(mintControls.find((control) =>
      control.controlKey === controlKeyByAuthority.get(DAO_PROXY_ADMIN_AUTHORITY),
    )?.capabilities).toEqual(["mint", "upgrade"]);
    // Mint selection lands on the fee-share dilution control and the upgrade path on the DAO proxy
    // admin; the Security Council's recovery-module control carries only parameter-change capability.
    expect(asset.economicControlReview?.mint.controlKey).toBe(controlKeyByAuthority.get(FEE_SHARE_AUTHORITY));
    expect(asset.economicControlReview?.mint.upgrade).toMatchObject({
      state: "reviewed",
      controlKey: controlKeyByAuthority.get(DAO_PROXY_ADMIN_AUTHORITY),
    });
    const councilControl = mintControls.find(
      (control) => control.controlKey === controlKeyByAuthority.get(SECURITY_COUNCIL_AUTHORITY),
    )!;
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
      compiledMintControls.map(() =>
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
              // Keep only the deployments the reviewed controls name, so the fixture is a
              // single-canonical asset rather than an unrouted multi-deployment one.
              ...(() => {
                const refs = new Set<string>([
                  ...(mintAuthority.controls ?? []).flatMap((control) => control.deploymentRefs ?? []),
                  ...(mintAuthority.upgradeability?.deploymentRefs ?? []),
                ]);
                const contracts = (meta.contracts ?? []).filter((contract) =>
                  refs.has(`${contract.chain}:${contract.address}`.toLowerCase()),
                );
                return contracts.length > 0 ? { contracts } : {};
              })(),
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
      omitLiveReserveIds: relationships.map(({ assetId }) => assetId),
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
        omitLiveReserveIds: [assetId],
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
      omitLiveReserveIds: [assetId],
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

function governedControl(
  address = SCOPE_CONTROLLER.split(":")[1]!,
  overrides: Partial<MintAuthorityControl> = {},
): MintAuthorityControl {
  const deployment = `ethereum:${address}`;
  const scope = reviewedScope({ controllerDeployment: deployment });
  scope.paths[0] = {
    ...scope.paths[0]!,
    targetDeployment: deployment,
    affectedLiabilityIds: [ASSET_ID],
    affectedDeployments: [deployment],
    capSemantics: { kind: "unbounded", bound: null },
    claimImpairment: "unbounded",
    unavoidableDelaySec: 259200,
  };
  scope.pin = { ...scope.pin, signerIdentity: `Only governor ${SCOPE_CONTROLLER.split(":")[1]} can cause execution.` };
  scope.observedState = { ...scope.pin };
  return {
    chain: "ethereum",
    address,
    label: "Token governor",
    role: "governor",
    authorityType: "dao-governor",
    directMintAbility: "can-authorize",
    executionScope: scope,
    sources: [{ label: "Pinned executable", url: "https://example.com/source" }],
    ...overrides,
  };
}

function governedProfile(controls = [governedControl()]): MintAuthorityProfile {
  return {
    ...AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE,
    authorityPosture: "unbounded-governed",
    controls,
    reconciliation: "none",
    supervision: "none",
    review: { ...AUTHORING_CONTRACT_MINT_AUTHORITY_EXAMPLE.review, reviewedAt: "2026-10-01" },
    governedIssuance: {
      decisionRule: "affirmative-vote",
      governorControlRef: SCOPE_CONTROLLER,
      votingPower: "lock-escrowed",
      votingPowerEvidence: "Voting weight remains locked throughout the voting and executable delay interval.",
      enumerability: { authorizationEvents: ["Authorized(address)"], capacityReads: ["capacity(address)"] },
      observedAt: "2026-10-01",
      observedBlock: 100,
      reviewedAt: "2026-10-01",
      reviewer: "Fixture Reviewer",
      sources: [{ label: "Governor source", url: "https://example.com/governor" }],
    },
  };
}

function governedRows(profile: MintAuthorityProfile, clockSec = SCOPE_CLOCK) {
  const input = fixedInput([ASSET_ID], {}, {
    clockSec, capturedAt: new Date(clockSec * 1000).toISOString(),
  });
  const extension = buildSafetyScoreV9BaselineExtension(input, { metaById: metaWith(profile) });
  const controlReview = extension.assets[0]!.controlReview;
  const rows = controlReview && "controls" in controlReview ? controlReview.controls : [];
  const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(input), extension);
  return {
    rows: rows.filter((row) => row.controlKey.startsWith(`mint-meta:${ASSET_ID}:`)),
    compiledRows: compiled.assets[0]!.controls.filter((row) => row.controlKey.startsWith(`mint-meta:${ASSET_ID}:`)),
  };
}

describe("Governed issuance compilation (D29)", () => {
  it("omits the governance stamp when the authored block is absent", () => {
    const profile = governedProfile();
    delete profile.governedIssuance;
    profile.authorityPosture = "unbounded-unreconciled";
    const { rows, compiledRows } = governedRows(profile);
    expect(rows.map((row) => row.issuanceGovernance)).toEqual([undefined]);
    expect(compiledRows.map((row) => row.issuanceGovernance)).toEqual([undefined]);
  });

  it("uses the minimum path delay, not overlapping-clock sums, and stamps every emitted path", () => {
    const governor = governedControl();
    const minter = governedControl("0x2222222222222222222222222222222222222222", {
      label: "Governed minter", authorityType: "contract", role: "direct-minter", directMintAbility: "direct",
      timelockDelaySec: 604800,
    });
    const scope = minter.executionScope!;
    scope.paths[0]!.unavoidableDelaySec = 172800;
    scope.paths.push({
      ...scope.paths[0]!, id: "upgrade", capabilities: ["upgrade"], unavoidableDelaySec: 200000,
    });
    const profile = governedProfile([governor, minter]);
    const { rows, compiledRows } = governedRows(profile);
    const expected = {
      coverage: "complete",
      incompleteReasons: [],
      governorAuthorityKey: SCOPE_CONTROLLER,
      decisionRule: "affirmative-vote", vetoQuorumBps: null, vetoOverride: null,
      minUnavoidableDelaySec: 172800,
      votingPower: "lock-escrowed",
      enumerable: true,
      nonGovernorUnboundedPathKeys: [],
    };
    expect(rows.map((row) => row.controlKey.split(":path:")[1]).sort()).toEqual(["issuance", "issuance", "upgrade"]);
    expect(rows.map((row) => row.issuanceGovernance)).toEqual([expected, expected, expected]);
    expect(compiledRows.map((row) => row.issuanceGovernance)).toEqual([expected, expected, expected]);
  });

  it("preserves the asset-wide stamp on deployment-local path rows", () => {
    const localDeployment = "base:0x3333333333333333333333333333333333333333";
    const local = governedControl("0x2222222222222222222222222222222222222222", {
      label: "Governed local upgrader", authorityType: "contract", role: "proxy-admin",
      directMintAbility: "upgrade-only", deploymentRefs: [localDeployment],
    });
    Object.assign(local.executionScope!.paths[0]!, {
      capabilities: ["upgrade"], reach: "deployment", economicLossScope: "deployment",
      affectedDeployments: [localDeployment], unavoidableDelaySec: 172800,
    });
    const profile = governedProfile([
      governedControl(undefined, { deploymentRefs: [SCOPE_CONTROLLER, localDeployment] }), local,
    ]);
    const source = { label: "Native route source", url: "https://example.com/routes" };
    const routes = [SCOPE_CONTROLLER, localDeployment].map((id) => ({
      id, destinationChain: id.split(":")[0]!, contractAddress: id.split(":")[1]!,
      protocol: "Native fixture", issuanceModel: "native-issuance" as const, routeClass: "native" as const,
      riskTier: "single-chain-or-native" as const, semantics: "native-mint" as const, scope: "canonical" as const,
      reviewDisposition: "reviewed" as const, observedAt: "2026-10-01", sources: [source],
    }));
    const meta: V9ExtensionRegistryMeta = {
      ...metaWith(profile).get(ASSET_ID)!,
      contracts: routes.map((route) => ({ chain: route.destinationChain, address: route.contractAddress, decimals: 18 })),
      bridgeRouteRisk: {
        tier: "issuer-native-burn-mint", summary: "Reviewed native deployments share the same governance.",
        reviewedAt: "2026-10-01", reviewer: "Fixture Reviewer", confidence: "verified", sources: [source], routes,
      },
    };
    const input = makeV9FixedInput({
      assetId: ASSET_ID, clockSec: SCOPE_CLOCK,
      chainSupplyByChain: {
        ethereum: { current: 8_000_000, circulatingPrevDay: 8_000_000, circulatingPrevWeek: 8_000_000, circulatingPrevMonth: 8_000_000 },
        base: { current: 2_000_000, circulatingPrevDay: 2_000_000, circulatingPrevWeek: 2_000_000, circulatingPrevMonth: 2_000_000 },
      },
    });
    const extension = buildSafetyScoreV9BaselineExtension(input, { metaById: new Map([[ASSET_ID, meta]]) });
    const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(input), extension);
    const rows = compiled.assets[0]!.controls.filter((row) => row.controlKey.startsWith(`mint-meta:${ASSET_ID}:`));
    expect(rows.find((row) => row.scope === "global")).toMatchObject({
      materialSupplyShare: null, capabilities: ["mint"],
    });
    expect(rows.find((row) => row.scope === "deployment")).toMatchObject({
      deploymentKey: localDeployment, materialSupplyShare: 0.2, capabilities: ["upgrade"],
    });
    const expected = {
      coverage: "complete", incompleteReasons: [], governorAuthorityKey: SCOPE_CONTROLLER,
      decisionRule: "affirmative-vote", vetoQuorumBps: null, vetoOverride: null,
      minUnavoidableDelaySec: 172800, votingPower: "lock-escrowed", enumerable: true, nonGovernorUnboundedPathKeys: [],
    };
    expect(rows.map((row) => row.issuanceGovernance)).toEqual([expected, expected]);
  });

  it.each(["parameter", "restriction", "delegated", "contract"] as const)(
    "requires a complete scope on every authored %s control", (kind) => {
      const control = governedControl("0x2222222222222222222222222222222222222222", {
        label: `${kind} control`, authorityType: "contract", role: "direct-minter",
        directMintAbility: kind === "parameter" ? "parameter-only" : kind === "restriction" ? "none" : "cap-limited",
        canRaiseCap: false,
      });
      control.executionScope!.inventory = "partial";
      control.executionScope!.confidence = "partial";
      const profile = governedProfile([governedControl(), control]);
      const { rows } = governedRows(profile);
      expect(rows.map((row) => row.issuanceGovernance?.incompleteReasons)).toEqual([
        [`control-scope-incomplete:${kind} control`], [`control-scope-incomplete:${kind} control`],
      ]);
      expect(rows.map((row) => row.issuanceGovernance?.coverage)).toEqual(["incomplete", "incomplete"]);
      delete control.executionScope;
      expect(governedRows(profile).rows[0]!.issuanceGovernance?.incompleteReasons)
        .toContain(`control-scope-incomplete:${kind} control`);
    },
  );

  it("reports an unresolved reference and a governor whose projected authority is not governance", () => {
    const missing = governedProfile();
    missing.governedIssuance!.governorControlRef = "ethereum:0x3333333333333333333333333333333333333333";
    expect(governedRows(missing).rows[0]!.issuanceGovernance?.incompleteReasons).toEqual(["governor-control-missing"]);
    const nongovernor = governedProfile([governedControl(undefined, { authorityType: "contract" })]);
    expect(governedRows(nongovernor).rows[0]!.issuanceGovernance?.incompleteReasons).toEqual(["governor-not-governance"]);
  });

  it.each(["holding-period-weighted", "lock-escrowed", "past-block-checkpoint"] as const)(
    "rejects signer-quorum claims on the %s governor during compilation", (votingPower) => {
      for (const field of ["weightedQuorum", "threshold", "signerCount"] as const) {
        const governor = governedControl();
        if (field === "weightedQuorum") {
          governor.weightedQuorum = {
            scheme: "contract", deployment: SCOPE_CONTROLLER,
            signers: [{ account: governor.address!, weight: 1 }], quorum: 1, totalWeight: 1,
            pin: governor.executionScope!.pin, status: "verified",
            reviewedAt: "2026-10-01", expiresAt: "2026-10-31",
            reviewer: "Fixture Reviewer", sources: governor.sources!,
          };
        } else {
          governor[field] = 1;
        }
        const profile = governedProfile([governor]);
        profile.governedIssuance!.votingPower = votingPower;
        expect(governedRows(profile).rows[0]!.issuanceGovernance).toMatchObject({
          coverage: "incomplete", incompleteReasons: ["governor-not-governance"],
        });
      }
    },
  );

  it.each(["unbounded", "unknown"] as const)(
    "includes a non-governor parameter-change path with %s cap in rooting and the delay minimum", (kind) => {
      const parameter = governedControl("0x2222222222222222222222222222222222222222", {
        label: "Parameter authority", authorityType: "eoa", role: "minter-admin", directMintAbility: "parameter-only",
      });
      Object.assign(parameter.executionScope!.paths[0]!, {
        capabilities: ["parameter-change"], capSemantics: { kind, bound: null },
        claimImpairment: "none", unavoidableDelaySec: 86400,
      });
      expect(governedRows(governedProfile([governedControl(), parameter])).rows[0]!.issuanceGovernance)
        .toMatchObject({
          coverage: "complete", minUnavoidableDelaySec: 86400,
          nonGovernorUnboundedPathKeys: ["Parameter authority:issuance"],
        });
    },
  );

  it("fails closed for null delay and no unbounded issuance paths", () => {
    const delayed = governedControl();
    const unknownDelay = governedControl("0x2222222222222222222222222222222222222222", {
      label: "Governed minter", authorityType: "contract", role: "direct-minter",
    });
    unknownDelay.executionScope!.paths[0]!.unavoidableDelaySec = null;
    expect(governedRows(governedProfile([delayed, unknownDelay])).rows[0]!.issuanceGovernance?.minUnavoidableDelaySec).toBeNull();
    const boundedGovernor = governedControl();
    boundedGovernor.executionScope!.paths[0]!.capSemantics = { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } };
    boundedGovernor.executionScope!.paths[0]!.claimImpairment = "bounded";
    expect(governedRows(governedProfile([boundedGovernor])).rows[0]!.issuanceGovernance?.minUnavoidableDelaySec).toBeNull();
  });

  it.each(["timelock", "safe", "multisig", "eoa", "issuer-backend", "custodian", "validator-quorum", "dao-governor"] as const)(
    "does not treat a %s-owned unbounded route as governor-rooted", (authorityType) => {
      const bypass = governedControl("0x2222222222222222222222222222222222222222", {
        label: "Other authority", authorityType, role: "direct-minter", threshold: 2, signerCount: 3,
      });
      const { rows } = governedRows(governedProfile([governedControl(), bypass]));
      expect(rows[0]!.issuanceGovernance?.nonGovernorUnboundedPathKeys).toEqual(["Other authority:issuance"]);
    },
  );

  it("rejects contract paths whose certificate omits the governor", () => {
    const bypass = governedControl("0x2222222222222222222222222222222222222222", {
      label: "Unbound contract", authorityType: "contract", role: "direct-minter",
    });
    bypass.executionScope!.pin.signerIdentity = "Safe owners alone can execute.";
    bypass.executionScope!.observedState = { ...bypass.executionScope!.pin };
    expect(governedRows(governedProfile([governedControl(), bypass])).rows[0]!.issuanceGovernance?.nonGovernorUnboundedPathKeys)
      .toEqual(["Unbound contract:issuance"]);
  });

  it.each([
    `Governor ${SCOPE_CONTROLLER.split(":")[1]} or 0x3333333333333333333333333333333333333333 can execute.`,
    `Governor f${SCOPE_CONTROLLER.split(":")[1]} can execute.`,
    `Governor ${SCOPE_CONTROLLER.split(":")[1]}a can execute.`,
  ])("rejects unauthored parties and non-standalone governor tokens (%s)", (signerIdentity) => {
    const minter = governedControl("0x2222222222222222222222222222222222222222", {
      label: "Contract minter", authorityType: "contract", role: "direct-minter",
    });
    minter.executionScope!.pin.signerIdentity = signerIdentity;
    minter.executionScope!.observedState = { ...minter.executionScope!.pin };
    expect(governedRows(governedProfile([governedControl(), minter])).rows[0]!.issuanceGovernance?.nonGovernorUnboundedPathKeys)
      .toEqual(["Contract minter:issuance"]);
  });

  it.each(["2 of 3", "2 out of 3", "2/3", "2-of-3", "one of three", "two out of five", "three-of-five", "two signatures from five", "signature", "signatures", "Safe", "safes", "multisig", "multisigs", "multisignature", "threshold", "thresholds", "signer", "signers", "owner", "owners", "quorum"])(
    "rejects contract certificates containing %s party phrasing", (phrasing) => {
      const minter = governedControl("0x2222222222222222222222222222222222222222", {
        label: "Contract minter", authorityType: "contract", role: "direct-minter",
      });
      minter.executionScope!.pin.signerIdentity = `${phrasing}; governor ${SCOPE_CONTROLLER.split(":")[1]} can execute.`;
      minter.executionScope!.observedState = { ...minter.executionScope!.pin };
      expect(governedRows(governedProfile([governedControl(), minter])).rows[0]!.issuanceGovernance?.nonGovernorUnboundedPathKeys)
        .toEqual(["Contract minter:issuance"]);
    },
  );

  it("admits a governor chain through another authored and governor-rooted contract control", () => {
    const minter = governedControl("0x2222222222222222222222222222222222222222", {
      label: "Contract minter", authorityType: "contract", role: "direct-minter",
    });
    const hop = governedControl("0x3333333333333333333333333333333333333333", {
      label: "Execution hop", authorityType: "contract", role: "minter-admin",
    });
    minter.executionScope!.pin.signerIdentity = `Only governor ${SCOPE_CONTROLLER.split(":")[1]} through contract ${hop.address} can execute.`;
    minter.executionScope!.observedState = { ...minter.executionScope!.pin };
    const profile = governedProfile([governedControl(), minter, hop]);
    expect(governedRows(profile).rows[0]!.issuanceGovernance).toMatchObject({
      coverage: "complete", nonGovernorUnboundedPathKeys: [],
    });
    hop.authorityType = "eoa";
    expect(governedRows(profile).rows[0]!.issuanceGovernance?.nonGovernorUnboundedPathKeys)
      .toEqual(["Contract minter:issuance", "Execution hop:issuance"]);
  });

  it("matches checksum-case governor tokens after case folding", () => {
    const governorAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const governor = governedControl(governorAddress.toLowerCase());
    const minter = governedControl("0x2222222222222222222222222222222222222222", {
      label: "Contract minter", authorityType: "contract", role: "direct-minter",
    });
    minter.executionScope!.pin.signerIdentity = `Only governor (${governorAddress}) can execute.`;
    minter.executionScope!.observedState = { ...minter.executionScope!.pin };
    const profile = governedProfile([governor, minter]);
    profile.governedIssuance!.governorControlRef = `ethereum:${governor.address}`;
    expect(governedRows(profile).rows[0]!.issuanceGovernance?.nonGovernorUnboundedPathKeys).toEqual([]);
  });

  it.each(["governor", "execution-hop"] as const)(
    "rejects a same-address %s token authored only on another chain", (party) => {
      const minter = governedControl("0x2222222222222222222222222222222222222222", {
        label: "Contract minter", authorityType: "contract", role: "direct-minter",
      });
      const hop = governedControl("0x3333333333333333333333333333333333333333", {
        label: "Execution hop", authorityType: "contract", role: "minter-admin",
      });
      hop.executionScope!.paths[0]!.capSemantics = { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } };
      hop.executionScope!.paths[0]!.claimImpairment = "bounded";
      minter.executionScope!.pin.signerIdentity =
        `Only governor ${SCOPE_CONTROLLER.split(":")[1]} through contract ${hop.address} can execute.`;
      minter.executionScope!.observedState = { ...minter.executionScope!.pin };
      const crossChainControl = party === "governor" ? minter : hop;
      crossChainControl.chain = "base";
      const deployment = `base:${crossChainControl.address}`;
      crossChainControl.executionScope!.controllerDeployment = deployment;
      crossChainControl.executionScope!.paths[0]!.targetDeployment = deployment;
      crossChainControl.executionScope!.paths[0]!.affectedDeployments = [deployment];
      expect(governedRows(governedProfile([governedControl(), minter, hop])).rows[0]!.issuanceGovernance)
        .toMatchObject({ coverage: "complete", nonGovernorUnboundedPathKeys: ["Contract minter:issuance"] });
    },
  );

  it.each(["bounded", "raiseable", "collateral-gated"] as const)(
    "does not charge delay to %s delegated actors or restriction-only paths", (kind) => {
      const delegated = governedControl("0x2222222222222222222222222222222222222222", {
        label: "Delegated minter", authorityType: "eoa", role: "direct-minter", directMintAbility: "cap-limited",
      });
      delegated.executionScope!.paths[0]!.capSemantics = kind === "bounded"
        ? { kind, bound: { amount: 1, unit: "supply-fraction" } } : { kind, bound: null };
      delegated.executionScope!.paths[0]!.claimImpairment = "bounded";
      delegated.executionScope!.paths[0]!.unavoidableDelaySec = null;
      const restriction = governedControl("0x3333333333333333333333333333333333333333", {
        label: "Pause-only authority", authorityType: "eoa", role: "direct-minter", directMintAbility: "none",
      });
      restriction.executionScope!.paths[0]!.capabilities = ["freeze"];
      restriction.executionScope!.paths[0]!.capSemantics = { kind: "not-applicable", bound: null };
      restriction.executionScope!.paths[0]!.claimImpairment = "none";
      restriction.executionScope!.paths[0]!.unavoidableDelaySec = null;
      expect(governedRows(governedProfile([governedControl(), delegated, restriction])).rows[0]!.issuanceGovernance)
        .toMatchObject({ coverage: "complete", minUnavoidableDelaySec: 259200, nonGovernorUnboundedPathKeys: [] });
    },
  );

  it.each(["mint", "upgrade", "bridge-mint"] as const)(
    "admits the governor's complete reachable %s path outside the asset liability projection", (capability) => {
      const governor = governedControl();
      Object.assign(governor.executionScope!.paths[0]!, {
        capabilities: [capability], reach: "other-liability", affectedLiabilityIds: ["another-asset"],
      });
      const minter = governedControl("0x2222222222222222222222222222222222222222", {
        label: "Governed minter", authorityType: "contract", role: "direct-minter",
      });
      minter.executionScope!.paths[0]!.unavoidableDelaySec = 172800;
      expect(governedRows(governedProfile([governor, minter])).rows[0]!.issuanceGovernance).toMatchObject({
        coverage: "complete", incompleteReasons: [], minUnavoidableDelaySec: 172800,
      });
    },
  );

  it("requires a reachable mint, upgrade or bridge-mint path on the governor", () => {
    for (const [mutate, minUnavoidableDelaySec] of [
      [(control: MintAuthorityControl) => { control.executionScope!.paths[0]!.capabilities = ["parameter-change"]; }, 259200],
      [(control: MintAuthorityControl) => { control.executionScope!.paths[0]!.activation = "disabled-final"; }, null],
    ] as const) {
      const governor = governedControl();
      mutate(governor);
      expect(governedRows(governedProfile([governor])).rows[0]!.issuanceGovernance)
        .toMatchObject({ coverage: "incomplete", incompleteReasons: ["governor-without-issuance-path"], minUnavoidableDelaySec });
    }
  });

  it("compiles evidence coverage and voting power without applying evaluator thresholds", () => {
    const profile = governedProfile();
    profile.controls![0]!.executionScope!.paths[0]!.unavoidableDelaySec = 1;
    profile.governedIssuance!.votingPower = "live-balance";
    expect(governedRows(profile).rows[0]!.issuanceGovernance).toMatchObject({
      coverage: "complete", incompleteReasons: [], votingPower: "live-balance", minUnavoidableDelaySec: 1, enumerable: true,
    });
    profile.governedIssuance!.enumerability.capacityReads = [];
    expect(governedRows(profile).rows[0]!.issuanceGovernance?.enumerable).toBe(false);
  });

  it("emits sorted coverage reasons for review, scoped questions, active incidents and expired governance", () => {
    const profile = governedProfile();
    profile.review.disposition = "unresolved";
    profile.review.scopedQuestions = [{
      controlRef: SCOPE_CONTROLLER, question: "Is every issuance route included in the certificate?",
      reviewedAt: "2026-10-01", reviewer: "Fixture Reviewer",
    }];
    profile.authorityPosture = "compromised";
    profile.mintIncidents = [{
      date: "2026-10-01", status: "active", summary: "An active issuance compromise remains unresolved.",
      sources: [{ label: "Incident report", url: "https://example.com/incident" }],
    }];
    profile.governedIssuance!.reviewedAt = "2025-09-01";
    expect(governedRows(profile).rows[0]!.issuanceGovernance?.incompleteReasons).toEqual([
      "active-incident", "governed-review-expired", "review-incomplete", "scoped-question-open",
    ]);
  });

  it("uses the inclusive governed review freshness boundary and rejects future review relief", () => {
    const profile = governedProfile();
    const reviewSec = Date.parse(`${profile.governedIssuance!.reviewedAt}T00:00:00Z`) / 1000;
    const later = reviewSec + V9_REVIEW_EVIDENCE_MAX_AGE_SEC;
    expect(governedRows(profile, later).rows[0]!.issuanceGovernance?.incompleteReasons).not.toContain("governed-review-expired");
    expect(governedRows(profile, later + 1).rows[0]!.issuanceGovernance?.incompleteReasons).toContain("governed-review-expired");
    profile.governedIssuance!.reviewedAt = "2026-10-03";
    expect(governedRows(profile).rows[0]!.issuanceGovernance?.incompleteReasons).toEqual(["governed-review-expired"]);
  });
});

function vetoProfile(): MintAuthorityProfile {
  const governor = governedControl(undefined, { directMintAbility: "parameter-only" });
  const registry = governedControl("0x2222222222222222222222222222222222222222", {
    label: "Guarded registry", authorityType: "contract", role: "minter-admin", directMintAbility: "can-authorize",
  });
  const vetoPath = governor.executionScope!.paths[0]!;
  Object.assign(vetoPath, {
    id: "veto-admission", targetDeployment: registry.executionScope!.controllerDeployment,
    capabilities: ["parameter-change"], entrypoints: ["0x12345678", "0xabcdef01"],
    capSemantics: { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } }, claimImpairment: "none",
  });
  registry.executionScope!.paths[0]!.unavoidableDelaySec = 1_209_600;
  const profile = governedProfile([governor, registry]);
  profile.authorityPosture = "unbounded-veto-guarded";
  profile.governedIssuance = {
    ...profile.governedIssuance!, decisionRule: "minority-veto", votingPower: "holding-period-weighted",
    veto: {
      quorumBps: 200, entrypoints: ["0x12345678", "0xabcdef01"], override: "symmetric-vote-destruction",
      evidence: "Pinned executable fixture: every application remains vetoable for fourteen days by two percent of holding-duration votes, and neutralizing votes costs the caller an equal number.",
    },
  };
  return profile;
}

describe("Minority-veto issuance compilation (D30)", () => {
  it("admits a selector-complete veto path targeting the governor-rooted issuance registry", () => {
    const { compiledRows } = governedRows(vetoProfile());
    const registry = compiledRows.find((row) => row.authority?.model === "contract")!;
    expect(registry.issuanceGovernance).toMatchObject({
      coverage: "complete", incompleteReasons: [], decisionRule: "minority-veto",
      minUnavoidableDelaySec: 1_209_600, vetoQuorumBps: 200, vetoOverride: "symmetric-vote-destruction",
      nonGovernorUnboundedPathKeys: [],
    });
  });

  it.each(["disabled", "dormant", "wrong-capability", "missing-selector", "wrong-target"] as const)(
    "fails coverage for a %s veto execution path", (failure) => {
      const profile = vetoProfile();
      const path = profile.controls![0]!.executionScope!.paths[0]!;
      if (failure === "disabled") path.activation = "disabled-final";
      if (failure === "dormant") path.activation = "disabled-reactivatable";
      if (failure === "wrong-capability") path.capabilities = ["mint"];
      if (failure === "missing-selector") path.entrypoints = ["0x12345678"];
      if (failure === "wrong-target") path.targetDeployment = SCOPE_CONTROLLER;
      expect(governedRows(profile).compiledRows[0]!.issuanceGovernance).toMatchObject({
        coverage: "incomplete", incompleteReasons: ["governor-without-veto-path:Guarded registry"],
      });
    },
  );

  it("requires veto coverage for each guarded controller, not a matching sibling", () => {
    const profile = vetoProfile();
    const second = governedControl("0x4444444444444444444444444444444444444444", {
      label: "Second registry", authorityType: "contract", role: "minter-admin", directMintAbility: "can-authorize",
    });
    second.executionScope!.paths[0]!.unavoidableDelaySec = 1_209_600;
    profile.controls!.push(second);
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons)
      .toEqual(["governor-without-veto-path:Second registry"]);
    const scope = profile.controls![0]!.executionScope!;
    scope.paths.push({ ...scope.paths[0]!, id: "veto-second", targetDeployment: second.executionScope!.controllerDeployment });
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.coverage).toBe("complete");
  });

  it.each(["unbounded", "unknown"] as const)("rejects a veto governor's %s issuance bypass", (kind) => {
    const profile = vetoProfile();
    const scope = profile.controls![0]!.executionScope!;
    scope.paths.push({
      ...scope.paths[0]!, id: "governor-bypass", targetDeployment: SCOPE_CONTROLLER,
      capabilities: ["mint"], capSemantics: { kind, bound: null }, claimImpairment: kind,
    });
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons)
      .toContain("governor-carries-unbounded-path");
  });

  it("retains structured veto-governor rooting and the minimum, never summed, window", () => {
    const profile = vetoProfile();
    const registry = profile.controls![1]!;
    registry.executionScope!.paths.push({
      ...registry.executionScope!.paths[0]!, id: "second-admission", unavoidableDelaySec: 1_209_599,
    });
    registry.executionScope!.pin.signerIdentity = "A 2 of 3 threshold council controls this registry.";
    registry.executionScope!.observedState = { ...registry.executionScope!.pin };
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance).toMatchObject({
      coverage: "complete", minUnavoidableDelaySec: 1_209_599,
      nonGovernorUnboundedPathKeys: ["Guarded registry:issuance", "Guarded registry:second-admission"],
    });
  });

  it("keeps admitted minter exercise delay separate from the admission window", () => {
    const profile = vetoProfile();
    const registry = profile.controls![1]!;
    registry.executionScope!.paths.push({
      ...registry.executionScope!.paths[0]!, id: "admitted-minter-exercise", unavoidableDelaySec: 0,
    });
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance).toMatchObject({
      coverage: "complete", minUnavoidableDelaySec: 0, nonGovernorUnboundedPathKeys: [],
    });
  });

  it.each(["missing", "incomplete"] as const)(
    "names every unguarded controller when the veto governor is %s", (state) => {
      const profile = vetoProfile();
      if (state === "missing") profile.governedIssuance!.governorControlRef = "ethereum:0x3333333333333333333333333333333333333333";
      else profile.controls![0]!.executionScope!.inventory = "partial";
      expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons)
        .toContain("governor-without-veto-path:Guarded registry");
    },
  );
});

function monetaryVetoProfile(): MintAuthorityProfile {
  const profile = vetoProfile();
  const registry = profile.controls![1]!;
  registry.executionScope!.paths.push({
    ...registry.executionScope!.paths[0]!, id: "deposit-interest",
    capSemantics: { kind: "raiseable", bound: null }, claimImpairment: "bounded", unavoidableDelaySec: 172800,
  });
  profile.governedIssuance!.monetaryPolicyPaths = [{
    controlRef: registry.executionScope!.controllerDeployment, pathId: "deposit-interest",
    rateCapPpm: 100000, rateChangeDelaySec: 172800, rateChangeRule: "minority-replaceable",
    evidence: "Pinned formula fixture limits interest to deposits times the hard-capped rate times time; rate replacement is minority-blockable for at least two days.",
  }];
  return profile;
}

function restructureVetoProfile(): MintAuthorityProfile {
  const profile = vetoProfile();
  const bootstrap = governedControl("0x3333333333333333333333333333333333333333", {
    label: "Bootstrap", authorityType: "eoa", role: "direct-minter", directMintAbility: "direct",
  });
  bootstrap.executionScope!.paths[0]!.activation = "disabled-reactivatable";
  bootstrap.executionScope!.paths[0]!.unavoidableDelaySec = 0;
  profile.controls!.push(bootstrap);
  const governorScope = profile.controls![0]!.executionScope!;
  governorScope.paths.push({
    ...governorScope.paths[0]!, id: "veto-bootstrap", targetDeployment: bootstrap.executionScope!.controllerDeployment,
  });
  profile.governedIssuance!.enumerability.capacityReads.push("equity()");
  profile.governedIssuance!.veto = {
    ...profile.governedIssuance!.veto!, override: "insolvency-gated-restructure",
    restructure: {
      entrypoints: ["0xabcdef01"], equityThresholdUnits: 1000, observedEquityUnits: 2000,
      dependentPaths: [{ controlRef: bootstrap.executionScope!.controllerDeployment, pathId: "issuance" }],
      evidence: "Pinned equity exceeds the insolvency gate; only restructure can produce zero share supply, which alone reactivates bootstrap. Redemption retains one share.",
    },
  };
  return profile;
}

describe("Minority-veto monetary policy and restructure (D30-S/D30-R)", () => {
  it("excludes qualified formula-bound interest from the fourteen-day admission minimum", () => {
    expect(governedRows(monetaryVetoProfile()).compiledRows[0]!.issuanceGovernance).toMatchObject({
      coverage: "complete", minUnavoidableDelaySec: 1_209_600, nonGovernorUnboundedPathKeys: [],
    });
  });

  it.each(["mint", "bridge-mint"] as const)("requires a monetary-policy review on a raiseable %s path", (capability) => {
    const profile = monetaryVetoProfile();
    profile.controls![1]!.executionScope!.paths[1]!.capabilities = [capability];
    delete profile.governedIssuance!.monetaryPolicyPaths;
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons)
      .toEqual(["monetary-policy-path-unreviewed:Guarded registry:deposit-interest"]);
  });

  it.each([
    ["delay short", { rateChangeDelaySec: 172799 }],
    ["unrestricted rate", { rateChangeRule: "unrestricted" }],
    ["unknown rate rule", { rateChangeRule: "unknown" }],
  ] as const)("rejects %s monetary-policy evidence", (_name, change) => {
    const profile = monetaryVetoProfile();
    Object.assign(profile.governedIssuance!.monetaryPolicyPaths![0]!, change);
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons)
      .toEqual(["monetary-policy-path-inadmissible:Guarded registry:deposit-interest"]);
  });

  it.each(["missing", "disabled", "unbounded-cap", "unbounded-impairment"] as const)(
    "rejects a %s listed monetary-policy path", (failure) => {
      const profile = monetaryVetoProfile();
      const path = profile.controls![1]!.executionScope!.paths[1]!;
      if (failure === "missing") profile.governedIssuance!.monetaryPolicyPaths![0]!.pathId = "missing-path";
      if (failure === "disabled") path.activation = "disabled-final";
      if (failure === "unbounded-cap") path.capSemantics = { kind: "unbounded", bound: null };
      if (failure === "unbounded-impairment") path.claimImpairment = "unbounded";
      expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons)
        .toContain(`monetary-policy-path-inadmissible:Guarded registry:${failure === "missing" ? "missing-path" : "deposit-interest"}`);
    },
  );

  it("keeps affirmative D29 compilation unchanged when no monetary-policy block is authored", () => {
    const profile = monetaryVetoProfile();
    profile.governedIssuance!.decisionRule = "affirmative-vote";
    delete profile.governedIssuance!.veto;
    delete profile.governedIssuance!.monetaryPolicyPaths;
    profile.controls![0]!.executionScope!.paths[0]!.capabilities = ["upgrade"];
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons).toEqual([]);
  });

  it("excludes only certified dormant restructure-dependent paths while equity is above the gate", () => {
    expect(governedRows(restructureVetoProfile()).compiledRows[0]!.issuanceGovernance).toMatchObject({
      coverage: "complete", minUnavoidableDelaySec: 1_209_600,
      vetoOverride: "insolvency-gated-restructure", nonGovernorUnboundedPathKeys: [],
    });
  });

  it("requires a reachable certificate path containing every declared restructure selector", () => {
    const profile = restructureVetoProfile();
    profile.governedIssuance!.veto!.restructure!.entrypoints = ["0xeeeeeeee"];
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons)
      .toEqual(["restructure-path-missing"]);
    const scope = profile.controls![0]!.executionScope!;
    scope.paths.push({
      ...scope.paths[0]!, id: "restructure", entrypoints: ["0xeeeeeeee"], activation: "disabled-final",
    });
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons)
      .toEqual(["restructure-path-missing"]);
    scope.paths[scope.paths.length - 1]!.activation = "active";
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.coverage).toBe("complete");
  });

  it.each([1999, 1001, 1000, 999, 0])("fails closed at equity %i and retains bootstrap reach", (observedEquityUnits) => {
    const profile = restructureVetoProfile();
    profile.governedIssuance!.veto!.restructure!.observedEquityUnits = observedEquityUnits;
    expect(governedRows(profile).compiledRows[0]!.issuanceGovernance).toMatchObject({
      coverage: "incomplete", incompleteReasons: ["restructure-reachable"],
      minUnavoidableDelaySec: 0, nonGovernorUnboundedPathKeys: ["Bootstrap:issuance"],
    });
  });

  it.each(["missing-control", "missing-path", "active"] as const)(
    "rejects %s restructure-dependent reach", (failure) => {
      const profile = restructureVetoProfile();
      const dependent = profile.governedIssuance!.veto!.restructure!.dependentPaths[0]!;
      if (failure === "missing-control") dependent.controlRef = "ethereum:0x4444444444444444444444444444444444444444";
      if (failure === "missing-path") dependent.pathId = "missing-path";
      if (failure === "active") profile.controls![2]!.executionScope!.paths[0]!.activation = "active";
      expect(governedRows(profile).compiledRows[0]!.issuanceGovernance?.incompleteReasons)
        .toContain(`restructure-dependent-path-invalid:${failure === "missing-control" ? dependent.controlRef : "Bootstrap"}:${dependent.pathId}`);
    },
  );
});
