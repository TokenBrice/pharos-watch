import { z } from "zod";
import { Sha256Schema } from "../types/safety-schema-primitives";
import {
  ContentAddressedJournalAssetIdSchema,
  ContentAddressedJournalSafeIdentifierSchema,
  createContentAddressedJournal,
} from "./content-addressed-journal";

const SUPPLY_ATTRIBUTION_JOURNAL_ENTRY_MAX_BYTES = 1_152;
const SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_BYTES = 32 * 1_024;
export const SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET = 2;
export const SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS = 32;
const WM_SUPPLY_ATTRIBUTION_MAX_POST_CLOCK_SEC = 120;

export const SupplyAttributionJournalIdSchema = z
  .string()
  .regex(/^supply-attribution-evidence:v1:[a-f0-9]{64}$/);

const SupplyAttributionAdmissionCodeSchema = z.enum([
  "supply-attribution.admission.accepted",
  "supply-attribution.admission.rejected-upstream",
  "supply-attribution.admission.rejected-invalid-payload",
  "supply-attribution.admission.rejected-identity-drift",
  "supply-attribution.admission.rejected-route-inventory",
  "supply-attribution.admission.rejected-stale",
  "supply-attribution.admission.rejected-skew",
  "supply-attribution.admission.rejected-reconciliation",
]);

export type SupplyAttributionAdmissionCode = z.infer<
  typeof SupplyAttributionAdmissionCodeSchema
>;

export const SupplyAttributionRejectionCodeSchema = z.enum([
  "route-inventory-unavailable",
  "deployment-identity-unavailable",
  "chain-rpc-unavailable",
  "safe-block-unavailable",
  "deployment-state-unavailable",
  "deployment-state-invalid",
  "deployment-identity-mismatch",
  "deployment-observation-skew",
  "packet-reconciliation-failed",
  "transparency-source-config-unavailable",
  "transparency-source-unavailable",
  "transparency-payload-invalid",
  "transparency-stale",
  "transparency-clock-skew",
  "transparency-onchain-mismatch",
  "transparency-liability-state-invalid",
  "finalized-block-unavailable",
  "observation-stale",
]);

export type SupplyAttributionRejectionCode = z.infer<
  typeof SupplyAttributionRejectionCodeSchema
>;

const SUPPLY_ATTRIBUTION_ADMISSION_BY_REJECTION_CODE = {
  "route-inventory-unavailable":
    "supply-attribution.admission.rejected-route-inventory",
  "deployment-identity-unavailable":
    "supply-attribution.admission.rejected-identity-drift",
  "chain-rpc-unavailable":
    "supply-attribution.admission.rejected-upstream",
  "safe-block-unavailable":
    "supply-attribution.admission.rejected-stale",
  "deployment-state-unavailable":
    "supply-attribution.admission.rejected-upstream",
  "deployment-state-invalid":
    "supply-attribution.admission.rejected-invalid-payload",
  "deployment-identity-mismatch":
    "supply-attribution.admission.rejected-identity-drift",
  "deployment-observation-skew":
    "supply-attribution.admission.rejected-skew",
  "packet-reconciliation-failed":
    "supply-attribution.admission.rejected-reconciliation",
  "transparency-source-config-unavailable":
    "supply-attribution.admission.rejected-identity-drift",
  "transparency-source-unavailable":
    "supply-attribution.admission.rejected-upstream",
  "transparency-payload-invalid":
    "supply-attribution.admission.rejected-invalid-payload",
  "transparency-stale":
    "supply-attribution.admission.rejected-stale",
  "transparency-clock-skew":
    "supply-attribution.admission.rejected-skew",
  "transparency-onchain-mismatch":
    "supply-attribution.admission.rejected-reconciliation",
  "transparency-liability-state-invalid":
    "supply-attribution.admission.rejected-reconciliation",
  "finalized-block-unavailable":
    "supply-attribution.admission.rejected-stale",
  "observation-stale":
    "supply-attribution.admission.rejected-stale",
} as const satisfies Readonly<
  Record<SupplyAttributionRejectionCode, SupplyAttributionAdmissionCode>
>;

export function admissionCodeForSupplyAttributionRejection(
  rejectionCode: SupplyAttributionRejectionCode,
): SupplyAttributionAdmissionCode {
  return SUPPLY_ATTRIBUTION_ADMISSION_BY_REJECTION_CODE[rejectionCode];
}

const REVIEWED_DEPLOYMENT_REJECTION_CODES =
  new Set<SupplyAttributionRejectionCode>([
    "route-inventory-unavailable",
    "deployment-identity-unavailable",
    "chain-rpc-unavailable",
    "safe-block-unavailable",
    "deployment-state-unavailable",
    "deployment-state-invalid",
    "deployment-identity-mismatch",
    "deployment-observation-skew",
    "packet-reconciliation-failed",
  ]);

