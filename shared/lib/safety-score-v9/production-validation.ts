import { z } from "zod";
import { V9EvidenceResponsibilitySchema } from "../../types/safety-score-v9-fact-primitives";
import { SafetyScoreV9ResponseSchema } from "../../types/safety-score-v9-public";
import {
  V9_PRODUCTION_ACCEPTANCE_THRESHOLDS,
  V9_PRODUCTION_ACCEPTANCE_TOP_TWO_ASSET_IDS,
  V9_PRODUCTION_REQUIRED_MONOTONIC_CONTROL_IDS,
  V9_PRODUCTION_REQUIRED_QUALITATIVE_SENTINEL_IDS,
  type V9ProductionAcceptanceCandidateIdentity,
  type V9ProductionAcceptanceNoGoReason,
  type V9ProductionAcceptanceReport,
  type V9ProductionDistributionGate,
  type V9ProductionDistributionReport,
  type V9ProductionGenerationMovement,
  type V9ProductionGenerationReport,
  type V9ProductionMonotonicControlVerdict,
  type V9ProductionSentinelVerdict,
  type V9ProductionSupplementalValidationEvidence,
  type V9ProductionSyntheticAPlusReport,
  type V9ProductionV8ClassificationReport,
  type V9ProductionValidationEvidenceReport,
} from "../../types/safety-score-v9-production-validation";
import { V9GradeSchema, type V9Grade } from "../../types/safety-score-v9";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BaseInputGenerationIdSchema = z.string().regex(/^report-cards-input:v1:[a-f0-9]{64}$/);

const CandidateIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    policyId: z.string().min(1),
    policyDigest: Sha256Schema,
    evaluationBuildDigest: Sha256Schema,
    compilerFactSchemaDigest: Sha256Schema,
    producerCapabilityDigest: Sha256Schema,
  })
  .strict();

const AssetIdRowSchema = z
  .object({
    assetId: z.string().min(1),
    archetype: z.string().min(1).optional(),
  })
  .passthrough();

const ReplayArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-candidate-replay"),
    pipeline: z
      .object({
        fixedInput: z
          .object({
            activeAssetIds: z.array(z.string().min(1)).min(1),
            sourceGeneration: z.string().min(1),
            baseInputGenerationId: BaseInputGenerationIdSchema,
            clockSec: z.number().int().nonnegative(),
            captureKind: z.enum(["exact-publication-inputs", "public-reconstruction"]),
            liquidityStale: z.boolean(),
            redemptionStale: z.boolean(),
            inputFreshness: z.record(
              z.string().min(1),
              z.object({ stale: z.boolean() }).passthrough(),
            ),
          })
          .passthrough(),
        compiledFacts: z
          .object({
            activeAssetIds: z.array(z.string().min(1)).min(1),
            assets: z.array(AssetIdRowSchema).min(1),
            baseInputGenerationId: BaseInputGenerationIdSchema,
            v9FactSetDigest: Sha256Schema,
            asOfSec: z.number().int().nonnegative(),
            sourceFingerprints: z.record(
              z.string().min(1),
              z.object({ generationId: z.string().min(1) }).passthrough(),
            ),
          })
          .passthrough(),
        evaluatedSet: z
          .object({
            assets: z
              .array(
                z
                  .object({
                    assetId: z.string().min(1),
                    scoreInput: z.unknown(),
                    stressState: z.unknown(),
                  })
                  .passthrough(),
              )
              .min(1),
            baseInputGenerationId: BaseInputGenerationIdSchema,
            factSetDigest: Sha256Schema,
            scoreResultDigest: Sha256Schema,
            policyId: z.string().min(1),
            policyDigest: Sha256Schema,
            evaluationBuildDigest: Sha256Schema,
            asOfSec: z.number().int().nonnegative(),
            sourceGenerations: z.record(z.string().min(1), z.string().min(1)),
          })
          .passthrough(),
        candidate: SafetyScoreV9ResponseSchema,
        candidateIdentity: CandidateIdentitySchema,
        compilerFactSchemaDigest: Sha256Schema,
        producerCapabilityDigest: Sha256Schema,
      })
      .passthrough(),
  })
  .passthrough();

