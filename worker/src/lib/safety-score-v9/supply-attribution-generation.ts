import { uniqueSorted } from "@shared/lib/safety-score-v9/primitives";
import { sha256Hex } from "@shared/lib/sha256";
import {
  SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES,
  SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  SupplyAttributionJournalIdSchema,
  SupplyAttributionJournalV1Schema,
  SupplyAttributionRejectionCodeSchema,
  type SupplyAttributionJournalV1,
} from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { BaseInputGenerationIdSchema, Sha256Schema, UnixSecondsSchema } from "@shared/types/safety-schema-primitives";
import { SupplyAttributionAttemptDiagnosticsSchema, SupplyAttributionCaptureFailureReasonSchema } from "@shared/types/safety-score-v9-supply-attribution";
import {
  SafetyScoreV9DeploymentSupplyCensusBindingSchema,
  SafetyScoreV9DeploymentSupplyCensusByIdSchema,
  type SafetyScoreV9DeploymentSupplyCensusBinding,
  type SafetyScoreV9DeploymentSupplyCensusById,
} from "@shared/types/safety-score-v9-deployment-supply-census";
import { z } from "zod";
import { createCanonicalGenerationCodec } from "../canonical-generation-codec";
import { SafetyScoreV9SupplyAttributionSchema } from "../report-cards-fixed-input";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import {
  CENTRIFUGE_BURN_MINT_ASSET_IDS,
  deriveReviewedDeploymentUnitPartition,
} from "./supply-attribution-contract";
import { REVIEWED_ECONOMIC_SUPPLY_PLANS, deriveReviewedEconomicDeploymentPartition, economicProviderSupplyContradictionChain, economicSupplyInputDeploymentObservation, economicSupplyInputReferencePrice, reviewedEconomicDeploymentAttributionValidationError } from "./supply-attribution-contract";
import {
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT_ASSET_ID,
} from "./xaut-supply-attribution-contract";
import type {
  SafetyScoreV9SupplyAttributionCapture,
} from "./supply-attribution-capture";
import {
  aggregateSupplyUsd,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_ID_BY_ASSET,
  safetyScoreV9SupplyAttributionExpectedAssetIds,
} from "./supply-attribution";
import type { SafetyScoreV9SupplyAttributionInput } from "./supply-attribution-source";
import { parseJson, parseJsonObject } from "../json-parse";

export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY =
  "safety-score-v9:supply-attribution-generation:v1";
// Both cooldowns stay under the :08/:23/:38/:53 capture grid so every
// firing is eligible. The :08/:38 opportunities precede :22/:52 publication;
// :23/:53 can settle the exact-source request from fresh :16/:46 preparation.
const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_HEALTHY_PRODUCER_INTERVAL_SEC =
  12 * 60;
const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_RETRY_PRODUCER_INTERVAL_SEC =
  14 * 60;
const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_CONSUMER_ACCEPTANCE_WINDOW_SEC =
  45 * 60;

const AssetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
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
        diagnostics: SupplyAttributionAttemptDiagnosticsSchema.optional(),
      })
      .strict(),
    z
      .object({
        status: z.literal("rejected"),
        rejectionCode: SupplyAttributionRejectionCodeSchema,
        failedRouteId: z.string().min(1).nullable(),
        journalId: SupplyAttributionJournalIdSchema,
        diagnostics: SupplyAttributionAttemptDiagnosticsSchema.optional(),
        captureFailureReason: SupplyAttributionCaptureFailureReasonSchema.optional(),
      })
      .strict(),
  ],
);

const SupplyAttributionGenerationPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-supply-attribution-generation"),
    sourceBaseInputGenerationId: BaseInputGenerationIdSchema,
    sourceGeneration: z.string().min(1),
    registryFingerprint: Sha256Schema,
    sourceClockSec: UnixSecondsSchema,
    captureClockSec: UnixSecondsSchema,
    capturedAtSec: UnixSecondsSchema,
    expectedAssetIds: z.array(AssetIdSchema).max(SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS),
    observedAssetIds: z.array(AssetIdSchema).max(SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS),
    acceptedAssetIds: z.array(AssetIdSchema).max(SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS),
    rejectedAssetIds: z.array(AssetIdSchema).max(SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS),
    attributionById: z.record(
      AssetIdSchema,
      SafetyScoreV9SupplyAttributionSchema,
    ),
    outcomesById: z.record(
      AssetIdSchema,
      SupplyAttributionGenerationOutcomeSchema,
    ),
    // v10.38 deployment supply census projection carried beside the
    // attribution it was captured with (SA-4 / RV-SA §6). Optional and never
    // defaulted: a generation captured without census packets keeps the exact
    // pre-v10.38 payload bytes and generation id.
    deploymentSupplyCensusById: SafetyScoreV9DeploymentSupplyCensusByIdSchema.optional(),
    // The store read's generation identity. Never split from the map: the map
    // alone is rejected `generation-unbound` by the consumer (SA-FIX F2).
    deploymentSupplyCensusBinding: SafetyScoreV9DeploymentSupplyCensusBindingSchema.optional(),
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
    const censusById = generation.deploymentSupplyCensusById;
    const censusBinding = generation.deploymentSupplyCensusBinding;
    if ((censusById === undefined) !== (censusBinding === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["deploymentSupplyCensusBinding"],
        message:
          "Deployment supply census packets and their generation binding travel together",
      });
    } else if (censusById !== undefined && censusBinding !== undefined) {
      // Unavailable is not empty (R1): a captured census with no packet must
      // omit the key, never carry `{}`.
      if (Object.keys(censusById).length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["deploymentSupplyCensusById"],
          message: "A carried deployment supply census must contain at least one packet",
        });
      }
      // The store read names the registry and base generation it was built
      // for; a generation carrying another pair would be rejected
      // `generation-mismatch` at every consumer, so refuse it at capture.
      if (
        censusBinding.registryFingerprint !== generation.registryFingerprint ||
        censusBinding.sourceBaseInputGenerationId !==
          generation.sourceBaseInputGenerationId
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["deploymentSupplyCensusBinding"],
          message:
            "Deployment supply census binding must name this generation's registry and base input",
        });
      }
    }
  });

export type SafetyScoreV9SupplyAttributionGenerationPayload = z.infer<
  typeof SupplyAttributionGenerationPayloadSchema
>;

const supplyAttributionGenerationCodec = createCanonicalGenerationCodec({
  payloadSchema: SupplyAttributionGenerationPayloadSchema,
  generationIdSchema: GenerationIdSchema,
  generationIdPrefix: "safety-score-v9-supply-attribution:v1:",
  digestPayload: (payload) => ({ domain: "safety-score-v9.supply-attribution-generation.v1", payload }),
  mismatchMessage:
    "Supply attribution generation ID does not match its canonical payload",
  maxBytes: {
    limit: SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES,
    schemaMessage: `Supply attribution generation exceeds ${SUPPLY_ATTRIBUTION_GENERATION_MAX_BYTES} bytes`,
    inputMessage: "Supply attribution generation cache value is oversized",
  },
  parseString: (value) => {
    const parsed = parseJson(value, { onFailure: () => undefined });
    if (!parsed.ok) {
      throw new Error(`Malformed supply attribution generation cache: ${parsed.message}`);
    }
    return parsed.value;
  },
  validateSerialization: true,
});

export type SafetyScoreV9SupplyAttributionGeneration = z.infer<
  typeof supplyAttributionGenerationCodec.schema
>;

function exactStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export const computeSafetyScoreV9SupplyAttributionGenerationId =
  supplyAttributionGenerationCodec.computeId;

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
    // Bound to the XAUT asset alone; other assets fail closed at the caller.
    return expectedJournalSourceIdForAsset(XAUT_ASSET_ID);
  }
  if (attribution.model === "reviewed-deployment-unit-partition-v1") {
    // wM keeps its own binding; every other asset is held to the centrifuge one.
    return expectedJournalSourceIdForAsset(
      assetId === "wm-m0" ? "wm-m0" : CENTRIFUGE_BURN_MINT_ASSET_IDS[0],
    );
  }
  if (attribution.model === "reviewed-economic-deployment-partition-v1") return expectedJournalSourceIdForAsset(assetId);
  return null;
}

