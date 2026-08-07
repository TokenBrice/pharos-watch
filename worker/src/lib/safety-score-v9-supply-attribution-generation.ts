import { sha256Hex } from "@shared/lib/sha256";
import {
  SupplyAttributionJournalIdSchema,
  SupplyAttributionJournalV1Schema,
  SupplyAttributionRejectionCodeSchema,
  type SupplyAttributionJournalV1,
} from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { z } from "zod";
import { SafetyScoreV9SupplyAttributionSchema } from "./report-cards-fixed-input";
import {
  normalizeSafetyScoreV9CompilerInput,
  type SafetyScoreV9CompilerInput,
} from "./safety-score-v9-native-input";
import {
  CENTRIFUGE_BURN_MINT_ASSET_IDS,
  deriveReviewedDeploymentUnitPartition,
} from "./safety-score-v9-supply-attribution-contract";
import {
  deriveXautRepresentationGroupSupplyAttribution,
} from "./safety-score-v9-xaut-supply-attribution-contract";
import type {
  SafetyScoreV9SupplyAttributionCapture,
} from "./safety-score-v9-supply-attribution";
import {
  safetyScoreV9SupplyAttributionExpectedAssetIds,
} from "./safety-score-v9-supply-attribution";
import { parseJson } from "./json-parse";

export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY =
  "safety-score-v9:supply-attribution-generation:v1";
const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES =
  128 * 1_024;
const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_HEALTHY_PRODUCER_INTERVAL_SEC =
  25 * 60;
const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_RETRY_PRODUCER_INTERVAL_SEC =
  14 * 60;
const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_CONSUMER_ACCEPTANCE_WINDOW_SEC =
  45 * 60;
const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_CADENCE_DEFER_MAX_SKEW_SEC =
  30 * 60;

const AssetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GenerationIdSchema = z
  .string()
  .regex(/^safety-score-v9-supply-attribution:v1:[a-f0-9]{64}$/);

const SupplyAttributionGenerationOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("accepted"),
        journalId: SupplyAttributionJournalIdSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("rejected"),
        rejectionCode: SupplyAttributionRejectionCodeSchema,
        failedRouteId: z.string().min(1).nullable(),
        journalId: SupplyAttributionJournalIdSchema,
      })
      .strict(),
  ],
);

const SupplyAttributionGenerationPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-supply-attribution-generation"),
    // v1 = retained exact fixed input; v2 = native V9 capture. This is a
    // private cache payload, so both lanes are admissible here.
    sourceBaseInputGenerationId: z
      .string()
      .regex(/^report-cards-input:v[12]:[a-f0-9]{64}$/),
    sourceGeneration: z.string().min(1),
    registryFingerprint: Sha256Schema,
    sourceClockSec: z.number().int().nonnegative(),
    captureClockSec: z.number().int().nonnegative(),
    capturedAtSec: z.number().int().nonnegative(),
    expectedAssetIds: z.array(AssetIdSchema).max(32),
    observedAssetIds: z.array(AssetIdSchema).max(32),
    acceptedAssetIds: z.array(AssetIdSchema).max(32),
    rejectedAssetIds: z.array(AssetIdSchema).max(32),
    attributionById: z.record(
      AssetIdSchema,
      SafetyScoreV9SupplyAttributionSchema,
    ),
    outcomesById: z.record(
      AssetIdSchema,
      SupplyAttributionGenerationOutcomeSchema,
    ),
  })
  .strict()
  .superRefine((generation, ctx) => {
    if (
      generation.captureClockSec < generation.sourceClockSec ||
      generation.capturedAtSec < generation.captureClockSec
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["captureClockSec"],
        message:
          "Supply attribution generation clocks must order source, capture, then completion",
      });
    }
    const arrays = [
      ["expectedAssetIds", generation.expectedAssetIds],
      ["observedAssetIds", generation.observedAssetIds],
      ["acceptedAssetIds", generation.acceptedAssetIds],
      ["rejectedAssetIds", generation.rejectedAssetIds],
    ] as const;
    for (const [field, values] of arrays) {
      const normalized = uniqueSorted(values);
      if (
        normalized.length !== values.length ||
        normalized.some((value, index) => value !== values[index])
      ) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be sorted and unique`,
        });
      }
    }

    if (!exactStrings(generation.expectedAssetIds, generation.observedAssetIds)) {
      ctx.addIssue({
        code: "custom",
        path: ["observedAssetIds"],
        message:
          "Supply attribution generation must observe its exact expected asset inventory",
      });
    }
    if (
      !exactStrings(
        generation.observedAssetIds,
        uniqueSorted([
          ...generation.acceptedAssetIds,
          ...generation.rejectedAssetIds,
        ]),
      ) ||
      generation.acceptedAssetIds.some((assetId) =>
        generation.rejectedAssetIds.includes(assetId),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Supply attribution accepted and rejected assets must exactly partition observations",
      });
    }
    if (
      !exactStrings(
        generation.acceptedAssetIds,
        Object.keys(generation.attributionById).sort(),
      ) ||
      !exactStrings(
        generation.observedAssetIds,
        Object.keys(generation.outcomesById).sort(),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Supply attribution generation maps must match their exact asset inventories",
      });
    }
    for (const assetId of generation.acceptedAssetIds) {
      const attribution = generation.attributionById[assetId];
      const outcome = generation.outcomesById[assetId];
      if (
        !attribution ||
        attribution.model === "canonical-lock-mint-partition-v1" ||
        ("assetId" in attribution && attribution.assetId !== assetId) ||
        ("registryFingerprint" in attribution &&
          attribution.registryFingerprint !==
            generation.registryFingerprint) ||
        outcome?.status !== "accepted"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["attributionById", assetId],
          message:
            "Accepted supply attribution must bind its asset, registry, and outcome",
        });
      }
    }
    for (const assetId of generation.rejectedAssetIds) {
      if (generation.outcomesById[assetId]?.status !== "rejected") {
        ctx.addIssue({
          code: "custom",
          path: ["outcomesById", assetId],
          message: "Rejected supply attribution requires an exact rejection outcome",
        });
      }
    }
  });

export type SafetyScoreV9SupplyAttributionGenerationPayload = z.infer<
  typeof SupplyAttributionGenerationPayloadSchema
>;

const SafetyScoreV9SupplyAttributionGenerationSchema =
  SupplyAttributionGenerationPayloadSchema.extend({
    generationId: GenerationIdSchema,
  })
    .strict()
    .superRefine((generation, ctx) => {
      const { generationId, ...payload } = generation;
      if (
        generationId !==
        computeSafetyScoreV9SupplyAttributionGenerationId(payload)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["generationId"],
          message:
            "Supply attribution generation ID does not match its canonical payload",
        });
      }
      const bytes = new TextEncoder().encode(
        stableJsonStringifyV1(generation),
      ).byteLength;
      if (bytes > SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES) {
        ctx.addIssue({
          code: "custom",
          message:
            `Supply attribution generation exceeds ` +
            `${SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES} bytes`,
        });
      }
    });

export type SafetyScoreV9SupplyAttributionGeneration = z.infer<
  typeof SafetyScoreV9SupplyAttributionGenerationSchema
>;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function exactStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function aggregateSupplyUsd(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
): number {
  return Object.values(
    fixedInput.aggregateCirculatingById[assetId]?.circulating ?? {},
  ).reduce((sum, value) => sum + value, 0);
}

export function computeSafetyScoreV9SupplyAttributionGenerationId(
  payload: SafetyScoreV9SupplyAttributionGenerationPayload,
): string {
  return `safety-score-v9-supply-attribution:v1:${sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.supply-attribution-generation.v1",
      payload,
    }),
  )}`;
}

function journalRecordsByAsset(
  records: readonly SupplyAttributionJournalV1[],
): Map<string, SupplyAttributionJournalV1> {
  const byAsset = new Map<string, SupplyAttributionJournalV1>();
  for (const value of records) {
    const record = SupplyAttributionJournalV1Schema.parse(value);
    if (byAsset.has(record.assetId)) {
      throw new Error(
        `Supply attribution generation received duplicate attempt for ${record.assetId}`,
      );
    }
    byAsset.set(record.assetId, record);
  }
  return byAsset;
}

function expectedJournalSourceId(
  assetId: string,
  attribution: SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"][string],
): SupplyAttributionJournalV1["sourceId"] | null {
  if (attribution.model === "canonical-lock-mint-group-partition-v2") {
    return "xaut.canonical-lock-mint-group-partition.v2";
  }
  if (attribution.model === "reviewed-deployment-unit-partition-v1") {
    return assetId === "wm-m0"
      ? "wm.reviewed-deployment-unit-partition.v1"
      : "centrifuge.reviewed-deployment-unit-partition.v1";
  }
  return null;
}

function expectedJournalSourceIdForAsset(
  assetId: string,
): SupplyAttributionJournalV1["sourceId"] | null {
  if (assetId === "xaut-tether") {
    return "xaut.canonical-lock-mint-group-partition.v2";
  }
  if (assetId === "wm-m0") {
    return "wm.reviewed-deployment-unit-partition.v1";
  }
  return CENTRIFUGE_BURN_MINT_ASSET_IDS.some(
    (candidate) => candidate === assetId,
  )
    ? "centrifuge.reviewed-deployment-unit-partition.v1"
    : null;
}

function assertCaptureBindings(input: {
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  capture: SafetyScoreV9SupplyAttributionCapture;
  capturedAtSec: number;
  recordsByAsset: ReadonlyMap<string, SupplyAttributionJournalV1>;
}): void {
  const expectedAssetIds = uniqueSorted(
    safetyScoreV9SupplyAttributionExpectedAssetIds(input.fixedInput),
  );
  if (!exactStrings(uniqueSorted(input.capture.expectedAssetIds), expectedAssetIds)) {
    throw new Error(
      "Supply attribution generation capture inventory does not match its source fixed input",
    );
  }

  for (const [assetId, record] of input.recordsByAsset) {
    const expectedSourceIdForAsset =
      expectedJournalSourceIdForAsset(assetId);
    if (
      expectedSourceIdForAsset === null ||
      record.sourceId !== expectedSourceIdForAsset ||
      record.baseInputGenerationId !== input.fixedInput.baseInputGenerationId ||
      record.sourceGeneration !== input.fixedInput.sourceGeneration ||
      record.registryFingerprint !== input.fixedInput.registryFingerprint
    ) {
      throw new Error(
        `Supply attribution generation journal source identity mismatch for ${assetId}`,
      );
    }
    if (
      record.scoringClockSec < input.fixedInput.clockSec ||
      record.scoringClockSec > input.capture.captureClockSec ||
      record.completedAtSec > input.capturedAtSec
    ) {
      throw new Error(
        `Supply attribution generation journal clock mismatch for ${assetId}`,
      );
    }

    const attribution = input.capture.attributionById[assetId];
    const accepted =
      record.admissionCode === "supply-attribution.admission.accepted";
    if (accepted !== (attribution !== undefined)) {
      throw new Error(
        `Supply attribution generation journal outcome mismatch for ${assetId}`,
      );
    }
    if (!attribution) continue;

    const expectedSourceId = expectedJournalSourceId(assetId, attribution);
    if (
      expectedSourceId === null ||
      !("routeInventoryDigest" in attribution)
    ) {
      throw new Error(
        `Supply attribution generation accepted provenance mismatch for ${assetId}`,
      );
    }
    if (
      record.sourceId !== expectedSourceId ||
      record.routeInventoryDigest !== attribution.routeInventoryDigest ||
      record.sourceObservedAtSec !== attribution.observedAtSec ||
      record.contentSha256 !==
        sha256Hex(stableJsonStringifyV1(attribution))
    ) {
      throw new Error(
        `Supply attribution generation accepted provenance mismatch for ${assetId}`,
      );
    }
  }
}

export function createSafetyScoreV9SupplyAttributionGeneration(input: {
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  capture: SafetyScoreV9SupplyAttributionCapture;
  capturedAtSec: number;
}): SafetyScoreV9SupplyAttributionGeneration {
  const recordsByAsset = journalRecordsByAsset(input.capture.journalRecords);
  assertCaptureBindings({ ...input, recordsByAsset });
  const expectedAssetIds = uniqueSorted(input.capture.expectedAssetIds);
  const observedAssetIds = uniqueSorted(recordsByAsset.keys());
  const acceptedAssetIds = uniqueSorted(
    Object.keys(input.capture.attributionById),
  );
  const rejectedAssetIds = observedAssetIds.filter(
    (assetId) => !acceptedAssetIds.includes(assetId),
  );
  const outcomesById = Object.fromEntries(
    observedAssetIds.map((assetId) => {
      const record = recordsByAsset.get(assetId)!;
      return [
        assetId,
        record.admissionCode === "supply-attribution.admission.accepted"
          ? {
              status: "accepted" as const,
              journalId: record.journalId,
            }
          : {
              status: "rejected" as const,
              rejectionCode: record.rejectionCode!,
              failedRouteId: record.failedRouteId,
              journalId: record.journalId,
            },
      ];
    }),
  );
  const payload = SupplyAttributionGenerationPayloadSchema.parse({
    schemaVersion: 1,
    kind: "safety-score-v9-supply-attribution-generation",
    sourceBaseInputGenerationId: input.fixedInput.baseInputGenerationId,
    sourceGeneration: input.fixedInput.sourceGeneration,
    registryFingerprint: input.fixedInput.registryFingerprint,
    sourceClockSec: input.fixedInput.clockSec,
    captureClockSec: input.capture.captureClockSec,
    capturedAtSec: input.capturedAtSec,
    expectedAssetIds,
    observedAssetIds,
    acceptedAssetIds,
    rejectedAssetIds,
    attributionById: input.capture.attributionById,
    outcomesById,
  });
  return SafetyScoreV9SupplyAttributionGenerationSchema.parse({
    ...payload,
    generationId:
      computeSafetyScoreV9SupplyAttributionGenerationId(payload),
  });
}

export function serializeSafetyScoreV9SupplyAttributionGeneration(
  generation: SafetyScoreV9SupplyAttributionGeneration,
): string {
  return stableJsonStringifyV1(
    SafetyScoreV9SupplyAttributionGenerationSchema.parse(generation),
  );
}

export function parseSafetyScoreV9SupplyAttributionGeneration(
  value: unknown,
): SafetyScoreV9SupplyAttributionGeneration {
  if (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength >
      SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES
  ) {
    throw new Error("Supply attribution generation cache value is oversized");
  }
  const parsed =
    typeof value === "string"
      ? parseJson(value, { onFailure: () => undefined })
      : { ok: true as const, value };
  if (!parsed.ok) {
    throw new Error(
      `Malformed supply attribution generation cache: ${parsed.message}`,
    );
  }
  return SafetyScoreV9SupplyAttributionGenerationSchema.parse(parsed.value);
}

export function nextSafetyScoreV9SupplyAttributionDueAtSec(
  generation: SafetyScoreV9SupplyAttributionGeneration,
): number {
  return (
    generation.capturedAtSec +
    (generation.rejectedAssetIds.length === 0
      ? SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_HEALTHY_PRODUCER_INTERVAL_SEC
      : SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_RETRY_PRODUCER_INTERVAL_SEC)
  );
}

export type SafetyScoreV9SupplyAttributionGenerationApplication =
  | {
      status: "applied";
      generationId: string;
      fixedInput: SafetyScoreV9CompilerInput;
      acceptedAssetIds: string[];
      rejectedAssetIds: string[];
      invalidAssetIds: string[];
    }
  | {
      status: "unavailable" | "incompatible";
      generationId: string | null;
      fixedInput: SafetyScoreV9CompilerInput;
      reason: string;
    };

type SupplyAttributionGenerationCompatibilityReason =
  | "registry-fingerprint-mismatch"
  | "expected-asset-ids-mismatch"
  | "source-clock-after-fixed-input"
  | "capture-clock-after-consumer"
  | "captured-after-consumer"
  | "generation-stale";

function withoutSupplyAttribution(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
): SafetyScoreV9CompilerInput {
  return normalizeSafetyScoreV9CompilerInput({
    ...fixedInput,
    safetyScoreV9SupplyAttributionById: {},
  });
}

export function diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  generation: SafetyScoreV9SupplyAttributionGeneration,
  consumerClockSec = fixedInput.clockSec,
): SupplyAttributionGenerationCompatibilityReason | null {
  const expectedAssetIds = uniqueSorted(
    safetyScoreV9SupplyAttributionExpectedAssetIds(fixedInput),
  );
  if (generation.registryFingerprint !== fixedInput.registryFingerprint) {
    return "registry-fingerprint-mismatch";
  }
  if (!exactStrings(generation.expectedAssetIds, expectedAssetIds)) {
    return "expected-asset-ids-mismatch";
  }
  if (generation.sourceClockSec > fixedInput.clockSec) {
    return "source-clock-after-fixed-input";
  }
  if (generation.captureClockSec > consumerClockSec) {
    return "capture-clock-after-consumer";
  }
  if (generation.capturedAtSec > consumerClockSec) {
    return "captured-after-consumer";
  }
  if (
    consumerClockSec - generation.capturedAtSec >
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_CONSUMER_ACCEPTANCE_WINDOW_SEC
  ) {
    return "generation-stale";
  }
  return null;
}

export function isSafetyScoreV9SupplyAttributionGenerationCompatible(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  generation: SafetyScoreV9SupplyAttributionGeneration,
  consumerClockSec = fixedInput.clockSec,
): boolean {
  return diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
    fixedInput,
    generation,
    consumerClockSec,
  ) === null;
}

export function isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  generation: SafetyScoreV9SupplyAttributionGeneration,
): boolean {
  const expectedAssetIds = uniqueSorted(
    safetyScoreV9SupplyAttributionExpectedAssetIds(fixedInput),
  );
  const latestGenerationClockSec = Math.max(
    generation.captureClockSec,
    generation.capturedAtSec,
  );
  const futureClockSkewSec =
    latestGenerationClockSec - fixedInput.clockSec;
  return (
    generation.registryFingerprint === fixedInput.registryFingerprint &&
    generation.sourceBaseInputGenerationId ===
      fixedInput.baseInputGenerationId &&
    generation.sourceGeneration === fixedInput.sourceGeneration &&
    generation.sourceClockSec === fixedInput.clockSec &&
    exactStrings(generation.expectedAssetIds, expectedAssetIds) &&
    generation.rejectedAssetIds.length === 0 &&
    futureClockSkewSec > 0 &&
    futureClockSkewSec <=
      SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_CADENCE_DEFER_MAX_SKEW_SEC
  );
}

export function applySafetyScoreV9SupplyAttributionGeneration(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  generation:
    | SafetyScoreV9SupplyAttributionGeneration
    | null,
): SafetyScoreV9SupplyAttributionGenerationApplication {
  if (!generation) {
    return {
      status: "unavailable",
      generationId: null,
      fixedInput: withoutSupplyAttribution(fixedInput),
      reason: "generation-missing",
    };
  }
  const compatibilityReason =
    diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
      fixedInput,
      generation,
    );
  if (compatibilityReason) {
    return {
      status: "incompatible",
      generationId: generation.generationId,
      fixedInput: withoutSupplyAttribution(fixedInput),
      reason: compatibilityReason,
    };
  }

  const attributionById:
    SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"] = {};
  const appliedAssetIds: string[] = [];
  const invalidAssetIds: string[] = [];
  for (const assetId of generation.acceptedAssetIds) {
    const stored = generation.attributionById[assetId]!;
    const aggregate = aggregateSupplyUsd(fixedInput, assetId);
    const attribution =
      stored.model === "reviewed-deployment-unit-partition-v1"
        ? deriveReviewedDeploymentUnitPartition({
            assetId,
            aggregateSupplyUsd: aggregate,
            registryFingerprint: fixedInput.registryFingerprint,
            scoringClockSec: fixedInput.clockSec,
            observations: stored.deployments,
          })
        : stored.model === "canonical-lock-mint-group-partition-v2"
          ? deriveXautRepresentationGroupSupplyAttribution({
              aggregateSupplyUsd: aggregate,
              registryFingerprint: fixedInput.registryFingerprint,
              scoringClockSec: fixedInput.clockSec,
              observation: stored.observation,
            })
          : null;
    // Each accepted asset carries its own observation contract, so a re-derivation
    // failure (typically an observation that aged past that asset's own window
    // while the generation itself is still fresh) drops only that asset's row.
    // Co-tenant assets keep their attribution instead of failing closed with it.
    if (!attribution) {
      invalidAssetIds.push(assetId);
      continue;
    }
    attributionById[assetId] = attribution;
    appliedAssetIds.push(assetId);
  }

  return {
    status: "applied",
    generationId: generation.generationId,
    fixedInput: normalizeSafetyScoreV9CompilerInput({
      ...fixedInput,
      safetyScoreV9SupplyAttributionById: attributionById,
    }),
    acceptedAssetIds: appliedAssetIds,
    rejectedAssetIds: [...generation.rejectedAssetIds],
    invalidAssetIds,
  };
}
