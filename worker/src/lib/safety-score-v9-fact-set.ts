import { compileV9FactSetV3 } from "@shared/lib/safety-score-v9/compile";
import {
  createV9FactStatus,
  requiredV9Applicability,
} from "@shared/lib/safety-score-v9/evidence";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import {
  V9AssetFactsV3Schema,
  V9EffectiveDependenciesV3Schema,
  type CompiledV9FactSetV3,
  type V9AssetFactsV3,
  type V9EffectiveDependenciesV3,
  type V9EvidenceReferenceV2,
  type V9FactGapV3,
} from "@shared/types/safety-score-v9-facts";
import {
  V9WrapperLocalFactsSchema,
  type V9WrapperLocalDimensionFact,
  type V9WrapperLocalFacts,
} from "@shared/types/safety-score-v9-wrapper";
import { normalizeFixedInput, type ReportCardsFixedInput } from "./report-cards-fixed-input";
import { assertSafetyScoreV9ExactExtensionAssets } from "./safety-score-v9-fact-set-boundary";
import { hydrateSafetyScoreV9ShockCoverageExtension } from "./safety-score-v9-extension-shock";
import { safetyScoreV9ChainSupplySourcePayload } from "./safety-score-v9-supply-attribution";
import {
  SafetyScoreV9FactSetExtensionV2Schema,
  type AssetExtension,
  type SafetyScoreV9FactSetExtensionV2,
} from "./safety-score-v9-fact-set-schema";
import {
  createAssetBuildContext,
  normalizeCompiledFailureDomains,
  projectResearchOverlayPayload,
  type AssetBuildContext,
} from "./safety-score-v9-fact-set-context";
import { buildOperationalResilienceFact } from "./safety-score-v9-fact-set-operational-resilience";
import {
  buildCdpStressCoverage,
  buildDependencies,
  buildImplementation,
  buildMechanismExitFacts,
  buildMechanismReview,
  buildReserves,
  reconcileCollateralDependencyMappings,
} from "./safety-score-v9-fact-set-backing";
import { buildRoutes } from "./safety-score-v9-fact-set-exit";
import {
  buildAccessReview,
  buildControls,
  buildEconomicControlReview,
} from "./safety-score-v9-fact-set-control";
import {
  buildPeg,
  buildSupply,
} from "./safety-score-v9-fact-set-peg-supply";
import { buildWrapperLocalFacts } from "./safety-score-v9-fact-set-wrapper";

export {
  SafetyScoreV9FactSetExtensionV2Schema,
  type SafetyScoreV9FactSetExtensionV2,
} from "./safety-score-v9-fact-set-schema";
export { computeSafetyScoreV9ReserveExposureKey } from "./safety-score-v9-fact-set-schema";
export { deriveSafetyScoreV9PegScore } from "./safety-score-v9-fact-set-peg-supply";

export type V9AssetQuarantineCode =
  | "fact-build-failed"
  | "fact-validation-failed";

export interface V9AssetQuarantine {
  assetId: string;
  code: V9AssetQuarantineCode;
}

export interface SafetyScoreV9FactCompilationResult {
  factSet: Readonly<CompiledV9FactSetV3>;
  quarantines: readonly V9AssetQuarantine[];
}
const materializedExtensions = new WeakSet<object>();

export function materializeSafetyScoreV9FactSetExtension(
  fixedInput: Readonly<ReportCardsFixedInput>,
  extensionValue: unknown,
): Readonly<SafetyScoreV9FactSetExtensionV2> {
  const extension = SafetyScoreV9FactSetExtensionV2Schema.parse(
    hydrateSafetyScoreV9ShockCoverageExtension(extensionValue, fixedInput.clockSec),
  );
  materializedExtensions.add(extension);
  return extension;
}

