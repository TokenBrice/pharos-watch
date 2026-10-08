import { z } from "zod";
import { ExitExecutionCertificateSchema, ExitExecutionModelReviewSchema, type ExitExecutionCertificate, type ExitExecutionModelReview, type ExitExecutionRequestPoint } from "../../types/exit-route";
import type { V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import { domainDigest } from "./primitives";
import { stableJsonStringifyV1 } from "../stable-json";
import reviewedModels from "../../data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { exitRawUsd, requestedExitRawInput } from "./exit-execution-units";

/** Bind model inputs and the selected exact request, not incidental supply drift within its bucket. */
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

export function validateExitExecutionModelReviews(input: unknown, envelope: V9ValidatedPolicyEnvelope): ExitExecutionModelReview[] {
  const registry = z.object({ schemaVersion: z.literal(1), reviews: z.array(ExitExecutionModelReviewSchema) }).strict().parse(input);
  const seen = new Set<string>();
  for (const review of registry.reviews) {
    const digest = exitExecutionReviewDigest(review);
    if (seen.has(digest) || !envelope.policy.semantic.exit.executionModels[review.modelId] || Date.parse(review.expiresAt) <= Date.parse(review.reviewedAt)) {
      throw new Error("Invalid or duplicate exit execution model review");
    }
    seen.add(digest);
  }
  return registry.reviews;
}

export function resolveExitExecutionRequestPoint(certificate: ExitExecutionCertificate, request: { requestedNotionalUsd: number; maxCostBps: number }): ExitExecutionRequestPoint | null {
  return certificate.points.find((point) => point.requestedNotionalUsd === request.requestedNotionalUsd && point.maxCostBps === request.maxCostBps) ?? null;
}

export type ExitExecutionAdmission =
  | { state: "observed" | "adverse"; point: ExitExecutionRequestPoint; certificate: ExitExecutionCertificate }
  | { state: "unavailable"; responsibility: "method-unsupported" | "producer-failed" | "issuer-undisclosed"; reason: string };

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
  const review = (args.reviews ?? validateExitExecutionModelReviews(reviewedModels, args.envelope)).find((entry) => exitExecutionReviewDigest(entry) === certificate.reviewDigest);
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
      BigInt(point.requestedRawInput) !== requestedExitRawInput(point.requestedNotionalUsd, certificate.inputReference.unitValueUsd, certificate.inputReference.decimals)) {
    return unavailable("execution-input-units-mismatch");
  }
  if (point.executableUsd > 0) {
    const executedValue = exitRawUsd(BigInt(point.executedRawInput), certificate.inputReference.decimals, certificate.inputReference.unitValueUsd);
    const outputValue = point.outputs.reduce((sum, leg) => sum + exitRawUsd(BigInt(leg.rawUnits), leg.decimals, leg.unitValueUsd), 0n);
    const expectedOutputValue = point.outputs.reduce((sum, leg) => sum + exitRawUsd(BigInt(leg.rawUnits), leg.decimals, leg.expectedUnitValueUsd), 0n);
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
  if (!fresh(certificate.inputReference.observedAtSec, model.priceMaxAgeSec) ||
      [...point.outputs, ...certificate.feeReferences].some((leg) => !fresh(leg.observedAtSec, model.priceMaxAgeSec))) return unavailable("execution-price-stale");
  if (!model.permittedBases.includes(certificate.capacityBasis) || certificate.capacityBasis === "documented-only" || point.certification === "diagnostic" || model.maximumCertification === "diagnostic" || (model.maximumCertification === "exact-lower-bound" && point.certification === "exact-complete")) return unavailable(point.reason ?? "execution-proof-insufficient");
  for (const gateId of model.requiredGates) {
    const gate = certificate.gates.find((entry) => entry.gateId === gateId);
    if (gate && !fresh(gate.observedAtSec, model.sourceMaxAgeSec)) return unavailable(`execution-gate-stale:${gateId}`);
    if (!gate || gate.verdict === "unsupported" || gate.verdict === "unavailable") return unavailable(gate?.reason ?? `execution-gate-missing:${gateId}`, gate?.reason === "issuer-undisclosed" ? "issuer-undisclosed" : "producer-failed");
    if (gate.verdict === "closed" && point.executableUsd !== 0) return unavailable(`execution-gate-closed:${gateId}`);
  }
  if (certificate.gates.some((gate) => gate.verdict === "unavailable" || gate.verdict === "unsupported" || (gate.verdict === "closed" && point.executableUsd > 0))) return unavailable("execution-gate-unproven");
  if (certificate.settlement.maximumCompletionSec === null) return unavailable("execution-settlement-unproven");
  return { state: point.executableUsd === 0 && point.certification === "exact-complete" ? "adverse" : "observed", point, certificate };
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
    settlement: { endpoint: certificate.settlement.endpoint, maximumCompletionSec: certificate.settlement.maximumCompletionSec },
    gates: certificate.gates.map((gate) => ({ gateId: gate.gateId, verdict: gate.verdict, reason: gate.reason, observedAtSec: gate.observedAtSec })),
    points: certificate.points.map((point) => ({
      requestedNotionalUsd: point.requestedNotionalUsd, requestedRawInput: point.requestedRawInput,
      executedRawInput: point.executedRawInput, executableUsd: point.executableUsd,
      executionCostBps: point.executionCostBps, allInCostBps: point.allInCostBps,
      certification: point.certification, reason: point.reason, fees: point.fees,
      outputs: point.outputs.map((leg) => ({
        assetKey: leg.assetKey, rawUnits: leg.rawUnits, decimals: leg.decimals,
        unitValueUsd: leg.unitValueUsd, expectedUnitValueUsd: leg.expectedUnitValueUsd,
        observedAtSec: leg.observedAtSec, sourceId: leg.sourceId, sourceGenerationId: leg.sourceGenerationId,
      })),
    })),
  };
}
