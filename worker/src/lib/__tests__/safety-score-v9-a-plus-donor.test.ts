import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { describe, expect, it } from "vitest";
import donorCapture from "./fixtures/safety-score-v9-a-plus-donor-capture.json";
import {
  computeReportCardsRegistryFingerprint,
  createReportCardsFixedInput,
  normalizeFixedInput,
  type ReportCardsFixedInputDraft,
} from "../report-cards-fixed-input";
import { buildSafetyScoreV9Candidate, computeSafetyScoreV9CandidateId } from "../safety-score-v9-candidate";
import {
  SafetyScoreV9FactSetExtensionV2Schema,
  type SafetyScoreV9FactSetExtensionV2,
} from "../safety-score-v9-fact-set";

const COMPOSITE_ID = "fixture-a-plus-composite";
const SUPPORT_ID = "usdc-circle";
const PUBLISHED_AT_SEC = 1_784_199_880;
const RETAINED_DONOR_REGISTRY_FINGERPRINT = "1778128d7fb2310eaac57c924f3a7b1110915427ab6dadd5c18b4712b6e6d76c";
const DAI_DEX_ROUTE_ID =
  "dex:dai-makerdao:dl:ethereum%3Afp%3Aethereum%3Acurve%3A0x6b175474e89094c44da98b954eedeac495271d0f%3A0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48%3A0xdac17f958d2ee523a2206206994597c13d831ec7:ethereum%3A0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI_REDEMPTION_ROUTE_ID = "redemption:dai-makerdao:psm-swap";
const RETAINED_344_ASSET_IDENTITY = {
  baseInputGenerationId: "report-cards-input:v1:eb6291212ca82c28388f2db1241b33749a677ea152515076fa0df0e27d03fd58",
  dexPayloadFingerprint: "9a11470413bf238373e5309e95ed89bc2b893ca4a5cfc254f20046c5fd2f13fe",
  redemptionPayloadFingerprint: "d84911de7b257e4754e6a5c7c4853b87c1c99812a2fecca6978481396203c33f",
  researchOverlayDigest: "0a6721d265d85611dc8b7d88fcccfabefb158e63013ebee72c3f9746b0b1dc15",
  factSetDigest: "89ae515b8be840a209988bfc73f5bea305bb3e66dce2b79f5340b47f687eaf99",
  evaluatedSetDigest: "26211b579c0699539d75692b2955e4b6befa15f0c256df63e40e0619335072a5",
  scoreResultDigest: "62928bec680d4f7137d7265f2f3f88300645c6f32885a865fe71370151e89718",
  publicationGenerationId:
    "report-cards:v9:candidate:v1:c88f3b245540f83e157d7948d9a1b239a493e7bdafe205a9ec2354bca51a7596",
} as const;

// The frozen donor capture lives in JSON so the epoch-shift reclocking tooling
// can rewrite it in place; the shapes below re-attach the production types the
// TS literals used to carry, and the suite schema-validates the load.
type DonorFixedInputFragment = Pick<
  ReportCardsFixedInputDraft,
  | "capturedAt"
  | "sourceGeneration"
  | "dexGenerationId"
  | "redemptionGenerationId"
  | "registryRevision"
  | "methodologyVersion"
  | "clockSec"
  | "updatedAt"
  | "liquidityStale"
  | "redemptionStale"
  | "inputFreshness"
  | "pegDataById"
  | "dexLiqMap"
  | "redemptionBackstopMap"
  | "resolvedBlacklistStatuses"
  | "liveReserveMap"
  | "liveReserveProvenanceMap"
  | "chainCirculatingById"
>;

type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
type DonorExtensionFragment = Omit<SafetyScoreV9FactSetExtensionV2, "assets"> & {
  assets: Array<{ assetId: string } & Partial<ExtensionAsset>>;
};

const donorFixed = donorCapture.fixedInput as unknown as DonorFixedInputFragment;
const donorReplay = { extension: donorCapture.extension as unknown as DonorExtensionFragment };

/**
 * Every donor whose review blocks this suite reads is a reviewed fiat-cash
 * asset with a reviewed control inventory and an access review, so the loader
 * narrows those three unions the TS literals used to narrow by inference.
 */
type DonorAsset = Omit<ExtensionAsset, "mechanismRiskReview" | "controlReview" | "accessReview"> & {
  mechanismRiskReview: Extract<
    NonNullable<ExtensionAsset["mechanismRiskReview"]>,
    { archetype: "fiat-cash" }
  >;
  controlReview: Extract<
    NonNullable<ExtensionAsset["controlReview"]>,
    { state: "reviewed-controls" }
  >;
  accessReview: NonNullable<ExtensionAsset["accessReview"]>;
};

function donorAsset(assetId: string): DonorAsset {
  const asset = donorReplay.extension.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) throw new Error(`Missing donor asset ${assetId}`);
  return asset as unknown as DonorAsset;
}

