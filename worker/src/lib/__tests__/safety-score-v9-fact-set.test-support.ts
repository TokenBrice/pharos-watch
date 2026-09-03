import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import type { SafetyScoreV9ReviewedTransferFact } from "../safety-score-v9/extension-transfer";
import {
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9/extension";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9/extension-routes";
import type { SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  makeV9FixedInput as exactFixedInput,
  makeV9TwoAssetFixedInput as exactTwoAssetFixedInput,
  makeV9Extension as makeV9Extension,
  makeV9QueuedRedemptionFixedInput as queuedRedemptionFixedInput,
  v9Status as status,
} from "../../test-helpers/v9-fixed-input";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import usdtMetaSource from "@shared/data/stablecoins/coins/usdt-tether.json";
import usdtComplianceSource from "@shared/data/stablecoins/domains/compliance/usdt-tether.json";
import usdtMintAuthoritySource from "@shared/data/stablecoins/domains/mint-authority/usdt-tether.json";
import usdtReserveSource from "@shared/data/stablecoins/domains/reserves/usdt-tether.json";
import usdtRiskReviewSource from "@shared/data/stablecoins/domains/risk-review/usdt-tether.json";

export type FixedInput = ReturnType<typeof exactFixedInput>;
type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
type ControlOverlay = NonNullable<Extract<NonNullable<ExtensionAsset["controlReview"]>, { state: "partially-reviewed-controls" }>>["controls"][number];
type BridgeRoute = NonNullable<NonNullable<V9ExtensionRegistryMeta["bridgeRouteRisk"]>["routes"]>[number];

export function metaMap(...metas: V9ExtensionRegistryMeta[]): Map<string, V9ExtensionRegistryMeta> {
  return new Map(metas.map((meta) => [meta.id, meta]));
}

export function alphaMeta(overrides: Partial<V9ExtensionRegistryMeta> = {}): V9ExtensionRegistryMeta {
  return {
    id: "alpha",
    mechanismArchetype: "fiat-cash",
    launchDate: "1970-01-01",
    ...overrides,
  };
}

export function pinnedUusdMeta(): Map<string, V9ExtensionRegistryMeta> {
  const meta = structuredClone(ACTIVE_META_BY_ID.get("uusd-anything-labs")!);
  meta.mintAuthority!.review.reviewedAt = "2026-08-08";
  return new Map([["uusd-anything-labs", meta as V9ExtensionRegistryMeta]]);
}

export function commodityOracleMeta(): V9ExtensionRegistryMeta {
  return alphaMeta({
    mechanismArchetype: "commodity-claim",
    mintAuthority: {
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      confidence: "verified",
      summary: "Prudential issuer fixture.",
      supervision: "prudential",
      review: {
        sources: [{ label: "Supervisor", url: "https://example.com/supervisor" }],
        evidence: "The issuer is prudentially supervised.",
        reviewer: "Fixture reviewer",
        reviewedAt: "1970-01-01",
      },
    },
  });
}

function reviewedBranch(): NonNullable<NonNullable<V9ExtensionRegistryMeta["oracleRisk"]>["branches"]>[number] {
  return {
    id: "eth",
    label: "ETH branch",
    tier: "redundant-with-failover",
    summary: "The ETH branch has complete reviewed controls.",
    feeds: [{ provider: "Fixture", path: "ETH/USD", chain: "ethereum" }],
    collateralParameters: [{ asset: "ETH", minimumCollateralRatioPct: 120 }],
    liquidationMechanism: "Immediate permissionless liquidation through the branch.",
    liquidationDelaySec: 0,
    backstop: "A dedicated stability pool absorbs liquidated debt.",
    shutdownOrBadDebtBehavior: "The branch shuts down and exposes residual bad debt explicitly.",
    sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
  };
}

export function reviewedOracleMeta(reviewedAt = "1970-01-01"): V9ExtensionRegistryMeta {
  return alphaMeta({
    mechanismArchetype: "cdp",
    oracleRisk: {
      tier: "redundant-with-failover",
      summary: "The fixture has reviewed oracle and liquidation branch behavior.",
      branchModel: "multi-branch",
      branchApplicability: {
        disposition: "branches-required",
        reviewedAt,
        reviewer: "Fixture reviewer",
        rationale: "The collateral market requires explicit branch evidence.",
        sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
      },
      reviewedAt,
      reviewer: "Fixture reviewer",
      confidence: "verified",
      sources: [{ label: "Oracle docs", url: "https://example.com/oracle" }],
      branches: [reviewedBranch()],
    },
  });
}

export function internalPriceMeta(): V9ExtensionRegistryMeta {
  return alphaMeta({
    mechanismArchetype: "synthetic-delta-neutral",
    oracleRisk: {
      tier: "privileged-internal-pricing",
      summary: "A privileged backend constructs the economically effective mint and redemption quote.",
      branchModel: "single-path",
      branchApplicability: {
        disposition: "top-level-only",
        reviewedAt: "1970-01-01",
        reviewer: "Fixture reviewer",
        rationale: "The price authority applies without borrower liquidation branches.",
        sources: [{ label: "Pricing docs", url: "https://example.com/pricing" }],
      },
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      confidence: "verified",
      sources: [{ label: "Pricing docs", url: "https://example.com/pricing" }],
    },
  });
}

export function immutableMintMeta(): V9ExtensionRegistryMeta {
  return alphaMeta({
    mechanismArchetype: "cdp",
    mintAuthority: {
      mintPath: "immutable-user-collateralized",
      authorityPosture: "none-resolved",
      confidence: "verified",
      summary: "Protocol contracts mediate issuance and no privileged issuer minter is resolved.",
      controls: [{ chain: "ethereum", address: "0x2222222222222222222222222222222222222222", label: "Protocol token", role: "other", authorityType: "contract", directMintAbility: "none", sources: [{ label: "Token docs", url: "https://example.com/token" }] }],
      review: { sources: [{ label: "Token docs", url: "https://example.com/token" }], evidence: "The token mint path is reviewed without a separate upgradeability conclusion.", reviewer: "Fixture reviewer", reviewedAt: "1970-01-01" },
    },
  });
}

export function cappedMinterMeta(governorChain: "ethereum" | "arbitrum" = "ethereum"): V9ExtensionRegistryMeta {
  return alphaMeta({
    mechanismArchetype: "cdp",
    mintAuthority: {
      mintPath: "user-collateralized-governed",
      authorityPosture: "partially-bounded-admin",
      confidence: "verified",
      summary: "A protocol adapter mints within a cap that a separate governor can raise.",
      upgradeability: { model: "immutable", canChangeMintLogic: false, sources: [{ label: "Contract source", url: "https://example.com/source" }] },
      controls: [
        { chain: "ethereum", address: "0x1111111111111111111111111111111111111111", label: "Capped protocol minter", role: "direct-minter", authorityType: "contract", directMintAbility: "cap-limited", canRaiseCap: false, sources: [{ label: "Minter docs", url: "https://example.com/minter" }] },
        { chain: governorChain, address: "0x2222222222222222222222222222222222222222", label: "Cap governor", role: "governor", authorityType: "dao-governor", directMintAbility: "parameter-only", canRaiseCap: true, sources: [{ label: "Governance docs", url: "https://example.com/governance" }] },
      ],
      review: { sources: [{ label: "Minter docs", url: "https://example.com/minter" }], evidence: "The capped mint path and the separate cap-raising governor are both reviewed.", reviewer: "Fixture reviewer", reviewedAt: "1970-01-01" },
    },
  });
}

export function accessOnlyMeta(): V9ExtensionRegistryMeta {
  return alphaMeta({
    mechanismArchetype: "cdp",
    mintAuthority: {
      mintPath: "immutable-user-collateralized",
      authorityPosture: "none-resolved",
      confidence: "verified",
      summary: "Immutable user issuance includes a non-claiming control with no privileged authority identity.",
      upgradeability: { model: "immutable", canChangeMintLogic: false, sources: [{ label: "Token source", url: "https://example.com/token" }] },
      controls: [{ label: "Non-claiming protocol surface", role: "other", authorityType: "none", directMintAbility: "none", canRaiseCap: false, sources: [{ label: "Token source", url: "https://example.com/token" }] }],
      review: { sources: [{ label: "Token source", url: "https://example.com/token" }], evidence: "The reviewed surface cannot mint or impair the protocol claim.", reviewer: "Fixture reviewer", reviewedAt: "1970-01-01" },
    },
  });
}

export function reviewedUpgradeExtension(): SafetyScoreV9FactSetExtensionV2 {
  const reviewed = makeV9Extension();
  const asset = reviewed.assets[0]!;
  const bridgeDeploymentKey = "ethereum:0x3333333333333333333333333333333333333333";
  const bridgeControlKey = "bridge:unresolved";
  const mintControlKey = "mint:unresolved";
  const upgradeControlKey = "upgrade:reviewed";
  asset.controlReview = {
    state: "partially-reviewed-controls",
    rationale: "The upgrade authority is reviewed, while bridge and direct-minter identities remain unresolved.",
    controls: [
      localControl({ controlKey: bridgeControlKey, deploymentKey: bridgeDeploymentKey, controlKind: "bridge", scope: "deployment", capabilities: ["bridge-mint"], capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", economicLossScope: "deployment", authority: { authorityKey: `bridge-route:${bridgeDeploymentKey}`, model: "unknown", threshold: null }, materialSupplyShare: 1, failureDomains: [{ kind: "bridge-route", key: bridgeDeploymentKey }] }),
      localControl({ controlKey: mintControlKey, controlKind: "mint", capabilities: ["mint"], capSemantics: { kind: "raiseable", bound: null }, claimImpairment: "bounded", economicLossScope: "global-claim", authority: null, materialSupplyShare: null, failureDomains: [] }),
      localControl({ controlKey: upgradeControlKey, controlKind: "upgrade", capabilities: ["upgrade"], capSemantics: { kind: "not-applicable", bound: null }, claimImpairment: "unbounded", economicLossScope: "global-claim", authority: { authorityKey: "ethereum:0x4444444444444444444444444444444444444444", model: "multisig", threshold: { required: 3, total: 6 } }, materialSupplyShare: null, failureDomains: [{ kind: "upgrade-control", key: "ethereum:0x4444444444444444444444444444444444444444" }] }),
    ],
  };
  asset.economicControlReview = {
    ...asset.economicControlReview!,
    mint: { status: status("known", "v9.control.mint-review"), controlKey: mintControlKey, reconciliation: "not-applicable", supervision: "unknown", latestResolvedIncidentAtSec: null, upgrade: { state: "reviewed", controlKey: upgradeControlKey } },
    bridge: { status: boundedStatus("v9.control.bridge-review", "extension-gap:bridge:alpha"), routes: [] },
  };
  asset.supplyReview = { selectedBridgeRoutes: [{ deploymentRouteKey: bridgeDeploymentKey, supplyUsd: 10_000_000, supplyShare: 1, reviewState: "selected-unresolved" }], selectedRouteSupplyShare: 0, unknownRouteSupplyShare: 0, unreviewedRouteSupplyShare: 1, failureDomains: [{ kind: "bridge-route", key: bridgeDeploymentKey }] };
  return reviewed;
}

export function unresolvedMintMeta(): V9ExtensionRegistryMeta {
  return alphaMeta({
    mechanismArchetype: "cdp",
    mintAuthority: {
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      confidence: "unknown",
      summary: "A reviewed issuer backend can mint the fixture token directly.",
      controls: [{
        chain: "ethereum",
        address: "0x1111111111111111111111111111111111111111",
        label: "Issuer minter",
        role: "direct-minter",
        authorityType: "issuer-backend",
        directMintAbility: "direct",
        sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
      }],
      review: {
        sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
        evidence: "The issuer minter path is reviewed, but reconciliation and upgrades are not established.",
        reviewer: "Fixture reviewer",
        reviewedAt: "1970-01-01",
        disposition: "unresolved",
        unresolvedQuestions: ["Reconciliation cadence and upgrade authority are not yet established."],
      },
    },
  });
}

export function strategyVaultExtension(): SafetyScoreV9FactSetExtensionV2 {
  const extension = makeV9Extension();
  extension.assets[0]!.variantKind = "strategy-vault";
  return extension;
}

export function localControl(overrides: Partial<ControlOverlay> = {}): ControlOverlay {
  return {
    controlKey: "custody:reviewed",
    deploymentKey: "asset:alpha",
    controlKind: "custody",
    scope: "global",
    capabilities: ["custody-transfer"],
    capSemantics: { kind: "bounded", bound: { amount: 0.25, unit: "supply-fraction" } },
    claimImpairment: "bounded",
    economicLossScope: "reserve-claim",
    authority: {
      authorityKey: "ethereum:0x4444444444444444444444444444444444444444",
      model: "multisig",
      threshold: { required: 3, total: 6 },
    },
    delaySec: 604_800,
    materialSupplyShare: null,
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: "none",
    failureDomains: [{ kind: "reserve-custodian", key: "issuer:alpha" }],
    ...overrides,
  };
}

export function boundedStatus(policyRuleId: string, gapId: string) {
  return {
    applicability: { state: "required" as const, policyRuleId, rationale: null, gapId: null },
    observationState: "bounded-unknown" as const,
    evidenceRefIds: ["placeholder:evidence"],
    gapIds: [gapId],
  };
}

export function rebuildFixed(fixed: FixedInput): FixedInput {
  const {
    schemaVersion: _schemaVersion,
    dexPayloadFingerprint: _dexPayloadFingerprint,
    redemptionPayloadFingerprint: _redemptionPayloadFingerprint,
    registryFingerprint: _registryFingerprint,
    inputMethodologyVersions: _inputMethodologyVersions,
    baseInputGenerationId: _baseInputGenerationId,
    ...draft
  } = fixed;
  return createReportCardsFixedInput(draft);
}

export function withRedemptionRoute(
  fixed: ReturnType<typeof queuedRedemptionFixedInput>,
  overrides: Record<string, unknown> = {},
): SafetyScoreV9FactSetExtensionV2 {
  const reviewed = strategyVaultExtension();
  reviewed.registryFingerprint = fixed.registryFingerprint;
  reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha").map((review) =>
    review.lane === "redemption" ? { ...review, ...overrides } : review,
  );
  reviewed.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, "alpha");
  return reviewed;
}

export function bridgeRoute(
  id: string,
  disposition: "reviewed" | "unresolved" = "unresolved",
): BridgeRoute {
  const chain = id.slice(0, id.indexOf(":"));
  return {
    id,
    destinationChain: chain,
    contractAddress: id.slice(id.indexOf(":") + 1),
    protocol: disposition === "reviewed" ? "Fixture native issuance" : "Unresolved fixture route",
    issuanceModel: disposition === "reviewed" ? "native-issuance" : "unknown",
    routeClass: disposition === "reviewed" ? "native" : "unknown",
    riskTier: disposition === "reviewed" ? "single-chain-or-native" : "opaque-or-unknown",
    semantics: disposition === "reviewed" ? "native-mint" : "unknown",
    scope: disposition === "reviewed" ? "canonical" : "unknown",
    reviewDisposition: disposition,
    ...(disposition === "unresolved" ? { reviewNote: "The route semantics remain unresolved." } : {}),
    observedAt: "1970-01-01",
    ...(disposition === "reviewed" ? { sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }] } : {}),
  } as BridgeRoute;
}

