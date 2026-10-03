import { z } from "zod";

export const DexExitEvidenceKindSchema = z.enum([
  "measured-executable-depth",
  "reserve-based-amm-simulation",
  "direct-orderbook-depth",
  "generic-tvl-proxy",
  "synthetic-or-fallback",
  "unobserved",
]);
export type DexExitEvidenceKind = z.infer<typeof DexExitEvidenceKindSchema>;

export const ExitRouteFamilySchema = z.enum([
  "dex-amm",
  "dex-orderbook",
  "issuer-redemption",
  "protocol-redemption",
  "eventual-redemption",
]);
export type ExitRouteFamily = z.infer<typeof ExitRouteFamilySchema>;

export const ExitRouteEvidenceKindSchema = z.union([
  DexExitEvidenceKindSchema,
  z.enum(["documented-terms", "live-reserve-state", "onchain-contract-state", "manual-review"]),
]);
export type ExitRouteEvidenceKind = z.infer<typeof ExitRouteEvidenceKindSchema>;

const RedemptionExitEvidenceKindSchema = z.enum([
  "documented-terms",
  "live-reserve-state",
  "onchain-contract-state",
  "manual-review",
]);

export const ExitRouteConfidenceSchema = z.enum(["high", "medium", "low", "unknown"]);
export type ExitRouteConfidence = z.infer<typeof ExitRouteConfidenceSchema>;

export const ExitRouteCapacityEvidenceTierSchema = z.enum(["live-direct", "live-queue-proxy", "documented", "heuristic", "unknown"]);
export type ExitRouteCapacityEvidenceTier = z.infer<typeof ExitRouteCapacityEvidenceTierSchema>;

export const ExitRouteScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chain-contract"),
    chain: z.string().min(1),
    contractOrPoolId: z.string().min(1),
    protocol: z.string().min(1),
  }),
  z.object({
    kind: z.literal("venue"),
    venue: z.string().min(1),
    protocol: z.string().min(1),
  }),
  z.object({
    kind: z.literal("issuer"),
    issuerId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("protocol"),
    protocol: z.string().min(1),
    chain: z.string().min(1).optional(),
  }),
]);
export type ExitRouteScope = z.infer<typeof ExitRouteScopeSchema>;

export const ExitRouteOutputKindSchema = z.enum([
  "tracked-stablecoin",
  "fiat",
  "collateral",
  "physical-commodity-delivery",
  "unresolved-asset",
  "unresolved-basket",
  "unknown",
]);
export type ExitRouteOutputKind = z.infer<typeof ExitRouteOutputKindSchema>;

export const ExitRouteOutputSchema = z.object({
  kind: ExitRouteOutputKindSchema,
  currency: z.string().min(1).optional(),
  sameNotionalEligible: z.literal(false).optional(),
  unboundedDeliveryCap: z.number().finite().min(0).max(100).optional(),
  trackedAssetIds: z.array(z.string().min(1)).optional(),
  assetKeys: z.array(z.string().min(1)).min(1).max(16).optional(),
  basketWeights: z
    .array(
      z.object({
        assetId: z.string().min(1).optional(),
        symbol: z.string().min(1).optional(),
        weight: z.number().finite().min(0).max(1),
      }),
    )
    .optional(),
});
export type ExitRouteOutput = z.infer<typeof ExitRouteOutputSchema>;

export const ExitRouteCapacityPointSchema = z
  .object({
    requestedNotionalUsd: z.number().finite().positive(),
    maxCostBps: z.number().finite().nonnegative(),
    executableUsd: z.number().finite().nonnegative(),
    completionRatio: z.number().finite().min(0).max(1),
    /** Realized cost of the defining passing quote; absent on legacy or zero-capacity points. */
    executionCostBps: z.number().finite().nonnegative().optional(),
  })
  .superRefine((point, ctx) => {
    if (point.executionCostBps != null && point.executionCostBps > point.maxCostBps) {
      ctx.addIssue({
        code: "custom",
        path: ["executionCostBps"],
        message: "Realized execution cost exceeds the request limit",
      });
    }
  });
export type ExitRouteCapacityPoint = z.infer<typeof ExitRouteCapacityPointSchema>;