type DonorRouteReview = SafetyScoreV9FactSetExtensionV2["assets"][number]["routeReviews"][number];

function findDonorRouteReview(asset: { routeReviews: readonly DonorRouteReview[] }, routeId: string): DonorRouteReview {
  const review = asset.routeReviews.find((candidate) => candidate.routeId === routeId);
  if (!review) throw new Error(`Missing donor route review ${routeId}`);
  return review;
}

function findRoute<TRoute extends { routeId: string }>(routes: readonly TRoute[], routeId: string): TRoute {
  const route = routes.find((candidate) => candidate.routeId === routeId);
  if (!route) throw new Error(`Missing donor route ${routeId}`);
  return route;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ownerRekey(value: string): string {
  return value
    .replaceAll("dai-makerdao", COMPOSITE_ID)
    .replaceAll("sdola-inverse-finance", COMPOSITE_ID)
    .replaceAll("ausd-agora", COMPOSITE_ID);
}

function objectKeysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeysDeep);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...objectKeysDeep(child)]);
}

function buildFixture() {
  const sourceDex = donorFixed.dexLiqMap["dai-makerdao"]!;
  const dexObservation = clone(findRoute(sourceDex.exitRouteObservations!, DAI_DEX_ROUTE_ID));
  dexObservation.routeId = ownerRekey(dexObservation.routeId);
  const aggregateExecutableUsd = dexObservation.executableUsd;
  const sourceRedemption = donorFixed.redemptionBackstopMap["dai-makerdao"]!;
  const redemptionObservation = clone(sourceRedemption.capacityProfile!.exitRouteObservations![0]!);
  redemptionObservation.routeId = ownerRekey(redemptionObservation.routeId);

  const fixedInput = createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [COMPOSITE_ID, SUPPORT_ID],
    capturedAt: donorFixed.capturedAt,
    sourceGeneration: donorFixed.sourceGeneration,
    dexGenerationId: donorFixed.dexGenerationId,
    redemptionGenerationId: donorFixed.redemptionGenerationId,
    registryRevision: donorFixed.registryRevision,
    methodologyVersion: donorFixed.methodologyVersion,
    clockSec: donorFixed.clockSec,
    updatedAt: donorFixed.updatedAt,
    liquidityStale: donorFixed.liquidityStale,
    redemptionStale: donorFixed.redemptionStale,
    inputFreshness: clone(donorFixed.inputFreshness),
    pegDataById: {
      [COMPOSITE_ID]: {
        ...clone(donorFixed.pegDataById["bold-liquity"]),
        id: COMPOSITE_ID,
        symbol: "A+FIXTURE",
        name: "A+ donor composite",
      },
      [SUPPORT_ID]: clone(donorFixed.pegDataById[SUPPORT_ID]),
    },
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      [COMPOSITE_ID]: {
        liquidityScore: dexObservation.completionRatio * 100,
        concentrationHhi: 1,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: aggregateExecutableUsd,
        balanceMeasuredTvlUsd: aggregateExecutableUsd,
        organicMeasuredTvlUsd: aggregateExecutableUsd,
        deploymentCoverage: { observedPools: 1, verifiedNoPools: 0, providerInaccessible: 0 },
        exitRouteObservations: [dexObservation],
        exitRouteObservationCoverage: {
          status: "populated",
          capabilityMatrixVersion: "p4a.9",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1,
          scoreEligibleCapabilityPoolCount: 1,
          unsupportedPoolCount: 0,
          evidenceCounts: { "reserve-based-amm-simulation": 1 },
          unsupportedReasons: {},
        },
        methodologyVersion: sourceDex.methodologyVersion,
        updatedAt: sourceDex.updatedAt,
      },
      [SUPPORT_ID]: {
        liquidityScore: null,
        concentrationHhi: null,
        poolCount: 0,
        chainCount: 0,
        coverageClass: "unobserved",
        coverageConfidence: 0,
        liquidityEvidenceClass: "unobserved",
        hasMeasuredLiquidityEvidence: false,
        effectiveTvlUsd: 0,
        balanceMeasuredTvlUsd: 0,
        organicMeasuredTvlUsd: 0,
        deploymentCoverage: { observedPools: 0, verifiedNoPools: 0, providerInaccessible: 0 },
        exitRouteObservations: [],
        methodologyVersion: sourceDex.methodologyVersion,
        updatedAt: sourceDex.updatedAt,
      },
    },
    redemptionBackstopMap: {
      [COMPOSITE_ID]: {
        ...clone(sourceRedemption),
        stablecoinId: COMPOSITE_ID,
        capacityProfile: {
          ...clone(sourceRedemption.capacityProfile!),
          exitRouteObservations: [redemptionObservation],
        },
      },
    },
    bluechipMap: {},
    resolvedBlacklistStatuses: {
      [COMPOSITE_ID]: donorFixed.resolvedBlacklistStatuses["ausd-agora"],
      [SUPPORT_ID]: donorFixed.resolvedBlacklistStatuses[SUPPORT_ID],
    },
    liveReserveMap: { [COMPOSITE_ID]: clone(donorFixed.liveReserveMap[SUPPORT_ID]) },
    liveReserveProvenanceMap: {
      [COMPOSITE_ID]: clone(donorFixed.liveReserveProvenanceMap[SUPPORT_ID]),
    },
    chainCirculatingById: {
      [COMPOSITE_ID]: clone(donorFixed.chainCirculatingById["pusd-polymarket"]),
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });

  const agora = donorAsset("ausd-agora");
  const schuman = donorAsset("europ-schuman");
  const sdola = donorAsset("sdola-inverse-finance");
  const usdc = donorAsset(SUPPORT_ID);
  const dai = donorAsset("dai-makerdao");
  const bold = donorAsset("bold-liquity");
  const usdt = donorAsset("usdt-tether");
  const evidenceKeys = new Set([
    "stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6",
    "stablecoin-meta.bridge-route-risk:0:b203420e4331b092",
    "stablecoin-meta.bridge-route-risk:1:11466b79ead57814",
    "stablecoin-meta.bridge-route-risk:2:2fa668e2df97413e",
    "stablecoin-meta.mint-authority:0:8e07e78f0fb9a457",
    "stablecoin-meta.mint-authority:1:a0f7405d0bc5755d",
    "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
    "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
  ]);
  const researchEvidence = [...agora.researchEvidence, ...sdola.researchEvidence].filter((entry) =>
    evidenceKeys.has(entry.evidenceKey),
  );
  const componentEvidence = [...agora.componentEvidence, ...sdola.componentEvidence]
    .filter((binding) => binding.evidenceKeys.every((key: string) => evidenceKeys.has(key)))
    .map((binding) => ({ ...clone(binding), componentKey: ownerRekey(binding.componentKey) }));
  const sourceControl = clone(sdola.controlReview);
  sourceControl.controls = sourceControl.controls.map((control) => ({
    ...control,
    controlKey: ownerRekey(control.controlKey),
    deploymentKey: ownerRekey(control.deploymentKey),
  }));
  const accessReview = clone(agora.accessReview);
  accessReview.freeze.reviews = accessReview.freeze.reviews.map((review) => ({
    ...review,
    reviewKey: ownerRekey(review.reviewKey),
  }));
  const routeReviews = [
    findDonorRouteReview(dai, DAI_DEX_ROUTE_ID),
    findDonorRouteReview(dai, DAI_REDEMPTION_ROUTE_ID),
  ].map((review) => ({ ...clone(review), routeId: ownerRekey(review.routeId) }));

  const extension = SafetyScoreV9FactSetExtensionV2Schema.parse({
    ...clone(donorReplay.extension),
    registryFingerprint: fixedInput.registryFingerprint,
    assets: [
      {
        assetId: COMPOSITE_ID,
        archetype: "fiat-cash",
        launchedAtSec: usdt.launchedAtSec,
        mechanismRiskReview: {
          archetype: "fiat-cash",
          assuranceAndReconciliation: clone(agora.mechanismRiskReview.assuranceAndReconciliation),
          claimAndSegregation: clone(agora.mechanismRiskReview.claimAndSegregation),
          custodyContinuity: clone(schuman.mechanismRiskReview.custodyContinuity),
        },
        dependencies: clone(usdc.dependencies),
        reserveApplicability: clone(usdc.reserveApplicability),
        reserveClassifications: clone(usdc.reserveClassifications),
        routeReviews,
        retainedRoutes: [],
        controlReview: sourceControl,
        economicControlReview: clone(sdola.economicControlReview),
        accessReview,
        pegReference: clone(bold.pegReference),
        supplyReview: {
          selectedBridgeRoutes: [],
          selectedRouteSupplyShare: 0,
          unknownRouteSupplyShare: 1,
          unreviewedRouteSupplyShare: 0,
          failureDomains: [],
        },
        researchEvidence,
        componentEvidence,
      },
      {
        assetId: SUPPORT_ID,
        archetype: "unresolved",
        launchedAtSec: null,
        mechanismRiskReview: null,
        dependencies: null,
        reserveApplicability: { state: "not-applicable", rationale: "Support-only tracked output." },
        reserveClassifications: [],
        routeReviews: [],
        retainedRoutes: [],
        controlReview: null,
        economicControlReview: null,
        accessReview: null,
        pegReference: clone(usdc.pegReference),
        supplyReview: null,
        researchEvidence: [],
        componentEvidence: [],
      },
    ],
  } satisfies SafetyScoreV9FactSetExtensionV2);
  return { fixedInput, extension, donors: { agora, schuman, sdola, usdc, dai, bold, usdt } };
}