export function bridgeMeta(
  routes: BridgeRoute[],
  overrides: Partial<NonNullable<V9ExtensionRegistryMeta["bridgeRouteRisk"]>> = {},
): V9ExtensionRegistryMeta {
  return alphaMeta({
    bridgeRouteRisk: {
      tier: "canonical-rollup-bridge",
      summary: "A reviewed bridge inventory for the fixture token.",
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      confidence: "verified",
      sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
      routes,
      ...overrides,
    },
  });
}

export function reviewedLockMintRoute(id: string): BridgeRoute {
  return {
    ...bridgeRoute(id, "reviewed"),
    issuanceModel: "bridge-representation",
    routeClass: "canonical",
    riskTier: "canonical-rollup-bridge",
    semantics: "lock-mint",
    scope: "peripheral",
    protocol: "Fixture canonical bridge",
  };
}

export function materialityFixture(unresolvedShare: number | null) {
  const totalSupply = 1_000;
  const reviewedShare = 0.05;
  const row = (current: number) => ({
    current,
    circulatingPrevDay: current,
    circulatingPrevWeek: current,
    circulatingPrevMonth: current,
  });
  const fixed = exactFixedInput({
    chainSupplyByChain:
      unresolvedShare === null
        ? {}
        : {
            ethereum: row(totalSupply * (1 - reviewedShare - unresolvedShare)),
            base: row(totalSupply * reviewedShare),
            polygon: row(totalSupply * unresolvedShare),
          },
  });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: metaMap(
      bridgeMeta([
        {
          ...bridgeRoute("ethereum:0x1111111111111111111111111111111111111111", "reviewed"),
          destinationChain: "ethereum",
          canonicalChain: "ethereum",
          issuanceModel: "native-issuance",
          routeClass: "native",
          riskTier: "single-chain-or-native",
          semantics: "native-mint",
          scope: "canonical",
        },
        {
          ...reviewedLockMintRoute("base:0x2222222222222222222222222222222222222222"),
          sourceChain: "ethereum",
          destinationChain: "base",
          canonicalChain: "ethereum",
        },
        {
          ...bridgeRoute("polygon:0x3333333333333333333333333333333333333333"),
          destinationChain: "polygon",
        },
      ]),
    ),
  });
  return { fixed, extension, asset: extension.assets[0]! };
}