export const ExitRouteObservationHistorySchema = z
  .object({
    completeProducerCycleCount: z.number().int().positive(),
    successfulObservationCount: z.number().int().positive(),
    consecutiveSuccessCount: z.number().int().nonnegative(),
    observationWindowStartedAt: z.number().int().nonnegative(),
    observationWindowEndedAt: z.number().int().nonnegative(),
    latestOperationalFailureAt: z.number().int().nonnegative().nullable(),
    conservativeStatistic: z.literal("pointwise-minimum"),
    conservativeCapacityCurve: z.array(ExitRouteCapacityPointSchema).min(1).max(16),
  })
  .strict()
  .superRefine((history, ctx) => {
    if (history.successfulObservationCount > history.completeProducerCycleCount) {
      ctx.addIssue({
        code: "custom",
        path: ["successfulObservationCount"],
        message: "Successful observations cannot exceed complete producer cycles",
      });
    }
    if (history.consecutiveSuccessCount > history.successfulObservationCount) {
      ctx.addIssue({
        code: "custom",
        path: ["consecutiveSuccessCount"],
        message: "Consecutive successes cannot exceed successful observations",
      });
    }
    if (history.observationWindowEndedAt < history.observationWindowStartedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["observationWindowEndedAt"],
        message: "Observation window cannot end before it starts",
      });
    }
    if (
      history.latestOperationalFailureAt !== null &&
      (history.latestOperationalFailureAt < history.observationWindowStartedAt ||
        history.latestOperationalFailureAt > history.observationWindowEndedAt)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["latestOperationalFailureAt"],
        message: "Operational failure must fall inside the observation window",
      });
    }
  });
export type ExitRouteObservationHistory = z.infer<typeof ExitRouteObservationHistorySchema>;

export const MAX_EXIT_ROUTE_COMMON_MODE_KEYS = 16;
/**
 * Bounded public route payload per surface.
 *
 * Raised from 10 on the 2026-08-21 exit-stability pass. At 10 slots the three
 * anchor surfaces (`usdc-circle` 977 capability pools, `usdt-tether` 488,
 * `dai-makerdao` 73) published a tenth of their evidence, so one measured route
 * losing eligibility swapped 10% of the capacity basis and moved the composite
 * by ~9 points — which the dependency graph then propagated to every surface
 * backed by them. Widening the payload makes each individual slot a smaller
 * share of the basis, so ordinary producer churn no longer re-grades an anchor.
 *
 * A flat bound rather than a per-coin tier is deliberate: measured against the
 * live surface only those three coins reach 10 (nothing else exceeds 7), so a
 * tier keyed on capability count would add a second fluctuating input — the
 * budget itself — to the instability this pass exists to remove.
 *
 * Cost is bounded: observations serialize at ~1.8KB, so the widened ceiling adds
 * at most ~75KB across the whole published dataset.
 */
export const MAX_DEX_EXIT_ROUTE_OBSERVATIONS = 24;

export const PhysicalToUsdTraceSchema = z.object({
  endpoint: z.literal("USD"),
  holderScope: z.literal("verified-customer"),
  branch: z.enum(["modelled-metal-sale", "best-effort-issuer-cash-out"]),
  requestedNotionalUsd: z.number().finite().positive(),
  lots: z.number().int().nonnegative().nullable(),
  tokens: z.number().finite().nonnegative().nullable(),
  grossUsd: z.number().finite().nonnegative().nullable(),
  netUsd: z.number().finite().nonnegative().nullable(),
  costBps: z.number().finite().nonnegative().nullable(),
  minimumUsd: z.number().finite().positive().nullable(),
  maximumSettlementSec: z.number().int().nonnegative().nullable(),
  modelConfidence: z.enum(["medium", "low"]),
  assumptions: z.array(z.enum(["fee-policy-assumed", "settlement-maximum-policy-assumed"])),
  reviewedAt: z.string(),
  reviewExpiresAt: z.string(),
  termsMaxAgeSec: z.number().int().positive(),
  metalPriceMaxAgeSec: z.number().int().positive(),
  metalPriceObservedAtSec: z.number().int().nonnegative(),
  rejectionReason: z.string().min(1).nullable(),
}).strict();
export type PhysicalToUsdTrace = z.infer<typeof PhysicalToUsdTraceSchema>;

const ExitRawUnitsSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const ExitExecutionIdentitySchema = z.object({
  assetId: z.string().min(1),
  deployment: z.string().min(1),
  endpoint: z.string().min(1),
  outputAssetKeys: z.array(z.string().min(1)).min(1).max(16),
  implementationIdentity: z.string().min(1),
}).strict();
export const ExitExecutionGateSchema = z.object({
  gateId: z.string().min(1),
  verdict: z.enum(["passed", "closed", "unsupported", "unavailable"]),
  evidenceId: z.string().min(1),
  observedAtSec: z.number().int().nonnegative(),
  reason: z.string().min(1).nullable(),
}).strict().superRefine((gate, ctx) => {
  if (gate.verdict !== "passed" && gate.reason === null) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "Non-success gate requires a machine reason" });
  }
});
export const ExitExecutionOutputLegSchema = z.object({
  assetKey: z.string().min(1),
  deployment: z.string().min(1),
  rawUnits: ExitRawUnitsSchema,
  decimals: z.number().int().min(0).max(36),
  unitValueUsd: z.number().finite().positive(),
  expectedUnitValueUsd: z.number().finite().positive(),
  sourceId: z.string().min(1),
  sourceGenerationId: z.string().min(1),
  observedAtSec: z.number().int().nonnegative(),
}).strict();
export const ExitExecutionRequestPointSchema = z.object({
  requestedNotionalUsd: z.number().finite().positive(),
  maxCostBps: z.number().finite().nonnegative(),
  requestedRawInput: ExitRawUnitsSchema,
  executedRawInput: ExitRawUnitsSchema,
  executableUsd: z.number().finite().nonnegative(),
  executionCostBps: z.number().finite().nonnegative(),
  allInCostBps: z.number().finite().nonnegative(),
  fees: z.array(z.object({ kind: z.string().min(1), rawUnits: ExitRawUnitsSchema, assetKey: z.string().min(1) }).strict()).max(16),
  outputs: z.array(ExitExecutionOutputLegSchema).max(16),
  certification: z.enum(["exact-complete", "exact-lower-bound", "diagnostic"]),
  reason: z.string().min(1).nullable(),
}).strict().superRefine((point, ctx) => {
  // Zod refinements also run after regex failures; never parse rejected units.
  const rawUnits = [point.requestedRawInput, point.executedRawInput,
    ...point.outputs.map((leg) => leg.rawUnits), ...point.fees.map((fee) => fee.rawUnits)];
  if (rawUnits.some((value) => !/^(0|[1-9][0-9]*)$/.test(value))) return;
  const requested = BigInt(point.requestedRawInput);
  const executed = BigInt(point.executedRawInput);
  if (requested === 0n || executed > requested ||
      point.executableUsd > point.requestedNotionalUsd ||
      (executed === 0n) !== (point.executableUsd === 0) ||
      (point.certification === "exact-complete" && executed !== requested) ||
      (point.certification !== "diagnostic" && executed > 0n &&
        (point.outputs.length === 0 || point.allInCostBps > point.maxCostBps)) ||
      (point.certification !== "diagnostic" && executed === 0n &&
        (point.outputs.some((leg) => BigInt(leg.rawUnits) !== 0n) || point.fees.some((fee) => BigInt(fee.rawUnits) !== 0n))) ||
      (point.certification === "diagnostic" && point.reason === null)) {
    ctx.addIssue({ code: "custom", message: "Invalid exact-request execution proof" });
  }
  if (requested === 0n) return;
  const expectedCapacity = Number(executed * 1_000_000_000n / requested) / 1_000_000_000 * point.requestedNotionalUsd;
  if (Math.abs(point.executableUsd - expectedCapacity) > 0.01) {
    ctx.addIssue({ code: "custom", path: ["executableUsd"], message: "Capacity must represent executed input, not retained output" });
  }
});
export const ExitExecutionCertificateSchema = z.object({
  modelId: z.string().min(1),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  identity: ExitExecutionIdentitySchema,
  inputGenerationId: z.string().min(1),
  observationGenerationId: z.string().min(1),
  observedAtSec: z.number().int().nonnegative(),
  sourceMaxAgeSec: z.number().int().positive(),
  priceMaxAgeSec: z.number().int().positive(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("block"), number: z.number().int().nonnegative(), hash: z.string().min(1), timestamp: z.number().int().nonnegative(), complete: z.boolean(), truncated: z.boolean() }).strict(),
    z.object({ kind: z.literal("venue"), timestamp: z.number().int().nonnegative(), sequence: z.string().min(1), complete: z.boolean(), truncated: z.boolean() }).strict(),
  ]),
  holder: z.enum(["any-holder", "verified-customer", "whitelisted-primary"]),
  prerequisites: z.array(z.string().min(1)).max(16),
  gates: z.array(ExitExecutionGateSchema).min(1).max(32),
  inputReference: ExitExecutionOutputLegSchema,
  feeReferences: z.array(ExitExecutionOutputLegSchema).max(16),
  points: z.array(ExitExecutionRequestPointSchema).min(1).max(16),
  capacityBasis: z.enum(["transaction-simulation", "exhaustive-book-walk", "observed-prefix-book-walk", "funded-claim", "documented-only"]),
  settlement: z.object({
    endpoint: z.string().min(1),
    maximumCompletionSec: z.number().int().nonnegative().nullable(),
    evidenceId: z.string().min(1),
  }).strict(),
  resourceKeys: z.array(z.string().min(1)).min(1).max(16),
  failureDomainKeys: z.array(z.string().min(1)).min(1).max(16),
}).strict().superRefine((certificate, ctx) => {
  const pointKeys = new Set<string>();
  const gateKeys = new Set<string>();
  for (const gate of certificate.gates) {
    if (gateKeys.has(gate.gateId)) ctx.addIssue({ code: "custom", message: "Duplicate execution gate" });
    gateKeys.add(gate.gateId);
  }
  for (const point of certificate.points) {
    const key = `${point.requestedNotionalUsd}:${point.maxCostBps}`;
    if (pointKeys.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate exact-request point" });
    pointKeys.add(key);
    if (point.outputs.some((leg) => !certificate.identity.outputAssetKeys.includes(leg.assetKey)) ||
        (point.certification !== "diagnostic" && point.executableUsd > 0 &&
          (new Set(point.outputs.map((leg) => leg.assetKey)).size !== point.outputs.length ||
            certificate.identity.outputAssetKeys.some((assetKey) => !point.outputs.some((leg) => leg.assetKey === assetKey))))) {
      ctx.addIssue({ code: "custom", message: "Execution output does not match reviewed identity" });
    }
    if (point.certification === "exact-complete" && (!certificate.source.complete || certificate.source.truncated)) {
      ctx.addIssue({ code: "custom", message: "Incomplete source cannot certify exhaustive capacity" });
    }
  }
});
export type ExitExecutionCertificate = z.output<typeof ExitExecutionCertificateSchema>;
export type ExitExecutionRequestPoint = z.output<typeof ExitExecutionRequestPointSchema>;
export const ExitExecutionModelPolicySchema = z.object({
  admission: z.enum(["enabled", "research-only"]),
  requiredGates: z.array(z.string().min(1)).min(1),
  exactRequestRequired: z.literal(true),
  sourceMaxAgeSec: z.number().int().positive(),
  priceMaxAgeSec: z.number().int().positive(),
  futureSkewSec: z.number().int().nonnegative(),
  permittedBases: z.array(ExitExecutionCertificateSchema.shape.capacityBasis).min(1),
  maximumCertification: z.enum(["exact-complete", "exact-lower-bound", "diagnostic"]),
}).strict();
export const ExitExecutionModelReviewSchema = z.object({
  modelId: z.string().min(1),
  identity: ExitExecutionIdentitySchema,
  holder: ExitExecutionCertificateSchema.shape.holder,
  reviewedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  evidenceIds: z.array(z.string().min(1)).min(1),
  sourceUrls: z.array(z.string().url()).min(1),
  producer: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("kraken"), market: z.string().min(1), base: z.string().min(1), quote: z.string().min(1),
      inputDecimals: z.number().int().min(0).max(18), outputDecimals: z.number().int().min(0).max(18),
      outputDeployment: z.string().min(1), settlementEndpoint: z.string().min(1),
      feeSchedule: z.object({
        url: z.string().url(), contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
        applicableTakerFeeBps: z.number().finite().nonnegative().lt(10_000),
      }).strict().optional(),
    }).strict(),
    z.object({
      kind: z.literal("securitize-offramp"), chain: z.string().min(1),
      contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      implementation: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      provider: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      inputToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      outputToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      inputDecimals: z.number().int().min(0).max(18), outputDecimals: z.number().int().min(0).max(18),
      codeSha256: z.string().regex(/^[a-f0-9]{64}$/),
      implementationCodeSha256: z.string().regex(/^[a-f0-9]{64}$/),
      dependencyCodeIdentities: z.array(z.object({
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), codeSha256: z.string().regex(/^[a-f0-9]{64}$/),
        implementationAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      }).strict()).min(5).max(16),
    }).strict(),
  ]),
}).strict();
export type ExitExecutionModelReview = z.output<typeof ExitExecutionModelReviewSchema>;

