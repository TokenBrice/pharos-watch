import { getPublishedLegacyPegReference } from "@shared/lib/current-peg-observations";
import type { ExitExecutionCanonicalAttempt, ExitExecutionCertificate, ExitExecutionModelReview, ExitExecutionRouteFailure, ExitRouteObservation } from "@shared/types/exit-route";
import { ExitRouteObservationSchema } from "@shared/types/exit-route";
import type { V9ValidatedPolicyEnvelope } from "@shared/types/safety-score-v9";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { selectV9ExitStressRequest } from "@shared/lib/safety-score-v9/exit";
import { admitExitExecutionCertificate, exitExecutionEurVaultReviewDigest, exitExecutionInKindReviewDigest, exitExecutionInputGenerationId, exitExecutionReviewDigest, resolveExitExecutionPriceLegBudget, validateExitExecutionModelReviews } from "@shared/lib/safety-score-v9/exit-execution";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import reviewedModels from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { observeSecuritizeOffRampExit } from "./securitize-offramp";
import { Erc4626CanonicalAttemptError, observeErc4626InstantExit } from "./erc4626-instant";
import type { EvmRpcOptions } from "../evm-rpc";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "../stablecoins-cache";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { getFxReferenceTypeFromState, loadFxRateState, type FxRateState } from "../fx-rate-state";
import { ReferenceAdmissionSchema } from "@shared/types/reference-admission";
import { EUR_VAULT_PAYOUT_REFERENCE_PREFIX, hasCurrentPegAdmission } from "../safety-score-v9/reference-evidence";

