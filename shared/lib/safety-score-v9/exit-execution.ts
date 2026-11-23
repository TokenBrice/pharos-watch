import { z } from "zod";
import { ExitExecutionCertificateSchema, ExitExecutionModelReviewSchema, type ExitExecutionCertificate, type ExitExecutionModelReview, type ExitExecutionRequestPoint } from "../../types/exit-route";
import type { V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import { V9_EVIDENCE_PRODUCER_INTERVAL_SEC } from "../cron-cadences";
import { getPegTaxonomyByType } from "../peg-taxonomy";
import { REFERENCE_INTRADAY_BUDGET_SEC } from "../reference-admission";
import { getReferenceMarket, getReferenceSessionState, type ReferenceMarket } from "../reference-market-hours";
import { domainDigest } from "./primitives";
import { stableJsonStringifyV1 } from "../stable-json";
import reviewedModels from "../../data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { exitRawUsd, requestedExitRawInput } from "./exit-execution-units";

const EXIT_EXECUTION_FX_LEG_SOURCE_PATTERN = /\+fx-rates:(pegged[A-Z]+)$/;
const EXIT_EXECUTION_CERTIFICATE_PRODUCER_CADENCE_SEC =
  V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-redemption-backstops"];

export type ExitExecutionPriceLegBudgetBasis = "policy-price-max-age" | "fx-closure-intraday";

export interface ExitExecutionPriceLegFreshness {
  status: "ok" | "stale" | "future";
  reason: null | "execution-price-stale" | "execution-price-future";
  budgetSec: number;
  budgetBasis: ExitExecutionPriceLegBudgetBasis;
  generationId: string;
  sourceId: string;
  observedAtSec: number;
  ageSec: number;
  closureStartSec: number | null;
}

/** Identify a certificate price leg valued through an FX reference clock (e.g. `coingecko+fx-rates:peggedEUR` or `erc4626-nav:coingecko+fx-rates:peggedEUR`). */
function getExitExecutionFxLegMarket(sourceId: string): ReferenceMarket | null {
  const match = EXIT_EXECUTION_FX_LEG_SOURCE_PATTERN.exec(sourceId);
  if (!match) return null;
  const peg = getPegTaxonomyByType(match[1]);
  const market = getReferenceMarket(peg?.currency);
  return market === "fx" ? market : null;
}

/**
 * Single freshness-budget authority for certificate price legs.
 * When a certificate was captured during an FX market closure, an FX-valued leg
 * whose print was observed within that closure (`closureStartSec <= observedAtSec < nextOpenSec`)
 * uses the shared intraday FX freshness budget (`REFERENCE_INTRADAY_BUDGET_SEC`)
 * while the evaluation clock remains before `nextOpenSec` plus one certificate
 * producer cadence (`V9_EVIDENCE_PRODUCER_INTERVAL_SEC["sync-redemption-backstops"]`).
 * Post-reopen certificates, clocks at or past that grace window, pre-closure prints,
 * weekday runs, and non-FX legs keep the policy `baseMaxAgeSec` unchanged.
 */
export function resolveExitExecutionPriceLegBudget(
  leg: Pick<ExitExecutionCertificate["inputReference"], "sourceId" | "observedAtSec">,
  clockSec: number,
  baseMaxAgeSec: number,
  certificateObservedAtSec: number = clockSec,
): {
  budgetSec: number;
  budgetBasis: ExitExecutionPriceLegBudgetBasis;
  closureStartSec: number | null;
} {
  const market = getExitExecutionFxLegMarket(leg.sourceId);
  if (
    market === "fx" &&
    Number.isFinite(clockSec) &&
    Number.isFinite(leg.observedAtSec) &&
    Number.isFinite(certificateObservedAtSec)
  ) {
    const anchorSession = getReferenceSessionState(market, certificateObservedAtSec);
    if (!anchorSession.open) {
      const withinClosureWindow =
        leg.observedAtSec >= anchorSession.closureStartSec &&
        leg.observedAtSec < anchorSession.nextOpenSec;
      const withinGraceClock =
        clockSec >= anchorSession.closureStartSec &&
        clockSec < anchorSession.nextOpenSec + EXIT_EXECUTION_CERTIFICATE_PRODUCER_CADENCE_SEC;
      if (withinClosureWindow && withinGraceClock) {
        const fxClosureBudgetSec = Math.max(baseMaxAgeSec, REFERENCE_INTRADAY_BUDGET_SEC);
        return {
          budgetSec: fxClosureBudgetSec,
          budgetBasis: fxClosureBudgetSec > baseMaxAgeSec ? "fx-closure-intraday" : "policy-price-max-age",
          closureStartSec: anchorSession.closureStartSec,
        };
      }
      return {
        budgetSec: baseMaxAgeSec,
        budgetBasis: "policy-price-max-age",
        closureStartSec: anchorSession.closureStartSec,
      };
    }
    return { budgetSec: baseMaxAgeSec, budgetBasis: "policy-price-max-age", closureStartSec: null };
  }
  return { budgetSec: baseMaxAgeSec, budgetBasis: "policy-price-max-age", closureStartSec: null };
}

function assessExitExecutionPriceLegFreshness(
  leg: Pick<ExitExecutionCertificate["inputReference"], "sourceId" | "sourceGenerationId" | "observedAtSec">,
  clockSec: number,
  baseMaxAgeSec: number,
  futureSkewSec = 0,
  certificateObservedAtSec: number = clockSec,
): ExitExecutionPriceLegFreshness {
  const { budgetSec, budgetBasis, closureStartSec } = resolveExitExecutionPriceLegBudget(
    leg,
    clockSec,
    baseMaxAgeSec,
    certificateObservedAtSec,
  );
  const ageSec = clockSec - leg.observedAtSec;
  if (leg.observedAtSec > clockSec + futureSkewSec) {
    return {
      status: "future",
      reason: "execution-price-future",
      budgetSec,
      budgetBasis,
      generationId: leg.sourceGenerationId,
      sourceId: leg.sourceId,
      observedAtSec: leg.observedAtSec,
      ageSec,
      closureStartSec,
    };
  }
  if (ageSec > budgetSec) {
    return {
      status: "stale",
      reason: "execution-price-stale",
      budgetSec,
      budgetBasis,
      generationId: leg.sourceGenerationId,
      sourceId: leg.sourceId,
      observedAtSec: leg.observedAtSec,
      ageSec,
      closureStartSec,
    };
  }
  return {
    status: "ok",
    reason: null,
    budgetSec,
    budgetBasis,
    generationId: leg.sourceGenerationId,
    sourceId: leg.sourceId,
    observedAtSec: leg.observedAtSec,
    ageSec,
    closureStartSec,
  };
}

export function selectBindingExitExecutionPriceLegFreshness(
  legs: readonly Pick<ExitExecutionCertificate["inputReference"], "sourceId" | "sourceGenerationId" | "observedAtSec">[],
  clockSec: number,
  baseMaxAgeSec: number,
  futureSkewSec = 0,
  certificateObservedAtSec: number = clockSec,
): ExitExecutionPriceLegFreshness {
  if (legs.length === 0) throw new RangeError("At least one exit execution price leg is required");
  let binding = assessExitExecutionPriceLegFreshness(
    legs[0]!,
    clockSec,
    baseMaxAgeSec,
    futureSkewSec,
    certificateObservedAtSec,
  );
  for (let index = 1; index < legs.length; index += 1) {
    const next = assessExitExecutionPriceLegFreshness(
      legs[index]!,
      clockSec,
      baseMaxAgeSec,
      futureSkewSec,
      certificateObservedAtSec,
    );
    if (binding.status === "ok" && next.status !== "ok") {
      binding = next;
      continue;
    }
    if (binding.status !== "ok" && next.status === "ok") continue;
    if (binding.status === "future" || next.status === "future") {
      if (binding.status !== "future" || (next.status === "future" && next.observedAtSec > binding.observedAtSec)) {
        binding = next;
      }
      continue;
    }
    const bindingMargin = binding.budgetSec - binding.ageSec;
    const nextMargin = next.budgetSec - next.ageSec;
    if (nextMargin < bindingMargin || (nextMargin === bindingMargin && next.observedAtSec < binding.observedAtSec)) {
      binding = next;
    }
  }
  return binding;
}

/** Bind model inputs and the exact measured request, independently of later stress sizing. */
export function exitExecutionInputGenerationId(
  assetId: string,
  request: Pick<ExitExecutionRequestPoint, "requestedNotionalUsd" | "maxCostBps">,
  inputReference: ExitExecutionCertificate["inputReference"],
): string {
  return domainDigest("safety-score-v10.exit-execution-input.v2", {
    assetId,
    request: { requestedNotionalUsd: request.requestedNotionalUsd, maxCostBps: request.maxCostBps },
    inputReference,
  });
}

export function exitExecutionReviewDigest(review: ExitExecutionModelReview): string {
  return domainDigest("safety-score-v10.exit-execution-review.v1", review);
}

/** EUR vault receipts use market value in both cost legs and carry retention basis separately. */
export function exitExecutionEurVaultReviewDigest(review: ExitExecutionModelReview): string {
  return domainDigest("safety-score-v10.exit-execution-eur-vault-review.v2", review);
}

/** In-kind receipts with market-value costs and retention pinned by their output legs. */
export function exitExecutionInKindReviewDigest(review: ExitExecutionModelReview): string {
  return domainDigest("safety-score-v10.exit-execution-in-kind-review.v2", review);
}

export function exitExecutionReviewDigests(review: ExitExecutionModelReview): string[] {
  const legacy = exitExecutionReviewDigest(review);
  return review.producer.kind === "erc4626-instant" && !review.producer.externalShareToken
    ? [legacy, exitExecutionInKindReviewDigest(review), exitExecutionEurVaultReviewDigest(review)]
    : [legacy];
}

export function validateExitExecutionModelReviews(input: unknown, envelope: V9ValidatedPolicyEnvelope): ExitExecutionModelReview[] {
  const registry = z.object({ schemaVersion: z.literal(1), reviews: z.array(ExitExecutionModelReviewSchema) }).strict().parse(input);
  const seen = new Set<string>();
  for (const review of registry.reviews) {
    const digest = exitExecutionReviewDigest(review);
    if (seen.has(digest) || Date.parse(review.expiresAt) <= Date.parse(review.reviewedAt)) {
      throw new Error("Invalid or duplicate exit execution model review");
    }
    seen.add(digest);
  }
  return registry.reviews.filter((review) => envelope.policy.semantic.exit.executionModels[review.modelId]?.admission === "enabled");
}

export function resolveExitExecutionRequestPoint(certificate: ExitExecutionCertificate, request: { requestedNotionalUsd: number; maxCostBps: number }): ExitExecutionRequestPoint | null {
  return certificate.points.find((point) => point.requestedNotionalUsd === request.requestedNotionalUsd && point.maxCostBps === request.maxCostBps) ?? null;
}

/**
 * Recover the measured request bound to this certificate's input generation.
 * Stress-size drift does not invalidate that receipt or invent a new execution.
 * Admission still validates the original units, costs, identity, gates and clocks.
 */
export function resolveExitExecutionBoundPoint(
  certificate: ExitExecutionCertificate,
  request: { requestedNotionalUsd: number; maxCostBps: number },
): ExitExecutionRequestPoint | null {
  return certificate.points.find((point) => point.maxCostBps <= request.maxCostBps &&
    certificate.inputGenerationId === exitExecutionInputGenerationId(
      certificate.identity.assetId, point, certificate.inputReference,
    )) ?? null;
}

export type ExitExecutionAdmission =
  | {
      state: "observed" | "adverse";
      point: ExitExecutionRequestPoint;
      certificate: ExitExecutionCertificate;
      priceFreshness: ExitExecutionPriceLegFreshness;
    }
  | {
      state: "unavailable";
      responsibility: "method-unsupported" | "producer-failed" | "issuer-undisclosed";
      reason: string;
      priceFreshness?: ExitExecutionPriceLegFreshness;
    };

/**
 * The exact request is sized in raw input units; a clamped or otherwise bounded
 * simulation measures fewer of them. That is a lower-bound receipt of the exact
 * request, not a different request: only `exact-complete` claims it served every
 * requested unit, so only `exact-complete` must match the expected units exactly.
 */
function admitsRequestedInputUnits(point: ExitExecutionRequestPoint, inputReference: ExitExecutionCertificate["inputReference"]): boolean {
  const requested = BigInt(point.requestedRawInput);
  const expected = requestedExitRawInput(point.requestedNotionalUsd, inputReference.unitValueUsd, inputReference.decimals);
  return point.certification === "exact-complete" ? requested === expected : requested > 0n && requested <= expected;
}

export function admitExitExecutionCertificate(args: {
  certificate: unknown;
  envelope: V9ValidatedPolicyEnvelope;
  assetId: string;
  clockSec: number;
  inputGenerationId: string;
  observationGenerationId: string;
  request: { requestedNotionalUsd: number; maxCostBps: number };
  reviews?: readonly ExitExecutionModelReview[];
}): ExitExecutionAdmission {
  const unavailable = (reason: string, responsibility: "method-unsupported" | "producer-failed" | "issuer-undisclosed" = "producer-failed"): ExitExecutionAdmission => ({ state: "unavailable", reason, responsibility });
  const parsed = ExitExecutionCertificateSchema.safeParse(args.certificate);
  if (!parsed.success) return unavailable("execution-certificate-invalid");
  const certificate = parsed.data;
  const model = args.envelope.policy.semantic.exit.executionModels[certificate.modelId];
  if (!model || model.admission !== "enabled") return unavailable("execution-model-unreviewed", "method-unsupported");
  const review = (args.reviews ?? validateExitExecutionModelReviews(reviewedModels, args.envelope)).find((entry) =>
    entry.identity.assetId === args.assetId && exitExecutionReviewDigests(entry).includes(certificate.reviewDigest));
  if (!review || review.modelId !== certificate.modelId || stableJsonStringifyV1(review.identity) !== stableJsonStringifyV1(certificate.identity) || review.holder !== certificate.holder || certificate.identity.assetId !== args.assetId) return unavailable("execution-identity-unreviewed", "method-unsupported");
  if (Date.parse(review.reviewedAt) / 1000 > args.clockSec || Date.parse(review.expiresAt) / 1000 < args.clockSec) return unavailable("execution-review-expired", "method-unsupported");
  if (certificate.inputGenerationId !== args.inputGenerationId || certificate.observationGenerationId !== args.observationGenerationId) return unavailable("execution-generation-mismatch");
  const fresh = (time: number, age: number) => time <= args.clockSec + model.futureSkewSec && args.clockSec - time <= age;
  if (certificate.sourceMaxAgeSec !== model.sourceMaxAgeSec || certificate.priceMaxAgeSec !== model.priceMaxAgeSec || !fresh(certificate.observedAtSec, model.sourceMaxAgeSec) || !fresh(certificate.source.timestamp, model.sourceMaxAgeSec)) return unavailable("execution-source-stale");
  const point = resolveExitExecutionRequestPoint(certificate, args.request);
  if (!point) return unavailable("execution-exact-request-missing");
  const outputDeployment = `${review.producer.chain}:${review.producer.outputToken.toLowerCase()}`;
  if (certificate.inputReference.decimals !== review.producer.inputDecimals ||
      point.outputs.some((leg) => leg.decimals !== review.producer.outputDecimals || leg.deployment !== outputDeployment)) {
    return unavailable("execution-output-deployment-mismatch", "method-unsupported");
  }
  if (certificate.inputReference.assetKey !== args.assetId ||
      certificate.inputReference.deployment !== certificate.identity.deployment ||
      !admitsRequestedInputUnits(point, certificate.inputReference)) {
    return unavailable("execution-input-units-mismatch");
  }
  if (point.executableUsd > 0) {
    const externalShares = review.producer.kind === "erc4626-instant" ? review.producer.externalShareToken : undefined;
    if (externalShares) {
      const gasFees = point.fees.filter((fee) => fee.kind === "gas");
      const native = certificate.feeReferences.find((reference) => reference.assetKey === "asset:eth");
      if (review.producer.chain !== "ethereum" || gasFees.length !== 1 || gasFees[0]!.assetKey !== "asset:eth" ||
          BigInt(gasFees[0]!.rawUnits) <= 0n || !native || native.deployment !== "ethereum:native:eth" ||
          native.decimals !== 18 || native.sourceId !== `chainlink:${externalShares.nativeUsdFeed.address.toLowerCase()}` ||
          !fresh(native.observedAtSec, Math.min(model.priceMaxAgeSec, externalShares.nativeUsdFeed.maxAgeSec)) ||
          !certificate.prerequisites.includes("ordinary-token-approval") ||
          !certificate.prerequisites.includes("pinned-transaction-gas-estimate")) return unavailable("execution-custodian-gas-unproven");
    }
    const executedValue = exitRawUsd(BigInt(point.executedRawInput), certificate.inputReference.decimals, certificate.inputReference.unitValueUsd);
    const outputValue = point.outputs.reduce((sum, leg) => sum + exitRawUsd(BigInt(leg.rawUnits), leg.decimals, leg.unitValueUsd), 0n);
    const marketCostReceipt = certificate.reviewDigest !== exitExecutionReviewDigest(review);
    const expectedOutputValue = marketCostReceipt ? outputValue : point.outputs.reduce(
      (sum, leg) => sum + exitRawUsd(BigInt(leg.rawUnits), leg.decimals, leg.expectedUnitValueUsd), 0n,
    );
    if (executedValue <= 0n) return unavailable("execution-input-value-unavailable");
    let additionalFeeValue = 0n;
    for (const fee of point.fees.filter((entry) => entry.kind === "gas")) {
      const reference = certificate.feeReferences.find((entry) => entry.assetKey === fee.assetKey);
      if (!reference) return unavailable("execution-fee-valuation-unavailable");
      additionalFeeValue += exitRawUsd(BigInt(fee.rawUnits), reference.decimals, reference.unitValueUsd);
    }
    const allInCost = Number(((executedValue > outputValue ? executedValue - outputValue : 0n) + additionalFeeValue) * 1_000_000n / executedValue) / 100;
    const executionCost = Number(((executedValue > expectedOutputValue ? executedValue - expectedOutputValue : 0n) + additionalFeeValue) * 1_000_000n / executedValue) / 100;
    if (point.allInCostBps + 0.01 < allInCost || point.executionCostBps + 0.01 < executionCost) return unavailable("execution-cost-understated");
  }
  const priceFreshness = selectBindingExitExecutionPriceLegFreshness(
    [certificate.inputReference, ...point.outputs, ...certificate.feeReferences],
    args.clockSec,
    model.priceMaxAgeSec,
    model.futureSkewSec,
    certificate.observedAtSec,
  );
  if (priceFreshness.status !== "ok") {
    return {
      state: "unavailable",
      reason: priceFreshness.reason ?? "execution-price-stale",
      responsibility: "producer-failed",
      priceFreshness,
    };
  }
  if (!model.permittedBases.includes(certificate.capacityBasis) || certificate.capacityBasis === "documented-only" || point.certification === "diagnostic" || model.maximumCertification === "diagnostic" || (model.maximumCertification === "exact-lower-bound" && point.certification === "exact-complete")) return unavailable(point.reason ?? "execution-proof-insufficient");
  for (const gateId of model.requiredGates) {
    const gate = certificate.gates.find((entry) => entry.gateId === gateId);
    if (gate && !fresh(gate.observedAtSec, model.sourceMaxAgeSec)) return unavailable(`execution-gate-stale:${gateId}`);
    if (!gate || gate.verdict === "unsupported" || gate.verdict === "unavailable") return unavailable(gate?.reason ?? `execution-gate-missing:${gateId}`, gate?.reason === "issuer-undisclosed" ? "issuer-undisclosed" : "producer-failed");
    if (gate.verdict === "closed" && point.executableUsd !== 0) return unavailable(`execution-gate-closed:${gateId}`);
  }
  if (certificate.gates.some((gate) => gate.verdict === "unavailable" || gate.verdict === "unsupported" || (gate.verdict === "closed" && point.executableUsd > 0))) return unavailable("execution-gate-unproven");
  if (certificate.settlement.maximumCompletionSec === null) return unavailable("execution-settlement-unproven");
  return { state: point.executableUsd === 0 && point.certification === "exact-complete" ? "adverse" : "observed", point, certificate, priceFreshness };
}

/** Public projection deliberately has no account identifiers, calldata or private source URLs. */
export function projectExitExecutionCertificate(certificate: ExitExecutionCertificate) {
  return {
    modelId: certificate.modelId,
    observationGenerationId: certificate.observationGenerationId,
    observedAtSec: certificate.observedAtSec,
    sourceMaxAgeSec: certificate.sourceMaxAgeSec,
    priceMaxAgeSec: certificate.priceMaxAgeSec,
    holder: certificate.holder,
    capacityBasis: certificate.capacityBasis,
    source: certificate.source,
    settlement: { endpoint: certificate.settlement.endpoint, maximumCompletionSec: certificate.settlement.maximumCompletionSec,
      ...(certificate.settlement.scope ? { scope: certificate.settlement.scope } : {}) },
    gates: certificate.gates.map((gate) => ({ gateId: gate.gateId, verdict: gate.verdict, reason: gate.reason, observedAtSec: gate.observedAtSec })),
    points: certificate.points.map((point) => ({
      requestedNotionalUsd: point.requestedNotionalUsd, requestedRawInput: point.requestedRawInput,
      executedRawInput: point.executedRawInput, executableUsd: point.executableUsd,
      executionCostBps: point.executionCostBps, allInCostBps: point.allInCostBps,
      certification: point.certification, reason: point.reason, fees: point.fees,
      ...(point.canonicalAttempt ? { canonicalAttempt: {
        outcome: point.canonicalAttempt.outcome, block: point.canonicalAttempt.block,
        requestedRawInput: point.canonicalAttempt.requestedRawInput,
        shareBalanceBefore: point.canonicalAttempt.shareBalanceBefore, shareBalanceAfter: point.canonicalAttempt.shareBalanceAfter,
        totalSupplyBefore: point.canonicalAttempt.totalSupplyBefore, totalSupplyAfter: point.canonicalAttempt.totalSupplyAfter,
        returnedRawOutput: point.canonicalAttempt.returnedRawOutput, receivedRawOutput: point.canonicalAttempt.receivedRawOutput,
        reason: point.canonicalAttempt.reason,
      } } : {}),
      outputs: point.outputs.map((leg) => ({
        assetKey: leg.assetKey, rawUnits: leg.rawUnits, decimals: leg.decimals,
        unitValueUsd: leg.unitValueUsd, expectedUnitValueUsd: leg.expectedUnitValueUsd,
        observedAtSec: leg.observedAtSec, sourceId: leg.sourceId, sourceGenerationId: leg.sourceGenerationId,
      })),
    })),
  };
}
