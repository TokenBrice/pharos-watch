import type { ExitExecutionCertificate, ExitExecutionModelReview, ExitRouteObservation } from "@shared/types/exit-route";
import { ExitRouteObservationSchema } from "@shared/types/exit-route";
import type { V9ValidatedPolicyEnvelope } from "@shared/types/safety-score-v9";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { selectV9ExitStressRequest } from "@shared/lib/safety-score-v9/exit";
import { admitExitExecutionCertificate, exitExecutionInputGenerationId, exitExecutionReviewDigest, validateExitExecutionModelReviews } from "@shared/lib/safety-score-v9/exit-execution";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import reviewedModels from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { observeSecuritizeOffRampExit } from "./securitize-offramp";
import { observeErc4626InstantExit } from "./erc4626-instant";
import type { EvmRpcOptions } from "../evm-rpc";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "../stablecoins-cache";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { getFxReferenceTypeFromState, loadFxRateState, type FxRateState } from "../fx-rate-state";

export async function observeReviewedExitExecutionRoutes(args: {
  assetId: string;
  circulatingUsd: number | null;
  clockSec: number;
  db?: D1Database;
  stablecoinsCache?: StablecoinsCacheLoadResult;
  fxRateState?: FxRateState | null;
  envelope?: V9ValidatedPolicyEnvelope;
  reviews?: readonly ExitExecutionModelReview[];
  inputReference?: ExitExecutionCertificate["inputReference"];
  outputReference?: ExitExecutionCertificate["inputReference"];
  nativeReference?: ExitExecutionCertificate["inputReference"];
  holderAddress?: string;
  gates?: ExitExecutionCertificate["gates"];
  signal?: AbortSignal;
  rpcOptions?: EvmRpcOptions;
  blockNumber?: number;
}) {
  if (!args.reviews && reviewedModels.reviews.length === 0) return {
    observations: [] as ExitRouteObservation[],
    failures: [] as { modelId: string; reason: string; responsibility: "producer-failed" | "method-unsupported" }[],
  };
  const envelope = args.envelope ?? loadV9CandidateMethodologyPolicy(args.clockSec);
  const reviews = (args.reviews ?? validateExitExecutionModelReviews(reviewedModels, envelope)).filter((review) => review.identity.assetId === args.assetId);
  const observations: ExitRouteObservation[] = [];
  const failures: { modelId: string; reason: string; responsibility: "producer-failed" | "method-unsupported" }[] = [];
  if (reviews.length === 0) return { observations, failures };
  const request = selectV9ExitStressRequest(args.circulatingUsd, envelope);
  if (!request) return { observations, failures: reviews.map((review) => ({ modelId: review.modelId, reason: "canonical-supply-unavailable", responsibility: "producer-failed" as const })) };
  const requests = envelope.policy.semantic.exit.stressRequest.notionalGridUsd.map((requestedNotionalUsd) => ({ requestedNotionalUsd, maxCostBps: request.maxCostBps }));
  const cache = !args.inputReference || !args.outputReference
    ? args.stablecoinsCache ?? (args.db ? await loadStablecoinsCache(args.db) : null)
    : null;
  let fxRateState = args.fxRateState;
  for (const review of reviews) {
    if (args.signal?.aborted) throw args.signal.reason;
    try {
      const policy = envelope.policy.semantic.exit.executionModels[review.modelId];
      if (!policy || policy.admission !== "enabled") { failures.push({ modelId: review.modelId, reason: "execution-model-unreviewed", responsibility: "method-unsupported" }); continue; }
      let inputReference = args.inputReference;
      let outputReference = args.outputReference;
      if (cache?.kind === "ok") {
        const input = cache.payload.peggedAssets.find((asset) => asset.id === args.assetId);
        const output = cache.payload.peggedAssets.find((asset) => asset.id === review.identity.outputAssetKeys[0]);
        if (!inputReference && input?.price && input.priceObservedAt != null && isObservedPrice(input)) inputReference = {
          assetKey: args.assetId, deployment: review.identity.deployment, rawUnits: "0", decimals: review.producer.inputDecimals,
          unitValueUsd: input.price, expectedUnitValueUsd: input.price, sourceId: input.priceSource!, sourceGenerationId: `stablecoins:${cache.updatedAt}`, observedAtSec: input.priceObservedAt,
        };
        if (!outputReference && output?.price && output.priceObservedAt != null && isObservedPrice(output)) {
          let expectedUnitValueUsd = output.pegType === "peggedUSD" ? 1 : null;
          let fxObservedAtSec: number | null = null;
          if (output.pegType === "peggedEUR") {
            if (fxRateState === undefined) fxRateState = args.db ? await loadFxRateState(args.db) : null;
            const sourceTime = fxRateState?.sourceUpdatedAtByPeg.peggedEUR;
            if (getFxReferenceTypeFromState(fxRateState ?? null, "peggedEUR", policy.priceMaxAgeSec, args.clockSec) === "fresh" &&
                sourceTime != null && sourceTime <= args.clockSec && args.clockSec - sourceTime <= policy.priceMaxAgeSec) {
              expectedUnitValueUsd = fxRateState!.rates.peggedEUR!;
              fxObservedAtSec = sourceTime;
            }
          }
          if (expectedUnitValueUsd !== null) outputReference = {
            assetKey: review.identity.outputAssetKeys[0]!, deployment: `${review.producer.chain}:${review.producer.outputToken.toLowerCase()}`,
            rawUnits: "0", decimals: review.producer.outputDecimals, unitValueUsd: output.price, expectedUnitValueUsd,
            sourceId: fxObservedAtSec === null ? output.priceSource! : `${output.priceSource!}+fx-rates:peggedEUR`,
            sourceGenerationId: fxObservedAtSec === null ? `stablecoins:${cache.updatedAt}` : domainDigest("safety-score-v10.exit-execution-eur-reference.v1", {
              stablecoinsUpdatedAt: cache.updatedAt, fxUpdatedAt: fxRateState!.usableSyncAt,
              expectedUnitValueUsd, fxObservedAtSec, sourceDate: fxRateState!.sourceDateByPeg.peggedEUR,
            }),
            observedAtSec: fxObservedAtSec === null ? output.priceObservedAt : Math.min(output.priceObservedAt, fxObservedAtSec),
          };
        }
      }
      if (!inputReference || !outputReference) { failures.push({ modelId: review.modelId, reason: "execution-price-reference-unavailable", responsibility: "producer-failed" }); continue; }
      const isVault = review.producer.kind === "erc4626-instant";
      const observed = isVault
        ? await observeErc4626InstantExit({ review, inputReference, outputReference, requests, blockNumber: args.blockNumber, rpcOptions: { ...args.rpcOptions, signal: args.signal } })
        : await observeSecuritizeOffRampExit({ review, inputReference, outputReference, nativeReference: args.nativeReference, requests, holderAddress: args.holderAddress, rpcOptions: { ...args.rpcOptions, signal: args.signal } });
      const observedAtSec = Math.floor(Date.now() / 1000);
      const source = observed.source;
      const completeExecution = observed.points.some((point) => point.requestedNotionalUsd === request.requestedNotionalUsd && point.executableUsd > 0 && point.certification !== "diagnostic");
      const gates = policy.requiredGates.map((gateId) => args.gates?.find((gate) => gate.gateId === gateId) ?? {
        gateId, verdict: completeExecution ? "passed" as const : "unavailable" as const,
        evidenceId: `exit-execution:${gateId}`, observedAtSec: source.timestamp,
        reason: completeExecution ? null : isVault ? observed.points.find((point) => point.requestedNotionalUsd === request.requestedNotionalUsd)?.reason ?? "erc4626-execution-unproven" : "live-holder-or-rail-proof-unavailable",
      });
      const settlementMaximumSec = completeExecution ? 0 : null;
      const certificate: ExitExecutionCertificate = {
        modelId: review.modelId, reviewDigest: exitExecutionReviewDigest(review), identity: review.identity,
        inputGenerationId: exitExecutionInputGenerationId(args.assetId, request, inputReference),
        observationGenerationId: domainDigest("safety-score-v10.exit-execution-source.v1", source),
        observedAtSec, sourceMaxAgeSec: policy.sourceMaxAgeSec, priceMaxAgeSec: policy.priceMaxAgeSec, source,
        holder: review.holder, prerequisites: isVault ? ["counterfactual-share-balance-only", "ordinary-synchronous-redeem", "network-gas-excluded-as-dex"] : ["eligible-holder", "token-balance", "approved-spender"],
        gates, inputReference, feeReferences: args.nativeReference ? [args.nativeReference] : [], points: observed.points,
        capacityBasis: "transaction-simulation",
        settlement: { endpoint: outputReference.deployment, maximumCompletionSec: settlementMaximumSec, evidenceId: "exit-execution-settlement" },
        resourceKeys: [`exit-resource:${review.identity.endpoint}`, ...(review.producer.kind === "securitize-offramp" ? [`inventory:${review.producer.chain}:${review.producer.provider.toLowerCase()}:${review.producer.outputToken.toLowerCase()}`] : [])],
        failureDomainKeys: [`provider:${review.identity.endpoint}`],
      };
      const admission = admitExitExecutionCertificate({ certificate, envelope, assetId: args.assetId, clockSec: Math.max(args.clockSec, observedAtSec), inputGenerationId: certificate.inputGenerationId, observationGenerationId: certificate.observationGenerationId, request, reviews });
      const point = observed.points.find((entry) => entry.requestedNotionalUsd === request.requestedNotionalUsd)!;
      const scoreEligible = admission.state !== "unavailable";
      observations.push(ExitRouteObservationSchema.parse({
        routeId: `execution:${exitExecutionReviewDigest(review)}`, routeFamily: "issuer-redemption",
        scope: { kind: "chain-contract", chain: review.producer.chain, contractOrPoolId: review.producer.contract, protocol: isVault ? "erc4626-instant" : "securitize-offramp" },
        requestedNotionalUsd: request.requestedNotionalUsd, maxCostBps: request.maxCostBps, settlementHorizonSec: Math.max(1, settlementMaximumSec ?? request.comparisonWindowSec),
        ...(settlementMaximumSec === null ? { settlementBoundUnproven: true } : {}), executableUsd: point.executableUsd, completionRatio: point.executableUsd / point.requestedNotionalUsd,
        executionCostBps: point.executionCostBps, allInCostBps: point.allInCostBps,
        output: { kind: outputReference.assetKey.startsWith("fiat:") ? "fiat" : "tracked-stablecoin", assetKeys: review.identity.outputAssetKeys, ...(outputReference.assetKey.startsWith("fiat:") ? { currency: outputReference.assetKey.slice(5) } : { trackedAssetIds: review.identity.outputAssetKeys }) },
        evidenceKind: "onchain-contract-state", confidence: "medium", modelConfidence: "medium", scoreEligible,
        observedAt: observedAtSec, freshnessSeconds: Math.max(0, observedAtSec - source.timestamp), commonModeKeys: certificate.resourceKeys,
        // Vault grid calls are independent executions: a larger failed redeem
        // can fall back below a smaller successful request. Keep every receipt
        // in the certificate, but project only the generation-bound canonical
        // request rather than presenting those receipts as a monotonic curve.
        capacityCurve: (isVault ? [point] : observed.points.filter((entry) => !scoreEligible || entry.certification !== "diagnostic")).map((entry) => ({ requestedNotionalUsd: entry.requestedNotionalUsd, maxCostBps: entry.maxCostBps, executableUsd: entry.executableUsd, completionRatio: entry.executableUsd / entry.requestedNotionalUsd, executionCostBps: entry.certification === "diagnostic" ? 0 : entry.executionCostBps })),
        executionModelId: review.modelId, executionCertificate: certificate,
      }));
      if (admission.state === "unavailable") failures.push({ modelId: review.modelId, reason: admission.reason, responsibility: admission.responsibility === "method-unsupported" ? "method-unsupported" : "producer-failed" });
    } catch (error) {
      if (args.signal?.aborted) throw error;
      failures.push({ modelId: review.modelId, reason: error instanceof Error ? error.message : "execution-producer-failed", responsibility: "producer-failed" });
    }
  }
  return { observations, failures };
}