type ExitExecutionRuntimeFailure = ExitExecutionRouteFailure & {
  canonicalAttempt?: ExitExecutionCanonicalAttempt;
};

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
    failures: [] as ExitExecutionRuntimeFailure[],
  };
  const envelope = args.envelope ?? loadV9CandidateMethodologyPolicy(args.clockSec);
  const reviews = (args.reviews ?? validateExitExecutionModelReviews(reviewedModels, envelope)).filter((review) => review.identity.assetId === args.assetId);
  const observations: ExitRouteObservation[] = [];
  const failures: ExitExecutionRuntimeFailure[] = [];
  if (reviews.length === 0) return { observations, failures };
  const request = selectV9ExitStressRequest(args.circulatingUsd, envelope);
  if (!request) return { observations, failures: reviews.map((review): ExitExecutionRuntimeFailure => ({ modelId: review.modelId, reason: "canonical-supply-unavailable", responsibility: "producer-failed" })) };
  const requests = [...new Set([...envelope.policy.semantic.exit.stressRequest.notionalGridUsd, request.requestedNotionalUsd])]
    .sort((left, right) => left - right)
    .map((requestedNotionalUsd) => ({ requestedNotionalUsd, maxCostBps: request.maxCostBps }));
  const cache = !args.inputReference || !args.outputReference
    ? args.stablecoinsCache ?? (args.db ? await loadStablecoinsCache(args.db) : null)
    : null;
  const referenceAdmissionActive = cache?.kind === "ok" && (
    cache.payload.fxReferenceObservations !== undefined || cache.payload.peggedAssets.some(({ currentPeg }) =>
      currentPeg?.referenceAdmission !== undefined || currentPeg?.admittedDeviationBps !== undefined)
  );
  let fxRateState = args.fxRateState;
  for (const review of reviews) {
    if (args.signal?.aborted) throw args.signal.reason;
    try {
      const policy = envelope.policy.semantic.exit.executionModels[review.modelId];
      if (!policy || policy.admission !== "enabled") { failures.push({ modelId: review.modelId, reason: "execution-model-unreviewed", responsibility: "method-unsupported" }); continue; }
      let inputReference = args.inputReference;
      let outputReference = args.outputReference;
      let inputPrice = null;
      let outputPrice = null;
      let outputFxObservedAtSec: number | null = null;
      let eurVaultPayout: { expectedUsd: number; sourceId: string; observedAtSec: number } | null | undefined;
      const isVault = review.producer.kind === "erc4626-instant";
      const externalShares = review.producer.kind === "erc4626-instant" ? review.producer.externalShareToken : undefined;
      if (cache?.kind === "ok") {
        const input = cache.payload.peggedAssets.find((asset) => asset.id === args.assetId);
        const output = cache.payload.peggedAssets.find((asset) => asset.id === review.identity.outputAssetKeys[0]);
        inputPrice = input ?? null;
        outputPrice = output ?? null;
        // A future-dated price is not an observed reference: the evaluator
        // would fail-close it on `futureSkewSec`, so capturing it only burns a
        // certificate that can never be admitted.
        if (!inputReference && input?.price && input.priceObservedAt != null && input.priceObservedAt <= args.clockSec && isObservedPrice(input)) inputReference = {
          assetKey: args.assetId, deployment: review.identity.deployment, rawUnits: "0", decimals: review.producer.inputDecimals,
          unitValueUsd: input.price, expectedUnitValueUsd: input.price, sourceId: input.priceSource!, sourceGenerationId: `stablecoins:${cache.updatedAt}`, observedAtSec: input.priceObservedAt,
        };
        if (!outputReference && output?.price && output.priceObservedAt != null && output.priceObservedAt <= args.clockSec && isObservedPrice(output)) {
          let expectedUnitValueUsd = output.pegType === "peggedUSD" ? 1 : null;
          let fxObservedAtSec: number | null = null;
          const peg = output.currentPeg;
          const legacyPayoutReference = getPublishedLegacyPegReference(output, cache.payload, cache.updatedAt);
          if (output.pegType === "peggedEUR" && isVault && !externalShares && referenceAdmissionActive && !legacyPayoutReference) {
            // The certificate leg is market-to-market. The optional route
            // evidence fields carry an independent reference for retention.
            expectedUnitValueUsd = output.price;
            eurVaultPayout = null;
            const reference = peg?.pegReference;
            const parsed = ReferenceAdmissionSchema.safeParse(peg && "referenceAdmission" in peg ? peg.referenceAdmission : undefined);
            const admission = parsed.data;
            if (reference && !cache.missingPriceObservedAtIds?.has(output.id) &&
                admission?.status === "admitted" && admission.reason === "live-reference" &&
                admission.kind === "fx" && admission.cadence === "intraday" &&
                hasCurrentPegAdmission("EUR", admission, output.priceObservedAt, reference.source, args.clockSec)) {
              eurVaultPayout = {
                expectedUsd: reference.valueUsd,
                observedAtSec: admission.referenceObservedAtSec,
                sourceId: `${EUR_VAULT_PAYOUT_REFERENCE_PREFIX}${admission.source}:${admission.generation ??
                  domainDigest("safety-score-v10.eur-vault-reference.v1", { admission, reference })}`,
              };
            }
          } else if (output.pegType === "peggedEUR") {
            if (fxRateState === undefined) fxRateState = args.db ? await loadFxRateState(args.db) : null;
            const sourceTime = fxRateState?.sourceUpdatedAtByPeg.peggedEUR;
            const fxLegBudget = sourceTime != null
              ? resolveExitExecutionPriceLegBudget(
                  { sourceId: `${output.priceSource!}+fx-rates:peggedEUR`, observedAtSec: sourceTime },
                  args.clockSec,
                  policy.priceMaxAgeSec,
                  args.clockSec,
                )
              : null;
            if (fxLegBudget &&
                getFxReferenceTypeFromState(fxRateState ?? null, "peggedEUR", fxLegBudget.budgetSec, args.clockSec) === "fresh" &&
                (!legacyPayoutReference || fxRateState?.rates.peggedEUR === legacyPayoutReference.valueUsd) &&
                sourceTime != null && sourceTime <= args.clockSec && args.clockSec - sourceTime <= fxLegBudget.budgetSec) {
              expectedUnitValueUsd = fxRateState!.rates.peggedEUR!;
              fxObservedAtSec = sourceTime;
              outputFxObservedAtSec = sourceTime;
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
      // Capture only asserts freshness now; the generation evaluates later. A leg
      // inside `priceMaxAgeSec` here can age past it before evaluation, so the
      // capture margin withholds it earlier and names the binding leg.
      const evaluationLagSec = policy.evaluationLagSec ?? 0;
      const baseCapturePriceMaxAgeSec = policy.priceMaxAgeSec - evaluationLagSec;
      const capturePriceMaxAgeForLeg = (reference: ExitExecutionCertificate["inputReference"] | undefined): number => (
        reference
          ? Math.max(
              0,
              resolveExitExecutionPriceLegBudget(
                reference,
                args.clockSec,
                policy.priceMaxAgeSec,
                args.clockSec,
              ).budgetSec - evaluationLagSec,
            )
          : baseCapturePriceMaxAgeSec
      );
      const outputCapturePriceMaxAgeSec = capturePriceMaxAgeForLeg(outputReference);
      const inputCapturePriceMaxAgeSec = capturePriceMaxAgeForLeg(inputReference);
      // Keep the 24/7 token market quote on the policy capture margin even when
      // an FX-valued output leg qualifies for the FX-closure intraday budget.
      const outputMarketStale = outputFxObservedAtSec !== null &&
        outputPrice?.priceObservedAt != null &&
        outputPrice.priceObservedAt <= args.clockSec &&
        args.clockSec - outputPrice.priceObservedAt > baseCapturePriceMaxAgeSec;
      const priceFailure = (leg: "input" | "output"): ExitExecutionRuntimeFailure => {
        const reference = leg === "input" ? inputReference : outputReference;
        const price = leg === "input" ? inputPrice : outputPrice;
        if (leg === "output" && outputMarketStale && outputPrice) {
          return {
            modelId: review.modelId,
            reason: "execution-price-leg-stale:output",
            responsibility: "producer-failed",
            priceLeg: {
              leg: "output",
              observedAtSec: outputPrice.priceObservedAt ?? null,
              capturePriceMaxAgeSec: baseCapturePriceMaxAgeSec,
              sourceId: outputPrice.priceSource ?? null,
              sourceGenerationId: cache?.kind === "ok" ? `stablecoins:${cache.updatedAt}` : null,
            },
          };
        }
        const observedAtSec = reference?.observedAtSec ?? price?.priceObservedAt ?? null;
        const capturePriceMaxAgeSec = leg === "input" ? inputCapturePriceMaxAgeSec : outputCapturePriceMaxAgeSec;
        return {
          modelId: review.modelId,
          reason: reference ? `execution-price-leg-stale:${leg}`
            : observedAtSec !== null && observedAtSec > args.clockSec
              ? `execution-price-leg-future:${leg}` : "execution-price-reference-unavailable",
          responsibility: "producer-failed",
          priceLeg: {
            leg, observedAtSec, capturePriceMaxAgeSec,
            sourceId: reference?.sourceId ?? price?.priceSource ?? null,
            sourceGenerationId: reference?.sourceGenerationId ?? (cache?.kind === "ok" ? `stablecoins:${cache.updatedAt}` : null),
          },
        };
      };
      const outputFresh = !!outputReference && !outputMarketStale && outputReference.observedAtSec <= args.clockSec &&
        args.clockSec - outputReference.observedAtSec <= outputCapturePriceMaxAgeSec;
      const inputFresh = !!inputReference && inputReference.observedAtSec <= args.clockSec &&
        args.clockSec - inputReference.observedAtSec <= inputCapturePriceMaxAgeSec;
      // A vault without an external share token re-derives a stale share price
      // from pinned NAV and the fresh output leg instead of admitting the old leg.
      const refreshInputFromOutput = isVault && !externalShares && outputFresh && !inputFresh;
      if (!outputReference || !outputFresh) {
        failures.push(priceFailure("output")); continue;
      }
      if (!inputFresh && !refreshInputFromOutput) {
        failures.push(priceFailure("input")); continue;
      }
      const observed = isVault
        // Only the canonical request is published/admitted. Bounded fallback
        // simulations prove this holder's receipt without probing every grid
        // notional on the shared serial redemption producer.
        ? await observeErc4626InstantExit({ review, inputReference, outputReference, refreshInputFromOutput, requests: [request], blockNumber: args.blockNumber, rpcOptions: { ...args.rpcOptions, signal: args.signal } })
        : await observeSecuritizeOffRampExit({ review, inputReference: inputReference!, outputReference, nativeReference: args.nativeReference, requests, holderAddress: args.holderAddress, rpcOptions: { ...args.rpcOptions, signal: args.signal } });
      if ("inputReference" in observed) inputReference = observed.inputReference;
      if (!inputReference) throw new Error("execution-price-reference-unavailable");
      const nativeReference = "nativeReference" in observed ? observed.nativeReference : args.nativeReference;
      const observedAtSec = Math.floor(Date.now() / 1000);
      const source = observed.source;
      const provenInstantFraction = observed.points.some((point) => point.requestedNotionalUsd === request.requestedNotionalUsd && point.executableUsd > 0 && point.certification !== "diagnostic");
      const gates = policy.requiredGates.map((gateId) => args.gates?.find((gate) => gate.gateId === gateId) ?? {
        gateId, verdict: provenInstantFraction ? "passed" as const : "unavailable" as const,
        evidenceId: `exit-execution:${gateId}`, observedAtSec: source.timestamp,
        reason: provenInstantFraction ? null : isVault ? observed.points.find((point) => point.requestedNotionalUsd === request.requestedNotionalUsd)?.reason ?? "erc4626-execution-unproven" : "live-holder-or-rail-proof-unavailable",
      });
      const settlementMaximumSec = provenInstantFraction ? 0 : null;
      const reviewDigest = exitExecutionReviewDigest(review);
      const certificate: ExitExecutionCertificate = {
        modelId: review.modelId,
        reviewDigest: eurVaultPayout !== undefined ? exitExecutionEurVaultReviewDigest(review)
          : isVault && !externalShares ? exitExecutionInKindReviewDigest(review) : reviewDigest,
        identity: review.identity,
        inputGenerationId: exitExecutionInputGenerationId(args.assetId, request, inputReference),
        observationGenerationId: domainDigest("safety-score-v10.exit-execution-source.v1", source),
        observedAtSec, sourceMaxAgeSec: policy.sourceMaxAgeSec, priceMaxAgeSec: policy.priceMaxAgeSec, source,
        holder: review.holder, prerequisites: isVault
          ? ["counterfactual-share-balance-only", "ordinary-synchronous-redeem", ...(externalShares
              ? ["ordinary-token-approval", "pinned-transaction-gas-estimate"] : ["network-gas-excluded-as-dex"])]
          : ["eligible-holder", "token-balance", "approved-spender"],
        gates, inputReference, feeReferences: nativeReference ? [nativeReference] : [], points: observed.points,
        capacityBasis: "transaction-simulation",
        settlement: { endpoint: outputReference.deployment, maximumCompletionSec: settlementMaximumSec, evidenceId: "exit-execution-settlement",
          ...(isVault ? { scope: "executed-input-only" as const } : {}) },
        resourceKeys: [`exit-resource:${review.identity.endpoint}`, ...(review.producer.kind === "securitize-offramp" ? [`inventory:${review.producer.chain}:${review.producer.provider.toLowerCase()}:${review.producer.outputToken.toLowerCase()}`] : [])],
        failureDomainKeys: [`provider:${review.identity.endpoint}`],
      };
      const admission = admitExitExecutionCertificate({ certificate, envelope, assetId: args.assetId, clockSec: Math.max(args.clockSec, observedAtSec), inputGenerationId: certificate.inputGenerationId, observationGenerationId: certificate.observationGenerationId, request, reviews });
      const point = observed.points.find((entry) => entry.requestedNotionalUsd === request.requestedNotionalUsd)!;
      const scoreEligible = admission.state !== "unavailable";
      observations.push(ExitRouteObservationSchema.parse({
        routeId: externalShares?.primaryRedemptionRouteId ?? `execution:${reviewDigest}`, routeFamily: isVault && !externalShares ? "protocol-redemption" : "issuer-redemption",
        scope: { kind: "chain-contract", chain: review.producer.chain, contractOrPoolId: review.producer.contract, protocol: isVault ? "erc4626-instant" : "securitize-offramp" },
        requestedNotionalUsd: request.requestedNotionalUsd, maxCostBps: request.maxCostBps, settlementHorizonSec: Math.max(1, settlementMaximumSec ?? request.comparisonWindowSec),
        ...(settlementMaximumSec === null ? { settlementBoundUnproven: true } : {}), executableUsd: point.executableUsd, completionRatio: point.executableUsd / point.requestedNotionalUsd,
        executionCostBps: point.executionCostBps, allInCostBps: point.allInCostBps,
        ...(eurVaultPayout === undefined ? {} : { outputUnitValueUsd: outputReference.unitValueUsd }),
        ...(eurVaultPayout ? {
          outputExpectedUnitValueUsd: eurVaultPayout.expectedUsd,
          outputUnitValueSourceId: eurVaultPayout.sourceId,
          outputUnitValueObservedAt: eurVaultPayout.observedAtSec,
        } : {}),
        output: { kind: outputReference.assetKey.startsWith("fiat:") ? "fiat" : "tracked-stablecoin", assetKeys: review.identity.outputAssetKeys, ...(outputReference.assetKey.startsWith("fiat:") ? { currency: outputReference.assetKey.slice(5) } : { trackedAssetIds: review.identity.outputAssetKeys }) },
        evidenceKind: "onchain-contract-state", confidence: "medium", modelConfidence: "medium", scoreEligible,
        observedAt: observedAtSec, freshnessSeconds: Math.max(0, observedAtSec - source.timestamp), commonModeKeys: certificate.resourceKeys,
        // Vault receipts certify only this generation-bound canonical request,
        // never a monotonic capacity curve inferred from independent samples.
        capacityCurve: (isVault ? [point] : observed.points.filter((entry) => !scoreEligible || entry.certification !== "diagnostic")).map((entry) => ({
          requestedNotionalUsd: entry.requestedNotionalUsd,
          maxCostBps: entry.maxCostBps,
          executableUsd: entry.executableUsd,
          completionRatio: entry.executableUsd / entry.requestedNotionalUsd,
          // A diagnostic point's measured cost may exceed maxCostBps; the wire
          // schema cannot carry it, so omit it rather than publish 0 bps (R7).
          ...(entry.certification === "diagnostic" ? {} : { executionCostBps: entry.executionCostBps }),
        })),
        executionModelId: review.modelId, executionCertificate: certificate,
      }));
      if (admission.state === "unavailable") failures.push({ modelId: review.modelId, reason: admission.reason, responsibility: admission.responsibility === "method-unsupported" ? "method-unsupported" : "producer-failed" });
    } catch (error) {
      if (args.signal?.aborted) throw error;
      failures.push({ modelId: review.modelId, reason: error instanceof Error && error.message ? error.message : "execution-producer-failed", responsibility: "producer-failed",
        ...(error instanceof Erc4626CanonicalAttemptError ? { canonicalAttempt: error.canonicalAttempt } : {}) });
    }
  }
  return { observations, failures };
}