export const ExitExecutionPublicCertificateSchema = z.object(ExitExecutionCertificateSchema.shape).pick({
  modelId: true, observationGenerationId: true, observedAtSec: true, sourceMaxAgeSec: true,
  priceMaxAgeSec: true, holder: true, capacityBasis: true, source: true,
}).extend({
  settlement: ExitExecutionCertificateSchema.shape.settlement.pick({ endpoint: true, maximumCompletionSec: true }),
  gates: z.array(z.object(ExitExecutionGateSchema.shape).pick({ gateId: true, verdict: true, reason: true, observedAtSec: true })),
  points: z.array(z.object(ExitExecutionRequestPointSchema.shape).pick({
    requestedNotionalUsd: true, requestedRawInput: true, executedRawInput: true, executableUsd: true,
    executionCostBps: true, allInCostBps: true, certification: true, reason: true, fees: true,
  }).extend({ outputs: z.array(ExitExecutionOutputLegSchema.pick({
    assetKey: true, rawUnits: true, decimals: true, unitValueUsd: true, expectedUnitValueUsd: true,
    observedAtSec: true, sourceId: true, sourceGenerationId: true,
  })) })),
});

const ExitRouteObservationBaseSchema = z.object({
  routeId: z.string().min(1),
  routeFamily: ExitRouteFamilySchema,
  scope: ExitRouteScopeSchema,
  requestedNotionalUsd: z.number().finite().positive(),
  settlementHorizonSec: z.number().int().positive(),
  /**
   * Open route whose settlement completion bound is unproven; capacity is a
   * bounded evidence gap, not a measurement.
   */
  settlementBoundUnproven: z.literal(true).optional(),
  maxCostBps: z.number().finite().nonnegative(),
  executableUsd: z.number().finite().nonnegative(),
  completionRatio: z.number().finite().min(0).max(1),
  output: ExitRouteOutputSchema,
  evidenceKind: ExitRouteEvidenceKindSchema,
  /** Exact measured-adapter identity when a DEX observation came from a reviewed runtime adapter. */
  adapterProfileId: z.string().min(1).optional(),
  /** Reviewed fee disclosure without a same-notional execution cost bound. */
  feeEvidence: z.enum(["undisclosed-reviewed", "disclosed-unquantified"]).optional(),
  /** Fee/slippage cost before valuing the received output asset. */
  executionCostBps: z.number().finite().nonnegative().optional(),
  /** Pinned USD unit value of the received output asset. */
  outputUnitValueUsd: z.number().finite().positive().optional(),
  /** Expected USD unit value under the output asset's own peg or NAV reference. */
  outputExpectedUnitValueUsd: z.number().finite().positive().optional(),
  /** Producer source identity for a pinned output valuation. */
  outputUnitValueSourceId: z.string().min(1).optional(),
  /** Source observation time for a pinned output valuation. */
  outputUnitValueObservedAt: z.number().int().nonnegative().optional(),
  /** Total input-value loss after execution cost and output-asset valuation. */
  allInCostBps: z.number().finite().nonnegative().optional(),
  /** Confidence in the route execution model, distinct from observation freshness/confidence. */
  modelConfidence: z.enum(["high", "medium", "low"]).optional(),
  confidence: ExitRouteConfidenceSchema,
  capacityEvidenceTier: ExitRouteCapacityEvidenceTierSchema.optional(),
  scoreEligible: z.boolean(),
  observedAt: z.number().int().nonnegative(),
  freshnessSeconds: z.number().int().nonnegative(),
  commonModeKeys: z.array(z.string().min(1)).max(MAX_EXIT_ROUTE_COMMON_MODE_KEYS),
  capacityCurve: z.array(ExitRouteCapacityPointSchema).min(1).max(16).optional(),
  observationHistory: ExitRouteObservationHistorySchema.optional(),
  physicalToUsd: PhysicalToUsdTraceSchema.optional(),
  executionModelId: z.string().min(1).optional(),
  executionCertificate: ExitExecutionCertificateSchema.optional(),
});

