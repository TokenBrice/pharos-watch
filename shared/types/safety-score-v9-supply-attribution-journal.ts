import { z } from "zod";
import { sha256Hex } from "../lib/sha256";
import { stableJsonStringifyV1 } from "../lib/stable-json";

export const SUPPLY_ATTRIBUTION_JOURNAL_ENTRY_MAX_BYTES = 1_152;
export const SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_BYTES = 32 * 1_024;
export const SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET = 2;
export const SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS = 32;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const AssetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const SafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const JournalIdSchema = z.string().regex(/^supply-attribution-evidence:v1:[a-f0-9]{64}$/);

const SECRET_BEARING_TEXT_PATTERNS = [
  /(?:https?|wss?):\/\//i,
  /\bauthorization\s*:/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret)\s*[:=]/i,
  /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret)=/i,
] as const;

export const SupplyAttributionAdmissionCodeSchema = z.enum([
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

export const SupplyAttributionFallbackCodeSchema = z.enum([
  "supply-attribution.fallback.not-used",
  "supply-attribution.fallback.aggregate-only",
]);

const SupplyAttributionJournalV1PayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    lane: z.literal("supply-attribution"),
    assetId: AssetIdSchema,
    attemptId: SafeIdentifierSchema,
    sourceId: z.literal("wm.reviewed-deployment-unit-partition.v1"),
    sourceOriginClass: z.literal("onchain-observation"),
    baseInputGenerationId: SafeIdentifierSchema,
    sourceGeneration: SafeIdentifierSchema,
    registryFingerprint: Sha256Schema,
    routeInventoryDigest: Sha256Schema.nullable(),
    attemptCode: z.literal("supply-attribution.collector.attempted"),
    admissionCode: SupplyAttributionAdmissionCodeSchema,
    fallbackCode: SupplyAttributionFallbackCodeSchema,
    attemptedAtSec: z.number().int().nonnegative(),
    completedAtSec: z.number().int().nonnegative(),
    scoringClockSec: z.number().int().nonnegative(),
    sourceObservedAtSec: z.number().int().nonnegative().nullable(),
    failedRouteId: SafeIdentifierSchema.nullable(),
    contentSha256: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.completedAtSec < record.attemptedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAtSec"],
        message: "Supply attribution journal completion cannot predate its attempt",
      });
    }
    const accepted =
      record.admissionCode === "supply-attribution.admission.accepted";
    if (accepted !== (record.fallbackCode === "supply-attribution.fallback.not-used")) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackCode"],
        message: "Only accepted supply attribution may omit the aggregate-only fallback",
      });
    }
    if (
      accepted !==
      (record.contentSha256 !== null &&
        record.sourceObservedAtSec !== null &&
        record.failedRouteId === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Accepted supply attribution requires content and source time without a failed route",
      });
    }
    if (
      record.sourceObservedAtSec !== null &&
      record.sourceObservedAtSec > record.scoringClockSec
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceObservedAtSec"],
        message: "Supply attribution evidence cannot follow its scoring clock",
      });
    }

    const serialized = stableJsonStringifyV1(record);
    if (SECRET_BEARING_TEXT_PATTERNS.some((pattern) => pattern.test(serialized))) {
      ctx.addIssue({
        code: "custom",
        message: "Supply attribution journal identifiers cannot contain secret-bearing text",
      });
    }
    if (
      new TextEncoder().encode(serialized).byteLength >
      SUPPLY_ATTRIBUTION_JOURNAL_ENTRY_MAX_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          `Supply attribution journal entry exceeds ` +
          `${SUPPLY_ATTRIBUTION_JOURNAL_ENTRY_MAX_BYTES} bytes`,
      });
    }
  });

export type SupplyAttributionJournalV1Payload = z.infer<
  typeof SupplyAttributionJournalV1PayloadSchema
>;

export function computeSupplyAttributionJournalIdV1(
  payload: SupplyAttributionJournalV1Payload,
): string {
  return `supply-attribution-evidence:v1:${sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.supply-attribution-evidence.v1",
      payload,
    }),
  )}`;
}

export const SupplyAttributionJournalV1Schema =
  SupplyAttributionJournalV1PayloadSchema.extend({
    journalId: JournalIdSchema,
  })
    .strict()
    .superRefine((record, ctx) => {
      const { journalId, ...payload } = record;
      if (journalId !== computeSupplyAttributionJournalIdV1(payload)) {
        ctx.addIssue({
          code: "custom",
          path: ["journalId"],
          message: "Supply attribution journal ID does not match its canonical payload",
        });
      }
    });

export type SupplyAttributionJournalV1 = z.infer<
  typeof SupplyAttributionJournalV1Schema
>;

export function createSupplyAttributionJournalV1(
  value: SupplyAttributionJournalV1Payload,
): SupplyAttributionJournalV1 {
  const payload = SupplyAttributionJournalV1PayloadSchema.parse(value);
  return SupplyAttributionJournalV1Schema.parse({
    ...payload,
    journalId: computeSupplyAttributionJournalIdV1(payload),
  });
}

function compareRecords(
  left: SupplyAttributionJournalV1,
  right: SupplyAttributionJournalV1,
): number {
  return (
    left.attemptedAtSec - right.attemptedAtSec ||
    left.completedAtSec - right.completedAtSec ||
    left.attemptId.localeCompare(right.attemptId) ||
    left.journalId.localeCompare(right.journalId)
  );
}

export const SupplyAttributionJournalByIdV1Schema = z
  .record(z.string(), z.array(SupplyAttributionJournalV1Schema))
  .superRefine((journalById, ctx) => {
    const entries = Object.entries(journalById);
    if (entries.length > SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS) {
      ctx.addIssue({
        code: "custom",
        message:
          `Supply attribution journal covers more than ` +
          `${SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS} assets`,
      });
    }
    for (const [assetId, records] of entries) {
      if (!AssetIdSchema.safeParse(assetId).success) {
        ctx.addIssue({
          code: "custom",
          path: [assetId],
          message: "Invalid supply attribution journal asset ID",
        });
      }
      if (records.length > SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET) {
        ctx.addIssue({
          code: "custom",
          path: [assetId],
          message:
            `Supply attribution journal retains at most ` +
            `${SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET} entries per asset`,
        });
      }
      const attemptIds = new Set<string>();
      for (const [index, record] of records.entries()) {
        if (record.assetId !== assetId) {
          ctx.addIssue({
            code: "custom",
            path: [assetId, index, "assetId"],
            message: "Supply attribution journal asset does not match its map key",
          });
        }
        if (attemptIds.has(record.attemptId)) {
          ctx.addIssue({
            code: "custom",
            path: [assetId, index, "attemptId"],
            message: "Supply attribution journal contains a duplicate attempt",
          });
        }
        attemptIds.add(record.attemptId);
      }
    }
    if (
      new TextEncoder().encode(stableJsonStringifyV1(journalById)).byteLength >
      SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          `Fixed-input supply attribution journal exceeds ` +
          `${SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_BYTES} bytes`,
      });
    }
  })
  .transform((journalById) =>
    Object.fromEntries(
      Object.entries(journalById)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([assetId, records]) => [assetId, [...records].sort(compareRecords)]),
    ),
  );

export type SupplyAttributionJournalByIdV1 = z.infer<
  typeof SupplyAttributionJournalByIdV1Schema
>;
