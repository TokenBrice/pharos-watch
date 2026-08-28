import { EXIT_ROUTE_SCORING_TABLES } from "./exit-route-scoring";
import { validateExitRouteCapacityCurve } from "./exit-route-capacity-point";
import type { ExitRouteObservation, ExitRouteOutput } from "../types/market";
import {
  canonicalExitRouteAssetKey,
  canonicalExitRouteChain,
  canonicalExitRouteScopedKey,
  encodeExitRouteIdentityPart,
  normalizeExitRouteCorrelationKey,
} from "./exit-route-identity";
import {
  getDexMeasuredExecutionFreshnessMaxSec,
  isDexMeasuredExecutionObservationHistoryMature,
} from "../types/measured-execution";
import {
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
  CURVE_STABLESWAP_MIN_COMPLETE_CYCLES,
  CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS,
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  CURVE_STABLESWAP_NG_MIN_COMPLETE_CYCLES,
  CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS,
  DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
  REFERENCE_NOTIONAL_USD,
  buildCapacityCurve,
  capabilityForPool,
  measuredExecutionProfilesForPool,
  normalizedKey,
  observationHistoryForProfile,
  outputFromPool,
  requiresP4DexScoreEligibleCapabilityCoverage,
  type P4DexRouteObservationResult,
  type P4DexRoutePoolInput,
} from "./p4-exit-route-capability-policy";
import {
  isCompleteCurveStableSwapDirectionPacket,
  reviewedCurveStableSwapNgPolicyForProfile,
  validateMeasuredExecutionProfile,
} from "./p4-exit-route-measured-profile-validation";
import {
  buildAmmCapacityCurve,
  outputFromAmmToken,
  trackedExactAmmOutputValuationFields,
  validateAmmExecutionModel,
} from "./p4-exit-route-amm-simulation";

function commonModeKeys(pool: P4DexRoutePoolInput, output: ExitRouteOutput): string[] {
  const keys = new Set<string>([
    `protocol:${normalizedKey(pool.project)}`,
    `pool:${canonicalExitRouteScopedKey(pool.chain, pool.poolId)}`,
  ]);
  if (pool.poolType === "orderbook") keys.add(`venue:${normalizedKey(pool.project)}`);
  else keys.add(`chain:${canonicalExitRouteChain(pool.chain)}`);
  if (output.currency) keys.add(`fiat:${normalizedKey(output.currency)}`);
  for (const assetId of output.trackedAssetIds ?? []) keys.add(`asset:${normalizedKey(assetId)}`);
  for (const assetKey of output.assetKeys ?? []) keys.add(`token:${assetKey}`);
  for (const item of output.basketWeights ?? []) {
    if (item.assetId) keys.add(`asset:${normalizedKey(item.assetId)}`);
    else if (item.symbol) keys.add(`asset-symbol:${normalizedKey(item.symbol)}`);
  }
  return [...keys].map(normalizeExitRouteCorrelationKey).filter(Boolean).sort();
}

function buildDexRouteId(parts: readonly string[]): string {
  return `dex:${parts.map(encodeExitRouteIdentityPart).join(":")}`;
}

