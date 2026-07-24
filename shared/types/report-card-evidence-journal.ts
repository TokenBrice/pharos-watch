import { z } from "zod";
import { sha256Hex } from "../lib/sha256";
import { stableJsonStringifyV1 } from "../lib/stable-json";

export const REPORT_CARD_EVIDENCE_JOURNAL_ENTRY_MAX_BYTES = 1_024;
export const REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_BYTES = 384 * 1_024;
export const REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET = 2;
export const REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS = 512;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const AssetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const SafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const JournalIdSchema = z.string().regex(/^report-card-evidence:v1:[a-f0-9]{64}$/);

const SECRET_BEARING_TEXT_PATTERNS = [
  /(?:https?|wss?):\/\//i,
  /\bauthorization\s*:/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret)\s*[:=]/i,
  /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret)=/i,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/,
] as const;

export const ReserveEvidenceAttemptCodeSchema = z.enum([
  "reserve.collector.attempted",
  "reserve.collector.not-configured",
  "reserve.collector.deferred",
]);

export const ReserveEvidenceAdmissionCodeSchema = z.enum([
  "reserve.admission.accepted",
  "reserve.admission.not-evaluated",
  "reserve.admission.rejected-upstream",
  "reserve.admission.rejected-timeout",
  "reserve.admission.rejected-invalid-payload",
  "reserve.admission.rejected-schema-drift",
  "reserve.admission.rejected-stale",
  "reserve.admission.rejected-reconciliation",
  "reserve.admission.rejected-sidecar-mismatch",
]);

export const ReserveEvidenceFallbackCodeSchema = z.enum([
  "reserve.fallback.not-used",
  "reserve.fallback.curated",
  "reserve.fallback.reviewed-sidecar",
  "reserve.fallback.last-known-good",
  "reserve.fallback.unavailable",
]);

export const ReserveEvidenceSourceOriginClassSchema = z.enum([
  "issuer-attested",
  "onchain-observation",
  "independent-assurance",
  "reviewed-curation",
  "unknown",
]);

export type ReserveEvidenceSourceOriginClass = z.infer<
  typeof ReserveEvidenceSourceOriginClassSchema
>;

const ReportCardEvidenceJournalSourceBlockV1Schema = z
  .object({
    chainId: SafeIdentifierSchema,
    blockNumber: z.number().int().nonnegative(),
    blockHash: z.string().regex(/^(?:0x)?[a-f0-9]{64}$/),
  })
  .strict();

const ReportCardEvidenceJournalV1PayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    lane: z.literal("reserve"),
    assetId: AssetIdSchema,
    attemptId: SafeIdentifierSchema,
    sourceId: SafeIdentifierSchema,
    sourceOriginClass: ReserveEvidenceSourceOriginClassSchema,
    attemptCode: ReserveEvidenceAttemptCodeSchema,
    admissionCode: ReserveEvidenceAdmissionCodeSchema,
    fallbackCode: ReserveEvidenceFallbackCodeSchema,
    attemptedAtSec: z.number().int().nonnegative(),
    completedAtSec: z.number().int().nonnegative(),
    sourceTimestampSec: z.number().int().nonnegative().nullable(),
    sourceBlock: ReportCardEvidenceJournalSourceBlockV1Schema.nullable(),
    contentSha256: Sha256Schema.nullable(),
    sidecarMaterializationSha256: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.completedAtSec < record.attemptedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAtSec"],
        message: "Evidence journal completion cannot predate its attempt",
      });
    }
    if (record.sourceTimestampSec !== null && record.sourceTimestampSec > record.completedAtSec) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceTimestampSec"],
        message: "Evidence journal source timestamp cannot follow collector completion",
      });
    }

    const attempted = record.attemptCode === "reserve.collector.attempted";
    const accepted = record.admissionCode === "reserve.admission.accepted";
    const notEvaluated = record.admissionCode === "reserve.admission.not-evaluated";
    if (attempted === notEvaluated) {
      ctx.addIssue({
        code: "custom",
        path: ["admissionCode"],
        message: "Attempted reserve evidence must be accepted or rejected; skipped evidence must not be evaluated",
      });
    }
    if (accepted && record.fallbackCode !== "reserve.fallback.not-used") {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackCode"],
        message: "Accepted reserve evidence cannot also use a fallback",
      });
    }
    if (!accepted && record.fallbackCode === "reserve.fallback.not-used") {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackCode"],
        message: "Rejected or skipped reserve evidence must record its fallback disposition",
      });
    }
    if (accepted && record.contentSha256 === null) {
      ctx.addIssue({
        code: "custom",
        path: ["contentSha256"],
        message: "Accepted reserve evidence requires a content hash",
      });
    }
    if (
      record.admissionCode === "reserve.admission.rejected-sidecar-mismatch" &&
      record.sidecarMaterializationSha256 === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sidecarMaterializationSha256"],
        message: "Sidecar mismatch rejection requires the observed materialization hash",
      });
    }
    if (
      record.fallbackCode === "reserve.fallback.reviewed-sidecar" &&
      record.sidecarMaterializationSha256 === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sidecarMaterializationSha256"],
        message: "Reviewed-sidecar fallback requires its materialization hash",
      });
    }

    const serialized = stableJsonStringifyV1(record);
    if (SECRET_BEARING_TEXT_PATTERNS.some((pattern) => pattern.test(serialized))) {
      ctx.addIssue({
        code: "custom",
        message: "Evidence journal identifiers must not contain URLs, credentials, or secret-bearing text",
      });
    }
    if (new TextEncoder().encode(serialized).byteLength > REPORT_CARD_EVIDENCE_JOURNAL_ENTRY_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `Evidence journal entry exceeds ${REPORT_CARD_EVIDENCE_JOURNAL_ENTRY_MAX_BYTES} bytes`,
      });
    }
  });