function expectedJournalSourceIdForAsset(
  assetId: string,
): SupplyAttributionJournalV1["sourceId"] | null {
  // Own-key lookup so prototype names resolve to no binding, like any other
  // unknown asset id.
  if (
    !Object.prototype.hasOwnProperty.call(
      SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_ID_BY_ASSET,
      assetId,
    )
  ) {
    return null;
  }
  return SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_ID_BY_ASSET[assetId];
}

function assertCaptureBindings(input: {
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>;
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

    if (attribution.model === "reviewed-economic-deployment-partition-v1") {
      const supplyUsd = aggregateSupplyUsd(input.fixedInput, assetId);
      if (supplyUsd === null) throw new Error(`Supply attribution for ${assetId} has unavailable aggregate supply`);
      const error = reviewedEconomicDeploymentAttributionValidationError({
        assetId, attribution, aggregateSupplyUsd: supplyUsd,
        registryFingerprint: input.fixedInput.registryFingerprint, clockSec: record.scoringClockSec,
        baseInputGenerationId: input.fixedInput.baseInputGenerationId, sourceGeneration: input.fixedInput.sourceGeneration,
        aggregateObservedAtSec: input.fixedInput.aggregateCirculatingById[assetId]?.observedAtSec ?? null,
        referencePrice: input.fixedInput.navPriceById?.[assetId] ?? null,
        chainRows: input.fixedInput.chainCirculatingById[assetId],
      });
      if (error) throw new Error(error);
    }
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
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>;
  capture: SafetyScoreV9SupplyAttributionCapture;
  capturedAtSec: number;
  /**
   * The census generation the producer's store read served for this capture
   * (SA-1/SA-4). Both fields come from that one read; pass nothing when the
   * store served no admitted packets (absent, never `{}`).
   */
  deploymentSupplyCensus?: {
    byId: SafetyScoreV9DeploymentSupplyCensusById;
    binding: SafetyScoreV9DeploymentSupplyCensusBinding;
  };
}): SafetyScoreV9SupplyAttributionGeneration {
  const recordsByAsset = journalRecordsByAsset(input.capture.journalRecords);
  assertCaptureBindings({ ...input, recordsByAsset });
  const expectedAssetIds = uniqueSorted(input.capture.expectedAssetIds);
  const observedAssetIds = uniqueSorted([...recordsByAsset.keys()]);
  const acceptedAssetIds = uniqueSorted(
    Object.keys(input.capture.attributionById),
  );
  const rejectedAssetIds = observedAssetIds.filter(
    (assetId) => !acceptedAssetIds.includes(assetId),
  );
  const outcomesById = Object.fromEntries(
    observedAssetIds.map((assetId) => {
      const record = recordsByAsset.get(assetId)!;
      const diagnostics = input.capture.diagnosticsById?.[assetId];
      const diagnosticFields = diagnostics?.length ? { diagnostics } : {};
      const captureFailureReason = input.capture.failureReasonById?.[assetId];
      return [
        assetId,
        record.admissionCode === "supply-attribution.admission.accepted"
          ? {
              status: "accepted" as const,
              journalId: record.journalId,
              ...diagnosticFields,
            }
          : {
              status: "rejected" as const,
              rejectionCode: record.rejectionCode!,
              failedRouteId: record.failedRouteId,
              journalId: record.journalId,
              ...diagnosticFields,
              ...(captureFailureReason ? { captureFailureReason } : {}),
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
    ...(input.deploymentSupplyCensus
      ? {
          deploymentSupplyCensusById: input.deploymentSupplyCensus.byId,
          deploymentSupplyCensusBinding: input.deploymentSupplyCensus.binding,
        }
      : {}),
  });
  return supplyAttributionGenerationCodec.create(payload);
}

export const serializeSafetyScoreV9SupplyAttributionGeneration =
  supplyAttributionGenerationCodec.serialize;
export const parseSafetyScoreV9SupplyAttributionGeneration =
  supplyAttributionGenerationCodec.parse;

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
      /**
       * Accepted packets skipped because the consumer no longer expects the
       * asset (its upstream chain rows returned, or it left the active set);
       * applying them would shadow observed data.
       */
      supersededAssetIds: string[];
      /** 10.26: expected assets this generation did not admit, re-derived from the last admitted packet. */
      carriedForwardAssetIds: string[];
    }
  | {
      status: "unavailable" | "incompatible";
      generationId: string | null;
      fixedInput: SafetyScoreV9CompilerInput;
      reason: string;
      carriedForwardAssetIds: string[];
    };

/**
 * Last admitted wM/XAUT-style packets (10.26 bounded carry-forward). Written
 * by the consumer after each application; re-derived against the current
 * fixed input and admitted only inside the per-model carry window.
 */
export const SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_LAST_ADMITTED_CACHE_KEY =
  "safety-score-v9:supply-attribution-last-admitted:v1";
const SupplyAttributionLastAdmittedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generationId: GenerationIdSchema,
  attributionById: z.record(AssetIdSchema, SafetyScoreV9SupplyAttributionSchema),
});
export type SafetyScoreV9SupplyAttributionLastAdmitted = z.infer<typeof SupplyAttributionLastAdmittedSchema>;

