import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS,
  REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET,
  ReportCardEvidenceJournalByIdV1Schema,
  ReportCardEvidenceJournalV1Schema,
  type ReportCardEvidenceJournalByIdV1,
  type ReportCardEvidenceJournalV1,
} from "@shared/lib/report-card-evidence-journal";
import { throwIfAborted } from "./abort";
import { parseJson } from "./json-parse";

const REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_BATCH_RECORDS = 48;
const REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_BATCH_BYTES = 64 * 1_024;
const REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_RECORD_BYTES = 1_280;
export const REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_ROWS_PER_ASSET = 32;
export const REPORT_CARD_EVIDENCE_JOURNAL_STORE_RETENTION_SEC = 45 * 24 * 60 * 60;

const D1_BIND_CHUNK_SIZE = 80;

interface StoredJournalRow {
  payload_json: string;
}

function serializedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalRecords(
  records: readonly ReportCardEvidenceJournalV1[],
  nowSec: number,
): Array<{ record: ReportCardEvidenceJournalV1; payloadJson: string; payloadBytes: number }> {
  if (!Number.isInteger(nowSec) || nowSec < 0) {
    throw new Error("Evidence journal store timestamp must be a non-negative integer");
  }
  if (records.length > REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_BATCH_RECORDS) {
    throw new Error(
      `Evidence journal batch exceeds ${REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_BATCH_RECORDS} records`,
    );
  }
  const canonical = records
    .map((value) => {
      const record = ReportCardEvidenceJournalV1Schema.parse(value);
      if (!ACTIVE_IDS.has(record.assetId)) {
        throw new Error(`Evidence journal store rejects inactive asset ${record.assetId}`);
      }
      if (record.completedAtSec > nowSec) {
        throw new Error(`Evidence journal store rejects future record ${record.journalId}`);
      }
      const payloadJson = stableJsonStringifyV1(record);
      const payloadBytes = serializedBytes(payloadJson);
      if (payloadBytes > REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_RECORD_BYTES) {
        throw new Error(
          `Evidence journal record ${record.journalId} exceeds ` +
            `${REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_RECORD_BYTES} bytes`,
        );
      }
      return { record, payloadJson, payloadBytes };
    })
    .sort((left, right) => left.record.journalId.localeCompare(right.record.journalId));

  const journalIds = new Set<string>();
  const attemptKeys = new Set<string>();
  for (const { record } of canonical) {
    if (journalIds.has(record.journalId)) {
      throw new Error(`Evidence journal batch duplicates record ${record.journalId}`);
    }
    journalIds.add(record.journalId);
    const attemptKey = `${record.lane}:${record.assetId}:${record.attemptId}`;
    if (attemptKeys.has(attemptKey)) {
      throw new Error(`Evidence journal batch duplicates reserve attempt ${attemptKey}`);
    }
    attemptKeys.add(attemptKey);
  }
  const totalBytes = canonical.reduce((sum, entry) => sum + entry.payloadBytes, 0);
  if (totalBytes > REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_BATCH_BYTES) {
    throw new Error(
      `Evidence journal batch exceeds ${REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_BATCH_BYTES} bytes`,
    );
  }
  return canonical;
}