function buildAssetFacts(
  context: AssetBuildContext,
  dependencies: V9EffectiveDependenciesV3,
  reserves: ReturnType<typeof buildReserves>,
): V9AssetFactsV3 {
  const implementation = buildImplementation(context);
  const mechanismRiskReview = buildMechanismReview(context);
  const mechanismExitFacts = buildMechanismExitFacts(context);
  const cdpStressCoverage = buildCdpStressCoverage(context);
  const routes = buildRoutes(context);
  const controls = buildControls(context);
  const economicControlReview = buildEconomicControlReview(context);
  const accessReview = buildAccessReview(context);
  const peg = buildPeg(context);
  const supply = buildSupply(context);
  const operationalResilience = buildOperationalResilienceFact(context);
  const wrapperLocalFacts = buildWrapperLocalFacts(context, {
    implementation,
    dependencies,
    reserveStatus: reserves.reserveStatus,
    reserveExposures: reserves.reserveExposures,
    exitStatus: routes.exitStatus,
    exitRoutes: routes.exitRoutes,
    controlStatus: controls.controlStatus,
    controls: controls.controls,
    economicControlReview,
    peg,
    supply,
  });
  const compiledAsset: V9AssetFactsV3 = {
    assetId: context.asset.assetId,
    assetIssuerKey: context.asset.assetIssuerKey ?? null,
    archetype: context.asset.archetype,
    ...(context.asset.variantKind == null
      ? {}
      : { variantKind: context.asset.variantKind }),
    evidence: [...context.evidence.values()],
    gaps: [...context.gaps.values()],
    implementation,
    mechanismRiskReview,
    mechanismExitFacts,
    ...(cdpStressCoverage === undefined ? {} : { cdpStressCoverage }),
    dependencies,
    ...reserves,
    ...routes,
    ...controls,
    economicControlReview,
    accessReview,
    peg,
    supply,
    operationalResilience,
    wrapperLocalFacts,
  };
  // Normalize once at the producer boundary so every score-bearing pillar,
  // including nested mechanism reviews, shares the same chain identity.
  return normalizeCompiledFailureDomains(compiledAsset);
}

function dependencySupport(
  context: AssetBuildContext,
  dependencies: V9EffectiveDependenciesV3,
): {
  evidence: V9EvidenceReferenceV2[];
  gaps: V9FactGapV3[];
} {
  const gapIds = new Set(dependencies.status.gapIds);
  const gaps = [...gapIds].map((gapId) => {
    const gap = context.gaps.get(gapId);
    if (!gap) {
      throw new Error(
        `Safety Score v9 dependency gap ${gapId} is missing for ${context.asset.assetId}`,
      );
    }
    return gap;
  });
  const evidenceIds = new Set([
    ...dependencies.status.evidenceRefIds,
    ...dependencies.edges.flatMap((edge) => edge.evidenceRefIds),
    ...gaps.flatMap((gap) => gap.evidenceRefIds),
  ]);
  const evidence = [...evidenceIds].map((evidenceId) => {
    const reference = context.evidence.get(evidenceId);
    if (!reference) {
      throw new Error(
        `Safety Score v9 dependency evidence ${evidenceId} is missing for ${context.asset.assetId}`,
      );
    }
    return reference;
  });
  return { evidence, gaps };
}

function quarantinedWrapperLocalFacts(
  asset: AssetExtension,
  dependencies: V9EffectiveDependenciesV3,
): V9WrapperLocalFacts {
  const wrapperApplicable =
    asset.variantKind === "pure-wrapper" ||
    asset.variantKind === "savings-passthrough" ||
    asset.variantKind === "strategy-vault" ||
    asset.variantKind === "risk-absorption" ||
    dependencies.edges.some(
      (edge) =>
        edge.pathKind === "serial-dependency" &&
        edge.dependencyType === "wrapper",
    );
  if (!wrapperApplicable) {
    return {
      schemaVersion: 1,
      applicability: "not-wrapper",
      evidenceRefIds: [],
    };
  }
  const unavailableDimension = (): V9WrapperLocalDimensionFact => ({
    disposition: "producer-failed",
    assessment: null,
    signals: ["asset-compilation-unavailable"],
    evidenceRefIds: [],
  });
  return V9WrapperLocalFactsSchema.parse({
    schemaVersion: 1,
    applicability: "wrapper",
    form:
      asset.variantKind === "pure-wrapper"
        ? "pure"
        : asset.variantKind === "savings-passthrough" ||
            asset.variantKind === "risk-absorption"
          ? "native-staked"
          : "strategy-vault",
    formDisposition: "producer-failed",
    formSignals: ["asset-compilation-unavailable"],
    formEvidenceRefIds: [],
    facts: {
      contractMutability: unavailableDimension(),
      custodyEscrow: unavailableDimension(),
      strategyComplexity: unavailableDimension(),
      leverage: unavailableDimension(),
      rehypothecationCorrelation: unavailableDimension(),
      shareAccountingNavOracle: unavailableDimension(),
      withdrawalTerms: unavailableDimension(),
      measuredUnwind: unavailableDimension(),
      lossAbsorptionEmergencyControls: unavailableDimension(),
    },
    riskTransfer: {
      disposition: "producer-failed",
      mechanism: "unknown",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["asset-compilation-unavailable"],
      evidenceRefIds: [],
    },
  });
}