export function parseSafetyScoreV9SupplyAttributionLastAdmitted(value: string): SafetyScoreV9SupplyAttributionLastAdmitted | null {
  // Malformed carry state fails closed: nothing is carried this run.
  const parsed = SupplyAttributionLastAdmittedSchema.safeParse(parseJsonObject(value));
  return parsed.success ? parsed.data : null;
}

/** Only models with a bounded carry contract are retained. */
export function buildSafetyScoreV9SupplyAttributionLastAdmitted(
  application: SafetyScoreV9SupplyAttributionGenerationApplication,
  previous: SafetyScoreV9SupplyAttributionLastAdmitted | null,
): SafetyScoreV9SupplyAttributionLastAdmitted | null {
  if (application.status !== "applied") return null;
  const attributionById = Object.fromEntries(
    Object.entries(application.fixedInput.safetyScoreV9SupplyAttributionById ?? {})
      .filter(([, attribution]) =>
        attribution.model === "reviewed-deployment-unit-partition-v1" ||
        attribution.model === "canonical-lock-mint-group-partition-v2"),
  );
  // A carried packet keeps naming its original generation; an empty current
  // application does not erase the previous admitted packets.
  return Object.keys(attributionById).length === 0
    ? previous
    : { schemaVersion: 1, generationId: application.generationId, attributionById };
}

function carryForwardSupplyAttribution(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  lastAdmitted: SafetyScoreV9SupplyAttributionLastAdmitted | null | undefined,
  applied: Readonly<SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"]>,
): { attributionById: SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"]; assetIds: string[] } {
  const attributionById: SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"] = {};
  const assetIds: string[] = [];
  if (!lastAdmitted) return { attributionById, assetIds };
  for (const assetId of safetyScoreV9SupplyAttributionExpectedAssetIds(fixedInput)) {
    const prior = lastAdmitted.attributionById[assetId];
    if (applied[assetId] || !prior) continue;
    const aggregate = aggregateSupplyUsd(fixedInput, assetId);
    if (aggregate === null) continue;
    const carriedForwardFromGenerationId =
      ("carriedForwardFromGenerationId" in prior ? prior.carriedForwardFromGenerationId : undefined) ??
      lastAdmitted.generationId;
    const attribution = prior.model === "reviewed-deployment-unit-partition-v1"
      ? deriveReviewedDeploymentUnitPartition({
          assetId, aggregateSupplyUsd: aggregate, registryFingerprint: fixedInput.registryFingerprint,
          scoringClockSec: fixedInput.clockSec, observations: prior.deployments, carriedForwardFromGenerationId,
        })
      : prior.model === "canonical-lock-mint-group-partition-v2"
        ? deriveXautRepresentationGroupSupplyAttribution({
            aggregateSupplyUsd: aggregate, registryFingerprint: fixedInput.registryFingerprint,
            scoringClockSec: fixedInput.clockSec, observation: prior.observation, carriedForwardFromGenerationId,
          })
        : null;
    // Outside the carry window the packet is not re-derivable and the
    // existing unavailable-materiality fallback applies.
    if (!attribution) continue;
    attributionById[assetId] = attribution;
    assetIds.push(assetId);
  }
  return { attributionById, assetIds };
}

