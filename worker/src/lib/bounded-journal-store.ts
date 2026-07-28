import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { throwIfAborted } from "./abort";
import { parseJson } from "./json-parse";

const MAX_BATCH_RECORDS = 48;
const MAX_BATCH_BYTES = 64 * 1_024;
const MAX_RECORD_BYTES = 1_280;
const D1_BIND_CHUNK_SIZE = 80;

export const BOUNDED_JOURNAL_MAX_ROWS_PER_ASSET = 32;
export const BOUNDED_JOURNAL_RETENTION_SEC = 45 * 24 * 60 * 60;

interface JournalRecord {
  journalId: string;
  lane: string;
  assetId: string;
  attemptId: string;
  completedAtSec: number;
}

interface StoredJournalRow {
  payload_json: string;
}

interface JournalStoreMessages {
  invalidStoreTimestamp: string;
  invalidReadTimestamp: string;
  batchRecords: (limit: number) => string;
  inactiveWrite: (assetId: string) => string;
  futureRecord: (journalId: string) => string;
  recordBytes: (journalId: string, limit: number) => string;
  duplicateJournal: (journalId: string) => string;
  duplicateAttempt: (attemptKey: string) => string;
  batchBytes: (limit: number) => string;
  duplicateReadAssets: string;
  readAssets: (limit: number) => string;
  inactiveRead: (assetId: string) => string;
  malformedStoredJson: (message: string) => string;
}

export interface BoundedJournalStoreConfig<TRecord extends JournalRecord, TProjection> {
  table: string;
  lane: string;
  maxAssets: number;
  maxEntriesPerAsset: number;
  parseRecord: (value: unknown) => TRecord;
  parseProjection: (value: Record<string, TRecord[]>) => TProjection;
  insert: (
    db: D1Database,
    record: TRecord,
    payloadJson: string,
    payloadBytes: number,
    nowSec: number,
  ) => D1PreparedStatement;
  validateRecord?: (record: TRecord) => void;
  messages: JournalStoreMessages;
}

function serializedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function canonicalRecords<TRecord extends JournalRecord, TProjection>(
  config: BoundedJournalStoreConfig<TRecord, TProjection>,
  records: readonly TRecord[],
  nowSec: number,
): Array<{ record: TRecord; payloadJson: string; payloadBytes: number }> {
  const { messages } = config;
  if (!Number.isInteger(nowSec) || nowSec < 0) throw new Error(messages.invalidStoreTimestamp);
  if (records.length > MAX_BATCH_RECORDS) throw new Error(messages.batchRecords(MAX_BATCH_RECORDS));

  const canonical = records.map((value) => {
    const record = config.parseRecord(value);
    config.validateRecord?.(record);
    if (!ACTIVE_IDS.has(record.assetId)) throw new Error(messages.inactiveWrite(record.assetId));
    if (record.completedAtSec > nowSec) throw new Error(messages.futureRecord(record.journalId));
    const payloadJson = stableJsonStringifyV1(record);
    const payloadBytes = serializedBytes(payloadJson);
    if (payloadBytes > MAX_RECORD_BYTES) {
      throw new Error(messages.recordBytes(record.journalId, MAX_RECORD_BYTES));
    }
    return { record, payloadJson, payloadBytes };
  }).sort((left, right) => left.record.journalId.localeCompare(right.record.journalId));

  const journalIds = new Set<string>();
  const attemptKeys = new Set<string>();
  for (const { record } of canonical) {
    if (journalIds.has(record.journalId)) throw new Error(messages.duplicateJournal(record.journalId));
    journalIds.add(record.journalId);
    const attemptKey = `${record.lane}:${record.assetId}:${record.attemptId}`;
    if (attemptKeys.has(attemptKey)) throw new Error(messages.duplicateAttempt(attemptKey));
    attemptKeys.add(attemptKey);
  }
  if (canonical.reduce((sum, entry) => sum + entry.payloadBytes, 0) > MAX_BATCH_BYTES) {
    throw new Error(messages.batchBytes(MAX_BATCH_BYTES));
  }
  return canonical;
}