export async function appendReportCardEvidenceJournalV1(
  db: D1Database,
  records: readonly ReportCardEvidenceJournalV1[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<{ accepted: number; assets: number }> {
  throwIfAborted(signal);
  const canonical = canonicalRecords(records, nowSec);
  if (canonical.length === 0) return { accepted: 0, assets: 0 };

  const assetIds = [...new Set(canonical.map(({ record }) => record.assetId))].sort();
  const retentionCutoff = Math.max(0, nowSec - REPORT_CARD_EVIDENCE_JOURNAL_STORE_RETENTION_SEC);
  const statements = canonical.map(({ record, payloadJson, payloadBytes }) =>
    db
      .prepare(
        `INSERT INTO report_card_evidence_journal (
           journal_id, schema_version, lane, asset_id, attempt_id, attempted_at,
           completed_at, source_id, attempt_code, admission_code, fallback_code,
           payload_json, payload_bytes, recorded_at
         ) VALUES (?, 1, 'reserve', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(journal_id) DO NOTHING`,
      )
      .bind(
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
  );
  statements.push(
    db
      .prepare("DELETE FROM report_card_evidence_journal WHERE recorded_at < ?")
      .bind(retentionCutoff),
  );
  for (const assetId of assetIds) {
    statements.push(
      db
        .prepare(
          `DELETE FROM report_card_evidence_journal
            WHERE journal_id IN (
              SELECT journal_id
                FROM report_card_evidence_journal
               WHERE lane = 'reserve' AND asset_id = ?
               ORDER BY completed_at DESC, attempt_id DESC, journal_id DESC
               LIMIT -1 OFFSET ?
            )`,
        )
        .bind(assetId, REPORT_CARD_EVIDENCE_JOURNAL_STORE_MAX_ROWS_PER_ASSET),
    );
  }
  await db.batch(statements);
  throwIfAborted(signal);
  return { accepted: canonical.length, assets: assetIds.length };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

export async function loadReportCardEvidenceJournalByIdV1(
  db: D1Database,
  assetIds: readonly string[],
  asOfSec: number,
  signal?: AbortSignal,
): Promise<ReportCardEvidenceJournalByIdV1> {
  throwIfAborted(signal);
  if (!Number.isInteger(asOfSec) || asOfSec < 0) {
    throw new Error("Evidence journal read timestamp must be a non-negative integer");
  }
  const canonicalAssetIds = [...new Set(assetIds)].sort();
  if (canonicalAssetIds.length !== assetIds.length) {
    throw new Error("Evidence journal read asset IDs contain duplicates");
  }
  if (canonicalAssetIds.length > REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS) {
    throw new Error(
      `Evidence journal read exceeds ${REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ASSETS} assets`,
    );
  }
  for (const assetId of canonicalAssetIds) {
    if (!ACTIVE_IDS.has(assetId)) {
      throw new Error(`Evidence journal read rejects inactive asset ${assetId}`);
    }
  }
  const retentionCutoff = Math.max(
    0,
    asOfSec - REPORT_CARD_EVIDENCE_JOURNAL_STORE_RETENTION_SEC,
  );

  const recordsById: Record<string, ReportCardEvidenceJournalV1[]> = {};
  for (const assetChunk of chunks(canonicalAssetIds, D1_BIND_CHUNK_SIZE)) {
    if (assetChunk.length === 0) continue;
    const placeholders = assetChunk.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT payload_json
           FROM (
             SELECT payload_json, asset_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY asset_id
                      ORDER BY completed_at DESC, attempt_id DESC, journal_id DESC
                    ) AS row_rank
              FROM report_card_evidence_journal
              WHERE lane = 'reserve'
                AND completed_at <= ?
                AND recorded_at >= ?
                AND asset_id IN (${placeholders})
           )
          WHERE row_rank <= ?
          ORDER BY asset_id ASC, row_rank DESC`,
      )
      .bind(
        asOfSec,
        retentionCutoff,
        ...assetChunk,
        REPORT_CARD_EVIDENCE_JOURNAL_FIXED_INPUT_MAX_ENTRIES_PER_ASSET,
      )
      .all<StoredJournalRow>();
    throwIfAborted(signal);
    for (const row of rows.results ?? []) {
      const parsed = parseJson(row.payload_json);
      if (!parsed.ok) {
        throw new Error(`Malformed stored report-card evidence journal JSON: ${parsed.message}`);
      }
      const record = ReportCardEvidenceJournalV1Schema.parse(parsed.value);
      (recordsById[record.assetId] ??= []).push(record);
    }
  }
  return ReportCardEvidenceJournalByIdV1Schema.parse(recordsById);
}