function buildQuarantinedAssetFacts(
  context: AssetBuildContext,
  dependencies: V9EffectiveDependenciesV3,
): V9AssetFactsV3 {
  const support = dependencySupport(context, dependencies);
  const gapId = `${context.asset.assetId}:gap:asset-compilation`;
  const quarantineGap = createV9FactGapV3({
    gapId,
    reasonCode: "missing-pillar-evidence",
    ownerDomain: "evidence",
    policyRuleId: "v9.asset.compilation",
    observationState: "missing",
    responsibility: "producer-failed",
    path: {
      kind: "local-component",
      componentKey: "asset-compilation",
    },
    message:
      "Current score-bearing facts for this asset could not be compiled.",
    evidenceRefIds: [],
  });
  const unavailableStatus = () =>
    createV9FactStatus({
      applicability: requiredV9Applicability("v9.asset.compilation"),
      observationState: "missing",
      evidenceRefIds: [],
      gapIds: [gapId],
    });
  const reference = context.asset.pegReference;
  return V9AssetFactsV3Schema.parse({
    assetId: context.asset.assetId,
    assetIssuerKey: context.asset.assetIssuerKey ?? null,
    archetype: context.asset.archetype,
    ...(context.asset.variantKind == null
      ? {}
      : { variantKind: context.asset.variantKind }),
    evidence: support.evidence,
    gaps: [...support.gaps, quarantineGap],
    implementation: {
      status: unavailableStatus(),
      launchedAtSec: null,
    },
    mechanismRiskReview: {
      status: unavailableStatus(),
      review: null,
    },
    mechanismExitFacts: [],
    dependencies,
    reserveStatus: unavailableStatus(),
    reserveExposures: [],
    exitStatus: unavailableStatus(),
    exitRoutes: [],
    controlStatus: unavailableStatus(),
    controls: [],
    economicControlReview: {
      mint: {
        status: unavailableStatus(),
        controlKey: null,
        reconciliation: "unknown",
        supervision: "unknown",
        upgrade: { state: "unknown", controlKey: null },
      },
      oracle: {
        status: unavailableStatus(),
        tier: null,
        branches: [],
      },
      bridge: {
        status: unavailableStatus(),
        routes: [],
      },
    },
    accessReview: {
      transfer: {
        status: unavailableStatus(),
        posture: null,
      },
      freeze: {
        status: unavailableStatus(),
        reviews: [],
      },
    },
    peg: {
      status: unavailableStatus(),
      pegKey: reference
        ? `peg:${reference.referenceKind}:${reference.referenceKey}`
        : `peg:unresolved:${context.asset.assetId}`,
      sourceGenerationId: context.extension.sources.peg.generationId,
      referenceKind: reference?.referenceKind ?? "other",
      referenceKey:
        reference?.referenceKey ?? `unresolved:${context.asset.assetId}`,
      methodologyVersion: context.fixedInput.methodologyVersion,
      pegScore: null,
      currentDeviationBps: null,
      activeDepeg: null,
      activeDepegBps: null,
      trackingSpanDays: null,
      failureDomains: reference?.failureDomains ?? [],
    },
    supply: {
      status: unavailableStatus(),
      sourceGenerationId:
        context.extension.sources.chainSupply.generationId,
      sourceKind: "usd-denominated-circulating",
      circulatingUnits: null,
      referencePriceUsd: null,
      circulatingUsd: null,
      chainDistribution: null,
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: null,
      unknownRouteSupplyShare: null,
      unreviewedRouteSupplyShare: null,
      failureDomains: [],
    },
    operationalResilience: null,
    wrapperLocalFacts: quarantinedWrapperLocalFacts(
      context.asset,
      dependencies,
    ),
  });
}