export function buildP4DexExitRouteObservations(params: {
  stablecoinId: string;
  retainedPools: readonly P4DexRoutePoolInput[];
  observedAt: number;
}): P4DexRouteObservationResult {
  const observations: ExitRouteObservation[] = [];
  const evidenceCounts: Record<string, number> = {};
  const unsupportedReasons: Record<string, number> = {};
  let unsupportedPoolCount = 0;
  let scoreEligiblePoolCount = 0;
  let scoreEligibleCapabilityPoolCount = 0;

  for (const pool of params.retainedPools) {
    if (requiresP4DexScoreEligibleCapabilityCoverage(pool)) scoreEligibleCapabilityPoolCount++;
    if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd <= 0 || !pool.poolId || !pool.project || !pool.chain) {
      // An invalid retained row cannot prove that it belongs to a diagnostic-only
      // capability, so keep it in the executable denominator and fail closed.
      unsupportedPoolCount++;
      unsupportedReasons.invalidRetainedPool = (unsupportedReasons.invalidRetainedPool ?? 0) + 1;
      continue;
    }
    let capability = capabilityForPool(pool);
    const ammModel = pool.extra?.ammExecutionModel;
    const executionCapabilityGate = pool.extra?.executionCapabilityGate;
    if (executionCapabilityGate != null) {
      unsupportedPoolCount++;
      const reason =
        ammModel == null
          ? `executionCapabilityGate:${executionCapabilityGate.family}:${executionCapabilityGate.reason}`
          : "conflictingExecutionCapabilityEvidence";
      unsupportedReasons[reason] = (unsupportedReasons[reason] ?? 0) + 1;
      continue;
    }
    const measuredProfiles = measuredExecutionProfilesForPool(pool);
    if (measuredProfiles.length > 0) {
      const isCurveStableSwapPacket = measuredProfiles.every(
        (profile) => profile.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
      );
      const isCurveStableSwapNgProfile =
        measuredProfiles.length === 1 &&
        measuredProfiles[0]!.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID;
      const curveStableSwapNgPolicy = isCurveStableSwapNgProfile
        ? reviewedCurveStableSwapNgPolicyForProfile(measuredProfiles[0]!)
        : null;
      if (
        isCurveStableSwapPacket &&
        (
          !isCompleteCurveStableSwapDirectionPacket(measuredProfiles) ||
          (ammModel != null &&
            (ammModel.source !== "curve" || ammModel.invariant !== "stableswap")) ||
          new Set(measuredProfiles.map((profile) => profile.poolId)).size !== 1 ||
          new Set(measuredProfiles.map((profile) => profile.quoteGenerationId)).size !== 1 ||
          new Set(measuredProfiles.map((profile) => "blockNumber" in profile ? profile.blockNumber : null)).size !== 1
        )
      ) {
        unsupportedPoolCount++;
        unsupportedReasons.invalidAtomicMeasuredPacket =
          (unsupportedReasons.invalidAtomicMeasuredPacket ?? 0) + 1;
        continue;
      }
      if (
        isCurveStableSwapNgProfile &&
        (
          curveStableSwapNgPolicy == null ||
          (ammModel != null &&
            (ammModel.source !== "curve" || ammModel.invariant !== "stableswap")) ||
          measuredProfiles[0]!.tokenIn.address !== curveStableSwapNgPolicy.tokenInAddress ||
          measuredProfiles[0]!.tokenOut.address !== curveStableSwapNgPolicy.tokenOutAddress
        )
      ) {
        unsupportedPoolCount++;
        unsupportedReasons.invalidAtomicMeasuredProfile =
          (unsupportedReasons.invalidAtomicMeasuredProfile ?? 0) + 1;
        continue;
      }
      if (
        !isCurveStableSwapPacket &&
        !isCurveStableSwapNgProfile &&
        (ammModel != null || measuredProfiles.length !== 1)
      ) {
        unsupportedPoolCount++;
        unsupportedReasons.conflictingExecutionCapabilityEvidence =
          (unsupportedReasons.conflictingExecutionCapabilityEvidence ?? 0) + 1;
        continue;
      }
      if (!capability.scoreEligible) {
        unsupportedPoolCount++;
        unsupportedReasons.shadowMeasuredProfileWithoutGate =
          (unsupportedReasons.shadowMeasuredProfileWithoutGate ?? 0) + 1;
        continue;
      }
      const profileIssues = measuredProfiles.flatMap((profile) =>
        validateMeasuredExecutionProfile(profile, {
          pool,
          stablecoinId: params.stablecoinId,
          observedAt: params.observedAt,
        })
      );
      if (profileIssues.length > 0) {
        unsupportedPoolCount++;
        for (const issue of profileIssues) {
          const reason = `invalidMeasuredExecution:${issue}`;
          unsupportedReasons[reason] = (unsupportedReasons[reason] ?? 0) + 1;
        }
        continue;
      }
      const measuredRows = measuredProfiles.map((profile) => {
        const capacityCurve =
          observationHistoryForProfile(profile)?.conservativeCapacityCurve ?? profile.capacityCurve;
        const referencePoint = capacityCurve.find(
          (point) =>
            point.requestedNotionalUsd === REFERENCE_NOTIONAL_USD &&
            point.maxCostBps === EXIT_ROUTE_SCORING_TABLES.request.maxCostBps,
        );
        return { profile, capacityCurve, referencePoint };
      });
      if (measuredRows.some(({ referencePoint }) => !referencePoint)) {
        unsupportedPoolCount++;
        unsupportedReasons.missingReferencePoint = (unsupportedReasons.missingReferencePoint ?? 0) + 1;
        continue;
      }
      const curveStableSwapMeasuredProfileIsMature =
        (isCurveStableSwapPacket || isCurveStableSwapNgProfile) &&
        measuredRows.every(({ profile }) => {
          const history = observationHistoryForProfile(profile);
          const freshnessMaxSec = getDexMeasuredExecutionFreshnessMaxSec(
            profile.adapterProfileId,
          );
          return (
            history != null &&
            params.observedAt - history.observationWindowEndedAt <= freshnessMaxSec &&
            history.observationWindowEndedAt <= params.observedAt + 60 &&
            history.completeProducerCycleCount >=
              (
                isCurveStableSwapNgProfile
                  ? CURVE_STABLESWAP_NG_MIN_COMPLETE_CYCLES
                  : CURVE_STABLESWAP_MIN_COMPLETE_CYCLES
              ) &&
            history.successfulObservationCount >=
              (
                isCurveStableSwapNgProfile
                  ? CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS
                  : CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS
              )
          );
        });
      if (
        (isCurveStableSwapPacket || isCurveStableSwapNgProfile) &&
        !curveStableSwapMeasuredProfileIsMature
      ) {
        if (ammModel == null) {
          unsupportedPoolCount++;
          unsupportedReasons.immatureAtomicMeasuredPacket =
            (unsupportedReasons.immatureAtomicMeasuredPacket ?? 0) + 1;
          continue;
        }
        capability = capabilityForPool(pool, { ignoreMeasured: true });
      } else {
        for (const { profile, capacityCurve, referencePoint } of measuredRows) {
          const output = outputFromAmmToken(pool.chain, profile.tokenOut);
          const outputIdentity = canonicalExitRouteAssetKey(pool.chain, profile.tokenOut.address);
          const physicalPool = { ...pool, poolId: profile.poolId };
          const observationHistory = observationHistoryForProfile(profile);
          const freshnessMaxSec = getDexMeasuredExecutionFreshnessMaxSec(
            profile.adapterProfileId,
          );
          // The producer bounds every included cycle to its latest complete
          // publication. The selected quote and the summary end must both remain fresh.
          const historyIsFresh =
            observationHistory != null &&
            params.observedAt - observationHistory.observationWindowEndedAt <= freshnessMaxSec &&
            observationHistory.observationWindowEndedAt <= params.observedAt + 60;
          const historyIsMature =
            observationHistory != null &&
            (isCurveStableSwapPacket || isCurveStableSwapNgProfile
              ? curveStableSwapMeasuredProfileIsMature
              : isDexMeasuredExecutionObservationHistoryMature(observationHistory));
          const confidence =
            historyIsFresh && historyIsMature
              ? capability.confidence
              : "medium";
          observations.push({
            routeId: buildDexRouteId([
              normalizedKey(params.stablecoinId),
              normalizedKey(pool.source),
              canonicalExitRouteScopedKey(pool.chain, profile.poolId),
              outputIdentity,
            ]),
            routeFamily: "dex-amm",
            scope: {
              kind: "chain-contract",
              chain: pool.chain,
              contractOrPoolId: profile.poolId,
              protocol: pool.project,
            },
            requestedNotionalUsd: referencePoint!.requestedNotionalUsd,
            settlementHorizonSec: EXIT_ROUTE_SCORING_TABLES.request.settlementHorizonSec,
            maxCostBps: referencePoint!.maxCostBps,
            executableUsd: referencePoint!.executableUsd,
            completionRatio: referencePoint!.completionRatio,
            output,
            evidenceKind: capability.outputEvidenceKind,
            adapterProfileId: profile.adapterProfileId,
            confidence,
            scoreEligible: true,
            observedAt: profile.quotedAt,
            freshnessSeconds: Math.max(0, params.observedAt - profile.quotedAt),
            commonModeKeys: commonModeKeys(physicalPool, output),
            capacityCurve,
            ...(observationHistory ? { observationHistory } : {}),
          });
          evidenceCounts[capability.outputEvidenceKind] =
            (evidenceCounts[capability.outputEvidenceKind] ?? 0) + 1;
        }
        scoreEligiblePoolCount++;
        continue;
      }
    }
    if (ammModel != null) {
      const modelIssues = validateAmmExecutionModel(ammModel, {
        chain: pool.chain,
        stablecoinId: params.stablecoinId,
        retainedTvlUsd: pool.tvlUsd,
      });
      if (modelIssues.length > 0) {
        unsupportedPoolCount++;
        for (const issue of modelIssues) {
          const reason = `invalidExecutionModel:${issue}`;
          unsupportedReasons[reason] = (unsupportedReasons[reason] ?? 0) + 1;
        }
        continue;
      }

      let emittedForPool = 0;
      for (let outputTokenIndex = 0; outputTokenIndex < ammModel.tokens.length; outputTokenIndex++) {
        if (outputTokenIndex === ammModel.trackedTokenIndex) continue;
        const outputToken = ammModel.tokens[outputTokenIndex]!;
        const curve = buildAmmCapacityCurve(ammModel, outputTokenIndex);
        if (validateExitRouteCapacityCurve(curve).length > 0) continue;
        const referencePoint = curve.find(
          (point) => point.requestedNotionalUsd === REFERENCE_NOTIONAL_USD &&
            point.maxCostBps === EXIT_ROUTE_SCORING_TABLES.request.maxCostBps,
        );
        if (!referencePoint) continue;

        const output = outputFromAmmToken(pool.chain, outputToken);
        const outputIdentity = canonicalExitRouteAssetKey(pool.chain, outputToken.address);
        observations.push({
          routeId: buildDexRouteId([
            normalizedKey(params.stablecoinId),
            normalizedKey(pool.source),
            canonicalExitRouteScopedKey(pool.chain, pool.poolId),
            outputIdentity,
          ]),
          routeFamily: "dex-amm",
          scope: {
            kind: "chain-contract",
            chain: pool.chain,
            contractOrPoolId: pool.poolId,
            protocol: pool.project,
          },
          requestedNotionalUsd: referencePoint.requestedNotionalUsd,
            settlementHorizonSec: EXIT_ROUTE_SCORING_TABLES.request.settlementHorizonSec,
          maxCostBps: referencePoint.maxCostBps,
          executableUsd: referencePoint.executableUsd,
          completionRatio: referencePoint.completionRatio,
          output,
          ...trackedExactAmmOutputValuationFields(
            outputToken,
            `dex-amm-output-reference:${ammModel.source}:${outputToken.referencePriceSource}`,
            params.observedAt,
          ),
          evidenceKind: capability.outputEvidenceKind,
          confidence: capability.confidence,
          scoreEligible: capability.scoreEligible,
          observedAt: params.observedAt,
          freshnessSeconds: 0,
          commonModeKeys: commonModeKeys(pool, output),
          capacityCurve: curve,
        });
        evidenceCounts[capability.outputEvidenceKind] = (evidenceCounts[capability.outputEvidenceKind] ?? 0) + 1;
        emittedForPool++;
      }
      if (emittedForPool === 0) {
        unsupportedPoolCount++;
        unsupportedReasons.noExecutableCounterAsset = (unsupportedReasons.noExecutableCounterAsset ?? 0) + 1;
      } else if (capability.scoreEligible) {
        scoreEligiblePoolCount++;
      }
      continue;
    }

    const curve = buildCapacityCurve(pool, capability);
    if (curve == null) {
      unsupportedPoolCount++;
      const reason = `nonExecutableEvidence:${capability.id}`;
      unsupportedReasons[reason] = (unsupportedReasons[reason] ?? 0) + 1;
      continue;
    }
    const curveIssues = validateExitRouteCapacityCurve(curve);
    if (curveIssues.length > 0) {
      unsupportedPoolCount++;
      unsupportedReasons.nonMonotonicCurve = (unsupportedReasons.nonMonotonicCurve ?? 0) + 1;
      continue;
    }
    const referencePoint = curve.find(
          (point) => point.requestedNotionalUsd === REFERENCE_NOTIONAL_USD &&
            point.maxCostBps === EXIT_ROUTE_SCORING_TABLES.request.maxCostBps,
    );
    if (!referencePoint) {
      unsupportedPoolCount++;
      unsupportedReasons.missingReferencePoint = (unsupportedReasons.missingReferencePoint ?? 0) + 1;
      continue;
    }
    const output = outputFromPool(pool);
    const orderbook = capability.model === "direct-orderbook";
    observations.push({
      routeId: buildDexRouteId([
        normalizedKey(params.stablecoinId),
        normalizedKey(pool.source),
        canonicalExitRouteScopedKey(pool.chain, pool.poolId),
      ]),
      routeFamily: orderbook ? "dex-orderbook" : "dex-amm",
      scope: orderbook
        ? { kind: "venue", venue: pool.project, protocol: pool.project }
        : {
            kind: "chain-contract",
            chain: pool.chain,
            contractOrPoolId: pool.poolId,
            protocol: pool.project,
          },
      requestedNotionalUsd: referencePoint.requestedNotionalUsd,
            settlementHorizonSec: EXIT_ROUTE_SCORING_TABLES.request.settlementHorizonSec,
      maxCostBps: referencePoint.maxCostBps,
      executableUsd: referencePoint.executableUsd,
      completionRatio: referencePoint.completionRatio,
      output,
      evidenceKind: capability.outputEvidenceKind,
      confidence: capability.confidence,
      scoreEligible: capability.scoreEligible,
      observedAt: params.observedAt,
      freshnessSeconds: 0,
      commonModeKeys: commonModeKeys(pool, output),
      capacityCurve: curve,
    });
    evidenceCounts[capability.outputEvidenceKind] = (evidenceCounts[capability.outputEvidenceKind] ?? 0) + 1;
    if (capability.scoreEligible) scoreEligiblePoolCount++;
  }

  return {
    observations,
    coverage: {
      status: observations.length > 0 ? "populated" : params.retainedPools.length > 0 ? "unsupported" : "unknown",
      capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
      retainedPoolCount: params.retainedPools.length,
      observationCount: observations.length,
      scoreEligibleObservationCount: observations.filter((observation) => observation.scoreEligible).length,
      scoreEligiblePoolCount,
      scoreEligibleCapabilityPoolCount,
      unsupportedPoolCount,
      evidenceCounts,
      unsupportedReasons,
    },
  };
}
