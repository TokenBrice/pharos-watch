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

export const REPORT_CARD_EVIDENCE_JOURNAL_STORE_RETENTION_SEC =
  BOUNDED_JOURNAL_RETENTION_SEC;

const config: BoundedJournalStoreConfig<
  ReportCardEvidenceJournalV1,
  ReportCardEvidenceJournalByIdV1
> = {
  table: "report_card_evidence_journal",
  lane: "reserve",
  label: "Evidence journal",
  maxAssets: REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  maxEntriesPerAsset: REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET,
  parseRecord: (value) => ReportCardEvidenceJournalV1Schema.parse(value),
  parseProjection: (value) => ReportCardEvidenceJournalByIdV1Schema.parse(value),
};

export async function loadReportCardEvidenceJournalByIdV1(
  db: D1Database,
  assetIds: readonly string[],
  asOfSec: number,
  signal?: AbortSignal,
): Promise<ReportCardEvidenceJournalByIdV1> {
  return loadBoundedJournal(config, db, assetIds, asOfSec, signal);
}