export async function appendBoundedJournal<TRecord extends JournalRecord, TProjection>(
  config: BoundedJournalStoreConfig<TRecord, TProjection>,
  db: D1Database,
  records: readonly TRecord[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<{ accepted: number; assets: number }> {
  throwIfAborted(signal);
  const canonical = canonicalRecords(config, records, nowSec);
  if (canonical.length === 0) return { accepted: 0, assets: 0 };

  const assetIds = [...new Set(canonical.map(({ record }) => record.assetId))].sort();
  const statements = canonical.map(({ record, payloadJson, payloadBytes }) =>
    config.insert(db, record, payloadJson, payloadBytes, nowSec)
  );
  statements.push(
    db.prepare(`DELETE FROM ${config.table} WHERE recorded_at < ?`)
      .bind(Math.max(0, nowSec - BOUNDED_JOURNAL_RETENTION_SEC)),
  );
  for (const assetId of assetIds) {
    statements.push(
      db.prepare(
        `DELETE FROM ${config.table}
          WHERE journal_id IN (
            SELECT journal_id
              FROM ${config.table}
             WHERE lane = ? AND asset_id = ?
             ORDER BY completed_at DESC, attempt_id DESC, journal_id DESC
             LIMIT -1 OFFSET ?
          )`,
      ).bind(config.lane, assetId, BOUNDED_JOURNAL_MAX_ROWS_PER_ASSET),
    );
  }
  await db.batch(statements);
  throwIfAborted(signal);
  return { accepted: canonical.length, assets: assetIds.length };
}

export async function loadBoundedJournal<TRecord extends JournalRecord, TProjection>(
  config: BoundedJournalStoreConfig<TRecord, TProjection>,
  db: D1Database,
  assetIds: readonly string[],
  asOfSec: number,
  signal?: AbortSignal,
): Promise<TProjection> {
  const { messages } = config;
  throwIfAborted(signal);
  if (!Number.isInteger(asOfSec) || asOfSec < 0) throw new Error(messages.invalidReadTimestamp);
  const canonicalAssetIds = [...new Set(assetIds)].sort();
  if (canonicalAssetIds.length !== assetIds.length) throw new Error(messages.duplicateReadAssets);
  if (canonicalAssetIds.length > config.maxAssets) throw new Error(messages.readAssets(config.maxAssets));
  for (const assetId of canonicalAssetIds) {
    if (!ACTIVE_IDS.has(assetId)) throw new Error(messages.inactiveRead(assetId));
  }

  const recordsById: Record<string, TRecord[]> = {};
  for (const assetChunk of chunks(canonicalAssetIds, D1_BIND_CHUNK_SIZE)) {
    if (assetChunk.length === 0) continue;
    const placeholders = assetChunk.map(() => "?").join(", ");
    const rows = await db.prepare(
      `SELECT payload_json
         FROM (
           SELECT payload_json, asset_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY asset_id
                    ORDER BY completed_at DESC, attempt_id DESC, journal_id DESC
                  ) AS row_rank
             FROM ${config.table}
            WHERE lane = ?
              AND completed_at <= ?
              AND recorded_at >= ?
              AND asset_id IN (${placeholders})
         )
        WHERE row_rank <= ?
        ORDER BY asset_id ASC, row_rank DESC`,
    ).bind(
      config.lane,
      asOfSec,
      Math.max(0, asOfSec - BOUNDED_JOURNAL_RETENTION_SEC),
      ...assetChunk,
      config.maxEntriesPerAsset,
    ).all<StoredJournalRow>();
    throwIfAborted(signal);
    for (const row of rows.results ?? []) {
      const parsed = parseJson(row.payload_json);
      if (!parsed.ok) throw new Error(messages.malformedStoredJson(parsed.message));
      const record = config.parseRecord(parsed.value);
      (recordsById[record.assetId] ??= []).push(record);
    }
  }
  return config.parseProjection(recordsById);
}
