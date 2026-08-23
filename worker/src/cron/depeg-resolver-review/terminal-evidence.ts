import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import type { DdrrActualEventInput } from "@shared/lib/depeg-resolver-review";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isRecord, numberValue, stringValue } from "@shared/lib/type-guards";
import { abortIf } from "../depeg-resolver/utils";
import { buildInClause, chunkArray } from "../../lib/db";
import { throwIfAborted } from "../../lib/abort";
import { toErrorMessage } from "../../lib/error-utils";
import { tryParseJson } from "../../lib/json-parse";
import { logWorkerEvent } from "../../lib/structured-log";

const DDRR_TAPE_TERMINAL_EVIDENCE_CACHE_KEY = "depeg-resolver-review:terminal-evidence:v1";

interface ActualEventDbRow {
  id: number;
  stablecoin_id: string;
  started_at: number;
  ended_at: number | null;
  recovery_price: number | null;
  close_reason: string | null;
}

interface TapeTerminalEvidenceRow {
  coin_id: string | null;
  type: string;
  ts: number | null;
  payload_json: string | null;
}

interface TerminalEvidence {
  terminalEvidenceAt: number | null;
  terminalEvidenceInterval: { start: number; end: number } | null;
  terminalEvidencePrecision: "day" | "month" | "unknown" | null;
  terminalEvidenceSourceDate: string | null;
}

interface TapeTerminalEvidenceCacheToken {
  rowCount: number;
  maxTs: number | null;
  maxId: number | null;
}

interface TapeTerminalEvidenceCachePayload {
  version: 1;
  token: TapeTerminalEvidenceCacheToken;
  checkedStablecoinIds: string[];
  evidenceByStablecoinId: Record<string, TerminalEvidence>;
}

export interface DdrrActualEventWithTerminalEvidence extends DdrrActualEventInput {
  terminalEvidenceSourceDate: string | null;
}

function payloadStringValue(value: unknown): string | null {
  return stringValue(value, { trim: false });
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function utcSec(year: number, monthIndex: number, day: number): number {
  return Math.floor(Date.UTC(year, monthIndex, day) / 1000);
}

function dateIntervalFromSourceDate(sourceDate: string | null | undefined): TerminalEvidence | null {
  if (!sourceDate) return null;

  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sourceDate);
  if (dayMatch) {
    const year = Number(dayMatch[1]);
    const month = Number(dayMatch[2]);
    const day = Number(dayMatch[3]);
    const start = utcSec(year, month - 1, day);
    const check = new Date(start * 1000);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      return null;
    }
    return {
      terminalEvidenceAt: start,
      terminalEvidenceInterval: { start, end: start + 86_400 },
      terminalEvidencePrecision: "day",
      terminalEvidenceSourceDate: sourceDate,
    };
  }

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(sourceDate);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (!Number.isInteger(year) || year < 1 || !Number.isInteger(month) || month < 1 || month > 12) return null;
    const start = utcSec(year, month - 1, 1);
    const end = utcSec(year, month, 1);
    return {
      terminalEvidenceAt: start,
      terminalEvidenceInterval: { start, end },
      terminalEvidencePrecision: "month",
      terminalEvidenceSourceDate: sourceDate,
    };
  }

  return null;
}

function exactTerminalEvidenceFromTapeTs(tsMs: number | null | undefined): TerminalEvidence | null {
  if (typeof tsMs !== "number" || !Number.isFinite(tsMs) || tsMs < 0) return null;
  return {
    terminalEvidenceAt: Math.floor(tsMs / 1000),
    terminalEvidenceInterval: null,
    terminalEvidencePrecision: "unknown",
    terminalEvidenceSourceDate: null,
  };
}

const CEMETERY_BY_ID = new Map(CEMETERY_ENTRIES.map((entry) => [entry.id, entry]));

function registryTerminalEvidence(stablecoinId: string): TerminalEvidence | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (meta?.status === "frozen") {
    const frozenEvidence = dateIntervalFromSourceDate(meta.frozenAt);
    if (frozenEvidence) return frozenEvidence;
  }

  if (meta && isTerminalStablecoinStatus(meta.status)) {
    const obituaryEvidence = dateIntervalFromSourceDate(meta.obituary?.deathDate);
    if (obituaryEvidence) return obituaryEvidence;
  }

  const cemetery = CEMETERY_BY_ID.get(stablecoinId);
  return dateIntervalFromSourceDate(cemetery?.deathDate);
}