const XAUT_REJECTION_CODES = new Set<SupplyAttributionRejectionCode>([
  "route-inventory-unavailable",
  "transparency-source-config-unavailable",
  "transparency-source-unavailable",
  "transparency-payload-invalid",
  "transparency-stale",
  "transparency-clock-skew",
  "transparency-onchain-mismatch",
  "transparency-liability-state-invalid",
  "chain-rpc-unavailable",
  "finalized-block-unavailable",
  "observation-stale",
  "deployment-state-unavailable",
  "deployment-state-invalid",
  "deployment-identity-mismatch",
  "packet-reconciliation-failed",
]);

const TIMESTAMPED_REJECTION_CODES =
  new Set<SupplyAttributionRejectionCode>([
    "transparency-stale",
    "transparency-clock-skew",
    "observation-stale",
  ]);

const SupplyAttributionFallbackCodeSchema = z.enum([
  "supply-attribution.fallback.not-used",
  "supply-attribution.fallback.aggregate-only",
]);

const SupplyAttributionJournalV1PayloadDomainSchema = z
  .object({
    schemaVersion: z.literal(1),
    lane: z.literal("supply-attribution"),
    assetId: ContentAddressedJournalAssetIdSchema,
    attemptId: ContentAddressedJournalSafeIdentifierSchema,
    sourceId: z.enum([
      "wm.reviewed-deployment-unit-partition.v1",
      "centrifuge.reviewed-deployment-unit-partition.v1",
      "xaut.canonical-lock-mint-group-partition.v2",
    ]),
    sourceOriginClass: z.enum([
      "onchain-observation",
      "issuer-disclosure-plus-onchain",
    ]),
    baseInputGenerationId: ContentAddressedJournalSafeIdentifierSchema,
    sourceGeneration: ContentAddressedJournalSafeIdentifierSchema,
    registryFingerprint: Sha256Schema,
    routeInventoryDigest: Sha256Schema.nullable(),
    attemptCode: z.literal("supply-attribution.collector.attempted"),
    admissionCode: SupplyAttributionAdmissionCodeSchema,
    fallbackCode: SupplyAttributionFallbackCodeSchema,
    // Optional only so immutable V1 rows written before exact leaf diagnostics
    // continue to parse and retain their original content-addressed IDs.
    rejectionCode: SupplyAttributionRejectionCodeSchema.optional(),
    attemptedAtSec: z.number().int().nonnegative(),
    completedAtSec: z.number().int().nonnegative(),
    scoringClockSec: z.number().int().nonnegative(),
    sourceObservedAtSec: z.number().int().nonnegative().nullable(),
    failedRouteId: ContentAddressedJournalSafeIdentifierSchema.nullable(),
    contentSha256: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const expectedOrigin =
      record.sourceId ===
      "xaut.canonical-lock-mint-group-partition.v2"
        ? "issuer-disclosure-plus-onchain"
        : "onchain-observation";
    if (record.sourceOriginClass !== expectedOrigin) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceOriginClass"],
        message:
          `Supply attribution source ${record.sourceId} requires ` +
          `${expectedOrigin} origin`,
      });
    }
    if (record.completedAtSec < record.attemptedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAtSec"],
        message: "Supply attribution journal completion cannot predate its attempt",
      });
    }
    const accepted =
      record.admissionCode === "supply-attribution.admission.accepted";
    const allowedRejectionCodes =
      record.sourceId ===
      "xaut.canonical-lock-mint-group-partition.v2"
        ? XAUT_REJECTION_CODES
        : REVIEWED_DEPLOYMENT_REJECTION_CODES;
    if (
      record.rejectionCode !== undefined &&
      !allowedRejectionCodes.has(record.rejectionCode)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["rejectionCode"],
        message:
          `Supply attribution source ${record.sourceId} cannot emit ` +
          `${record.rejectionCode}`,
      });
    }
    if (accepted && record.rejectionCode !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["rejectionCode"],
        message: "Accepted supply attribution cannot carry a rejection code",
      });
    }
    if (
      !accepted &&
      record.rejectionCode !== undefined &&
      record.admissionCode !==
        admissionCodeForSupplyAttributionRejection(record.rejectionCode)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["admissionCode"],
        message:
          `Supply attribution rejection ${record.rejectionCode} requires ` +
          `${admissionCodeForSupplyAttributionRejection(record.rejectionCode)}`,
      });
    }
    if (
      record.rejectionCode !== undefined &&
      TIMESTAMPED_REJECTION_CODES.has(record.rejectionCode) &&
      record.sourceObservedAtSec === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceObservedAtSec"],
        message:
          `Supply attribution rejection ${record.rejectionCode} requires ` +
          "its rejected source timestamp",
      });
    }
    if (accepted !== (record.fallbackCode === "supply-attribution.fallback.not-used")) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackCode"],
        message: "Only accepted supply attribution may omit the aggregate-only fallback",
      });
    }
    if (
      accepted
        ? record.contentSha256 === null ||
          record.sourceObservedAtSec === null ||
          record.failedRouteId !== null
        : record.contentSha256 !== null
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Accepted supply attribution requires content and source time " +
          "without a failed route; rejected attribution cannot carry content",
      });
    }
    const boundedWmPostClockObservation =
      record.assetId === "wm-m0" &&
      record.sourceId === "wm.reviewed-deployment-unit-partition.v1" &&
      record.sourceObservedAtSec !== null &&
      record.sourceObservedAtSec > record.scoringClockSec &&
      record.sourceObservedAtSec - record.scoringClockSec <=
        WM_SUPPLY_ATTRIBUTION_MAX_POST_CLOCK_SEC &&
      record.sourceObservedAtSec <= record.completedAtSec;
    const rejectedXautClockSkew =
      !accepted &&
      record.sourceId ===
        "xaut.canonical-lock-mint-group-partition.v2" &&
      record.rejectionCode === "transparency-clock-skew";
    if (
      record.sourceObservedAtSec !== null &&
      record.sourceObservedAtSec > record.scoringClockSec &&
      !boundedWmPostClockObservation &&
      !rejectedXautClockSkew
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceObservedAtSec"],
        message:
          "Supply attribution evidence cannot follow its scoring clock " +
          "outside the bounded wM finality exception",
      });
    }
  });