function compileAssetOutcome(
  fixedInput: ReportCardsFixedInput,
  extension: SafetyScoreV9FactSetExtensionV2,
  asset: AssetExtension,
  researchPayloadSha256: string,
): {
  facts: V9AssetFactsV3;
  quarantine: V9AssetQuarantine | null;
} {
  const context = createAssetBuildContext(
    fixedInput,
    extension,
    asset,
    researchPayloadSha256,
  );
  const rawDependencies = V9EffectiveDependenciesV3Schema.parse(
    buildDependencies(context),
  );
  let reserves: ReturnType<typeof buildReserves>;
  try {
    reserves = buildReserves(context);
  } catch {
    return {
      facts: buildQuarantinedAssetFacts(context, rawDependencies),
      quarantine: {
        assetId: asset.assetId,
        code: "fact-build-failed",
      },
    };
  }
  const dependencies = V9EffectiveDependenciesV3Schema.parse(
    reconcileCollateralDependencyMappings(
      context,
      rawDependencies,
      reserves.reserveExposures,
    ),
  );
  let facts: V9AssetFactsV3;
  try {
    facts = buildAssetFacts(context, dependencies, reserves);
  } catch {
    return {
      facts: buildQuarantinedAssetFacts(context, dependencies),
      quarantine: {
        assetId: asset.assetId,
        code: "fact-build-failed",
      },
    };
  }
  const parsed = V9AssetFactsV3Schema.safeParse(facts);
  if (!parsed.success) {
    return {
      facts: buildQuarantinedAssetFacts(context, dependencies),
      quarantine: {
        assetId: asset.assetId,
        code: "fact-validation-failed",
      },
    };
  }
  return { facts: parsed.data, quarantine: null };
}

/**
 * Compile policy-independent V9 facts directly from publication-exact base inputs.
 * ReportCard score outputs are intentionally not part of this adapter contract.
 */
export function compileSafetyScoreV9FactSetFromFixedInput(
  fixedInputValue: unknown,
  extensionValue: unknown,
): Readonly<CompiledV9FactSetV3> {
  return compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(fixedInputValue), extensionValue);
}

/** Trusted runtime entrypoint for already validated publication inputs. */
export function compileSafetyScoreV9FactSetFromNormalizedInput(
  fixedInput: Readonly<ReportCardsFixedInput>,
  extensionValue: unknown,
): Readonly<CompiledV9FactSetV3> {
  return compileSafetyScoreV9FactSetFromValidatedExtension(
    fixedInput,
    materializeSafetyScoreV9FactSetExtension(fixedInput, extensionValue),
  );
}

/**
 * Trusted same-process path for an extension just returned by
 * materializeSafetyScoreV9FactSetExtension().
 */
export function compileSafetyScoreV9FactSetFromValidatedExtension(
  fixedInput: Readonly<ReportCardsFixedInput>,
  extension: SafetyScoreV9FactSetExtensionV2,
): Readonly<CompiledV9FactSetV3> {
  return compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
    fixedInput,
    extension,
  ).factSet;
}