function tapeTerminalEvidence(row: TapeTerminalEvidenceRow): TerminalEvidence | null {
  const payload = recordValue(tryParseJson(row.payload_json));
  if (row.type === "lifecycle.tracked.frozen") {
    return dateIntervalFromSourceDate(payloadStringValue(payload.frozenAt)) ?? exactTerminalEvidenceFromTapeTs(row.ts);
  }
  if (row.type === "cemetery.entry.added") {
    return dateIntervalFromSourceDate(payloadStringValue(payload.deathDate)) ?? exactTerminalEvidenceFromTapeTs(row.ts);
  }
  return null;
}

function nullableNonnegativeInteger(value: unknown): number | null {
  const parsed = numberValue(value);
  if (parsed == null || !Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function terminalEvidencePrecisionValue(value: unknown): TerminalEvidence["terminalEvidencePrecision"] {
  return value === "day" || value === "month" || value === "unknown" ? value : null;
}

function terminalEvidenceIntervalValue(value: unknown): TerminalEvidence["terminalEvidenceInterval"] {
  if (value == null) return null;
  const interval = isRecord(value) ? value : null;
  const start = nullableNonnegativeInteger(interval?.start);
  const end = nullableNonnegativeInteger(interval?.end);
  if (start == null || end == null || end < start) return null;
  return { start, end };
}

function terminalEvidenceValue(value: unknown): TerminalEvidence | null {
  const record = isRecord(value) ? value : null;
  if (!record) return null;
  const terminalEvidenceAt = nullableNonnegativeInteger(record.terminalEvidenceAt);
  const terminalEvidenceInterval = terminalEvidenceIntervalValue(record.terminalEvidenceInterval);
  const terminalEvidencePrecision = terminalEvidencePrecisionValue(record.terminalEvidencePrecision);
  const terminalEvidenceSourceDate = stringValue(record.terminalEvidenceSourceDate);
  return {
    terminalEvidenceAt,
    terminalEvidenceInterval,
    terminalEvidencePrecision,
    terminalEvidenceSourceDate,
  };
}

function tapeTerminalEvidenceCachePayload(value: unknown): TapeTerminalEvidenceCachePayload | null {
  const payload = isRecord(value) ? value : null;
  const token = isRecord(payload?.token) ? payload.token : null;
  const rowCount = nullableNonnegativeInteger(token?.rowCount);
  if (!payload || payload.version !== 1 || rowCount == null) return null;
  const checkedStablecoinIds = arrayValue(payload.checkedStablecoinIds)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const evidenceRecord = isRecord(payload.evidenceByStablecoinId) ? payload.evidenceByStablecoinId : {};
  const evidenceByStablecoinId: Record<string, TerminalEvidence> = {};
  for (const [stablecoinId, evidence] of Object.entries(evidenceRecord)) {
    const parsed = terminalEvidenceValue(evidence);
    if (parsed) evidenceByStablecoinId[stablecoinId] = parsed;
  }
  return {
    version: 1,
    token: {
      rowCount,
      maxTs: nullableNonnegativeInteger(token?.maxTs),
      maxId: nullableNonnegativeInteger(token?.maxId),
    },
    checkedStablecoinIds,
    evidenceByStablecoinId,
  };
}

function sameTapeTerminalEvidenceToken(
  left: TapeTerminalEvidenceCacheToken,
  right: TapeTerminalEvidenceCacheToken,
): boolean {
  return left.rowCount === right.rowCount && left.maxTs === right.maxTs && left.maxId === right.maxId;
}

async function loadTapeTerminalEvidenceToken(
  db: D1Database,
  signal?: AbortSignal,
): Promise<TapeTerminalEvidenceCacheToken | null> {
  abortIf(signal, "compute-depeg-resolver-review");
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) as row_count, MAX(ts) as max_ts, MAX(id) as max_id
         FROM tape_events
         WHERE type IN ('lifecycle.tracked.frozen', 'cemetery.entry.added')`,
      )
      .first<{ row_count: number | null; max_ts: number | null; max_id: number | null }>();
    abortIf(signal, "compute-depeg-resolver-review");
    const rowCount = nullableNonnegativeInteger(row?.row_count);
    if (rowCount == null) return null;
    return {
      rowCount,
      maxTs: nullableNonnegativeInteger(row?.max_ts),
      maxId: nullableNonnegativeInteger(row?.max_id),
    };
  } catch (err) {
    const message = toErrorMessage(err);
    if (message.includes("no such table")) return null;
    logWorkerEvent({
      scope: "lib",
      level: "error",
      job: "compute-depeg-resolver-review",
      event: "tape_terminal_evidence_token_failed",
      source: "tape_events",
      message: "Failed to load tape terminal evidence cache token",
      error: err,
    });
    throw err;
  }
}

async function readTapeTerminalEvidenceCache(
  db: D1Database,
  token: TapeTerminalEvidenceCacheToken,
  signal?: AbortSignal,
): Promise<TapeTerminalEvidenceCachePayload | null> {
  abortIf(signal, "compute-depeg-resolver-review");
  try {
    const row = await db
      .prepare("SELECT value FROM cache WHERE key = ?")
      .bind(DDRR_TAPE_TERMINAL_EVIDENCE_CACHE_KEY)
      .first<{ value: string | null }>();
    abortIf(signal, "compute-depeg-resolver-review");
    const payload = tapeTerminalEvidenceCachePayload(tryParseJson(row?.value));
    if (!payload || !sameTapeTerminalEvidenceToken(payload.token, token)) return null;
    return payload;
  } catch (err) {
    const message = toErrorMessage(err);
    if (message.includes("no such table")) return null;
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      job: "compute-depeg-resolver-review",
      event: "tape_terminal_evidence_cache_read_failed",
      source: "cache",
      message: "Failed to read tape terminal evidence cache",
      error: err,
    });
    return null;
  }
}

async function writeTapeTerminalEvidenceCache(
  db: D1Database,
  token: TapeTerminalEvidenceCacheToken,
  checkedStablecoinIds: Set<string>,
  evidenceByStablecoinId: Map<string, TerminalEvidence>,
  signal?: AbortSignal,
): Promise<void> {
  abortIf(signal, "compute-depeg-resolver-review");
  const payload: TapeTerminalEvidenceCachePayload = {
    version: 1,
    token,
    checkedStablecoinIds: [...checkedStablecoinIds].sort(),
    evidenceByStablecoinId: Object.fromEntries(
      [...evidenceByStablecoinId.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  try {
    await db
      .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(DDRR_TAPE_TERMINAL_EVIDENCE_CACHE_KEY, JSON.stringify(payload), Math.floor(Date.now() / 1000))
      .run();
    abortIf(signal, "compute-depeg-resolver-review");
  } catch (err) {
    const message = toErrorMessage(err);
    if (message.includes("no such table")) return;
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      job: "compute-depeg-resolver-review",
      event: "tape_terminal_evidence_cache_write_failed",
      source: "cache",
      message: "Failed to write tape terminal evidence cache",
      error: err,
    });
  }
}

async function queryTapeTerminalEvidenceByStablecoinId(
  db: D1Database,
  stablecoinIdsInput: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, TerminalEvidence>> {
  const stablecoinIds = [...new Set(stablecoinIdsInput)];
  const evidenceByStablecoinId = new Map<string, TerminalEvidence>();

  for (const ids of chunkArray(stablecoinIds)) {
    throwIfAborted(signal);
    if (ids.length === 0) continue;
    const inClause = buildInClause(ids);
    try {
      const result = await db
        .prepare(
          `SELECT coin_id, type, ts, payload_json
           FROM tape_events
           WHERE coin_id IN (${inClause.sql})
             AND type IN ('lifecycle.tracked.frozen', 'cemetery.entry.added')
           ORDER BY ts ASC, id ASC`,
        )
        .bind(...inClause.binds)
        .all<TapeTerminalEvidenceRow>();

      abortIf(signal, "compute-depeg-resolver-review");
      for (const row of result.results ?? []) {
        if (!row.coin_id || evidenceByStablecoinId.has(row.coin_id)) continue;
        const evidence = tapeTerminalEvidence(row);
        if (evidence) evidenceByStablecoinId.set(row.coin_id, evidence);
      }
    } catch (err) {
      // Older local/test databases may not have tape_events. Registry and
      // cemetery metadata remain the authoritative terminal evidence sources.
      const message = toErrorMessage(err);
      if (message.includes("no such table")) continue;
      // Any other failure (transient D1 overload, malformed query, binding
      // fault) would silently drop terminal evidence and misclassify incidents
      // as non-terminal - surface it instead of failing open.
      logWorkerEvent({
        scope: "lib",
        level: "error",
        job: "compute-depeg-resolver-review",
        event: "tape_terminal_evidence_query_failed",
        source: "tape_events",
        message: "Failed to load tape terminal evidence",
        error: err,
      });
      throw err;
    }
  }

  return evidenceByStablecoinId;
}

async function loadTapeTerminalEvidenceByStablecoinId(
  db: D1Database,
  stablecoinIdsInput: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, TerminalEvidence>> {
  const stablecoinIds = [...new Set(stablecoinIdsInput)];
  if (stablecoinIds.length === 0) return new Map();

  abortIf(signal, "compute-depeg-resolver-review");
  const token = await loadTapeTerminalEvidenceToken(db, signal);
  abortIf(signal, "compute-depeg-resolver-review");
  if (!token) return queryTapeTerminalEvidenceByStablecoinId(db, stablecoinIds, signal);

  const cached = await readTapeTerminalEvidenceCache(db, token, signal);
  abortIf(signal, "compute-depeg-resolver-review");
  const checkedStablecoinIds = new Set(cached?.checkedStablecoinIds ?? []);
  const evidenceByStablecoinId = new Map<string, TerminalEvidence>(
    cached ? Object.entries(cached.evidenceByStablecoinId) : [],
  );
  const missingIds = stablecoinIds.filter((stablecoinId) => !checkedStablecoinIds.has(stablecoinId));
  if (missingIds.length === 0) {
    return new Map(stablecoinIds.flatMap((stablecoinId) => {
      const evidence = evidenceByStablecoinId.get(stablecoinId);
      return evidence ? [[stablecoinId, evidence] as const] : [];
    }));
  }

  const loadedEvidence = await queryTapeTerminalEvidenceByStablecoinId(db, missingIds, signal);
  abortIf(signal, "compute-depeg-resolver-review");
  for (const stablecoinId of missingIds) checkedStablecoinIds.add(stablecoinId);
  for (const [stablecoinId, evidence] of loadedEvidence) evidenceByStablecoinId.set(stablecoinId, evidence);
  await writeTapeTerminalEvidenceCache(db, token, checkedStablecoinIds, evidenceByStablecoinId, signal);
  abortIf(signal, "compute-depeg-resolver-review");
  return new Map(stablecoinIds.flatMap((stablecoinId) => {
    const evidence = evidenceByStablecoinId.get(stablecoinId);
    return evidence ? [[stablecoinId, evidence] as const] : [];
  }));
}

const EMPTY_TERMINAL_EVIDENCE: TerminalEvidence = {
  terminalEvidenceAt: null,
  terminalEvidenceInterval: null,
  terminalEvidencePrecision: null,
  terminalEvidenceSourceDate: null,
};

export async function loadActualEventsByEventIds(
  db: D1Database,
  eventIdsInput: readonly number[],
  signal?: AbortSignal,
): Promise<Map<number, DdrrActualEventWithTerminalEvidence>> {
  const eventIds = [...new Set(eventIdsInput)];
  const actualEventsById = new Map<number, DdrrActualEventWithTerminalEvidence>();
  const sourceRows: ActualEventDbRow[] = [];

  for (const ids of chunkArray(eventIds)) {
    throwIfAborted(signal);
    if (ids.length === 0) continue;
    const inClause = buildInClause(ids);
    const result = await db
      .prepare(
        `SELECT id, stablecoin_id, started_at, ended_at, recovery_price, close_reason
         FROM depeg_events
         WHERE id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<ActualEventDbRow>();

    abortIf(signal, "compute-depeg-resolver-review");
    for (const row of result.results ?? []) {
      sourceRows.push(row);
    }
  }

  const registryEvidenceByStablecoinId = new Map<string, TerminalEvidence>();
  const idsNeedingTapeEvidence: string[] = [];
  for (const row of sourceRows) {
    const registryEvidence = registryTerminalEvidence(row.stablecoin_id);
    if (registryEvidence) registryEvidenceByStablecoinId.set(row.stablecoin_id, registryEvidence);
    else idsNeedingTapeEvidence.push(row.stablecoin_id);
  }
  abortIf(signal, "compute-depeg-resolver-review");
  const tapeEvidenceByStablecoinId = await loadTapeTerminalEvidenceByStablecoinId(db, idsNeedingTapeEvidence, signal);
  abortIf(signal, "compute-depeg-resolver-review");

  for (const row of sourceRows) {
    const meta = TRACKED_META_BY_ID.get(row.stablecoin_id);
    const rawEvidence = registryEvidenceByStablecoinId.get(row.stablecoin_id)
      ?? tapeEvidenceByStablecoinId.get(row.stablecoin_id)
      ?? null;
    // Keep terminalEvidenceAt anchored to the interval start. The eligibility
    // comparison below is the single place that decides whether interval
    // evidence is relevant to a prediction lock. (audit Q-169)
    const terminalEvidence = rawEvidence ?? EMPTY_TERMINAL_EVIDENCE;
    const terminalObserved = isTerminalStablecoinStatus(meta?.status) || rawEvidence != null;
    actualEventsById.set(row.id, {
      eventId: row.id,
      currentEventId: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      recoveryPrice: row.recovery_price,
      closeReason: row.close_reason,
      stablecoinStatus: meta?.status ?? null,
      terminalObserved,
      terminalEvidenceAt: terminalEvidence.terminalEvidenceAt,
      terminalEvidenceInterval: terminalEvidence.terminalEvidenceInterval,
      terminalEvidencePrecision: terminalEvidence.terminalEvidencePrecision,
      terminalEvidenceSourceDate: terminalEvidence.terminalEvidenceSourceDate,
    });
  }

  return actualEventsById;
}