const supplyAttributionJournal = createContentAddressedJournal({
  payloadSchema: SupplyAttributionJournalV1PayloadDomainSchema,
  journalIdSchema: SupplyAttributionJournalIdSchema,
  idPrefix: "supply-attribution-evidence:v1:",
  domain: "safety-score-v9.supply-attribution-evidence.v1",
  entryMaxBytes: SUPPLY_ATTRIBUTION_JOURNAL_ENTRY_MAX_BYTES,
  aggregateMaxBytes: SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_BYTES,
  maxAssets: SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  maxEntriesPerAsset: SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET,
  messages: {
    secretBearingText: "Supply attribution journal identifiers cannot contain secret-bearing text",
    entryTooLarge:
      `Supply attribution journal entry exceeds ` +
      `${SUPPLY_ATTRIBUTION_JOURNAL_ENTRY_MAX_BYTES} bytes`,
    tooManyAssets:
      `Supply attribution journal covers more than ` +
      `${SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS} assets`,
    invalidAssetId: "Invalid supply attribution journal asset ID",
    tooManyEntriesPerAsset:
      `Supply attribution journal retains at most ` +
      `${SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET} entries per asset`,
    assetMismatch: "Supply attribution journal asset does not match its map key",
    duplicateAttempt: "Supply attribution journal contains a duplicate attempt",
    aggregateTooLarge:
      `Fixed-input supply attribution journal exceeds ` +
      `${SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_BYTES} bytes`,
    journalIdMismatch: "Supply attribution journal ID does not match its canonical payload",
  },
});

const SupplyAttributionJournalV1PayloadSchema =
  supplyAttributionJournal.payloadSchema;

export type SupplyAttributionJournalV1Payload = z.infer<
  typeof SupplyAttributionJournalV1PayloadSchema
>;

export function computeSupplyAttributionJournalIdV1(
  payload: SupplyAttributionJournalV1Payload,
): string {
  return supplyAttributionJournal.computeId(payload);
}

export const SupplyAttributionJournalV1Schema =
  supplyAttributionJournal.recordSchema;

export type SupplyAttributionJournalV1 = z.infer<
  typeof SupplyAttributionJournalV1Schema
>;

export function createSupplyAttributionJournalV1(
  value: SupplyAttributionJournalV1Payload,
): SupplyAttributionJournalV1 {
  const payload = SupplyAttributionJournalV1PayloadSchema.parse(value);
  if (
    payload.admissionCode !== "supply-attribution.admission.accepted" &&
    payload.rejectionCode === undefined
  ) {
    throw new Error(
      "New rejected supply attribution journal records require an exact leaf code",
    );
  }
  return supplyAttributionJournal.create(payload);
}

export const SupplyAttributionJournalByIdV1Schema =
  supplyAttributionJournal.journalByIdSchema;

export type SupplyAttributionJournalByIdV1 = z.infer<
  typeof SupplyAttributionJournalByIdV1Schema
>;