const DEX_EXIT_ROUTE_FAMILIES = new Set<ExitRouteFamily>(["dex-amm", "dex-orderbook"]);
const REDEMPTION_EXIT_ROUTE_FAMILIES = new Set<ExitRouteFamily>([
  "issuer-redemption",
  "protocol-redemption",
  "eventual-redemption",
]);
const DEX_EXIT_EVIDENCE_KINDS = new Set<string>(DexExitEvidenceKindSchema.options);
const REDEMPTION_EXIT_EVIDENCE_KINDS = new Set<string>(RedemptionExitEvidenceKindSchema.options);

type ExitRouteIssueContext = Pick<z.RefinementCtx, "addIssue">;

function enforceExecutionCertificate(observation: z.infer<typeof ExitRouteObservationBaseSchema>, ctx: ExitRouteIssueContext) {
  const certificate = observation.executionCertificate;
  if (!certificate) {
    if (observation.executionModelId && observation.scoreEligible) {
      ctx.addIssue({ code: "custom", message: "New execution models require a certificate" });
    }
    return;
  }
  const point = certificate.points.find((entry) =>
    entry.requestedNotionalUsd === observation.requestedNotionalUsd && entry.maxCostBps === observation.maxCostBps);
  if (observation.executionModelId !== certificate.modelId || !point ||
      point.executableUsd !== observation.executableUsd ||
      Math.abs(observation.completionRatio - observation.executableUsd / observation.requestedNotionalUsd) > 0.00001 ||
      certificate.observedAtSec !== observation.observedAt ||
      (observation.scoreEligible && (point.certification === "diagnostic" ||
        certificate.settlement.maximumCompletionSec === null ||
        certificate.gates.some((gate) => gate.verdict !== "passed" && !(gate.verdict === "closed" && point.executableUsd === 0))))) {
    ctx.addIssue({ code: "custom", message: "Observation envelope does not match execution certificate" });
  }
}

