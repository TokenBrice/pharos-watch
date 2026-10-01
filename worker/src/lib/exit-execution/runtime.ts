import type { ExitExecutionCertificate, ExitExecutionModelReview, ExitRouteObservation } from "@shared/types/exit-route";
import { ExitRouteObservationSchema } from "@shared/types/exit-route";
import type { V9ValidatedPolicyEnvelope } from "@shared/types/safety-score-v9";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { selectV9ExitStressRequest } from "@shared/lib/safety-score-v9/exit";
import { admitExitExecutionCertificate, exitExecutionInputGenerationId, exitExecutionReviewDigest, validateExitExecutionModelReviews } from "@shared/lib/safety-score-v9/exit-execution";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import reviewedModels from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { observeKrakenExitBooks } from "./orderbooks";
import { observeSecuritizeOffRampExit } from "./securitize-offramp";
import type { EvmRpcOptions } from "../evm-rpc";
import { loadStablecoinsCache } from "../stablecoins-cache";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";

export async function observeReviewedExitExecutionRoutes(args: {
  assetId: string;
  circulatingUsd: number | null;
  clockSec: number;
  lane: "dex" | "redemption";
  db?: D1Database;
  envelope?: V9ValidatedPolicyEnvelope;
  reviews?: readonly ExitExecutionModelReview[];
  inputReference?: ExitExecutionCertificate["inputReference"];
  outputReference?: ExitExecutionCertificate["inputReference"];
  nativeReference?: ExitExecutionCertificate["inputReference"];
  holderAddress?: string;
  gates?: ExitExecutionCertificate["gates"];
  settlementMaximumSec?: number;
  signal?: AbortSignal;
  rpcOptions?: EvmRpcOptions;
}) {
  if (!args.reviews && reviewedModels.reviews.length === 0) return {
    observations: [] as ExitRouteObservation[],
    failures: [] as { modelId: string; reason: string; responsibility: "producer-failed" | "method-unsupported" }[],
  };
  const envelope = args.envelope ?? loadV9CandidateMethodologyPolicy(args.clockSec);
  const reviews = (args.reviews ?? validateExitExecutionModelReviews(reviewedModels, envelope)).filter((review) => review.identity.assetId === args.assetId && (review.producer.kind === "kraken") === (args.lane === "dex"));
  const observations: ExitRouteObservation[] = [];
  const failures: { modelId: string; reason: string; responsibility: "producer-failed" | "method-unsupported" }[] = [];
  // Empty structural registry is intentionally byte-neutral for every legacy route, including USDC.
  if (reviews.length === 0) return { observations, failures };
  const request = selectV9ExitStressRequest(args.circulatingUsd, envelope);
  if (!request) return { observations, failures: reviews.map((review) => ({ modelId: review.modelId, reason: "canonical-supply-unavailable", responsibility: "producer-failed" as const })) };
  const requests = envelope.policy.semantic.exit.stressRequest.notionalGridUsd.map((requestedNotionalUsd) => ({ requestedNotionalUsd, maxCostBps: request.maxCostBps }));
  const cache = args.db && (!args.inputReference || !args.outputReference) ? await loadStablecoinsCache(args.db) : null;
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
        if (!outputReference && output?.price && output.priceObservedAt != null && output.pegType === "peggedUSD" && isObservedPrice(output)) outputReference = {
          assetKey: review.identity.outputAssetKeys[0]!, deployment: review.producer.kind === "kraken" ? review.producer.outputDeployment : `${review.producer.chain}:${review.producer.outputToken.toLowerCase()}`,
          rawUnits: "0", decimals: review.producer.outputDecimals, unitValueUsd: output.price, expectedUnitValueUsd: 1,
          sourceId: output.priceSource!, sourceGenerationId: `stablecoins:${cache.updatedAt}`, observedAtSec: output.priceObservedAt,
        };
      }
      if (!inputReference || !outputReference) { failures.push({ modelId: review.modelId, reason: "execution-price-reference-unavailable", responsibility: "producer-failed" }); continue; }
      const observed = review.producer.kind === "kraken"
        ? await observeKrakenExitBooks({ review, inputReference, outputReference, requests, signal: args.signal })
        : await observeSecuritizeOffRampExit({ review, inputReference, outputReference, nativeReference: args.nativeReference, requests, holderAddress: args.holderAddress, rpcOptions: { ...args.rpcOptions, signal: args.signal } });
      const observedAtSec = Math.floor(Date.now() / 1000);
      const source = observed.source;
      const isBook = review.producer.kind === "kraken";
      const completeExecution = !isBook && observed.points.some((point) => point.requestedNotionalUsd === request.requestedNotionalUsd && point.certification !== "diagnostic");
      const gates = policy.requiredGates.map((gateId) => args.gates?.find((gate) => gate.gateId === gateId) ?? {
        gateId, verdict: completeExecution || (isBook && (gateId === "market-identity" || gateId === "fees")) ? "passed" as const : "unavailable" as const,
        evidenceId: `exit-execution:${gateId}`, observedAtSec: source.timestamp,
        reason: completeExecution || (isBook && (gateId === "market-identity" || gateId === "fees")) ? null : "live-holder-or-rail-proof-unavailable",
      });
      const settlementMaximumSec = isBook ? args.settlementMaximumSec ?? null : completeExecution ? 0 : null;
      const certificate: ExitExecutionCertificate = {
        modelId: review.modelId, reviewDigest: exitExecutionReviewDigest(review), identity: review.identity,
        inputGenerationId: exitExecutionInputGenerationId(args.assetId, args.circulatingUsd, inputReference),
        observationGenerationId: domainDigest("safety-score-v10.exit-execution-source.v1", source),
        observedAtSec, sourceMaxAgeSec: policy.sourceMaxAgeSec, priceMaxAgeSec: policy.priceMaxAgeSec, source,
        holder: review.holder, prerequisites: isBook ? ["eligible-account", "funded-deposit", "enabled-withdrawal"] : ["eligible-holder", "token-balance", "approved-spender"],
        gates, inputReference, feeReferences: args.nativeReference ? [args.nativeReference] : [], points: observed.points,
        capacityBasis: isBook ? "observed-prefix-book-walk" : "transaction-simulation",
        settlement: { endpoint: isBook ? review.producer.kind === "kraken" ? review.producer.settlementEndpoint : "" : outputReference.deployment, maximumCompletionSec: settlementMaximumSec, evidenceId: "exit-execution-settlement" },
        resourceKeys: [`exit-resource:${review.identity.endpoint}`, ...(review.producer.kind === "securitize-offramp" ? [`inventory:${review.producer.chain}:${review.producer.provider.toLowerCase()}:${review.producer.outputToken.toLowerCase()}`] : [])],
        failureDomainKeys: [isBook ? `venue:${review.identity.endpoint.split(":")[0]}` : `provider:${review.identity.endpoint}`],
      };
      const admission = admitExitExecutionCertificate({ certificate, envelope, assetId: args.assetId, clockSec: args.clockSec, inputGenerationId: certificate.inputGenerationId, observationGenerationId: certificate.observationGenerationId, request, reviews });
      const point = observed.points.find((entry) => entry.requestedNotionalUsd === request.requestedNotionalUsd)!;
      const scoreEligible = admission.state !== "unavailable";
      observations.push(ExitRouteObservationSchema.parse({
        routeId: `execution:${exitExecutionReviewDigest(review)}`, routeFamily: isBook ? "dex-orderbook" : "issuer-redemption",
        scope: isBook ? { kind: "venue", venue: "kraken", protocol: "kraken" } : { kind: "chain-contract", chain: review.producer.kind === "securitize-offramp" ? review.producer.chain : "", contractOrPoolId: review.identity.endpoint, protocol: "securitize-offramp" },
        requestedNotionalUsd: request.requestedNotionalUsd, maxCostBps: request.maxCostBps, settlementHorizonSec: Math.max(1, settlementMaximumSec ?? request.comparisonWindowSec),
        ...(settlementMaximumSec === null ? { settlementBoundUnproven: true } : {}), executableUsd: point.executableUsd, completionRatio: point.executableUsd / point.requestedNotionalUsd,
        executionCostBps: point.executionCostBps, allInCostBps: point.allInCostBps,
        output: { kind: outputReference.assetKey.startsWith("fiat:") ? "fiat" : "tracked-stablecoin", assetKeys: review.identity.outputAssetKeys, ...(outputReference.assetKey.startsWith("fiat:") ? { currency: outputReference.assetKey.slice(5) } : { trackedAssetIds: review.identity.outputAssetKeys }) },
        evidenceKind: isBook ? "direct-orderbook-depth" : "onchain-contract-state", confidence: "medium", modelConfidence: "medium", scoreEligible,
        observedAt: observedAtSec, freshnessSeconds: Math.max(0, observedAtSec - source.timestamp), commonModeKeys: certificate.resourceKeys,
        capacityCurve: observed.points.filter((entry) => !scoreEligible || entry.certification !== "diagnostic").map((entry) => ({ requestedNotionalUsd: entry.requestedNotionalUsd, maxCostBps: entry.maxCostBps, executableUsd: entry.executableUsd, completionRatio: entry.executableUsd / entry.requestedNotionalUsd, executionCostBps: entry.certification === "diagnostic" ? 0 : entry.executionCostBps })),
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