type SupplyAttributionGenerationCompatibilityReason =
  | "source-clock-after-fixed-input"
  | "capture-clock-after-consumer"
  | "captured-after-consumer"
  | "generation-stale";

function withoutSupplyAttribution(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
): SafetyScoreV9CompilerInput {
  return {
    ...fixedInput,
    safetyScoreV9SupplyAttributionById: {},
  };
}

export function diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
  generation: SafetyScoreV9SupplyAttributionGeneration,
  consumerClockSec = fixedInput.clockSec,
): SupplyAttributionGenerationCompatibilityReason | null {
  // The generation's own registryFingerprint stays on the record as capture
  // provenance, but it is deliberately not an admission gate. It is global, so
  // any registry edit rotates it for every asset, including the ones the edit
  // never touched; gating here discarded the whole generation for one
  // publication cycle after each release. The expected-asset-id set is not a
  // gate for the same reason: it is derived from live upstream chain rows, so
  // one co-tenant gaining or losing DefiLlama coverage (or failing its own
  // capture) flipped the set and discarded every verified packet with it — on
  // 2026-08-18 two Solana RPC rejections cost XAUT its accepted attribution.
  // Admission is per asset instead: `applySafetyScoreV9SupplyAttributionGeneration`
  // re-derives every stored observation against the live route inventory,
  // identity pins, observation window, and aggregate supply, applies only the
  // assets the consumer still expects, and drops only the assets that fail.
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
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
  generation: SafetyScoreV9SupplyAttributionGeneration,
  consumerClockSec = fixedInput.clockSec,
): boolean {
  return diagnoseSafetyScoreV9SupplyAttributionGenerationCompatibility(
    fixedInput,
    generation,
    consumerClockSec,
  ) === null;
}


function rederiveEconomicSupplyAttribution(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  generation: SafetyScoreV9SupplyAttributionGeneration,
  assetId: string,
  stored: Extract<SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"][string], { model: "reviewed-economic-deployment-partition-v1" }>,
) {
  const plan = REVIEWED_ECONOMIC_SUPPLY_PLANS.get(assetId);
  // Validate the original packet against its capture, never the new publication
  // identity. Only raw external observations survive the consumer re-derivation.
  if (!plan || stored.scoringClockSec < generation.sourceClockSec ||
    stored.scoringClockSec > generation.captureClockSec ||
    reviewedEconomicDeploymentAttributionValidationError({
      assetId, attribution: stored, aggregateSupplyUsd: stored.aggregate.supplyUsd,
      registryFingerprint: generation.registryFingerprint, clockSec: stored.scoringClockSec,
      baseInputGenerationId: generation.sourceBaseInputGenerationId, sourceGeneration: generation.sourceGeneration,
    }) !== null) return null;
  const aggregate = fixedInput.aggregateCirculatingById[assetId];
  if (aggregate?.observedAtSec == null) return null;
  const referencePrice = plan.referencePriceSource === null
    ? economicSupplyInputReferencePrice(fixedInput, assetId) : stored.referencePrice;
  if (!referencePrice) return null;
  const observations = [];
  for (const observation of stored.observations) {
    const row = plan.deployments.find(row => row.deploymentKey === observation.id);
    if (row && (row.read.kind === "provider-chain" || row.read.kind === "native-from-aggregate")) {
      const current = economicSupplyInputDeploymentObservation({ fixedInput, plan, row, referencePrice });
      if (!current) return null;
      observations.push(current);
    } else {
      observations.push(observation);
    }
  }
  const supplyUsd = aggregateSupplyUsd(fixedInput, assetId);
  if (supplyUsd === null) return null;
  const attribution = deriveReviewedEconomicDeploymentPartition({
    plan, baseInputGenerationId: fixedInput.baseInputGenerationId, sourceGeneration: fixedInput.sourceGeneration,
    registryFingerprint: fixedInput.registryFingerprint, clockSec: fixedInput.clockSec,
    aggregate: { supplyUsd, observedAtSec: aggregate.observedAtSec,
      sourceGeneration: fixedInput.sourceGeneration },
    referencePrice, conversions: stored.conversions, observations, inFlight: stored.inFlight,
  });
  return attribution && economicProviderSupplyContradictionChain(
    attribution, fixedInput.chainCirculatingById[assetId] ?? {},
  ) === null ? attribution : null;
}