function enforceDexExitRouteLane(
  observation: z.infer<typeof ExitRouteObservationBaseSchema>,
  ctx: ExitRouteIssueContext,
) {
  if (!DEX_EXIT_ROUTE_FAMILIES.has(observation.routeFamily)) {
    ctx.addIssue({ code: "custom", path: ["routeFamily"], message: "DEX observations require a DEX route family" });
  }
  if (!DEX_EXIT_EVIDENCE_KINDS.has(observation.evidenceKind)) {
    ctx.addIssue({ code: "custom", path: ["evidenceKind"], message: "DEX observations require DEX evidence" });
  }
  if (
    observation.adapterProfileId !== undefined &&
    observation.evidenceKind !== "measured-executable-depth"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["adapterProfileId"],
      message: "Measured adapter identity requires measured executable-depth evidence",
    });
  }
  if (observation.observationHistory && observation.evidenceKind !== "measured-executable-depth") {
    ctx.addIssue({
      code: "custom",
      path: ["observationHistory"],
      message: "Producer-cycle history requires measured executable-depth evidence",
    });
  }
  if (observation.observationHistory) {
    const curve = observation.capacityCurve;
    const historyCurve = observation.observationHistory.conservativeCapacityCurve;
    const curveByPoint = new Map(
      (curve ?? []).map((point) => [`${point.requestedNotionalUsd}:${point.maxCostBps}`, point] as const),
    );
    const historyMatchesScoredCurve =
      curve?.length === historyCurve.length &&
      historyCurve.every((point) => {
        const scored = curveByPoint.get(`${point.requestedNotionalUsd}:${point.maxCostBps}`);
        return (
          scored?.executableUsd === point.executableUsd &&
          scored.completionRatio === point.completionRatio &&
          scored.executionCostBps === point.executionCostBps
        );
      });
    if (!historyMatchesScoredCurve) {
      ctx.addIssue({
        code: "custom",
        path: ["capacityCurve"],
        message: "Measured route capacity must use the conservative history curve",
      });
    }
    if (
      observation.observationHistory.observationWindowEndedAt >
      observation.observedAt + observation.freshnessSeconds + 60
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["observationHistory", "observationWindowEndedAt"],
        message: "Producer-cycle history cannot be newer than the observation clock",
      });
    }
  }
}