export function unmatchedFixture(
  chainShares: Record<string, number>,
  extraRoutes: BridgeRoute[] = [],
) {
  const fixed = exactFixedInput({
    chainSupplyByChain: Object.fromEntries(
      Object.entries(chainShares).map(([chain, share]) => [chain, {
        current: share * 10_000,
        circulatingPrevDay: share * 10_000,
        circulatingPrevWeek: share * 10_000,
        circulatingPrevMonth: share * 10_000,
      }]),
    ),
  });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: metaMap(bridgeMeta([bridgeRoute("ethereum:0x1111111111111111111111111111111111111111", "reviewed"), ...extraRoutes])),
  });
  return { fixed, extension, asset: extension.assets[0]! };
}

export function usdtMeta(): V9ExtensionRegistryMeta {
  return {
    ...usdtMetaSource,
    ...withoutId(usdtComplianceSource),
    ...withoutId(usdtMintAuthoritySource),
    ...withoutId(usdtReserveSource),
    ...withoutId(usdtRiskReviewSource),
  } as unknown as V9ExtensionRegistryMeta;
}

function withoutId<T extends { id: string }>({ id: _id, ...fields }: T): Omit<T, "id"> {
  return fields;
}

export function attestedReserveMeta(): V9ExtensionRegistryMeta {
  return alphaMeta({
    reserves: [
      {
        name: "Treasury bills",
        pct: 70.01,
        risk: "very-low",
        assetClass: "treasury-bill",
        issuerOrObligor: "United States Treasury",
        riskFactors: ["duration", "liquidity", "custody"],
        liquidityHorizon: "one-day",
        maturityDaysMax: 30,
      },
      {
        name: "Cash",
        pct: 30,
        risk: "very-low",
        assetClass: "bank-deposit",
        issuerOrObligor: "Commercial banks",
        riskFactors: ["counterparty", "custody"],
        liquidityHorizon: "immediate",
      },
    ],
    reserveReview: {
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      confidence: "verified",
      sources: [{ label: "Composition", url: "https://example.com/composition" }],
      rationale: "Complete composition from the signed report.",
      compositionBasis: "Signed report",
      compositionAsOf: "1970-01-01",
      scope: "full-composition",
      knownUnknownExposure: "None",
      knownUnknownExposurePct: 0,
    },
    proofOfReserves: {
      type: "independent-audit",
      url: "https://example.com/transparency",
      provider: "Independent LLP",
      attestorTier: "regional",
      cadence: "monthly",
      latestReport: {
        periodEnd: "1970-01-01",
        publishedAt: "1970-01-01",
        assuranceMethod: "examination",
        scope: "assets-and-liabilities",
        liabilityReconciliation: "full",
        reviewer: "Fixture reviewer",
        confidence: "verified",
        sources: [{ label: "Signed report", url: "https://example.com/report.pdf" }],
      },
    },
    mintAuthority: {
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      confidence: "verified",
      summary: "Prudential issuer fixture.",
      supervision: "prudential",
      review: {
        sources: [{ label: "Supervisor", url: "https://example.com/supervisor" }],
        evidence: "The issuer is prudentially supervised.",
        reviewer: "Fixture reviewer",
        reviewedAt: "1970-01-01",
      },
    },
  });
}