export function applySafetyScoreV9SupplyAttributionGeneration(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  generation:
    | SafetyScoreV9SupplyAttributionGeneration
    | null,
  lastAdmitted?: SafetyScoreV9SupplyAttributionLastAdmitted | null,
): SafetyScoreV9SupplyAttributionGenerationApplication {
  const censusById = generation?.deploymentSupplyCensusById;
  const censusBinding = generation?.deploymentSupplyCensusBinding;
  // The generation carries the projection and its binding as one unit (the
  // payload schema refuses either alone). An absent census stays absent: never
  // `{}`, which would claim a measured-empty census. The pair travels only when
  // the carrier generation is ADMITTED (below): a map from a generation this
  // input refuses must not bound a row, and the binding names the carrier's
  // own capture tuple, not this input's base generation.
  const censusFields =
    censusById === undefined || censusBinding === undefined
      ? {}
      : {
          safetyScoreV9DeploymentSupplyCensusById: censusById,
          safetyScoreV9DeploymentSupplyCensusBinding: censusBinding,
        };
  const withCarry = (
    applied: SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"],
    fields: Partial<Pick<SafetyScoreV9CompilerInput,
      "safetyScoreV9DeploymentSupplyCensusById" | "safetyScoreV9DeploymentSupplyCensusBinding">> = censusFields,
  ) => {
    const carried = carryForwardSupplyAttribution(fixedInput, lastAdmitted, applied);
    return {
      fixedInput: {
        ...fixedInput,
        ...fields,
        safetyScoreV9SupplyAttributionById: { ...applied, ...carried.attributionById },
      },
      carriedForwardAssetIds: carried.assetIds,
    };
  };
  if (!generation) {
    return {
      status: "unavailable",
      generationId: null,
      ...(lastAdmitted ? withCarry({}, {}) : { fixedInput: withoutSupplyAttribution(fixedInput), carriedForwardAssetIds: [] }),
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
      ...(lastAdmitted ? withCarry({}, {}) : { fixedInput: withoutSupplyAttribution(fixedInput), carriedForwardAssetIds: [] }),
      reason: compatibilityReason,
    };
  }

  const attributionById:
    SafetyScoreV9CompilerInput["safetyScoreV9SupplyAttributionById"] = {};
  const appliedAssetIds: string[] = [];
  const invalidAssetIds: string[] = [];
  const supersededAssetIds: string[] = [];
  const consumerExpectedAssetIds = new Set(
    safetyScoreV9SupplyAttributionExpectedAssetIds(fixedInput),
  );
  for (const assetId of generation.acceptedAssetIds) {
    if (!consumerExpectedAssetIds.has(assetId)) {
      supersededAssetIds.push(assetId);
      continue;
    }
    const stored = generation.attributionById[assetId]!;
    const aggregate = aggregateSupplyUsd(fixedInput, assetId);
    if (aggregate === null) {
      invalidAssetIds.push(assetId);
      continue;
    }
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
          : stored.model === "reviewed-economic-deployment-partition-v1"
            ? rederiveEconomicSupplyAttribution(fixedInput, generation, assetId, stored)
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
    ...withCarry(attributionById),
    acceptedAssetIds: appliedAssetIds,
    rejectedAssetIds: [...generation.rejectedAssetIds],
    invalidAssetIds,
    supersededAssetIds,
  };
}