function enforceRedemptionExitRouteLane(
  observation: z.infer<typeof ExitRouteObservationBaseSchema>,
  ctx: ExitRouteIssueContext,
) {
  if (observation.adapterProfileId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["adapterProfileId"],
      message: "Measured adapter identity is only supported for DEX observations",
    });
  }
  if (!REDEMPTION_EXIT_ROUTE_FAMILIES.has(observation.routeFamily)) {
    ctx.addIssue({
      code: "custom",
      path: ["routeFamily"],
      message: "redemption observations require a redemption route family",
    });
  }
  if (!REDEMPTION_EXIT_EVIDENCE_KINDS.has(observation.evidenceKind)) {
    ctx.addIssue({
      code: "custom",
      path: ["evidenceKind"],
      message: "redemption observations require redemption evidence",
    });
  }
  if (observation.observationHistory) {
    ctx.addIssue({
      code: "custom",
      path: ["observationHistory"],
      message: "Producer-cycle history is only supported for measured DEX evidence",
    });
  }
  if (observation.routeFamily === "eventual-redemption" && observation.scoreEligible) {
    ctx.addIssue({
      code: "custom",
      path: ["scoreEligible"],
      message: "eventual redemption observations are diagnostic-only",
    });
  }
  if (
    observation.scoreEligible &&
    observation.allInCostBps !== undefined &&
    observation.allInCostBps > observation.maxCostBps
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["allInCostBps"],
      message: "Score-eligible redemption all-in cost exceeds the request limit",
    });
  }
  if (
    observation.scoreEligible &&
    observation.outputUnitValueUsd !== undefined &&
    observation.allInCostBps === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["allInCostBps"],
      message: "A score-eligible redemption with pinned output value requires an all-in cost",
    });
  }
  if (
    (observation.outputExpectedUnitValueUsd !== undefined ||
      observation.outputUnitValueSourceId !== undefined ||
      observation.outputUnitValueObservedAt !== undefined) &&
    observation.outputUnitValueUsd === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["outputUnitValueUsd"],
      message: "Pinned output valuation provenance or expectation requires an output unit value",
    });
  }
  if (
    observation.outputUnitValueObservedAt !== undefined &&
    observation.outputUnitValueObservedAt > observation.observedAt + 60
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["outputUnitValueObservedAt"],
      message: "Pinned output valuation cannot be newer than its route observation",
    });
  }
}

export const DexExitRouteObservationSchema = ExitRouteObservationBaseSchema.superRefine((observation, ctx) => {
  enforceDexExitRouteLane(observation, ctx);
  enforceExecutionCertificate(observation, ctx);
});
export type DexExitRouteObservation = z.infer<typeof DexExitRouteObservationSchema>;

export const RedemptionExitRouteObservationSchema = ExitRouteObservationBaseSchema.superRefine((observation, ctx) => {
  enforceRedemptionExitRouteLane(observation, ctx);
  enforceExecutionCertificate(observation, ctx);
});