export type ReportCardEvidenceJournalV1Payload = z.infer<
  typeof ReportCardEvidenceJournalV1PayloadSchema
>;

export function computeReportCardEvidenceJournalIdV1(
  payload: ReportCardEvidenceJournalV1Payload,
): string {
  return `report-card-evidence:v1:${sha256Hex(
    stableJsonStringifyV1({
      domain: "report-card.evidence-journal.v1",
      payload,
    }),
  )}`;
}

export const ReportCardEvidenceJournalV1Schema = ReportCardEvidenceJournalV1PayloadSchema.extend({
  journalId: JournalIdSchema,
})
  .strict()
  .superRefine((record, ctx) => {
    const { journalId, ...payload } = record;
    if (journalId !== computeReportCardEvidenceJournalIdV1(payload)) {
      ctx.addIssue({
        code: "custom",
        path: ["journalId"],
        message: "Evidence journal ID does not match its canonical payload",
      });
    }
  });

export type ReportCardEvidenceJournalV1 = z.infer<typeof ReportCardEvidenceJournalV1Schema>;

export function createReportCardEvidenceJournalV1(
  value: ReportCardEvidenceJournalV1Payload,
): ReportCardEvidenceJournalV1 {
  const payload = ReportCardEvidenceJournalV1PayloadSchema.parse(value);
  return ReportCardEvidenceJournalV1Schema.parse({
    ...payload,
    journalId: computeReportCardEvidenceJournalIdV1(payload),
  });
}

function compareJournalRecords(
  left: ReportCardEvidenceJournalV1,
  right: ReportCardEvidenceJournalV1,
): number {
  return (
    left.attemptedAtSec - right.attemptedAtSec ||
    left.completedAtSec - right.completedAtSec ||
    left.attemptId.localeCompare(right.attemptId) ||
    left.journalId.localeCompare(right.journalId)
  );
}

export const ReportCardEvidenceJournalByIdV1Schema = z
  .record(z.string(), z.array(ReportCardEvidenceJournalV1Schema))
  .superRefine((journalById, ctx) => {
    const entries = Object.entries(journalById);
    if (entries.length > REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS) {
      ctx.addIssue({
        code: "custom",
        message: `Evidence journal covers more than ${REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS} assets`,
      });
    }
    for (const [assetId, records] of entries) {
      if (!AssetIdSchema.safeParse(assetId).success) {
        ctx.addIssue({ code: "custom", path: [assetId], message: "Invalid evidence journal asset ID" });
      }
      if (records.length > REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET) {
        ctx.addIssue({
          code: "custom",
          path: [assetId],
          message:
            `Evidence journal retains at most ` +
            `${REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET} entries per asset`,
        });
      }
      const attemptIds = new Set<string>();
      for (const [index, record] of records.entries()) {
        if (record.assetId !== assetId) {
          ctx.addIssue({
            code: "custom",
            path: [assetId, index, "assetId"],
            message: "Evidence journal record asset does not match its map key",
          });
        }
        if (attemptIds.has(record.attemptId)) {
          ctx.addIssue({
            code: "custom",
            path: [assetId, index, "attemptId"],
            message: "Evidence journal contains a duplicate reserve attempt",
          });
        }
        attemptIds.add(record.attemptId);
      }
    }
    if (
      new TextEncoder().encode(stableJsonStringifyV1(journalById)).byteLength >
      REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          `Fixed-input evidence journal exceeds ` +
          `${REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_BYTES} bytes`,
      });
    }
  })
  .transform((journalById) =>
    Object.fromEntries(
      Object.entries(journalById)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([assetId, records]) => [assetId, [...records].sort(compareJournalRecords)]),
    ),
  );

export type ReportCardEvidenceJournalByIdV1 = z.infer<
  typeof ReportCardEvidenceJournalByIdV1Schema
>;