export function dependencyMeta(): Map<string, V9ExtensionRegistryMeta> {
  const dependencyReview = {
    reviewedAt: "1970-01-01",
    reviewer: "Fixture reviewer",
    confidence: "manual-review" as const,
    sources: [{ label: "Fixture dependency analysis", url: "https://example.com/dependencies/alpha" }],
    rationale: "Beta is a reviewed collateral dependency.",
    relationships: [{ id: "beta", weight: 0.5, type: "collateral" as const, reason: "Half of the reviewed backing is Beta." }],
  };
  return metaMap(
    alphaMeta({ dependencies: [{ id: "beta", weight: 0.5, type: "collateral" }], dependencyReview }),
    alphaMeta({ id: "beta" }),
  );
}

export function transferFact(posture: "permissionless" | "restrictable" | "permissioned"): SafetyScoreV9ReviewedTransferFact {
  return {
    assetId: "alpha",
    reviewedAt: "1970-01-01",
    reviewer: "Fixture reviewer",
    deployments: [{
      chainId: "ethereum",
      contractOrTokenId: "0xalpha",
      scope: "canonical",
      posture,
      evidence: "The verified token implementation establishes this deployment posture.",
      sources: [{ label: "Verified token source", url: "https://example.com/token-source" }],
    }],
  };
}