export function compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
  fixedInput: Readonly<ReportCardsFixedInput>,
  extension: SafetyScoreV9FactSetExtensionV2,
): Readonly<SafetyScoreV9FactCompilationResult> {
  if (!materializedExtensions.has(extension)) {
    throw new Error("Trusted Safety Score v9 compilation requires an in-process materialized extension");
  }
  if (fixedInput.captureKind !== "exact-publication-inputs") {
    throw new Error("Safety Score v9 fact compilation requires exact publication inputs");
  }
  if (extension.registryFingerprint !== fixedInput.registryFingerprint) {
    throw new Error(
      `Safety Score v9 extension registry fingerprint ${extension.registryFingerprint} does not match fixed input ${fixedInput.registryFingerprint}`,
    );
  }
  assertSafetyScoreV9ExactExtensionAssets(fixedInput, extension);
  const researchPayloadSha256 = domainDigest(
    "safety-score-v9.research-overlay.v1",
    projectResearchOverlayPayload(extension.assets),
  );
  const redemptionObservedAtSec =
    fixedInput.inputFreshness.redemptionBackstops.updatedAt ?? extension.sources.unavailableRedemptionObservedAtSec;
  const shockCoveragePayload = extension.assets.flatMap((asset) =>
    asset.cdpStressCoverage === undefined
      ? []
      : [{ assetId: asset.assetId, cdpStressCoverage: asset.cdpStressCoverage }],
  );
  const shockCoveragePayloadSha256 = domainDigest("safety-score-v9.cdp-shock-coverage-source.v1", shockCoveragePayload);
  const shockCoverageObservedAtSec = shockCoveragePayload.reduce(
    (latest, entry) => Math.max(latest, entry.cdpStressCoverage.source?.block.timestampUnix ?? 0),
    0,
  );
  const outcomes = extension.assets.map((asset) =>
    compileAssetOutcome(
      fixedInput,
      extension,
      asset,
      researchPayloadSha256,
    ),
  );
  const factSet = compileV9FactSetV3({
    schemaVersion: 3,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    asOfSec: fixedInput.clockSec,
    compiledAtSec: extension.compiledAtSec,
    sourceFingerprints: {
      registry: {
        generationId: fixedInput.registryRevision,
        payloadSha256: fixedInput.registryFingerprint,
        observedAtSec: extension.sources.registryObservedAtSec,
      },
      dex: {
        generationId: fixedInput.dexGenerationId,
        payloadSha256: fixedInput.dexPayloadFingerprint,
        observedAtSec: fixedInput.inputFreshness.dexLiquidity.updatedAt!,
      },
      redemption: {
        generationId: fixedInput.redemptionGenerationId,
        payloadSha256: fixedInput.redemptionPayloadFingerprint,
        observedAtSec: redemptionObservedAtSec,
      },
      liveReserves: {
        generationId: extension.sources.liveReserves.generationId,
        payloadSha256: domainDigest("safety-score-v9.live-reserves.v1", {
          reserves: fixedInput.liveReserveMap,
          provenance: fixedInput.liveReserveProvenanceMap,
        }),
        observedAtSec: extension.sources.liveReserves.observedAtSec,
      },
      chainSupply: {
        generationId: extension.sources.chainSupply.generationId,
        payloadSha256: domainDigest(
          "safety-score-v9.chain-supply.v1",
          safetyScoreV9ChainSupplySourcePayload(fixedInput),
        ),
        observedAtSec: extension.sources.chainSupply.observedAtSec,
      },
      peg: {
        generationId: extension.sources.peg.generationId,
        payloadSha256: domainDigest("safety-score-v9.peg.v1", {
          pegDataById: fixedInput.pegDataById,
          navPriceById: fixedInput.navPriceById ?? {},
          activeDepegPeakBpsById: fixedInput.activeDepegPeakBpsById,
        }),
        observedAtSec: extension.sources.peg.observedAtSec,
      },
      researchOverlays: {
        generationId: extension.sources.researchOverlays.generationId,
        payloadSha256: researchPayloadSha256,
        observedAtSec: extension.sources.researchOverlays.observedAtSec,
      },
      ...(shockCoveragePayload.length === 0
        ? {}
        : {
            shockCoverage: {
              generationId: `cdp-shock-coverage:v1:${shockCoveragePayloadSha256}`,
              payloadSha256: shockCoveragePayloadSha256,
              observedAtSec: shockCoverageObservedAtSec,
            },
          }),
    },
    activeAssetIds: fixedInput.activeAssetIds,
    assets: outcomes.map((outcome) => outcome.facts),
  });
  const quarantines = outcomes
    .flatMap((outcome) =>
      outcome.quarantine === null ? [] : [outcome.quarantine],
    )
    .sort((left, right) => compareText(left.assetId, right.assetId));
  return Object.freeze({
    factSet,
    quarantines: Object.freeze(
      quarantines.map((quarantine) => Object.freeze(quarantine)),
    ),
  });
}