describe("Safety Score v9 real-donor A+ fixture", { timeout: 30_000 }, () => {
  it("attains A+ through the normal production compiler and evaluator", () => {
    const { fixedInput, extension, donors } = buildFixture();
    const result = buildSafetyScoreV9Candidate({
      fixedInput,
      extension,
      publishedAtSec: PUBLISHED_AT_SEC,
      policy: V9_CANDIDATE_POLICY_V1,
    });
    const repeatedFixture = buildFixture();
    const repeatedResult = buildSafetyScoreV9Candidate({
      fixedInput: repeatedFixture.fixedInput,
      extension: repeatedFixture.extension,
      publishedAtSec: PUBLISHED_AT_SEC,
      policy: V9_CANDIDATE_POLICY_V1,
    });
    const card = result.candidate.cards.find((candidate) => candidate.id === COMPOSITE_ID)!;
    const evaluated = result.evaluatedSet.assets.find((asset) => asset.assetId === COMPOSITE_ID)!;
    const compiled = result.compiledFacts.assets.find((asset) => asset.assetId === COMPOSITE_ID)!;
    const compositeExtension = extension.assets.find((asset) => asset.assetId === COMPOSITE_ID)!;
    const supportExtension = extension.assets.find((asset) => asset.assetId === SUPPORT_ID)!;
    const fixedDex = fixedInput.dexLiqMap[COMPOSITE_ID]!;
    const fixedDexObservation = fixedDex.exitRouteObservations![0]!;
    const fixedRedemptionObservation =
      fixedInput.redemptionBackstopMap[COMPOSITE_ID]!.capacityProfile!.exitRouteObservations![0]!;
    const sourceDexObservation = donorFixed.dexLiqMap["dai-makerdao"]!.exitRouteObservations![0]!;
    const sourceRedemptionObservation =
      donorFixed.redemptionBackstopMap["dai-makerdao"]!.capacityProfile!.exitRouteObservations![0]!;
    const sourceDexReview = findDonorRouteReview(donors.dai, DAI_DEX_ROUTE_ID);
    const sourceRedemptionReview = findDonorRouteReview(donors.dai, DAI_REDEMPTION_ROUTE_ID);
    const dexReview = compositeExtension.routeReviews.find((review) => review.lane === "dex")!;
    const redemptionReview = compositeExtension.routeReviews.find((review) => review.lane === "redemption")!;
    const currentGlobalRegistryFingerprint = computeReportCardsRegistryFingerprint();

    expect(stableJsonStringifyV1(repeatedResult)).toBe(stableJsonStringifyV1(result));
    expect(SafetyScoreV9FactSetExtensionV2Schema.parse(extension)).toEqual(extension);

    expect(fixedInput).toMatchObject({
      capturedAt: "2026-07-16T11:04:30.000Z",
      clockSec: 1_784_199_870,
      updatedAt: 1_784_199_667,
      inputFreshness: {
        dexLiquidity: { updatedAt: 1_784_198_459, ageSeconds: 1_411, stale: false },
        redemptionBackstops: { updatedAt: 1_784_175_209, ageSeconds: 24_661, stale: false },
      },
    });
    expect(extension).toMatchObject({
      compiledAtSec: 1_784_199_870,
      routeFreshness: {
        dexMaxAgeSec: 3_600,
        redemptionMaxAgeSec: 28_800,
        documentedTermsMaxAgeSec: 31_536_000,
      },
      sources: {
        registryObservedAtSec: 1_784_199_667,
        unavailableRedemptionObservedAtSec: 1_784_175_209,
        liveReserves: { observedAtSec: 1_784_189_884, maxAgeSec: 28_800 },
        chainSupply: { observedAtSec: 1_784_199_667, maxAgeSec: 1_800 },
        peg: { observedAtSec: 1_784_199_667, maxAgeSec: 1_800 },
        researchOverlays: { observedAtSec: 1_784_199_667, maxAgeSec: 31_536_000 },
      },
    });
    expect(fixedInput.dexLiqMap[COMPOSITE_ID]!.updatedAt).toBe(1_784_198_459);
    expect(fixedInput.dexLiqMap[SUPPORT_ID]!.updatedAt).toBe(1_784_198_459);
    expect(fixedInput.redemptionBackstopMap[COMPOSITE_ID]!.updatedAt).toBe(1_784_175_209);
    expect(fixedInput.liveReserveProvenanceMap[COMPOSITE_ID]!.fetchedAt).toBe(1_784_189_546);
    expect(result.compiledFacts).toMatchObject({ asOfSec: 1_784_199_870, compiledAtSec: 1_784_199_870 });
    expect(result.compiledFacts.sourceFingerprints).toMatchObject({
      registry: { observedAtSec: 1_784_199_667 },
      dex: { observedAtSec: 1_784_198_459 },
      redemption: { observedAtSec: 1_784_175_209 },
      liveReserves: { observedAtSec: 1_784_189_884 },
      chainSupply: { observedAtSec: 1_784_199_667 },
      peg: { observedAtSec: 1_784_199_667 },
      researchOverlays: { observedAtSec: 1_784_199_667 },
    });
    expect(result.evaluatedSet.asOfSec).toBe(1_784_199_870);
    expect(result.candidate).toMatchObject({ asOfSec: 1_784_199_870, publishedAtSec: PUBLISHED_AT_SEC });

    expect(fixedInput.activeAssetIds).toEqual([COMPOSITE_ID, SUPPORT_ID]);
    expect(extension.assets.map((asset) => asset.assetId)).toEqual([COMPOSITE_ID, SUPPORT_ID]);
    // The assembled fixture follows the current full catalog identity; the
    // frozen revision below remains the point-in-time Day1 donor receipt.
    expect(donorFixed.registryRevision).toBe(`sha256:${RETAINED_DONOR_REGISTRY_FINGERPRINT}`);
    expect(donorReplay.extension.registryFingerprint).toBe(RETAINED_DONOR_REGISTRY_FINGERPRINT);
    expect(fixedInput.registryFingerprint).toBe(currentGlobalRegistryFingerprint);
    expect(extension.registryFingerprint).toBe(currentGlobalRegistryFingerprint);
    expect(result.compiledFacts.sourceFingerprints.registry.payloadSha256).toBe(currentGlobalRegistryFingerprint);
    expect(fixedInput.baseInputGenerationId).not.toBe(RETAINED_344_ASSET_IDENTITY.baseInputGenerationId);
    expect(fixedInput.dexPayloadFingerprint).not.toBe(RETAINED_344_ASSET_IDENTITY.dexPayloadFingerprint);
    expect(fixedInput.redemptionPayloadFingerprint).not.toBe(RETAINED_344_ASSET_IDENTITY.redemptionPayloadFingerprint);
    expect(result.compiledFacts.sourceFingerprints.researchOverlays.payloadSha256).not.toBe(
      RETAINED_344_ASSET_IDENTITY.researchOverlayDigest,
    );

    expect(fixedDex).toMatchObject({
      liquidityScore: fixedDexObservation.completionRatio * 100,
      concentrationHhi: 1,
      poolCount: 1,
      chainCount: 1,
      effectiveTvlUsd: fixedDexObservation.executableUsd,
      balanceMeasuredTvlUsd: fixedDexObservation.executableUsd,
      organicMeasuredTvlUsd: fixedDexObservation.executableUsd,
      exitRouteObservationCoverage: {
        status: "populated",
        capabilityMatrixVersion: "p4a.9",
        retainedPoolCount: 1,
        observationCount: 1,
        scoreEligibleObservationCount: 1,
        scoreEligiblePoolCount: 1,
        scoreEligibleCapabilityPoolCount: 1,
        unsupportedPoolCount: 0,
        evidenceCounts: { "reserve-based-amm-simulation": 1 },
        unsupportedReasons: {},
      },
    });
    expect(fixedInput.dexLiqMap[SUPPORT_ID]).toMatchObject({
      liquidityScore: null,
      poolCount: 0,
      chainCount: 0,
      coverageClass: "unobserved",
      exitRouteObservations: [],
    });

    expect(fixedDexObservation.routeId).toBe(ownerRekey(sourceDexObservation.routeId));
    expect({ ...fixedDexObservation, routeId: sourceDexObservation.routeId }).toEqual(sourceDexObservation);
    expect(fixedRedemptionObservation.routeId).toBe(ownerRekey(sourceRedemptionObservation.routeId));
    expect({ ...fixedRedemptionObservation, routeId: sourceRedemptionObservation.routeId }).toEqual(
      sourceRedemptionObservation,
    );
    expect(fixedDexObservation.scope).toEqual(sourceDexObservation.scope);
    if (fixedDexObservation.scope.kind !== "chain-contract") throw new Error("Expected DAI chain-contract donor");
    expect(fixedDexObservation.scope.protocol).toBe("curve");
    expect(fixedRedemptionObservation.scope).toEqual({ kind: "protocol", protocol: "dai-makerdao" });
    expect(fixedDexObservation.output).toEqual(sourceDexObservation.output);
    expect(fixedRedemptionObservation.output).toEqual(sourceRedemptionObservation.output);
    expect(fixedDexObservation.output.trackedAssetIds).toEqual([SUPPORT_ID]);
    expect(fixedRedemptionObservation.output.trackedAssetIds).toEqual([SUPPORT_ID]);

    expect(dexReview.routeId).toBe(ownerRekey(sourceDexReview.routeId));
    expect({ ...dexReview, routeId: sourceDexReview.routeId }).toEqual(sourceDexReview);
    expect(redemptionReview.routeId).toBe(ownerRekey(sourceRedemptionReview.routeId));
    expect({ ...redemptionReview, routeId: sourceRedemptionReview.routeId }).toEqual(sourceRedemptionReview);
    expect(compositeExtension.routeReviews.map((review) => review.coverageClass)).toEqual([
      "exact-lower-bound",
      "exact-lower-bound",
    ]);
    expect(dexReview.physicalResourceKeys).toEqual([
      "pool:Ethereum:fp:ethereum:curve:0x6b175474e89094c44da98b954eedeac495271d0f:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:0xdac17f958d2ee523a2206206994597c13d831ec7",
    ]);
    expect(redemptionReview.physicalResourceKeys).toEqual(["protocol:dai-makerdao"]);
    expect(dexReview.output).toEqual(sourceDexReview.output);
    expect(redemptionReview.output).toEqual(sourceRedemptionReview.output);
    expect(fixedInput.pegDataById[SUPPORT_ID]).toEqual(donorFixed.pegDataById[SUPPORT_ID]);

    expect(compositeExtension.mechanismRiskReview).toEqual({
      archetype: "fiat-cash",
      assuranceAndReconciliation: donors.agora.mechanismRiskReview.assuranceAndReconciliation,
      claimAndSegregation: donors.agora.mechanismRiskReview.claimAndSegregation,
      custodyContinuity: donors.schuman.mechanismRiskReview.custodyContinuity,
    });
    expect(compositeExtension.dependencies).toEqual(donors.usdc.dependencies);
    expect(compositeExtension.reserveApplicability).toEqual(donors.usdc.reserveApplicability);
    expect(compositeExtension.reserveClassifications).toEqual(donors.usdc.reserveClassifications);
    expect(fixedInput.liveReserveMap[COMPOSITE_ID]).toEqual(donorFixed.liveReserveMap[SUPPORT_ID]);
    expect(fixedInput.liveReserveProvenanceMap[COMPOSITE_ID]).toEqual(donorFixed.liveReserveProvenanceMap[SUPPORT_ID]);
    expect(fixedInput.chainCirculatingById[COMPOSITE_ID]).toEqual(donorFixed.chainCirculatingById["pusd-polymarket"]);
    expect(compositeExtension.launchedAtSec).toBe(donors.usdt.launchedAtSec);
    expect(compositeExtension.pegReference).toEqual(donors.bold.pegReference);
    expect({
      ...fixedInput.pegDataById[COMPOSITE_ID],
      id: donorFixed.pegDataById["bold-liquity"].id,
      symbol: donorFixed.pegDataById["bold-liquity"].symbol,
      name: donorFixed.pegDataById["bold-liquity"].name,
    }).toEqual(donorFixed.pegDataById["bold-liquity"]);

    const sourceControl = donors.sdola.controlReview.controls[0];
    if (!compositeExtension.controlReview || !("controls" in compositeExtension.controlReview)) {
      throw new Error("Expected reviewed sDOLA control donor");
    }
    const compositeControl = compositeExtension.controlReview.controls[0]!;
    expect(compositeControl.controlKey).toBe(ownerRekey(sourceControl.controlKey));
    expect(compositeControl.deploymentKey).toBe(ownerRekey(sourceControl.deploymentKey));
    expect({
      ...compositeControl,
      controlKey: sourceControl.controlKey,
      deploymentKey: sourceControl.deploymentKey,
    }).toEqual(sourceControl);
    expect(compositeExtension.economicControlReview).toEqual(donors.sdola.economicControlReview);
    expect(compositeExtension.accessReview!.freeze.reviews[0]!.reviewKey).toBe(`blacklist:${COMPOSITE_ID}`);
    expect({
      ...compositeExtension.accessReview!.freeze.reviews[0],
      reviewKey: donors.agora.accessReview.freeze.reviews[0].reviewKey,
    }).toEqual(donors.agora.accessReview.freeze.reviews[0]);

    expect(compositeExtension.researchEvidence).toHaveLength(8);
    expect(compositeExtension.researchEvidence.map((entry) => entry.evidenceKey)).toEqual([
      "stablecoin-meta.blacklistability-review:0:b9898c8ea93851f6",
      "stablecoin-meta.bridge-route-risk:0:b203420e4331b092",
      "stablecoin-meta.bridge-route-risk:1:11466b79ead57814",
      "stablecoin-meta.bridge-route-risk:2:2fa668e2df97413e",
      "stablecoin-meta.mint-authority:0:8e07e78f0fb9a457",
      "stablecoin-meta.mint-authority:1:a0f7405d0bc5755d",
      "stablecoin-meta.oracle-risk:0:3d569028a463fce3",
      "stablecoin-meta.oracle-risk:1:479582b567ec9ab7",
    ]);
    expect(compositeExtension.researchEvidence).toEqual(
      [...donors.agora.researchEvidence, ...donors.sdola.researchEvidence].sort((left, right) =>
        left.evidenceKey.localeCompare(right.evidenceKey),
      ),
    );
    expect(compositeExtension.researchEvidence.filter((entry) => entry.sourceId.includes("blacklist"))).toHaveLength(1);
    expect(compositeExtension.researchEvidence.filter((entry) => entry.sourceId.includes("bridge-route"))).toHaveLength(
      3,
    );
    expect(
      compositeExtension.researchEvidence.filter((entry) => entry.sourceId.includes("mint-authority")),
    ).toHaveLength(2);
    expect(compositeExtension.researchEvidence.filter((entry) => entry.sourceId.includes("oracle-risk"))).toHaveLength(
      2,
    );
    expect(compositeExtension.componentEvidence).toHaveLength(12);
    expect(compositeExtension.componentEvidence).toEqual(
      [...donors.agora.componentEvidence, ...donors.sdola.componentEvidence]
        .map((binding) => ({ ...binding, componentKey: ownerRekey(binding.componentKey) }))
        .sort((left, right) => left.componentKey.localeCompare(right.componentKey)),
    );
    expect(
      compositeExtension.componentEvidence.filter((binding) => binding.componentKey.startsWith("access:")),
    ).toHaveLength(3);
    expect(
      compositeExtension.componentEvidence.filter(
        (binding) => binding.componentKey === "control" || binding.componentKey.startsWith("economic-control:"),
      ),
    ).toHaveLength(9);
    expect(
      compositeExtension.componentEvidence.find((binding) =>
        binding.componentKey.startsWith("access:freeze:blacklist:"),
      )!.componentKey,
    ).toBe(`access:freeze:blacklist:${COMPOSITE_ID}`);
    expect(compositeExtension.researchEvidence.some((entry) => entry.sourceId.includes("schuman"))).toBe(false);
    const compiledMechanismReview = compiled.mechanismRiskReview.review;
    if (!compiledMechanismReview || compiledMechanismReview.archetype !== "fiat-cash") {
      throw new Error("Expected compiled fiat-cash donor review");
    }
    expect(compiledMechanismReview.custodyContinuity.status.evidenceRefIds).toEqual([
      `${COMPOSITE_ID}:research-overlay`,
    ]);

    expect(supportExtension).toMatchObject({
      assetId: SUPPORT_ID,
      archetype: "unresolved",
      routeReviews: [],
      researchEvidence: [],
      componentEvidence: [],
    });
    const directResultKeys = [
      "score",
      "grade",
      "pillarScores",
      "weightedQuality",
      "preCapScore",
      "caps",
      "bindingCap",
      "scoreOverride",
      "assetSpecificException",
    ];
    expect(objectKeysDeep(compositeExtension).filter((key) => directResultKeys.includes(key))).toEqual([]);
    expect(objectKeysDeep(compiled).filter((key) => directResultKeys.includes(key))).toEqual([]);

    const compiledDexRoute = compiled.exitRoutes.find((route) => route.routeId === fixedDexObservation.routeId)!;
    const compiledRedemptionRoute = compiled.exitRoutes.find(
      (route) => route.routeId === fixedRedemptionObservation.routeId,
    )!;
    expect(compiledDexRoute.output.assetKeys).toEqual([SUPPORT_ID]);
    expect(compiledRedemptionRoute.output.assetKeys).toEqual([SUPPORT_ID]);
    expect(compiledDexRoute.output.valuation).toMatchObject({
      basis: dexReview.output!.valuation!.basis,
      referenceAssetKey: SUPPORT_ID,
      unitValueUsd: dexReview.output!.valuation!.unitValueUsd,
      expectedUnitValueUsd: dexReview.output!.valuation!.expectedUnitValueUsd,
      sourceId: dexReview.output!.valuation!.sourceId,
      sourceGenerationId: dexReview.output!.valuation!.sourceGenerationId,
      observedAtSec: dexReview.output!.valuation!.observedAtSec,
    });
    expect(compiledRedemptionRoute.output.valuation).toMatchObject({
      basis: redemptionReview.output!.valuation!.basis,
      referenceAssetKey: SUPPORT_ID,
      unitValueUsd: redemptionReview.output!.valuation!.unitValueUsd,
      expectedUnitValueUsd: redemptionReview.output!.valuation!.expectedUnitValueUsd,
      sourceId: redemptionReview.output!.valuation!.sourceId,
      sourceGenerationId: redemptionReview.output!.valuation!.sourceGenerationId,
      observedAtSec: redemptionReview.output!.valuation!.observedAtSec,
    });

    expect(card).toMatchObject({ id: COMPOSITE_ID, score: 88, grade: "A+", evidence: { level: "strong" } });
    expect(evaluated).toMatchObject({
      backing: { score: 92.42609075 },
      exit: { score: 79.44 },
      control: { score: 95 },
      trace: {
        pegMultiplier: 1,
        weightedQuality: 88.5244,
        aggregation: { weightedQuality: 88.5244, weakestScore: 79.44, headroom: 20, score: 87.9473 },
        preCapScore: 87.9473,
        bindingCap: null,
      },
    });
    const rawAuditScore = evaluated.trace.pillarContributions.reduce(
      (sum, contribution) => sum + contribution.score * contribution.weight,
      0,
    );
    expect(rawAuditScore).toBe(88.5244363);
    expect(card.pillars).toMatchObject({
      backing: { score: 92.42609075, evidenceLevel: "strong", reasons: [] },
      exit: { score: 79.44, evidenceLevel: "strong", reasons: [] },
      control: { score: 95, evidenceLevel: "strong", reasons: [] },
    });
    expect(compiled.gaps).toEqual([]);
    expect(card.nrReasons).toEqual([]);
    expect(card.evidence).toMatchObject({ level: "strong", reasons: [] });
    expect(card.caps).toEqual([]);
    expect(card.bindingCap).toBeNull();
    expect(evaluated.trace.bindingCap).toBeNull();

    expect(result.compiledFacts.baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
    expect(result.compiledFacts.activeAssetIds).toEqual(fixedInput.activeAssetIds);
    expect(result.compiledFacts.sourceFingerprints.dex.payloadSha256).toBe(fixedInput.dexPayloadFingerprint);
    expect(result.compiledFacts.sourceFingerprints.redemption.payloadSha256).toBe(
      fixedInput.redemptionPayloadFingerprint,
    );
    expect(result.evaluatedSet.baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
    expect(result.candidate.baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
    expect(result.evaluatedSet.factSetDigest).toBe(result.compiledFacts.v9FactSetDigest);
    expect(result.candidate.factSetDigest).toBe(result.compiledFacts.v9FactSetDigest);
    expect(result.candidate.resultDigest).toBe(result.evaluatedSet.scoreResultDigest);
    expect(evaluated.trace.factSetDigest).toBe(result.compiledFacts.v9FactSetDigest);
    expect(evaluated.trace.baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
    expect(result.candidate.policy.semanticDigest).toBe(result.evaluatedSet.policyDigest);
    expect(result.candidate.evaluationBuildDigest).toBe(result.evaluatedSet.evaluationBuildDigest);
    expect(result.candidate.candidateId).toBe(computeSafetyScoreV9CandidateId(result.candidateIdentity));
    expect(result.compiledFacts.v9FactSetDigest).not.toBe(RETAINED_344_ASSET_IDENTITY.factSetDigest);
    expect(result.evaluatedSet.evaluatedSetDigest).not.toBe(RETAINED_344_ASSET_IDENTITY.evaluatedSetDigest);
    expect(result.evaluatedSet.scoreResultDigest).not.toBe(RETAINED_344_ASSET_IDENTITY.scoreResultDigest);
    expect(result.candidate.resultDigest).not.toBe(RETAINED_344_ASSET_IDENTITY.scoreResultDigest);
    expect(result.candidate.publicationGenerationId).not.toBe(RETAINED_344_ASSET_IDENTITY.publicationGenerationId);
    expect(compiled.evidence.every((entry) => entry.evidenceId.startsWith(`${COMPOSITE_ID}:`))).toBe(true);
    expect(
      compiled.evidence.some((entry) =>
        ["ausd-agora:", "dai-makerdao:", "europ-schuman:", "sdola-inverse-finance:"].some((prefix) =>
          entry.evidenceId.startsWith(prefix),
        ),
      ),
    ).toBe(false);
  });

  it("loads the frozen donor capture through the production schemas", () => {
    // The capture is stored as JSON so the epoch-shift reclocking tooling can
    // rewrite it in place; these guards keep the load honest now that the TS
    // `satisfies` checks no longer stand between the file and the suite.
    expect(JSON.parse(JSON.stringify(donorCapture))).toEqual(donorCapture);
    expect(donorReplay.extension.assets.map((asset) => asset.assetId)).toEqual([
      "ausd-agora",
      "bold-liquity",
      "dai-makerdao",
      "europ-schuman",
      "sdola-inverse-finance",
      "usdc-circle",
      "usdt-tether",
    ]);

    // Donor assets are deliberately partial fragments, so the capture is
    // validated the only way it can be: assembled into the two-asset fixture and
    // parsed by the production fixed-input and extension schemas.
    const { fixedInput, extension } = buildFixture();
    expect(normalizeFixedInput(fixedInput)).toEqual(fixedInput);
    expect(SafetyScoreV9FactSetExtensionV2Schema.parse(extension)).toEqual(extension);
    expect(extension).toMatchObject({
      compiledAtSec: donorReplay.extension.compiledAtSec,
      routeFreshness: donorReplay.extension.routeFreshness,
      sources: donorReplay.extension.sources,
    });
  });
});