export function buildTransferBaseline(
  fixed: FixedInput,
  reviewedStatus: true | false | "possible",
  transferReview?: SafetyScoreV9ReviewedTransferFact,
  options: { blacklistReviewedAt?: string; contracts?: Array<{ chain: string; address: string; decimals: number }> } = {},
) {
  return buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: metaMap(alphaMeta({
      contracts: options.contracts ?? [
        { chain: "ethereum", address: "0xalpha", decimals: 18 },
        { chain: "base", address: "0xbeta", decimals: 18 },
      ],
      blacklistabilityReview: {
        sources: [{ label: "Reviewed token controls", url: "https://example.com/token-controls" }],
        evidence: "The reviewed token controls establish the authored blacklist status.",
        reviewer: "Fixture reviewer",
        reviewedAt: options.blacklistReviewedAt ?? "1970-01-01",
        reviewedStatus,
      },
    })),
    reviewedTransferFacts: new Map(transferReview ? [["alpha", transferReview]] : []),
  });
}

export function nativeSavingsFixedAndMeta() {
  const original = exactTwoAssetFixedInput({ mapAlphaCollateral: true });
  const redemptionInput = queuedRedemptionFixedInput();
  const {
    schemaVersion: _schemaVersion,
    activeAssetIds: _activeAssetIds,
    dexPayloadFingerprint: _dexPayloadFingerprint,
    redemptionPayloadFingerprint: _redemptionPayloadFingerprint,
    registryFingerprint: _registryFingerprint,
    inputMethodologyVersions: _inputMethodologyVersions,
    baseInputGenerationId: _baseInputGenerationId,
    ...draft
  } = original;
  const parentReserve = structuredClone(original.liveReserveMap.alpha![0]!);
  parentReserve.pct = 100;
  const redemption = structuredClone(redemptionInput.redemptionBackstopMap.alpha!);
  const observation = redemption.capacityProfile!.exitRouteObservations![0]!;
  observation.requestedNotionalUsd = 10_000_000;
  observation.executableUsd = 10_000_000;
  observation.completionRatio = 1;
  observation.capacityCurve = [...observation.capacityCurve!, {
    requestedNotionalUsd: 10_000_000,
    maxCostBps: 200,
    executableUsd: 10_000_000,
    completionRatio: 1,
  }];
  const fixed = createReportCardsFixedInput({
    ...draft,
    activeAssetIds: ["alpha", "beta"],
    liveReserveMap: { ...draft.liveReserveMap, alpha: [parentReserve] },
    redemptionGenerationId: redemptionInput.redemptionGenerationId,
    redemptionBackstopMap: { alpha: redemption },
    redemptionStale: false,
    inputFreshness: { ...draft.inputFreshness, redemptionBackstops: redemptionInput.inputFreshness.redemptionBackstops },
  });
  const meta = metaMap(
    alphaMeta({
      variantOf: "beta",
      variantKind: "savings-passthrough",
      flags: { backing: "crypto-backed", pegCurrency: "USD", governance: "decentralized", yieldBearing: true, rwa: false, navToken: true },
    }),
    alphaMeta({ id: "beta" }),
  );
  return { fixed, meta };
}

