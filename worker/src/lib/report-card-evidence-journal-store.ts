import {
  REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET,
  ReportCardEvidenceJournalByIdV1Schema,
  ReportCardEvidenceJournalV1Schema,
  type ReportCardEvidenceJournalByIdV1,
  type ReportCardEvidenceJournalV1,
} from "@shared/lib/report-card-evidence-journal";
import {
  BOUNDED_JOURNAL_MAX_ROWS_PER_ASSET,
  BOUNDED_JOURNAL_RETENTION_SEC,
  loadBoundedJournal,
  type BoundedJournalStoreConfig,
} from "./bounded-journal-store";

export const REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_ROWS_PER_ASSET =
  BOUNDED_JOURNAL_MAX_ROWS_PER_ASSET;
export const REPORT_CARD_EVIDENCE_JOURNAL_STORE_RETENTION_SEC =
  BOUNDED_JOURNAL_RETENTION_SEC;

const config: BoundedJournalStoreConfig<
  ReportCardEvidenceJournalV1,
  ReportCardEvidenceJournalByIdV1
> = {
  table: "report_card_evidence_journal",
  lane: "reserve",
  maxAssets: REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  maxEntriesPerAsset: REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET,
  parseRecord: (value) => ReportCardEvidenceJournalV1Schema.parse(value),
  parseProjection: (value) => ReportCardEvidenceJournalByIdV1Schema.parse(value),
  insert: (db, record, payloadJson, payloadBytes, nowSec) =>
    db.prepare(
      `INSERT INTO report_card_evidence_journal (
         journal_id, schema_version, lane, asset_id, attempt_id, attempted_at,
         completed_at, source_id, attempt_code, admission_code, fallback_code,
         payload_json, payload_bytes, recorded_at
       ) VALUES (?, 1, 'reserve', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(journal_id) DO NOTHING`,
    ).bind(
      record.journalId,
      record.assetId,
      record.attemptId,
      record.attemptedAtSec,
      record.completedAtSec,
      record.sourceId,
      record.attemptCode,
      record.admissionCode,
      record.fallbackCode,
      payloadJson,
      payloadBytes,
      nowSec,
    ),
  messages: {
    invalidStoreTimestamp: "Evidence journal store timestamp must be a non-negative integer",
    invalidReadTimestamp: "Evidence journal read timestamp must be a non-negative integer",
    batchRecords: (limit) => `Evidence journal batch exceeds ${limit} records`,
    inactiveWrite: (assetId) => `Evidence journal store rejects inactive asset ${assetId}`,
    futureRecord: (journalId) => `Evidence journal store rejects future record ${journalId}`,
    recordBytes: (journalId, limit) => `Evidence journal record ${journalId} exceeds ${limit} bytes`,
    duplicateJournal: (journalId) => `Evidence journal batch duplicates record ${journalId}`,
    duplicateAttempt: (key) => `Evidence journal batch duplicates reserve attempt ${key}`,
    batchBytes: (limit) => `Evidence journal batch exceeds ${limit} bytes`,
    duplicateReadAssets: "Evidence journal read asset IDs contain duplicates",
    readAssets: (limit) => `Evidence journal read exceeds ${limit} assets`,
    inactiveRead: (assetId) => `Evidence journal read rejects inactive asset ${assetId}`,
    malformedStoredJson: (message) => `Malformed stored report-card evidence journal JSON: ${message}`,
  },
};

export async function loadReportCardEvidenceJournalByIdV1(
  db: D1Database,
  assetIds: readonly string[],
  asOfSec: number,
  signal?: AbortSignal,
): Promise<ReportCardEvidenceJournalByIdV1> {
  return loadBoundedJournal(config, db, assetIds, asOfSec, signal);
}
