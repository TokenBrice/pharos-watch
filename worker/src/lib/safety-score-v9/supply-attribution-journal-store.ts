import {
  SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET,
  SupplyAttributionJournalByIdV1Schema,
  SupplyAttributionJournalV1Schema,
  type SupplyAttributionJournalByIdV1,
  type SupplyAttributionJournalV1,
} from "@shared/lib/safety-score-v9-supply-attribution-journal";
import {
  BOUNDED_JOURNAL_MAX_ROWS_PER_ASSET,
  BOUNDED_JOURNAL_RETENTION_SEC,
  appendBoundedJournal,
  loadBoundedJournal,
  type AppendableBoundedJournalStoreConfig,
} from "../bounded-journal-store";

export const SUPPLY_ATTRIBUTION_JOURNAL_STORE_MAX_ROWS_PER_ASSET =
  BOUNDED_JOURNAL_MAX_ROWS_PER_ASSET;
export const SUPPLY_ATTRIBUTION_JOURNAL_STORE_RETENTION_SEC =
  BOUNDED_JOURNAL_RETENTION_SEC;

const config: AppendableBoundedJournalStoreConfig<
  SupplyAttributionJournalV1,
  SupplyAttributionJournalByIdV1
> = {
  table: "safety_score_v9_supply_attribution_journal",
  lane: "supply-attribution",
  label: "Supply attribution journal",
  maxAssets: SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  maxEntriesPerAsset: SUPPLY_ATTRIBUTION_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET,
  parseRecord: (value) => SupplyAttributionJournalV1Schema.parse(value),
  parseProjection: (value) => SupplyAttributionJournalByIdV1Schema.parse(value),
  validateRecord: (record) => {
    if (
      record.admissionCode !== "supply-attribution.admission.accepted" &&
      record.rejectionCode === undefined
    ) {
      throw new Error("New rejected supply attribution journal records require an exact leaf code");
    }
  },
  insert: (db, record, payloadJson, payloadBytes, nowSec) =>
    db.prepare(
      `INSERT INTO safety_score_v9_supply_attribution_journal (
         journal_id, schema_version, lane, asset_id, attempt_id, attempted_at,
         completed_at, source_id, admission_code, fallback_code, payload_json,
         payload_bytes, recorded_at
       ) VALUES (?, 1, 'supply-attribution', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(journal_id) DO NOTHING`,
    ).bind(
      record.journalId,
      record.assetId,
      record.attemptId,
      record.attemptedAtSec,
      record.completedAtSec,
      record.sourceId,
      record.admissionCode,
      record.fallbackCode,
      payloadJson,
      payloadBytes,
      nowSec,
    ),
};

export async function appendSupplyAttributionJournalV1(
  db: D1Database,
  records: readonly SupplyAttributionJournalV1[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<{ accepted: number; assets: number }> {
  return appendBoundedJournal(config, db, records, nowSec, signal);
}

export async function loadSupplyAttributionJournalByIdV1(
  db: D1Database,
  assetIds: readonly string[],
  asOfSec: number,
  signal?: AbortSignal,
): Promise<SupplyAttributionJournalByIdV1> {
  return loadBoundedJournal(config, db, assetIds, asOfSec, signal);
}