export function reviewedResearchMeta(reviewedAt: string): V9ExtensionRegistryMeta {
  return {
    ...reviewedOracleMeta(reviewedAt),
    mintAuthority: {
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      confidence: "verified",
      summary: "The fixture token is reviewed immutable with no direct mint control.",
      upgradeability: { model: "immutable", canChangeMintLogic: false, sources: [{ label: "Mint docs", url: "https://example.com/mint" }] },
      controls: [],
      review: {
        sources: [{ label: "Mint docs", url: "https://example.com/mint" }],
        evidence: "The fixture mint path is reviewed and immutable.",
        reviewer: "Fixture reviewer",
        reviewedAt,
      },
    },
    bridgeRouteRisk: {
      tier: "external-lock-mint",
      summary: "A reviewed external bridge route represents the fixture token.",
      reviewedAt,
      reviewer: "Fixture reviewer",
      confidence: "verified",
      sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
      routes: [
        { ...bridgeRoute("ethereum:0x1111111111111111111111111111111111111111", "reviewed"), canonicalChain: "ethereum", issuanceModel: "native-issuance", routeClass: "native", riskTier: "single-chain-or-native", semantics: "native-mint", scope: "canonical" },
        { ...reviewedLockMintRoute("base:0x3333333333333333333333333333333333333333"), sourceChain: "ethereum", canonicalChain: "ethereum" },
      ],
    },
  };
}

