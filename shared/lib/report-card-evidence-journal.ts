import { z } from "zod";
import { Sha256Schema } from "../types/safety-schema-primitives";
import { RESERVE_EVIDENCE_SOURCE_ORIGIN_CLASSES } from "../types/report-card-evidence-journal";
import {
  ContentAddressedJournalAssetIdSchema,
  ContentAddressedJournalSafeIdentifierSchema,
  createContentAddressedJournal,
} from "./content-addressed-journal";

export type { ReserveEvidenceSourceOriginClass } from "../types/report-card-evidence-journal";

const REPORT_CARD_EVIDENCE_JOURNAL_ENTRY_MAX_BYTES = 1_024;
const REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_BYTES = 384 * 1_024;
export const REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET = 2;
export const REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS = 512;

const JournalIdSchema = z.string().regex(/^report-card-evidence:v1:[a-f0-9]{64}$/);

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

export const ReserveEvidenceSourceOriginClassSchema = z.enum(
  RESERVE_EVIDENCE_SOURCE_ORIGIN_CLASSES,
);

const ReportCardEvidenceJournalSourceBlockV1Schema = z
  .object({
    chainId: ContentAddressedJournalSafeIdentifierSchema,
    blockNumber: z.number().int().nonnegative(),
    blockHash: z.string().regex(/^(?:0x)?[a-f0-9]{64}$/),
  })
  .strict();

const ReportCardEvidenceJournalV1PayloadDomainSchema = z
  .object({
    schemaVersion: z.literal(1),
    lane: z.literal("reserve"),
    assetId: ContentAddressedJournalAssetIdSchema,
    attemptId: ContentAddressedJournalSafeIdentifierSchema,
    sourceId: ContentAddressedJournalSafeIdentifierSchema,
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
  });

const reportCardEvidenceJournal = createContentAddressedJournal({
  payloadSchema: ReportCardEvidenceJournalV1PayloadDomainSchema,
  journalIdSchema: JournalIdSchema,
  idPrefix: "report-card-evidence:v1:",
  domain: "report-card.evidence-journal.v1",
  entryMaxBytes: REPORT_CARD_EVIDENCE_JOURNAL_ENTRY_MAX_BYTES,
  aggregateMaxBytes: REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_BYTES,
  maxAssets: REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  maxEntriesPerAsset: REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET,
  secretBearingTextPatternExtensions: [
    /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/,
  ],
  messages: {
    secretBearingText: "Evidence journal identifiers must not contain URLs, credentials, or secret-bearing text",
    entryTooLarge: `Evidence journal entry exceeds ${REPORT_CARD_EVIDENCE_JOURNAL_ENTRY_MAX_BYTES} bytes`,
    tooManyAssets: `Evidence journal covers more than ${REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS} assets`,
    invalidAssetId: "Invalid evidence journal asset ID",
    tooManyEntriesPerAsset:
      `Evidence journal retains at most ` +
      `${REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET} entries per asset`,
    assetMismatch: "Evidence journal record asset does not match its map key",
    duplicateAttempt: "Evidence journal contains a duplicate reserve attempt",
    aggregateTooLarge:
      `Fixed-input evidence journal exceeds ` +
      `${REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_BYTES} bytes`,
    journalIdMismatch: "Evidence journal ID does not match its canonical payload",
  },
});

export type ReportCardEvidenceJournalV1Payload = z.infer<
  typeof reportCardEvidenceJournal.payloadSchema
>;

export const ReportCardEvidenceJournalV1Schema =
  reportCardEvidenceJournal.recordSchema;

export type ReportCardEvidenceJournalV1 = z.infer<typeof ReportCardEvidenceJournalV1Schema>;

export function createReportCardEvidenceJournalV1(
  value: ReportCardEvidenceJournalV1Payload,
): ReportCardEvidenceJournalV1 {
  return reportCardEvidenceJournal.create(value);
}

export const ReportCardEvidenceJournalByIdV1Schema =
  reportCardEvidenceJournal.journalByIdSchema;

export type ReportCardEvidenceJournalByIdV1 = z.infer<
  typeof ReportCardEvidenceJournalByIdV1Schema
>;