const EvidenceRefsSchema = z.array(z.string().trim().min(1)).min(1);
const SupplementalValidationEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-production-validation-evidence"),
    candidateIdentity: CandidateIdentitySchema,
    candidateResult: z
      .object({
        candidateId: z.string().min(1),
        baseInputGenerationId: BaseInputGenerationIdSchema,
        factSetDigest: Sha256Schema,
        resultDigest: Sha256Schema,
      })
      .strict(),
    qualitativeSentinels: z.array(
      z
        .object({
          id: z.enum(V9_PRODUCTION_REQUIRED_QUALITATIVE_SENTINEL_IDS),
          passed: z.boolean(),
          detail: z.string().trim().min(1),
          evidenceRefs: EvidenceRefsSchema,
        })
        .strict(),
    ),
    syntheticAPlusScenarios: z.array(
      z
        .object({
          scenarioId: z.string().trim().min(1),
          archetype: z.string().trim().min(1),
          score: z.number().finite().min(0).max(100).nullable(),
          grade: V9GradeSchema,
          resultDigest: Sha256Schema,
        })
        .strict(),
    ),
    monotonicControls: z.array(
      z
        .object({
          id: z.enum(V9_PRODUCTION_REQUIRED_MONOTONIC_CONTROL_IDS),
          caseCount: z.number().int().nonnegative(),
          failureCount: z.number().int().nonnegative(),
          evidenceRefs: EvidenceRefsSchema,
        })
        .strict(),
    ),
    v8: z
      .object({
        cards: z.array(
          z.object({ id: z.string().trim().min(1), grade: V9GradeSchema }).strict(),
        ),
        movementClassifications: z.array(
          z
            .object({
              assetId: z.string().trim().min(1),
              classification: z.enum([
                "intentional-strictness",
                "corrected-optimism",
                "producer-gap",
                "methodology-capability",
                "defect",
              ]),
              summary: z.string().trim().min(1),
              evidenceRefs: EvidenceRefsSchema,
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

type ParsedReplayArtifact = z.infer<typeof ReplayArtifactSchema>;

const GRADE_ORDER: readonly Exclude<V9Grade, "NR">[] = [
  "A+",
  "A",
  "A-",
  "B+",
  "B",
  "B-",
  "C+",
  "C",
  "C-",
  "D",
  "F",
];
const B_MINUS_OR_BETTER = new Set<V9Grade>(["A+", "A", "A-", "B+", "B", "B-"]);
const C_PLUS_THROUGH_D = new Set<V9Grade>(["C+", "C", "C-", "D"]);
const ECONOMIC_RESPONSIBILITIES = new Set(["measured-adverse", "issuer-undisclosed"]);
const AVAILABILITY_RESPONSIBILITIES = new Set([
  "integration-missing",
  "producer-failed",
  "method-unsupported",
]);
const SCORE_INPUT_DIGEST_DOMAIN = "safety-score-v9.production-score-input.v1";
const MAX_VALIDATED_ASSET_CIRCULATING_USD = 10_000_000_000_000;
const MAX_VALIDATED_AGGREGATE_CIRCULATING_USD = 20_000_000_000_000;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonnegativeInteger(value: number | bigint): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

function ratioBps(numerator: number | bigint, denominator: number | bigint): number {
  const integerNumerator = nonnegativeInteger(numerator);
  const integerDenominator = nonnegativeInteger(denominator);
  if (
    integerNumerator === null ||
    integerDenominator === null ||
    integerDenominator === 0n
  ) {
    return 0;
  }
  return Number(
    (integerNumerator * 10_000n + integerDenominator / 2n) /
      integerDenominator,
  );
}

function canonicalIds(values: readonly string[]): { ids: string[]; duplicateIds: string[] } {
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateIds.add(value);
    seen.add(value);
  }
  return {
    ids: [...seen].sort(compareText),
    duplicateIds: [...duplicateIds].sort(compareText),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJsonStringifyV1(left) === stableJsonStringifyV1(right);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, label);
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  return requireFiniteNumber(value, label);
}

function requireUnitInterval(value: unknown, label: string): number {
  const result = requireFiniteNumber(value, label);
  if (result < 0 || result > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return result;
}

function canonicalStrings(value: unknown, label: string): string[] {
  const values = requireArray(value, label);
  if (values.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${label} must contain nonempty strings`);
  }
  return [...new Set(values as string[])].sort(compareText);
}

function canonicalFailureDomains(value: unknown, label: string): unknown[] {
  return [
    ...new Map(
      requireArray(value, label).map((entry, index) => {
        const domain = requireRecord(entry, `${label}[${index}]`);
        const projected = {
          kind: requireString(domain.kind, `${label}[${index}].kind`),
          key: requireString(domain.key, `${label}[${index}].key`),
        };
        return [`${projected.kind}\u0000${projected.key}`, projected] as const;
      }),
    ).values(),
  ].sort((left, right) =>
    compareText(stableJsonStringifyV1(left), stableJsonStringifyV1(right))
  );
}

/**
 * Quantize production USD supply once, then keep all acceptance arithmetic in
 * integer cents. The canonical decimal spelling of the finite JSON number is
 * rounded to the nearest cent; an exact half-cent rounds upward. Parsing that
 * spelling avoids binary multiplication surprises such as 1.005 becoming 100
 * cents. Values whose rounded cents cannot fit in a safe integer are rejected.
 */
export function toV9ProductionSupplyCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const decimal = value.toString().toLowerCase();
  const exponentIndex = decimal.indexOf("e");
  const significand = exponentIndex === -1 ? decimal : decimal.slice(0, exponentIndex);
  const exponentText = exponentIndex === -1 ? "0" : decimal.slice(exponentIndex + 1);
  if (exponentIndex !== -1 && decimal.indexOf("e", exponentIndex + 1) !== -1) return null;

  const decimalPointIndex = significand.indexOf(".");
  const integerDigits = decimalPointIndex === -1 ? significand : significand.slice(0, decimalPointIndex);
  const fraction = decimalPointIndex === -1 ? "" : significand.slice(decimalPointIndex + 1);
  if (decimalPointIndex !== -1 && significand.indexOf(".", decimalPointIndex + 1) !== -1) return null;
  if (decimalPointIndex !== -1 && fraction.length === 0) return null;

  const unsignedExponent =
    exponentText[0] === "+" || exponentText[0] === "-" ? exponentText.slice(1) : exponentText;
  const isAsciiDigits = (text: string): boolean =>
    text.length > 0 && [...text].every((character) => character >= "0" && character <= "9");
  if (!isAsciiDigits(integerDigits) || (fraction.length > 0 && !isAsciiDigits(fraction))) return null;
  if (!isAsciiDigits(unsignedExponent)) return null;

  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return null;
  const unscaled = BigInt(`${integerDigits}${fraction}`);
  const centScale = exponent - fraction.length + 2;
  let cents: bigint;
  if (centScale >= 0) {
    cents = unscaled * 10n ** BigInt(centScale);
  } else {
    const divisor = 10n ** BigInt(-centScale);
    const quotient = unscaled / divisor;
    const remainder = unscaled % divisor;
    cents = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

interface ProjectedReason {
  code: string;
  responsibility: z.infer<typeof V9EvidenceResponsibilitySchema>;
}

function reasons(value: unknown, label: string): ProjectedReason[] {
  return [
    ...new Map(
      requireArray(value, label).map((entry, index) => {
        const reason = requireRecord(entry, `${label}[${index}]`);
        if (typeof reason.code !== "string" || reason.code.length === 0) {
          throw new Error(`${label}[${index}].code must be a nonempty string`);
        }
        const responsibility = V9EvidenceResponsibilitySchema.parse(reason.responsibility);
        const projected = { code: reason.code, responsibility };
        return [`${projected.code}\u0000${projected.responsibility}`, projected] as const;
      }),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.responsibility, right.responsibility),
  );
}

function structuralSignals(value: unknown, label: string): unknown[] {
  return requireArray(value, label)
    .map((entry, index) => {
      const signal = requireRecord(entry, `${label}[${index}]`);
      if (typeof signal.kind !== "string" || typeof signal.severity !== "string") {
        throw new Error(`${label}[${index}] must identify kind and severity`);
      }
      const materialSharePct = optionalFiniteNumber(
        signal.materialSharePct,
        `${label}[${index}].materialSharePct`,
      );
      const lossAbsorptionPct = optionalFiniteNumber(
        signal.lossAbsorptionPct,
        `${label}[${index}].lossAbsorptionPct`,
      );
      const expectedRecoverySec = optionalFiniteNumber(
        signal.expectedRecoverySec,
        `${label}[${index}].expectedRecoverySec`,
      );
      if (
        (materialSharePct !== null && (materialSharePct < 0 || materialSharePct > 100)) ||
        (lossAbsorptionPct !== null && (lossAbsorptionPct < 0 || lossAbsorptionPct > 100))
      ) {
        throw new Error(`${label}[${index}] percentage fields must be between 0 and 100`);
      }
      if (
        expectedRecoverySec !== null &&
        (!Number.isInteger(expectedRecoverySec) || expectedRecoverySec < 0)
      ) {
        throw new Error(`${label}[${index}].expectedRecoverySec must be a nonnegative integer`);
      }
      return {
        kind: signal.kind,
        severity: signal.severity,
        reason: requireString(signal.reason, `${label}[${index}].reason`),
        responsibility:
          signal.responsibility === undefined
            ? null
            : V9EvidenceResponsibilitySchema.parse(signal.responsibility),
        materialSharePct,
        economicLossScope: optionalString(
          signal.economicLossScope,
          `${label}[${index}].economicLossScope`,
        ),
        exposureKey: optionalString(
          signal.exposureKey,
          `${label}[${index}].exposureKey`,
        ),
        riskEventKey: optionalString(
          signal.riskEventKey,
          `${label}[${index}].riskEventKey`,
        ),
        recoveryPath: optionalString(
          signal.recoveryPath,
          `${label}[${index}].recoveryPath`,
        ),
        expectedRecoverySec,
        lossAbsorptionPct,
        evidenceConfidence: optionalString(
          signal.evidenceConfidence,
          `${label}[${index}].evidenceConfidence`,
        ),
        pricedInPillar: optionalString(
          signal.pricedInPillar,
          `${label}[${index}].pricedInPillar`,
        ),
        failureDomainKeys: canonicalStrings(
          signal.failureDomainKeys ?? [],
          `${label}[${index}].failureDomainKeys`,
        ),
      };
    })
    .sort((left, right) => compareText(stableJsonStringifyV1(left), stableJsonStringifyV1(right)));
}

function roleDependencyProjection(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const dependencyInputs = requireRecord(value, "evaluated dependency inputs");
  const roleInputs = requireArray(
    dependencyInputs.roleInputs ?? [],
    "evaluated dependency role inputs",
  )
    .map((entry, index) => {
      const role = requireRecord(entry, `evaluated dependency role inputs[${index}]`);
      return {
        upstreamAssetId: requireString(
          role.upstreamAssetId,
          `evaluated dependency role inputs[${index}].upstreamAssetId`,
        ),
        edgeKey: requireString(
          role.edgeKey,
          `evaluated dependency role inputs[${index}].edgeKey`,
        ),
        exposureKey: requireString(
          role.exposureKey,
          `evaluated dependency role inputs[${index}].exposureKey`,
        ),
        riskEventKey: requireString(
          role.riskEventKey,
          `evaluated dependency role inputs[${index}].riskEventKey`,
        ),
        dependencyType: requireString(
          role.dependencyType,
          `evaluated dependency role inputs[${index}].dependencyType`,
        ),
        role: requireString(
          role.role,
          `evaluated dependency role inputs[${index}].role`,
        ),
        weight: requireFiniteNumber(
          role.weight,
          `evaluated dependency role inputs[${index}].weight`,
        ),
        inheritedDimensions: canonicalStrings(
          role.inheritedDimensions ?? [],
          `evaluated dependency role inputs[${index}].inheritedDimensions`,
        ),
        unavailableDimensions: canonicalStrings(
          role.unavailableDimensions ?? [],
          `evaluated dependency role inputs[${index}].unavailableDimensions`,
        ),
        score: optionalFiniteNumber(
          role.score,
          `evaluated dependency role inputs[${index}].score`,
        ),
        boundedUnknown: requireBoolean(
          role.boundedUnknown,
          `evaluated dependency role inputs[${index}].boundedUnknown`,
        ),
        cycleBlocked: requireBoolean(
          role.cycleBlocked,
          `evaluated dependency role inputs[${index}].cycleBlocked`,
        ),
        evidenceRefIds: canonicalStrings(
          role.evidenceRefIds ?? [],
          `evaluated dependency role inputs[${index}].evidenceRefIds`,
        ),
        failureDomains: canonicalFailureDomains(
          role.failureDomains ?? [],
          `evaluated dependency role inputs[${index}].failureDomains`,
        ),
      };
    })
    .sort((left, right) =>
      compareText(stableJsonStringifyV1(left), stableJsonStringifyV1(right))
    );

  const rawProjections = dependencyInputs.rolePillarProjections;
  let rolePillarProjections: unknown = null;
  if (rawProjections !== undefined && rawProjections !== null) {
    const projections = requireRecord(
      rawProjections,
      "evaluated dependency role pillar projections",
    );
    rolePillarProjections = Object.fromEntries(
      ["exit", "control"].map((pillar) => {
        const projection = requireRecord(
          projections[pillar],
          `evaluated dependency ${pillar} role projection`,
        );
        const events = requireArray(
          projection.events,
          `evaluated dependency ${pillar} role projection events`,
        )
          .map((entry, index) => {
            const event = requireRecord(
              entry,
              `evaluated dependency ${pillar} role projection events[${index}]`,
            );
            return {
              targetPillar: requireString(
                event.targetPillar,
                `evaluated dependency ${pillar} role projection events[${index}].targetPillar`,
              ),
              exposureKey: requireString(
                event.exposureKey,
                `evaluated dependency ${pillar} role projection events[${index}].exposureKey`,
              ),
              riskEventKey: requireString(
                event.riskEventKey,
                `evaluated dependency ${pillar} role projection events[${index}].riskEventKey`,
              ),
              roles: canonicalStrings(
                event.roles ?? [],
                `evaluated dependency ${pillar} role projection events[${index}].roles`,
              ),
              edgeKeys: canonicalStrings(
                event.edgeKeys ?? [],
                `evaluated dependency ${pillar} role projection events[${index}].edgeKeys`,
              ),
              upstreamAssetIds: canonicalStrings(
                event.upstreamAssetIds ?? [],
                `evaluated dependency ${pillar} role projection events[${index}].upstreamAssetIds`,
              ),
              nominalExposureShare: requireUnitInterval(
                event.nominalExposureShare,
                `evaluated dependency ${pillar} role projection events[${index}].nominalExposureShare`,
              ),
              exposureShare: requireUnitInterval(
                event.exposureShare,
                `evaluated dependency ${pillar} role projection events[${index}].exposureShare`,
              ),
              inheritedScore: optionalFiniteNumber(
                event.inheritedScore,
                `evaluated dependency ${pillar} role projection events[${index}].inheritedScore`,
              ),
              modeledLossPoints: optionalFiniteNumber(
                event.modeledLossPoints,
                `evaluated dependency ${pillar} role projection events[${index}].modeledLossPoints`,
              ),
              boundedUnknown: requireBoolean(
                event.boundedUnknown,
                `evaluated dependency ${pillar} role projection events[${index}].boundedUnknown`,
              ),
              cycleBlocked: requireBoolean(
                event.cycleBlocked,
                `evaluated dependency ${pillar} role projection events[${index}].cycleBlocked`,
              ),
              unavailableDimensions: canonicalStrings(
                event.unavailableDimensions ?? [],
                `evaluated dependency ${pillar} role projection events[${index}].unavailableDimensions`,
              ),
              evidenceRefIds: canonicalStrings(
                event.evidenceRefIds ?? [],
                `evaluated dependency ${pillar} role projection events[${index}].evidenceRefIds`,
              ),
              failureDomains: canonicalFailureDomains(
                event.failureDomains ?? [],
                `evaluated dependency ${pillar} role projection events[${index}].failureDomains`,
              ),
            };
          })
          .sort((left, right) =>
            compareText(stableJsonStringifyV1(left), stableJsonStringifyV1(right))
          );
        return [
          pillar,
          {
            targetPillar: requireString(
              projection.targetPillar,
              `evaluated dependency ${pillar} role projection target`,
            ),
            limit: optionalFiniteNumber(
              projection.limit,
              `evaluated dependency ${pillar} role projection limit`,
            ),
            knownLossPoints: requireFiniteNumber(
              projection.knownLossPoints,
              `evaluated dependency ${pillar} role projection known loss`,
            ),
            boundedUnknownLossPoints: requireFiniteNumber(
              projection.boundedUnknownLossPoints,
              `evaluated dependency ${pillar} role projection bounded-unknown loss`,
            ),
            unresolvedExposureShare: requireFiniteNumber(
              projection.unresolvedExposureShare,
              `evaluated dependency ${pillar} role projection unresolved exposure`,
            ),
            materialUnresolvedExposure: requireBoolean(
              projection.materialUnresolvedExposure,
              `evaluated dependency ${pillar} role projection material unresolved exposure`,
            ),
            events,
          },
        ];
      }),
    );
  }

  return {
    roleInputs,
    rolePillarProjections,
    cycleBlocked: requireBoolean(
      dependencyInputs.cycleBlocked,
      "evaluated dependency inputs cycleBlocked",
    ),
  };
}

function operationalResilience(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const result = requireRecord(value, "evaluated score input operational resilience");
  const eligibility = requireRecord(
    result.eligibility,
    "evaluated score input operational resilience eligibility",
  );
  const pillarCredits = requireRecord(
    result.pillarCredits,
    "evaluated score input operational resilience pillar credits",
  );
  const contributions = requireArray(
    result.contributions,
    "evaluated score input operational resilience contributions",
  )
    .map((entry, index) => {
      const contribution = requireRecord(
        entry,
        `evaluated score input operational resilience contributions[${index}]`,
      );
      return {
        component: contribution.component,
        pillar: contribution.pillar,
        points: contribution.points,
        confidence: contribution.confidence,
      };
    })
    .sort((left, right) => compareText(stableJsonStringifyV1(left), stableJsonStringifyV1(right)));
  const blockerCodes = requireArray(
    result.blockerCodes,
    "evaluated score input operational resilience blocker codes",
  );
  if (blockerCodes.some((code) => typeof code !== "string")) {
    throw new Error("evaluated score input operational resilience blocker codes must contain strings");
  }
  return {
    eligible: result.eligible,
    eligibility: {
      requiredLiveHistoryMonths: eligibility.requiredLiveHistoryMonths,
      documentedLiveHistoryMonths: eligibility.documentedLiveHistoryMonths,
      confidence: eligibility.confidence,
      satisfied: eligibility.satisfied,
    },
    pillarCredits: {
      backing: pillarCredits.backing,
      exit: pillarCredits.exit,
      control: pillarCredits.control,
    },
    contributions,
    blockerCodes: [...new Set(blockerCodes as string[])].sort(compareText),
  };
}

/**
 * Projects only semantic scoring fields. Global replay identity, evidence prose,
 * and source-generation churn are excluded from stability checks.
 */
export function projectV9ProductionScoreInput(
  value: unknown,
  dependencyInputs?: unknown,
): Record<string, unknown> {
  const scoreInput = requireRecord(value, "evaluated score input");
  const pillars = requireRecord(scoreInput.pillars, "evaluated score input pillars");
  const projectedPillars = Object.fromEntries(
    ["backing", "exit", "control"].map((pillar) => {
      const input = requireRecord(pillars[pillar], `${pillar} score input`);
      const score = input.score;
      if (score !== null && (typeof score !== "number" || !Number.isFinite(score))) {
        throw new Error(`${pillar} score input score must be finite or null`);
      }
      if (typeof input.evidenceLevel !== "string") {
        throw new Error(`${pillar} score input evidenceLevel must be a string`);
      }
      return [
        pillar,
        {
          score,
          evidenceLevel: input.evidenceLevel,
          reasons: reasons(input.reasons ?? [], `${pillar} score input reasons`),
          structuralSignals: structuralSignals(
            input.structuralSignals ?? [],
            `${pillar} score input structural signals`,
          ),
        },
      ];
    }),
  );
  const peg = requireRecord(scoreInput.peg, "evaluated score input peg");
  const parent = requireRecord(scoreInput.parent, "evaluated score input parent");
  return {
    pillars: projectedPillars,
    peg: {
      applicable: peg.applicable,
      score: peg.score,
      activeDepegBps: peg.activeDepegBps,
      reasons: reasons(peg.reasons ?? [], "evaluated score input peg reasons"),
    },
    parent: {
      required: parent.required,
      score: parent.score,
      reasons: reasons(parent.propagatedReasons ?? [], "evaluated score input parent reasons"),
    },
    trackRecordMonths: scoreInput.trackRecordMonths,
    dependencyReasons: reasons(
      scoreInput.dependencyReasons ?? [],
      "evaluated score input dependency reasons",
    ),
    methodologyReasons: reasons(
      scoreInput.methodologyReasons ?? [],
      "evaluated score input methodology reasons",
    ),
    dependencyStructuralSignals: structuralSignals(
      scoreInput.dependencyStructuralSignals ?? [],
      "evaluated score input dependency structural signals",
    ),
    operationalResilience: operationalResilience(scoreInput.operationalResilience),
    dependencyRoles: roleDependencyProjection(dependencyInputs),
  };
}

function scoreInputDigest(input: Record<string, unknown>): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: SCORE_INPUT_DIGEST_DOMAIN,
      scoreInput: input,
    }),
  );
}

function changedPaths(left: unknown, right: unknown, prefix = ""): string[] {
  if (sameValue(left, right)) return [];
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    return [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
      .sort(compareText)
      .flatMap((key) =>
        changedPaths(leftRecord[key], rightRecord[key], prefix.length === 0 ? key : `${prefix}.${key}`),
      );
  }
  return [prefix || "$"];
}

function mapReasons(
  value: unknown,
  predicate: (responsibility: string) => boolean,
): unknown {
  if (Array.isArray(value)) {
    if (
      value.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof (entry as Record<string, unknown>).responsibility === "string",
      )
    ) {
      return value.filter((entry) =>
        predicate((entry as Record<string, unknown>).responsibility as string),
      );
    }
    return value.map((entry) => mapReasons(entry, predicate));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        mapReasons(entry, predicate),
      ]),
    );
  }
  return value;
}

function projectStructuralSignalChannel(
  value: unknown,
  predicate: (responsibility: string) => boolean,
): unknown[] {
  return requireArray(value, "projected structural signals").filter((entry) => {
    const signal = requireRecord(entry, "projected structural signal");
    return (
      typeof signal.responsibility === "string" &&
      V9EvidenceResponsibilitySchema.safeParse(signal.responsibility).success &&
      predicate(signal.responsibility)
    );
  });
}

function projectReasonChannel(
  input: Record<string, unknown>,
  predicate: (responsibility: string) => boolean,
): Record<string, unknown> {
  const pillars = requireRecord(input.pillars, "projected pillars");
  const peg = requireRecord(input.peg, "projected peg");
  const parent = requireRecord(input.parent, "projected parent");
  return {
    pillars: Object.fromEntries(
      ["backing", "exit", "control"].map((pillar) => {
        const value = requireRecord(pillars[pillar], `projected ${pillar}`);
        return [
          pillar,
          {
            reasons: mapReasons(value.reasons, predicate),
            structuralSignals: projectStructuralSignalChannel(
              value.structuralSignals,
              predicate,
            ),
          },
        ];
      }),
    ),
    peg: mapReasons(peg.reasons, predicate),
    parent: mapReasons(parent.reasons, predicate),
    dependencyReasons: mapReasons(input.dependencyReasons, predicate),
    methodologyReasons: mapReasons(input.methodologyReasons, predicate),
    dependencyStructuralSignals: projectStructuralSignalChannel(
      input.dependencyStructuralSignals,
      predicate,
    ),
  };
}

function rawEconomicProjection(input: Record<string, unknown>): Record<string, unknown> {
  const pillars = requireRecord(input.pillars, "projected pillars");
  const peg = requireRecord(input.peg, "projected peg");
  const parent = requireRecord(input.parent, "projected parent");
  return {
    pillars: Object.fromEntries(
      ["backing", "exit", "control"].map((pillar) => {
        const value = requireRecord(pillars[pillar], `projected ${pillar}`);
        return [
          pillar,
          {
            score: value.score,
            structuralSignals: projectStructuralSignalChannel(
              value.structuralSignals,
              (responsibility) => ECONOMIC_RESPONSIBILITIES.has(responsibility),
            ),
          },
        ];
      }),
    ),
    peg: {
      applicable: peg.applicable,
      score: peg.score,
      activeDepegBps: peg.activeDepegBps,
    },
    parent: {
      required: parent.required,
      score: parent.score,
    },
    trackRecordMonths: input.trackRecordMonths,
    dependencyStructuralSignals: projectStructuralSignalChannel(
      input.dependencyStructuralSignals,
      (responsibility) => ECONOMIC_RESPONSIBILITIES.has(responsibility),
    ),
    operationalResilience: input.operationalResilience,
    dependencyRoles: input.dependencyRoles,
  };
}

function collectReasonKeys(
  value: unknown,
  target: Map<string, z.infer<typeof V9EvidenceResponsibilitySchema>>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReasonKeys(entry, target);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.responsibility === "string" &&
    V9EvidenceResponsibilitySchema.safeParse(record.responsibility).success
  ) {
    const ownerKey =
      typeof record.code === "string"
        ? `reason:${record.code}\u0000${record.responsibility}`
        : typeof record.kind === "string"
          ? `structural:${stableJsonStringifyV1(record)}`
          : null;
    if (ownerKey !== null) {
      target.set(
        ownerKey,
        record.responsibility as z.infer<typeof V9EvidenceResponsibilitySchema>,
      );
    }
  }
  for (const entry of Object.values(record)) collectReasonKeys(entry, target);
}

function identityIssues(replay: ParsedReplayArtifact): string[] {
  const { pipeline } = replay;
  const { fixedInput, compiledFacts, evaluatedSet, candidate, candidateIdentity } = pipeline;
  const issues: string[] = [];
  const check = (passed: boolean, issue: string): void => {
    if (!passed) issues.push(issue);
  };
  check(candidate.baseInputGenerationId === fixedInput.baseInputGenerationId, "candidate base input generation");
  check(compiledFacts.baseInputGenerationId === fixedInput.baseInputGenerationId, "compiled base input generation");
  check(evaluatedSet.baseInputGenerationId === fixedInput.baseInputGenerationId, "evaluated base input generation");
  check(candidate.factSetDigest === compiledFacts.v9FactSetDigest, "candidate fact-set digest");
  check(evaluatedSet.factSetDigest === compiledFacts.v9FactSetDigest, "evaluated fact-set digest");
  check(candidate.resultDigest === evaluatedSet.scoreResultDigest, "candidate result digest");
  check(candidate.policy.id === candidateIdentity.policyId, "candidate policy ID");
  check(candidate.policy.semanticDigest === candidateIdentity.policyDigest, "candidate policy digest");
  check(candidate.evaluationBuildDigest === candidateIdentity.evaluationBuildDigest, "candidate evaluation build");
  check(evaluatedSet.policyId === candidateIdentity.policyId, "evaluated policy ID");
  check(evaluatedSet.policyDigest === candidateIdentity.policyDigest, "evaluated policy digest");
  check(evaluatedSet.evaluationBuildDigest === candidateIdentity.evaluationBuildDigest, "evaluated build digest");
  check(
    pipeline.compilerFactSchemaDigest === candidateIdentity.compilerFactSchemaDigest,
    "compiler fact-schema digest",
  );
  check(
    pipeline.producerCapabilityDigest === candidateIdentity.producerCapabilityDigest,
    "producer capability digest",
  );
  check(candidate.asOfSec === fixedInput.clockSec, "candidate evidence clock");
  check(compiledFacts.asOfSec === fixedInput.clockSec, "compiled evidence clock");
  check(evaluatedSet.asOfSec === fixedInput.clockSec, "evaluated evidence clock");
  const compiledSources = Object.fromEntries(
    Object.entries(compiledFacts.sourceFingerprints)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, source]) => [key, source.generationId]),
  );
  check(sameValue(candidate.sourceGenerations, evaluatedSet.sourceGenerations), "candidate source generations");
  check(sameValue(candidate.sourceGenerations, compiledSources), "compiled source generations");
  return issues.sort(compareText);
}

function assetSetIssues(replay: ParsedReplayArtifact): { issues: string[]; candidateIds: string[] } {
  const { pipeline } = replay;
  const sources = [
    ["fixed input", pipeline.fixedInput.activeAssetIds],
    ["compiled active set", pipeline.compiledFacts.activeAssetIds],
    ["compiled rows", pipeline.compiledFacts.assets.map((asset) => asset.assetId)],
    ["evaluated rows", pipeline.evaluatedSet.assets.map((asset) => asset.assetId)],
    ["candidate cards", pipeline.candidate.cards.map((card) => card.id)],
  ] as const;
  const canonical = sources.map(([label, values]) => [label, canonicalIds(values)] as const);
  const expected = canonical[0]![1].ids;
  const issues: string[] = [];
  for (const [label, result] of canonical) {
    if (result.duplicateIds.length > 0) issues.push(`${label} contains duplicate asset IDs`);
    if (!sameValue(result.ids, expected)) issues.push(`${label} does not match the fixed-input asset set`);
  }
  return {
    issues: [...new Set(issues)].sort(compareText),
    candidateIds: canonical[canonical.length - 1]![1].ids,
  };
}

function supplyState(replay: ParsedReplayArtifact): {
  centsByAssetId: ReadonlyMap<string, number>;
  issues: string[];
  invalidAssetIds: string[];
} {
  const centsByAssetId = new Map<string, number>();
  const issues: string[] = [];
  const invalidAssetIds: string[] = [];
  for (const asset of replay.pipeline.evaluatedSet.assets) {
    let supply: unknown;
    try {
      const stressState = requireRecord(asset.stressState, `${asset.assetId} stress state`);
      const exitPortfolio = requireRecord(
        stressState.exitPortfolio,
        `${asset.assetId} stress-state exit portfolio`,
      );
      supply = exitPortfolio.circulatingUsd;
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `${asset.assetId} supply state is malformed`);
      invalidAssetIds.push(asset.assetId);
      continue;
    }
    const supplyCents = toV9ProductionSupplyCents(supply);
    if (
      supplyCents === null ||
      BigInt(supplyCents) >
        BigInt(MAX_VALIDATED_ASSET_CIRCULATING_USD) * 100n
    ) {
      issues.push(
        `${asset.assetId} circulating USD supply must be finite, nonnegative, safely quantizable to cents, and no greater than ${MAX_VALIDATED_ASSET_CIRCULATING_USD}`,
      );
      invalidAssetIds.push(asset.assetId);
      continue;
    }
    centsByAssetId.set(asset.assetId, supplyCents);
  }
  const aggregateSupplyCents = [...centsByAssetId.values()].reduce(
    (sum, supplyCents) => sum + BigInt(supplyCents),
    0n,
  );
  if (
    aggregateSupplyCents >
    BigInt(MAX_VALIDATED_AGGREGATE_CIRCULATING_USD) * 100n
  ) {
    issues.push(
      `aggregate circulating USD supply must not exceed ${MAX_VALIDATED_AGGREGATE_CIRCULATING_USD}`,
    );
  }
  return {
    centsByAssetId,
    issues: [...new Set(issues)].sort(compareText),
    invalidAssetIds: [...new Set(invalidAssetIds)].sort(compareText),
  };
}

function completenessIssues(
  replay: ParsedReplayArtifact,
  identity: readonly string[],
  assetSets: readonly string[],
  supplyIssues: readonly string[],
): string[] {
  const { fixedInput, compiledFacts, evaluatedSet, candidate } = replay.pipeline;
  const issues: string[] = [];
  if (fixedInput.captureKind !== "exact-publication-inputs") {
    issues.push("fixed input is not an exact production publication capture");
  }
  if (fixedInput.liquidityStale) issues.push("fixed-input liquidity source is stale");
  if (fixedInput.redemptionStale) issues.push("fixed-input redemption source is stale");
  const freshnessEntries = Object.entries(fixedInput.inputFreshness);
  if (freshnessEntries.length === 0) issues.push("fixed input carries no producer freshness records");
  for (const [source, freshness] of freshnessEntries) {
    if (freshness.stale) issues.push(`fixed-input source ${source} is stale`);
  }
  if (Object.keys(compiledFacts.sourceFingerprints).length === 0) {
    issues.push("compiled fact set carries no source fingerprints");
  }
  if (Object.keys(evaluatedSet.sourceGenerations).length === 0) {
    issues.push("evaluated set carries no source generations");
  }
  const cards = candidate.cards;
  const ratedIds = cards.filter((card) => card.grade !== "NR").map((card) => card.id);
  const notRatedIds = cards.filter((card) => card.grade === "NR").map((card) => card.id).sort(compareText);
  if (candidate.completeness.expectedCount !== fixedInput.activeAssetIds.length) {
    issues.push("candidate expected count does not match the production active set");
  }
  if (candidate.schemaVersion !== 4) {
    issues.push("candidate uses the legacy public schema instead of the production trace contract");
  }
  if (candidate.cards.some((card) => !("scoreTrace" in card) || card.scoreTrace === undefined)) {
    issues.push("candidate cards do not all carry the mandatory production score trace");
  }
  if (candidate.completeness.ratedCount !== ratedIds.length) {
    issues.push("candidate rated count does not match candidate cards");
  }
  if (candidate.completeness.notRatedCount !== notRatedIds.length) {
    issues.push("candidate not-rated count does not match candidate cards");
  }
  if (!sameValue(candidate.completeness.notRatedIds, notRatedIds)) {
    issues.push("candidate not-rated IDs do not match candidate cards");
  }
  if (identity.length > 0) issues.push("generation has internal identity issues");
  if (assetSets.length > 0) issues.push("generation has internal asset-set issues");
  if (supplyIssues.length > 0) issues.push("generation has invalid supply inputs");
  return [...new Set(issues)].sort(compareText);
}

function ratioGate(input: {
  id: V9ProductionDistributionGate["id"];
  numerator: number | bigint;
  denominator: number | bigint;
  reportedNumerator?: number;
  reportedDenominator?: number;
  threshold: number;
  comparator: "at-least" | "at-most" | "strictly-below";
}): V9ProductionDistributionGate {
  const { numerator, denominator, threshold, comparator } = input;
  const integerNumerator = nonnegativeInteger(numerator);
  const integerDenominator = nonnegativeInteger(denominator);
  const exactInputs =
    integerNumerator !== null && integerDenominator !== null
      ? {
          scaled: integerNumerator * 10_000n,
          boundary: integerDenominator * BigInt(threshold),
          denominator: integerDenominator,
        }
      : null;
  const passed =
    exactInputs !== null &&
    exactInputs.denominator > 0n &&
    (comparator === "at-least"
      ? exactInputs.scaled >= exactInputs.boundary
      : comparator === "at-most"
        ? exactInputs.scaled <= exactInputs.boundary
        : exactInputs.scaled < exactInputs.boundary);
  return {
    id: input.id,
    passed,
    actual: ratioBps(numerator, denominator),
    threshold,
    unit: "basis-points",
    comparator,
    numerator: input.reportedNumerator ?? Number(numerator),
    denominator: input.reportedDenominator ?? Number(denominator),
  };
}

function countGate(input: {
  id: V9ProductionDistributionGate["id"];
  actual: number;
  threshold: number;
}): V9ProductionDistributionGate {
  return {
    id: input.id,
    passed: input.actual === input.threshold,
    actual: input.actual,
    threshold: input.threshold,
    unit: "count",
    comparator: "equals",
    numerator: null,
    denominator: null,
  };
}

function distributionReport(
  replay: ParsedReplayArtifact,
  excludedAssetIds: readonly string[],
  supply: ReturnType<typeof supplyState>,
): V9ProductionDistributionReport {
  const cards = replay.pipeline.candidate.cards;
  const gradeHistogram = Object.fromEntries(
    V9GradeSchema.options.map((grade) => [grade, 0]),
  ) as Record<V9Grade, number>;
  for (const card of cards) gradeHistogram[card.grade] += 1;
  const rated = cards.filter((card) => card.grade !== "NR");
  const bMinusOrBetterCount = rated.filter((card) => B_MINUS_OR_BETTER.has(card.grade)).length;
  const cPlusThroughDCount = rated.filter((card) => C_PLUS_THROUGH_D.has(card.grade)).length;
  const dCount = gradeHistogram.D;
  const exactCounts = new Map<number, number>();
  for (const card of rated) {
    if (card.score === null) continue;
    exactCounts.set(card.score, (exactCounts.get(card.score) ?? 0) + 1);
  }
  const exactScoreBuckets = [...exactCounts.entries()]
    .map(([score, count]) => ({ score, count, shareBps: ratioBps(count, rated.length) }))
    .sort((left, right) => right.count - left.count || left.score - right.score);
  const largestExactScoreBucket = exactScoreBuckets[0] ?? null;
  const syntheticEvidenceFloorIds = cards
    .filter(
      (card) =>
        card.score === 40 &&
        card.bindingCap?.kind === "evidence-floor:d" &&
        card.bindingCap.source === "evidence",
    )
    .map((card) => card.id)
    .sort(compareText);
  const excluded = new Set(excludedAssetIds);
  let exTopTwoSupplyCents = 0n;
  let exTopTwoBMinusOrBetterSupplyCents = 0n;
  for (const card of cards) {
    if (excluded.has(card.id)) continue;
    const supplyCents = supply.centsByAssetId.get(card.id);
    if (supplyCents === undefined) continue;
    exTopTwoSupplyCents += BigInt(supplyCents);
    if (B_MINUS_OR_BETTER.has(card.grade)) {
      exTopTwoBMinusOrBetterSupplyCents += BigInt(supplyCents);
    }
  }
  const exTopTwoSupplyUsd = Number(exTopTwoSupplyCents) / 100;
  const exTopTwoBMinusOrBetterSupplyUsd =
    Number(exTopTwoBMinusOrBetterSupplyCents) / 100;
  const gates: V9ProductionDistributionGate[] = [
    ratioGate({
      id: "b-minus-or-better-share",
      numerator: bMinusOrBetterCount,
      denominator: rated.length,
      threshold: V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.bMinusOrBetterMinimumBps,
      comparator: "at-least",
    }),
    ratioGate({
      id: "c-plus-through-d-share",
      numerator: cPlusThroughDCount,
      denominator: rated.length,
      threshold: V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.cPlusThroughDMaximumBps,
      comparator: "at-most",
    }),
    ratioGate({
      id: "d-share",
      numerator: dCount,
      denominator: rated.length,
      threshold: V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.dMaximumBps,
      comparator: "at-most",
    }),
    ratioGate({
      id: "exact-score-bucket-share",
      numerator: largestExactScoreBucket?.count ?? 0,
      denominator: rated.length,
      threshold: V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.exactScoreBucketExclusiveMaximumBps,
      comparator: "strictly-below",
    }),
    ratioGate({
      id: "not-rated-share",
      numerator: gradeHistogram.NR,
      denominator: cards.length,
      threshold: V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.notRatedMaximumBps,
      comparator: "at-most",
    }),
    ratioGate({
      id: "ex-top-two-b-minus-or-better-supply-share",
      numerator: exTopTwoBMinusOrBetterSupplyCents,
      denominator: exTopTwoSupplyCents,
      reportedNumerator: exTopTwoBMinusOrBetterSupplyUsd,
      reportedDenominator: exTopTwoSupplyUsd,
      threshold: V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.exTopTwoBMinusOrBetterSupplyMinimumBps,
      comparator: "at-least",
    }),
    countGate({
      id: "supply-input-validity",
      actual: supply.issues.length,
      threshold: 0,
    }),
    countGate({
      id: "synthetic-evidence-floor-count",
      actual: syntheticEvidenceFloorIds.length,
      threshold: V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.syntheticEvidenceFloorMaximumCount,
    }),
  ];
  return {
    decision: gates.every((gate) => gate.passed) ? "gate-passed" : "no-go",
    activeCount: cards.length,
    ratedCount: rated.length,
    notRatedCount: gradeHistogram.NR,
    gradeHistogram,
    bMinusOrBetter: {
      count: bMinusOrBetterCount,
      shareBps: ratioBps(bMinusOrBetterCount, rated.length),
    },
    cPlusThroughD: {
      count: cPlusThroughDCount,
      shareBps: ratioBps(cPlusThroughDCount, rated.length),
    },
    d: { count: dCount, shareBps: ratioBps(dCount, rated.length) },
    notRated: { count: gradeHistogram.NR, shareBps: ratioBps(gradeHistogram.NR, cards.length) },
    largestExactScoreBucket,
    exactScoreBuckets,
    syntheticEvidenceFloorIds,
    invalidSupplyAssetIds: supply.invalidAssetIds,
    exTopTwoSupply: {
      excludedAssetIds: [...excludedAssetIds].sort(compareText),
      totalUsd: exTopTwoSupplyUsd,
      bMinusOrBetterUsd: exTopTwoBMinusOrBetterSupplyUsd,
      bMinusOrBetterShareBps: ratioBps(
        exTopTwoBMinusOrBetterSupplyCents,
        exTopTwoSupplyCents,
      ),
    },
    gates,
  };
}

function generationReport(
  replay: ParsedReplayArtifact,
  excludedAssetIds: readonly string[],
): V9ProductionGenerationReport {
  const identity = identityIssues(replay);
  const assetSets = assetSetIssues(replay);
  const supply = supplyState(replay);
  const completeness = completenessIssues(replay, identity, assetSets.issues, supply.issues);
  return {
    sourceGeneration: replay.pipeline.fixedInput.sourceGeneration,
    baseInputGenerationId: replay.pipeline.fixedInput.baseInputGenerationId,
    clockSec: replay.pipeline.fixedInput.clockSec,
    candidateId: replay.pipeline.candidate.candidateId,
    factSetDigest: replay.pipeline.candidate.factSetDigest,
    resultDigest: replay.pipeline.candidate.resultDigest,
    candidateIdentity: replay.pipeline.candidateIdentity as V9ProductionAcceptanceCandidateIdentity,
    internalIdentityPassed: identity.length === 0,
    internalIdentityIssues: identity,
    internalAssetSetPassed: assetSets.issues.length === 0,
    internalAssetSetIssues: assetSets.issues,
    complete: completeness.length === 0,
    completenessIssues: completeness,
    supplyValid: supply.issues.length === 0,
    supplyIssues: supply.issues,
    assetIds: assetSets.candidateIds,
    distribution: distributionReport(replay, excludedAssetIds, supply),
  };
}

function gradeDistance(from: V9Grade, to: V9Grade): number | null {
  if (from === "NR" || to === "NR") return null;
  return Math.abs(GRADE_ORDER.indexOf(from) - GRADE_ORDER.indexOf(to));
}

function gradeWorsened(from: V9Grade, to: V9Grade): boolean {
  if (from === "NR") return false;
  if (to === "NR") return true;
  return GRADE_ORDER.indexOf(to) > GRADE_ORDER.indexOf(from);
}

function gradeImproved(from: V9Grade, to: V9Grade): boolean {
  if (to === "NR") return false;
  if (from === "NR") return true;
  return GRADE_ORDER.indexOf(to) < GRADE_ORDER.indexOf(from);
}

function movementPair(
  from: ParsedReplayArtifact,
  to: ParsedReplayArtifact,
  flagshipIds: ReadonlySet<string>,
): V9ProductionGenerationMovement[] {
  const fromCards = new Map(from.pipeline.candidate.cards.map((card) => [card.id, card]));
  const fromEvaluated = new Map(from.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const toEvaluated = new Map(to.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const movements: V9ProductionGenerationMovement[] = [];
  for (const card of to.pipeline.candidate.cards) {
    const previous = fromCards.get(card.id);
    const beforeEvaluated = fromEvaluated.get(card.id);
    const afterEvaluated = toEvaluated.get(card.id);
    if (!previous || !beforeEvaluated || !afterEvaluated) continue;
    if (previous.score === card.score && previous.grade === card.grade) continue;
    const beforeInput = projectV9ProductionScoreInput(
      beforeEvaluated.scoreInput,
      beforeEvaluated.dependencyInputs,
    );
    const afterInput = projectV9ProductionScoreInput(
      afterEvaluated.scoreInput,
      afterEvaluated.dependencyInputs,
    );
    const changedScoreBearingFields = changedPaths(beforeInput, afterInput);
    const beforeAvailability = projectReasonChannel(
      beforeInput,
      (responsibility) => AVAILABILITY_RESPONSIBILITIES.has(responsibility),
    );
    const afterAvailability = projectReasonChannel(
      afterInput,
      (responsibility) => AVAILABILITY_RESPONSIBILITIES.has(responsibility),
    );
    const changedAvailabilityFields = changedPaths(beforeAvailability, afterAvailability);
    const beforeEconomicReasons = projectReasonChannel(
      beforeInput,
      (responsibility) => ECONOMIC_RESPONSIBILITIES.has(responsibility),
    );
    const afterEconomicReasons = projectReasonChannel(
      afterInput,
      (responsibility) => ECONOMIC_RESPONSIBILITIES.has(responsibility),
    );
    const changedEconomicReasonFields = changedPaths(beforeEconomicReasons, afterEconomicReasons);
    const changedRawEconomicFields = changedPaths(
      rawEconomicProjection(beforeInput),
      rawEconomicProjection(afterInput),
    );
    const distance = gradeDistance(previous.grade, card.grade);
    const rateabilityChanged = (previous.grade === "NR") !== (card.grade === "NR");
    const scoreDelta =
      previous.score === null || card.score === null ? null : card.score - previous.score;
    const flagship = flagshipIds.has(card.id);
    const downgrade =
      gradeWorsened(previous.grade, card.grade) || (scoreDelta !== null && scoreDelta < 0);
    const improvement =
      gradeImproved(previous.grade, card.grade) || (scoreDelta !== null && scoreDelta > 0);
    const beforeEconomicReasonKeys = new Map<
      string,
      z.infer<typeof V9EvidenceResponsibilitySchema>
    >();
    const afterEconomicReasonKeys = new Map<
      string,
      z.infer<typeof V9EvidenceResponsibilitySchema>
    >();
    collectReasonKeys(beforeEconomicReasons, beforeEconomicReasonKeys);
    collectReasonKeys(afterEconomicReasons, afterEconomicReasonKeys);
    const addedEconomicReasons = [...afterEconomicReasonKeys.keys()].filter(
      (key) => !beforeEconomicReasonKeys.has(key),
    );
    const removedEconomicReasons = [...beforeEconomicReasonKeys.keys()].filter(
      (key) => !afterEconomicReasonKeys.has(key),
    );
    const directionalEconomicReasonChanged = downgrade
      ? addedEconomicReasons.length > 0
      : improvement
        ? removedEconomicReasons.length > 0
        : changedEconomicReasonFields.length > 0;
    const availabilityCauseChanged = changedAvailabilityFields.length > 0;
    const changedEconomicOrDisclosureFields = [
      ...new Set([
        ...(directionalEconomicReasonChanged ? changedEconomicReasonFields : []),
        ...(availabilityCauseChanged ? [] : changedRawEconomicFields),
      ]),
    ].sort(compareText);
    const economicOrDisclosureCauseChanged = changedEconomicOrDisclosureFields.length > 0;
    const beforeAvailabilityKeys = new Map<
      string,
      z.infer<typeof V9EvidenceResponsibilitySchema>
    >();
    const afterAvailabilityKeys = new Map<
      string,
      z.infer<typeof V9EvidenceResponsibilitySchema>
    >();
    collectReasonKeys(beforeAvailability, beforeAvailabilityKeys);
    collectReasonKeys(afterAvailability, afterAvailabilityKeys);
    const changedAvailabilityResponsibilities = [
      ...new Set([
        ...[...beforeAvailabilityKeys].flatMap(([key, responsibility]) =>
          afterAvailabilityKeys.has(key) ? [] : [responsibility],
        ),
        ...[...afterAvailabilityKeys].flatMap(([key, responsibility]) =>
          beforeAvailabilityKeys.has(key) ? [] : [responsibility],
        ),
      ]),
    ].sort(compareText);
    // A coincident economic label is not enough to prove that an availability
    // failure was non-causal. Until a counterfactual isolates the two changes,
    // any downgrade carrying an availability-responsibility delta is a no-go.
    const producerCausedDowngrade = downgrade && availabilityCauseChanged;
    movements.push({
      assetId: card.id,
      fromSourceGeneration: from.pipeline.fixedInput.sourceGeneration,
      toSourceGeneration: to.pipeline.fixedInput.sourceGeneration,
      fromScore: previous.score,
      toScore: card.score,
      scoreDelta,
      fromGrade: previous.grade,
      toGrade: card.grade,
      gradeDistance: distance,
      rateabilityChanged,
      flagship,
      scoreBearingInputChanged: changedScoreBearingFields.length > 0,
      changedScoreBearingFields,
      economicOrDisclosureCauseChanged,
      changedEconomicOrDisclosureFields,
      availabilityCauseChanged,
      changedAvailabilityFields,
      changedAvailabilityResponsibilities,
      cause:
        economicOrDisclosureCauseChanged && availabilityCauseChanged
          ? "mixed"
          : economicOrDisclosureCauseChanged
            ? "economic-or-disclosure"
            : availabilityCauseChanged
              ? "availability-only"
              : "none",
      fromScoreBearingInputDigest: scoreInputDigest(beforeInput),
      toScoreBearingInputDigest: scoreInputDigest(afterInput),
      producerCausedDowngrade,
      unexplainedGradeMovement:
        !economicOrDisclosureCauseChanged &&
        (rateabilityChanged ||
          (distance !== null &&
            distance > V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.maximumUnexplainedGradeDistance)),
      unexplainedFlagshipMovement:
        flagship &&
        !economicOrDisclosureCauseChanged &&
        scoreDelta !== null &&
        Math.abs(scoreDelta) > V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.flagshipMovementAttributionThreshold,
    });
  }
  return movements.sort((left, right) => compareText(left.assetId, right.assetId));
}

function gradeAtLeast(grade: V9Grade, minimum: Exclude<V9Grade, "NR">): boolean {
  return grade !== "NR" && GRADE_ORDER.indexOf(grade) <= GRADE_ORDER.indexOf(minimum);
}

function minimumGradeVerdict(
  byId: ReadonlyMap<string, ParsedReplayArtifact["pipeline"]["candidate"]["cards"][number]>,
  ruleId: string,
  assetId: string,
  minimum: Exclude<V9Grade, "NR">,
): V9ProductionSentinelVerdict {
  const card = byId.get(assetId);
  const passed = card !== undefined && gradeAtLeast(card.grade, minimum);
  return {
    ruleId,
    assetIds: [assetId],
    passed,
    observed: card ? `${card.score ?? "NR"} (${card.grade})` : "missing",
    required: `${minimum} or better`,
    detail: passed
      ? `${assetId} satisfies the production sentinel`
      : `${assetId} is missing, NR, or below ${minimum}`,
  };
}

function forbiddenReasonVerdict(
  byId: ReadonlyMap<string, ParsedReplayArtifact["pipeline"]["candidate"]["cards"][number]>,
  ruleId: string,
  assetId: string,
  forbiddenReasonCodes: readonly string[],
): V9ProductionSentinelVerdict {
  const card = byId.get(assetId);
  const present = card?.reasonCodes.filter((code) => forbiddenReasonCodes.includes(code)) ?? [];
  const passed = card !== undefined && card.grade !== "NR" && present.length === 0;
  return {
    ruleId,
    assetIds: [assetId],
    passed,
    observed: card
      ? present.length === 0
        ? `${card.score ?? "NR"} (${card.grade}); no forbidden reason`
        : present.join(", ")
      : "missing",
    required: `rated without ${forbiddenReasonCodes.join(" or ")}`,
    detail: passed
      ? `${assetId} clears the missing-materiality limitation`
      : `${assetId} remains missing, NR, or limited by deployment materiality`,
  };
}

function adverseScoreVerdict(
  byId: ReadonlyMap<string, ParsedReplayArtifact["pipeline"]["candidate"]["cards"][number]>,
  ruleId: string,
  assetId: string,
  maximumScore: number,
): V9ProductionSentinelVerdict {
  const card = byId.get(assetId);
  const passed = card !== undefined && card.score !== null && card.score <= maximumScore;
  return {
    ruleId,
    assetIds: [assetId],
    passed,
    observed: card ? `${card.score ?? "NR"} (${card.grade})` : "missing",
    required: `score <= ${maximumScore}`,
    detail: passed ? `${assetId} remains within its adverse bound` : `${assetId} exceeds its adverse bound`,
  };
}

function adverseGradeVerdict(
  byId: ReadonlyMap<string, ParsedReplayArtifact["pipeline"]["candidate"]["cards"][number]>,
  ruleId: string,
  assetId: string,
  maximumGrade: Exclude<V9Grade, "NR">,
): V9ProductionSentinelVerdict {
  const card = byId.get(assetId);
  const passed =
    card !== undefined &&
    card.grade !== "NR" &&
    GRADE_ORDER.indexOf(card.grade) >= GRADE_ORDER.indexOf(maximumGrade);
  return {
    ruleId,
    assetIds: [assetId],
    passed,
    observed: card ? `${card.score ?? "NR"} (${card.grade})` : "missing",
    required: `${maximumGrade} or worse`,
    detail: passed ? `${assetId} remains within its adverse bound` : `${assetId} exceeds its adverse bound`,
  };
}

function qualitativeVerdict(
  evidenceById: ReadonlyMap<
    string,
    V9ProductionSupplementalValidationEvidence["qualitativeSentinels"][number]
  >,
  ruleId: (typeof V9_PRODUCTION_REQUIRED_QUALITATIVE_SENTINEL_IDS)[number],
): V9ProductionSentinelVerdict {
  const evidence = evidenceById.get(ruleId);
  return {
    ruleId: `qualitative:${ruleId}`,
    assetIds: [],
    passed: evidence?.passed === true,
    observed: evidence ? (evidence.passed ? "passed" : "failed") : "missing evidence",
    required: "candidate-bound reviewed evidence passes",
    detail: evidence?.detail ?? `Missing qualitative sentinel evidence for ${ruleId}`,
  };
}

function acrossGenerationVerdict(
  replays: readonly ParsedReplayArtifact[],
  build: (
    byId: ReadonlyMap<
      string,
      ParsedReplayArtifact["pipeline"]["candidate"]["cards"][number]
    >,
  ) => V9ProductionSentinelVerdict,
): V9ProductionSentinelVerdict {
  const verdicts = replays.map((replay) => ({
    sourceGeneration: replay.pipeline.fixedInput.sourceGeneration,
    verdict: build(new Map(replay.pipeline.candidate.cards.map((card) => [card.id, card]))),
  }));
  const first = verdicts[0]!.verdict;
  const failed = verdicts.filter((entry) => !entry.verdict.passed);
  return {
    ...first,
    passed: failed.length === 0,
    observed: verdicts
      .map((entry) => `${entry.sourceGeneration}: ${entry.verdict.observed}`)
      .join("; "),
    detail:
      failed.length === 0
        ? `${first.detail} in every evaluated production generation`
        : `${first.detail}; failed generation(s): ${failed
            .map((entry) => entry.sourceGeneration)
            .join(", ")}`,
  };
}

function syntheticAPlusReport(
  evidence: V9ProductionSupplementalValidationEvidence | null,
): V9ProductionSyntheticAPlusReport {
  if (!evidence) {
    return {
      passed: false,
      scenarioCount: 0,
      qualifyingScenarioIds: [],
      distinctQualifyingArchetypes: [],
      issues: ["Supplemental validation evidence is unavailable"],
    };
  }
  const issues: string[] = [];
  const ids = canonicalIds(evidence.syntheticAPlusScenarios.map((scenario) => scenario.scenarioId));
  if (ids.duplicateIds.length > 0) issues.push("Synthetic A+ scenario IDs must be unique");
  const qualifying = evidence.syntheticAPlusScenarios.filter(
    (scenario) => scenario.grade === "A+" && scenario.score !== null,
  );
  const archetypes = [...new Set(qualifying.map((scenario) => scenario.archetype))].sort(compareText);
  if (archetypes.length < V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.minimumSyntheticAPlusArchetypeCount) {
    issues.push(
      `Synthetic A+ evidence covers ${archetypes.length} distinct archetype(s), below the required ` +
        V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.minimumSyntheticAPlusArchetypeCount,
    );
  }
  return {
    passed: issues.length === 0,
    scenarioCount: evidence.syntheticAPlusScenarios.length,
    qualifyingScenarioIds: qualifying.map((scenario) => scenario.scenarioId).sort(compareText),
    distinctQualifyingArchetypes: archetypes,
    issues,
  };
}

function monotonicControlReport(
  evidence: V9ProductionSupplementalValidationEvidence | null,
): { passed: boolean; verdicts: V9ProductionMonotonicControlVerdict[]; issues: string[] } {
  const issues: string[] = [];
  const rows = evidence?.monotonicControls ?? [];
  const ids = canonicalIds(rows.map((row) => row.id));
  if (ids.duplicateIds.length > 0) issues.push("Monotonic control IDs must be unique");
  const byId = new Map(rows.map((row) => [row.id, row]));
  const verdicts = V9_PRODUCTION_REQUIRED_MONOTONIC_CONTROL_IDS.map((id) => {
    const row = byId.get(id);
    const passed = row !== undefined && row.caseCount > 0 && row.failureCount === 0;
    if (!row) issues.push(`Missing monotonic control evidence for ${id}`);
    else if (row.caseCount === 0) issues.push(`Monotonic control ${id} executed zero cases`);
    else if (row.failureCount > 0) issues.push(`Monotonic control ${id} has ${row.failureCount} failure(s)`);
    return {
      id,
      passed,
      caseCount: row?.caseCount ?? 0,
      failureCount: row?.failureCount ?? 0,
      evidenceRefs: row?.evidenceRefs ?? [],
    };
  });
  return { passed: issues.length === 0 && verdicts.every((verdict) => verdict.passed), verdicts, issues };
}

function v8ClassificationReport(
  cards: readonly ParsedReplayArtifact["pipeline"]["candidate"]["cards"][number][],
  evidence: V9ProductionSupplementalValidationEvidence | null,
): V9ProductionV8ClassificationReport {
  if (!evidence) {
    return {
      passed: false,
      assetSetsMatch: false,
      requiredMovementCount: 0,
      classifiedMovementCount: 0,
      movements: [],
      issues: ["Supplemental V8 comparison evidence is unavailable"],
    };
  }
  const issues: string[] = [];
  const v8Ids = canonicalIds(evidence.v8.cards.map((card) => card.id));
  const v9Ids = canonicalIds(cards.map((card) => card.id));
  if (v8Ids.duplicateIds.length > 0) issues.push("V8 comparison cards contain duplicate asset IDs");
  const assetSetsMatch = sameValue(v8Ids.ids, v9Ids.ids);
  if (!assetSetsMatch) issues.push("V8 and V9 comparison asset sets do not match");
  const classificationIds = canonicalIds(
    evidence.v8.movementClassifications.map((row) => row.assetId),
  );
  if (classificationIds.duplicateIds.length > 0) {
    issues.push("V8 movement classifications contain duplicate asset IDs");
  }
  const v8ById = new Map(evidence.v8.cards.map((card) => [card.id, card]));
  const classificationById = new Map(
    evidence.v8.movementClassifications.map((row) => [row.assetId, row]),
  );
  const movements = cards
    .flatMap((card) => {
      const previous = v8ById.get(card.id);
      if (!previous) return [];
      const distance = gradeDistance(previous.grade, card.grade);
      const rateabilityChanged = (previous.grade === "NR") !== (card.grade === "NR");
      if (!rateabilityChanged && (distance === null || distance < 2)) return [];
      const classification = classificationById.get(card.id);
      const blockingClassification =
        classification?.classification === "producer-gap" ||
        classification?.classification === "defect";
      return [{
        assetId: card.id,
        v8Grade: previous.grade,
        v9Grade: card.grade,
        gradeDistance: distance,
        rateabilityChanged,
        classification: classification?.classification ?? null,
        blockingClassification,
        summary: classification?.summary ?? null,
        evidenceRefs: classification?.evidenceRefs ?? [],
      }];
    })
    .sort((left, right) => compareText(left.assetId, right.assetId));
  const requiredIds = movements.map((movement) => movement.assetId);
  const extraClassificationIds = classificationIds.ids.filter((id) => !requiredIds.includes(id));
  const missingClassificationIds = requiredIds.filter((id) => !classificationById.has(id));
  if (extraClassificationIds.length > 0) {
    issues.push(`V8 classifications contain non-qualifying asset IDs: ${extraClassificationIds.join(", ")}`);
  }
  if (missingClassificationIds.length > 0) {
    issues.push(`V8 classifications are missing asset IDs: ${missingClassificationIds.join(", ")}`);
  }
  const blocking = movements
    .filter((movement) => movement.blockingClassification)
    .map((movement) => movement.assetId);
  if (blocking.length > 0) {
    issues.push(`V8 movements remain classified as producer gaps or defects: ${blocking.join(", ")}`);
  }
  return {
    passed: issues.length === 0,
    assetSetsMatch,
    requiredMovementCount: movements.length,
    classifiedMovementCount: movements.filter((movement) => movement.classification !== null).length,
    movements,
    issues,
  };
}

function validationEvidenceReport(
  replays: readonly ParsedReplayArtifact[],
  rawEvidence: unknown,
): V9ProductionValidationEvidenceReport {
  const latest = replays[replays.length - 1]!;
  const parsed = SupplementalValidationEvidenceSchema.safeParse(rawEvidence);
  const evidence = parsed.success
    ? (parsed.data as V9ProductionSupplementalValidationEvidence)
    : null;
  const issues: string[] = [];
  if (!parsed.success && rawEvidence !== undefined) {
    issues.push(
      `Supplemental validation evidence is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  if (rawEvidence === undefined) issues.push("Supplemental validation evidence was not provided");
  const identityMatches =
    evidence !== null && sameValue(evidence.candidateIdentity, latest.pipeline.candidateIdentity);
  if (evidence && !identityMatches) {
    issues.push("Supplemental validation evidence does not bind the evaluated candidate identity");
  }
  const expectedCandidateResult = {
    candidateId: latest.pipeline.candidate.candidateId,
    baseInputGenerationId: latest.pipeline.candidate.baseInputGenerationId,
    factSetDigest: latest.pipeline.candidate.factSetDigest,
    resultDigest: latest.pipeline.candidate.resultDigest,
  };
  const candidateResultMatches =
    evidence !== null && sameValue(evidence.candidateResult, expectedCandidateResult);
  if (evidence && !candidateResultMatches) {
    issues.push("Supplemental validation evidence does not bind the latest candidate result");
  }
  const bindingMatches = identityMatches && candidateResultMatches;
  const qualitativeById = new Map(
    (evidence?.qualitativeSentinels ?? []).map((row) => [row.id, row]),
  );
  const qualitativeIds = canonicalIds((evidence?.qualitativeSentinels ?? []).map((row) => row.id));
  const qualitativeIdsValid = qualitativeIds.duplicateIds.length === 0;
  if (!qualitativeIdsValid) {
    issues.push("Qualitative sentinel evidence IDs must be unique");
  }
  const namedSentinels: V9ProductionSentinelVerdict[] = [
    acrossGenerationVerdict(replays, (byId) =>
      minimumGradeVerdict(byId, "usdc-a-anchor", "usdc-circle", "A"),
    ),
    acrossGenerationVerdict(replays, (byId) =>
      minimumGradeVerdict(byId, "usdt-resilience-anchor", "usdt-tether", "A-"),
    ),
    acrossGenerationVerdict(replays, (byId) =>
      minimumGradeVerdict(byId, "dai-current-facts-floor", "dai-makerdao", "B"),
    ),
    acrossGenerationVerdict(replays, (byId) =>
      minimumGradeVerdict(byId, "sdai-current-facts-floor", "sdai-sky", "B-"),
    ),
    acrossGenerationVerdict(replays, (byId) =>
      minimumGradeVerdict(byId, "bold-a-anchor", "bold-liquity", "A"),
    ),
    acrossGenerationVerdict(replays, (byId) =>
      minimumGradeVerdict(byId, "sbold-observed-withdrawal-floor", "sbold-k3-capital", "B-"),
    ),
    acrossGenerationVerdict(replays, (byId) =>
      forbiddenReasonVerdict(byId, "xaut-materiality-cleared", "xaut-tether", [
        "material-bridge-supply-unmatched",
        "runtime-bridge-materiality-unavailable",
      ]),
    ),
    qualitativeVerdict(qualitativeById, "usdg-base-and-deployment-separated"),
    qualitativeVerdict(qualitativeById, "usdc-wrapper-local-risk-separated"),
    qualitativeVerdict(qualitativeById, "frxusd-wtgxx-role-reviewed"),
    qualitativeVerdict(qualitativeById, "named-family-causal-explanations"),
  ];
  const adverseControls: V9ProductionSentinelVerdict[] = [
    acrossGenerationVerdict(replays, (byId) =>
      adverseScoreVerdict(byId, "u-adverse-pin", "u-united-stables", 32),
    ),
    acrossGenerationVerdict(replays, (byId) =>
      adverseGradeVerdict(byId, "eurs-adverse-pin", "eurs-stasis", "F"),
    ),
    acrossGenerationVerdict(replays, (byId) =>
      adverseGradeVerdict(byId, "mim-adverse-pin", "mim-abracadabra", "F"),
    ),
    qualitativeVerdict(qualitativeById, "tusd-watch-explained"),
  ];
  const syntheticAPlus = syntheticAPlusReport(evidence);
  const monotonic = monotonicControlReport(evidence);
  const v8Classification = v8ClassificationReport(latest.pipeline.candidate.cards, evidence);
  const namedSentinelsPassed =
    bindingMatches && qualitativeIdsValid && namedSentinels.every((verdict) => verdict.passed);
  const adverseControlsPassed =
    bindingMatches && qualitativeIdsValid && adverseControls.every((verdict) => verdict.passed);
  return {
    provided: rawEvidence !== undefined && parsed.success,
    identityMatches,
    candidateResultMatches,
    namedSentinelsPassed,
    namedSentinels,
    adverseControlsPassed,
    adverseControls,
    syntheticAPlus: {
      ...syntheticAPlus,
      passed: bindingMatches && syntheticAPlus.passed,
    },
    monotonicControlsPassed: bindingMatches && monotonic.passed,
    monotonicControls: monotonic.verdicts,
    v8Classification: {
      ...v8Classification,
      passed: bindingMatches && v8Classification.passed,
    },
    issues: [...new Set([...issues, ...syntheticAPlus.issues, ...monotonic.issues, ...v8Classification.issues])]
      .sort(compareText),
  };
}

export interface V9ProductionAcceptanceOptions {
  flagshipAssetIds?: readonly string[];
  excludedTopTwoAssetIds?: readonly string[];
  validationEvidence?: unknown;
}

/**
 * Analyzes supplied replay and supplemental artifacts without external I/O.
 * This pure function is not a release trust boundary because its caller owns
 * those inputs; production authorization belongs to the strict Worker verifier.
 */
export function evaluateV9ProductionAcceptance(
  rawGenerations: readonly unknown[],
  options: V9ProductionAcceptanceOptions = {},
): V9ProductionAcceptanceReport {
  if (rawGenerations.length === 0) throw new Error("Production acceptance requires at least one replay generation");
  const parsed = rawGenerations.map((generation) => ReplayArtifactSchema.parse(generation));
  const ordered = [...parsed].sort(
    (left, right) => left.pipeline.fixedInput.clockSec - right.pipeline.fixedInput.clockSec,
  );
  const excludedAssetIds =
    options.excludedTopTwoAssetIds ?? V9_PRODUCTION_ACCEPTANCE_TOP_TWO_ASSET_IDS;
  const flagshipIds = new Set(options.flagshipAssetIds ?? V9_PRODUCTION_ACCEPTANCE_TOP_TWO_ASSET_IDS);
  const generations = ordered.map((replay) => generationReport(replay, excludedAssetIds));
  let trailingCompleteGenerationCount = 0;
  for (let index = generations.length - 1; index >= 0; index -= 1) {
    if (!generations[index]!.complete) break;
    trailingCompleteGenerationCount += 1;
  }
  const qualifyingStart = Math.max(0, ordered.length - V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.minimumGenerationCount);
  const latestThreeReports = generations.slice(qualifyingStart);
  const latestThreeReplays = ordered.slice(qualifyingStart);
  const generationCountPassed =
    trailingCompleteGenerationCount >= V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.minimumGenerationCount;
  const identitiesMatch =
    latestThreeReports.length > 0 &&
    latestThreeReports.every((generation) => generation.internalIdentityPassed) &&
    latestThreeReports.every(
      (generation) =>
        sameValue(generation.candidateIdentity, latestThreeReports[0]!.candidateIdentity) &&
        generation.candidateId === latestThreeReports[0]!.candidateId,
    );
  const assetSetsMatch =
    latestThreeReports.length > 0 &&
    latestThreeReports.every((generation) => generation.internalAssetSetPassed) &&
    latestThreeReports.every((generation) => sameValue(generation.assetIds, latestThreeReports[0]!.assetIds));
  const clocks = latestThreeReports.map((generation) => generation.clockSec);
  const baseInputGenerationIds = latestThreeReports.map((generation) => generation.baseInputGenerationId);
  const sourceGenerations = latestThreeReports.map((generation) => generation.sourceGeneration);
  const observationWindowSec =
    latestThreeReports.length < V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.minimumGenerationCount
      ? null
      : clocks[clocks.length - 1]! - clocks[0]!;
  const sequenceValid =
    generationCountPassed &&
    new Set(clocks).size === clocks.length &&
    new Set(baseInputGenerationIds).size === baseInputGenerationIds.length &&
    new Set(sourceGenerations).size === sourceGenerations.length &&
    observationWindowSec !== null &&
    observationWindowSec >= V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.minimumObservationWindowSec &&
    observationWindowSec <= V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.maximumObservationWindowSec;
  const movements = latestThreeReplays.flatMap((generation, index) =>
    index === 0 ? [] : movementPair(latestThreeReplays[index - 1]!, generation, flagshipIds),
  );
  const producerCausedDowngradeIds = [
    ...new Set(
      movements.filter((movement) => movement.producerCausedDowngrade).map((movement) => movement.assetId),
    ),
  ].sort(compareText);
  const unexplainedGradeMovementIds = [
    ...new Set(movements.filter((movement) => movement.unexplainedGradeMovement).map((movement) => movement.assetId)),
  ].sort(compareText);
  const unexplainedFlagshipMovementIds = [
    ...new Set(
      movements.filter((movement) => movement.unexplainedFlagshipMovement).map((movement) => movement.assetId),
    ),
  ].sort(compareText);
  const validationEvidence = validationEvidenceReport(
    latestThreeReplays,
    options.validationEvidence,
  );
  const noGoReasons = new Set<V9ProductionAcceptanceNoGoReason>();
  if (generations.length < V9_PRODUCTION_ACCEPTANCE_THRESHOLDS.minimumGenerationCount) {
    noGoReasons.add("generation-count-below-three");
  }
  if (!generationCountPassed) noGoReasons.add("generation-incomplete");
  if (latestThreeReports.some((generation) => !generation.internalIdentityPassed)) {
    noGoReasons.add("generation-internal-identity-mismatch");
  }
  if (!identitiesMatch) noGoReasons.add("generation-identity-mismatch");
  if (latestThreeReports.some((generation) => !generation.internalAssetSetPassed)) {
    noGoReasons.add("generation-internal-asset-set-mismatch");
  }
  if (!assetSetsMatch) noGoReasons.add("generation-asset-set-mismatch");
  if (!sequenceValid) noGoReasons.add("generation-sequence-invalid");
  if (latestThreeReports.some((generation) => !generation.supplyValid)) {
    noGoReasons.add("generation-supply-invalid");
  }
  if (latestThreeReports.some((generation) => generation.distribution.decision === "no-go")) {
    noGoReasons.add("distribution-gate-failed");
  }
  if (producerCausedDowngradeIds.length > 0) noGoReasons.add("producer-caused-downgrade");
  if (unexplainedGradeMovementIds.length > 0) noGoReasons.add("unexplained-grade-movement");
  if (unexplainedFlagshipMovementIds.length > 0) noGoReasons.add("unexplained-flagship-movement");
  if (options.validationEvidence === undefined) noGoReasons.add("validation-evidence-missing");
  if (!validationEvidence.namedSentinelsPassed) noGoReasons.add("named-sentinel-gate-failed");
  if (!validationEvidence.adverseControlsPassed) noGoReasons.add("adverse-control-gate-failed");
  if (!validationEvidence.syntheticAPlus.passed) noGoReasons.add("synthetic-a-plus-gate-failed");
  if (!validationEvidence.monotonicControlsPassed) noGoReasons.add("monotonic-control-gate-failed");
  if (!validationEvidence.v8Classification.passed) noGoReasons.add("v8-classification-gate-failed");
  const orderedNoGoReasons = [...noGoReasons].sort(compareText);
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-production-acceptance",
    decision: orderedNoGoReasons.length === 0 ? "gate-passed" : "no-go",
    thresholds: V9_PRODUCTION_ACCEPTANCE_THRESHOLDS,
    noGoReasons: orderedNoGoReasons,
    generations,
    stability: {
      generationCountPassed,
      consecutiveCompleteGenerationCount: trailingCompleteGenerationCount,
      qualifyingSourceGenerations: generationCountPassed ? sourceGenerations : [],
      observationWindowSec,
      identitiesMatch,
      assetSetsMatch,
      sequenceValid,
      movements,
      producerCausedDowngradeIds,
      unexplainedGradeMovementIds,
      unexplainedFlagshipMovementIds,
    },
    validationEvidence,
  };
}