export function reviewedDependencyMeta(): V9ExtensionRegistryMeta {
  return alphaMeta({
    dependencies: [{ id: "beta", weight: 0.5, type: "collateral" }],
    dependencyReview: {
      reviewedAt: "1970-01-01", reviewer: "Fixture reviewer", confidence: "manual-review",
      sources: [{ label: "Fixture dependency analysis", url: "https://example.com/dependencies/alpha" }],
      rationale: "Beta is a reviewed collateral dependency.",
      relationships: [{ id: "beta", weight: 0.5, type: "collateral", reason: "Half of the reviewed backing is Beta." }],
    },
    reserves: [
      { name: "Beta stablecoin", pct: 50, risk: "low", coinId: "beta", depType: "collateral", assetClass: "stablecoin", issuerOrObligor: "Beta issuer", riskFactors: ["counterparty"], liquidityHorizon: "immediate" },
      { name: "Custodied cash", pct: 50, risk: "very-low", assetClass: "cash", issuerOrObligor: "issuer:alpha", riskFactors: ["custody", "counterparty"], liquidityHorizon: "immediate", maturityDaysMax: 0 },
    ],
    reserveReview: {
      reviewedAt: "1970-01-01", reviewer: "Fixture reviewer", confidence: "verified",
      sources: [{ label: "Fixture reserve review", url: "https://example.com/reserves/alpha" }],
      rationale: "The live Beta reserve row is linked by a reviewed one-to-one identity.", compositionBasis: "Fixture composition", compositionAsOf: "1970-01-01", scope: "full-composition", knownUnknownExposure: "No unknown exposure.", knownUnknownExposurePct: 0,
    },
  });
}

export { deriveReportCardsBaseInputGenerationId };