export const ExitRouteObservationSchema = ExitRouteObservationBaseSchema.superRefine((observation, ctx) => {
  enforceExecutionCertificate(observation, ctx);
  if (DEX_EXIT_ROUTE_FAMILIES.has(observation.routeFamily)) enforceDexExitRouteLane(observation, ctx);
  else enforceRedemptionExitRouteLane(observation, ctx);
});
export type ExitRouteObservation = z.infer<typeof ExitRouteObservationSchema>;

function laneExitRouteObservationsSchema(
  enforceLane: typeof enforceDexExitRouteLane,
  invalidMessage: string,
  maxLength?: number,
) {
  const arraySchema = maxLength === undefined
    ? z.array(ExitRouteObservationSchema)
    : z.array(ExitRouteObservationSchema).max(maxLength);

  return arraySchema.superRefine((observations, ctx) => {
    observations.forEach((observation, index) => {
      let invalid = false;
      enforceLane(observation, { addIssue: () => { invalid = true; } });
      if (invalid) {
        ctx.addIssue({ code: "custom", path: [index], message: invalidMessage });
      }
    });
  });
}

export const DexExitRouteObservationsSchema = laneExitRouteObservationsSchema(
  enforceDexExitRouteLane,
  "invalid DEX exit-route observation",
  MAX_DEX_EXIT_ROUTE_OBSERVATIONS,
);
export const RedemptionExitRouteObservationsSchema = laneExitRouteObservationsSchema(
  enforceRedemptionExitRouteLane,
  "invalid redemption exit-route observation",
  16,
);

export const ExitRouteObservationCoverageSchema = z
  .object({
    status: z.enum(["populated", "unsupported", "unknown"]),
    capabilityMatrixVersion: z.string().min(1),
    retainedPoolCount: z.number().int().nonnegative(),
    observationCount: z.number().int().nonnegative(),
    scoreEligibleObservationCount: z.number().int().nonnegative(),
    scoreEligiblePoolCount: z.number().int().nonnegative().optional(),
    /** Retained pools whose reviewed capability could emit a score-eligible observation. */
    scoreEligibleCapabilityPoolCount: z.number().int().nonnegative().optional(),
    unsupportedPoolCount: z.number().int().nonnegative(),
    evidenceCounts: z.record(z.string(), z.number().int().nonnegative()),
    unsupportedReasons: z.record(z.string(), z.number().int().nonnegative()),
  })
  .superRefine((coverage, ctx) => {
    if (coverage.scoreEligibleObservationCount > coverage.observationCount) {
      ctx.addIssue({
        code: "custom",
        path: ["scoreEligibleObservationCount"],
        message: "score-eligible observations cannot exceed total observations",
      });
    }
    if (coverage.unsupportedPoolCount > coverage.retainedPoolCount) {
      ctx.addIssue({
        code: "custom",
        path: ["unsupportedPoolCount"],
        message: "unsupported pools cannot exceed retained pools",
      });
    }
    if (coverage.scoreEligiblePoolCount != null) {
      if (coverage.scoreEligiblePoolCount > coverage.retainedPoolCount) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreEligiblePoolCount"],
          message: "score-eligible pools cannot exceed retained pools",
        });
      }
      if (coverage.scoreEligiblePoolCount > coverage.scoreEligibleObservationCount) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreEligiblePoolCount"],
          message: "each score-eligible pool requires a score-eligible observation",
        });
      }
    }
    if (coverage.scoreEligibleCapabilityPoolCount != null) {
      if (coverage.scoreEligibleCapabilityPoolCount > coverage.retainedPoolCount) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreEligibleCapabilityPoolCount"],
          message: "score-eligible capability pools cannot exceed retained pools",
        });
      }
      if (
        coverage.scoreEligiblePoolCount != null &&
        coverage.scoreEligiblePoolCount > coverage.scoreEligibleCapabilityPoolCount
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["scoreEligiblePoolCount"],
          message: "score-eligible pools cannot exceed score-eligible capability pools",
        });
      }
    }
  });
export type ExitRouteObservationCoverage = z.infer<typeof ExitRouteObservationCoverageSchema>;
