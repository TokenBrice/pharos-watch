import {
  hasTerminalEvidence,
  reviewDepegResolverAssessments,
  reviewDdrrV2Rows,
  summarizeDdrrRows,
  type DdrrV2CoverageInput,
  type DdrrV2InvalidatedPredictionInput,
} from "@shared/lib/depeg-resolver-review";
import {
  DDR_PREDICTION_POLICY_VERSION,
  DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
  DDR_V2_EFFECTIVE_AT,
} from "@shared/lib/depeg-resolver-version";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isRecord, numberValue, stringValue } from "@shared/lib/type-guards";
import type { DdrOfficialLockOutcome, DdrPredictionErratum } from "@shared/types/depeg-resolver";
import {
  DDRR_PUBLIC_WARNING,
  DDRR_REVIEWER_VERSION,
  DdrrAssessmentSchema,
  type DdrrActualEvent,
  type DdrrAssessment,
  type DdrrResponse,
  type DdrrSummary,
} from "@shared/types/depeg-resolver-review";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { CronResult } from "../lib/cron-logger";
import { buildInClause, chunkArray } from "../lib/db";
import { buildDdrMethodologyEnvelope } from "../lib/depeg-resolver-methodology";
import { toErrorMessage } from "../lib/error-utils";
import { throwIfAborted } from "../lib/abort";
import { tryParseJson } from "../lib/json-parse";
import { logWorkerEvent } from "../lib/structured-log";
import { writeDepegResolverReviewSnapshot } from "../lib/depeg-resolver-review-snapshot-cache";
import type {
  DdrCanonicalIncident,
  DdrFirstPublicationMembership,
  DdrSealedPublicPrediction,
  DdrV2StoreContracts,
} from "./depeg-resolver-v2-contracts";
import { normalizeErratumRecord } from "./depeg-resolver/public-projection";
import { firstPublicationByPredictionId, publicPredictionIdOf } from "./depeg-resolver/storage-adapters";
import { abortIf } from "./depeg-resolver/utils";
import { DDRR_ASSESSMENT_ROW_CAP, loadAssessments } from "./depeg-resolver-review/assessment-loader";

const DDRR_SNAPSHOT_TTL_SEC = API_FRESHNESS_MAX_AGE_SEC.depegResolverReview;
const DDRR_V2_INCIDENT_ROW_CAP = 20_000;
const DDRR_PUBLIC_ROW_CAP = 100;
const DDRR_TAPE_TERMINAL_EVIDENCE_CACHE_KEY = "depeg-resolver-review:terminal-evidence:v1";

export interface DdrrV2ReviewSource {
  incidents: DdrCanonicalIncident[];
  firstPublication: DdrFirstPublicationMembership[];
  sealedPublicPredictions: DdrSealedPublicPrediction[];
  errata: Array<Record<string, unknown>>;
  nowSec: number;
  incidentRowLimit: number;
  incidentRowsTruncated: boolean;
}

export interface ComputeDepegResolverReviewOptions {
  storeContracts?: DdrV2StoreContracts | null;
  v2ReviewBuilder?: ((source: DdrrV2ReviewSource, signal?: AbortSignal) => Promise<DdrrResponse>) | null;
}

interface ActualEventDbRow {
  id: number;
  stablecoin_id: string;
  started_at: number;
  ended_at: number | null;
  recovery_price: number | null;
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

interface DdrrActualEventWithTerminalEvidence extends DdrrActualEvent {
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

export function buildEmptyDdrrSummary(): DdrrSummary {
  return summarizeDdrrRows([]);
}

function buildDdrrResponseEnvelope(input: {
  nowSec: number;
  summary: DdrrSummary;
  rows: DdrrResponse["rows"];
  assessedEventCount: number;
  assessmentRowsTruncated: boolean;
  incidentRowLimit?: number;
  incidentRowsTruncated?: boolean;
  methodologyVersions: string[];
  degradedReasons?: string[];
}): DdrrResponse {
  const publicRows = input.rows.slice(0, DDRR_PUBLIC_ROW_CAP);
  const publicRowsTruncated = input.rows.length > publicRows.length;
  const degradedReasons = input.degradedReasons ?? [];

  return {
    _meta: {
      computedAt: input.nowSec,
      expiresAt: input.nowSec + DDRR_SNAPSHOT_TTL_SEC,
      degraded: degradedReasons.length > 0,
      degradedReason: degradedReasons.length > 0 ? degradedReasons.join(",") : null,
      reviewerVersion: DDRR_REVIEWER_VERSION,
      publicWarning: DDRR_PUBLIC_WARNING,
      assessedEventCount: input.assessedEventCount,
      reviewedEventCount: input.rows.length,
      pendingEventCount:
        input.summary.headline.pendingLockCount +
        input.summary.headline.lockDeferredCount +
        input.summary.headline.publicationRetryPendingCount,
      durationScoredCount: input.summary.headline.durationScoredCount,
      verdictScoredCount: input.summary.headline.recoveryLikelihoodScoredCount,
      assessmentRowLimit: DDRR_ASSESSMENT_ROW_CAP,
      assessmentRowsTruncated: input.assessmentRowsTruncated,
      incidentRowLimit: input.incidentRowLimit ?? DDRR_V2_INCIDENT_ROW_CAP,
      incidentRowsTruncated: input.incidentRowsTruncated ?? false,
      publicRowLimit: DDRR_PUBLIC_ROW_CAP,
      publicRowsTruncated,
      methodologyVersions: input.methodologyVersions,
    },
    summary: input.summary,
    rows: publicRows,
    methodology: buildDdrMethodologyEnvelope(input.nowSec),
  };
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
    evidenceByStablecoinId: Object.fromEntries([...evidenceByStablecoinId.entries()].sort(([left], [right]) => left.localeCompare(right))),
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
      // as non-terminal — surface it instead of failing open.
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

async function loadActualEventsByEventIds(
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
        `SELECT id, stablecoin_id, started_at, ended_at, recovery_price
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

function latestErrataByPredictionId(
  rows: readonly Record<string, unknown>[],
): Map<number, { latest: DdrPredictionErratum; history: DdrPredictionErratum[] }> {
  const out = new Map<number, { latest: DdrPredictionErratum; history: DdrPredictionErratum[] }>();
  for (const row of rows) {
    const erratum = normalizeErratumRecord(row);
    if (!erratum) continue;
    const publicPredictionId = erratum.publicPredictionId;
    const current = out.get(publicPredictionId);
    const history = [...(current?.history ?? []), erratum].sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
    out.set(publicPredictionId, { latest: history[0], history });
  }
  return out;
}

function baseFieldsForIncident(incident: DdrCanonicalIncident, payload: Record<string, unknown>) {
  const meta = TRACKED_META_BY_ID.get(incident.stablecoinId);
  return {
    eventId: incident.eventId,
    currentEventId: incident.currentEventId,
    incidentKey: incident.incidentKey,
    stablecoinId: incident.stablecoinId,
    symbol: payloadStringValue(payload.symbol) ?? meta?.symbol ?? incident.stablecoinId,
    name: payloadStringValue(payload.name) ?? meta?.name ?? payloadStringValue(payload.symbol) ?? incident.stablecoinId,
    pegCurrency: payloadStringValue(payload.pegCurrency) ?? incident.pegCurrency,
    governance: payloadStringValue(payload.governance) ?? meta?.flags.governance ?? "unknown",
    direction: incident.direction,
    startedAt: incident.startedAt,
    eligibleAt: incident.eligibleAt,
  };
}

function coverageEligibilityAt(incident: DdrCanonicalIncident): number {
  if (incident.rolloutActiveAtEnablement === true) {
    return Math.max(incident.eligibleAt, DDR_V2_EFFECTIVE_AT);
  }
  return incident.eligibleAt;
}

function sealedExposureStartedAt(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  payload: Record<string, unknown>,
): number {
  const payloadStartedAt = numberValue(payload.startedAt);
  if (
    payloadStartedAt != null &&
    Number.isInteger(payloadStartedAt) &&
    payloadStartedAt >= 0 &&
    payloadStartedAt <= sealed.lockedAt
  ) {
    return payloadStartedAt;
  }

  const inferredStartedAt = sealed.lockedAt - sealed.eventAgeAtLockSec;
  if (Number.isInteger(inferredStartedAt) && inferredStartedAt >= 0 && inferredStartedAt <= sealed.lockedAt) {
    return inferredStartedAt;
  }

  return Math.min(incident.startedAt, sealed.lockedAt);
}

function baseFieldsForSealedExposure(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  payload: Record<string, unknown>,
) {
  return {
    ...baseFieldsForIncident(incident, payload),
    eventId: incident.currentEventId,
    currentEventId: incident.currentEventId,
    startedAt: sealedExposureStartedAt(sealed, incident, payload),
    eligibleAt: sealed.eligibleAt,
  };
}

function assessmentFromPrediction(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  publication: DdrFirstPublicationMembership,
): DdrrAssessment | null {
  const payload = recordValue(sealed.sealedPayload);
  const frozen = recordValue(payload.frozen);
  const resolution = recordValue(frozen.resolution);
  const duration = recordValue(frozen.duration);
  const iqr = arrayValue(duration.iqrSec);
  const parsed = DdrrAssessmentSchema.safeParse({
    ...baseFieldsForSealedExposure(sealed, incident, payload),
    publicPredictionId: publicPredictionIdOf(sealed),
    assessmentId: sealed.assessmentId,
    lockedAt: sealed.lockedAt,
    publishedAt: publication.publishedAt,
    publicationSnapshotToken: publication.snapshotToken,
    assessedAt: sealed.lockedAt,
    eventAgeSec: sealed.eventAgeAtLockSec,
    checkpoint: "public_prediction",
    methodologyVersion: sealed.predictionMethodologyVersion,
    predictionMethodologyVersion: sealed.predictionMethodologyVersion,
    predictionPolicyVersion: sealed.predictionPolicyVersion,
    resolutionTier: resolution.tier,
    durationSuppressed: duration.suppressed === true,
    durationSuppressedReason: payloadStringValue(duration.suppressedReason),
    predictedRemainingSec: numberValue(duration.medianSec),
    iqrRemainingSec: iqr.length === 2 && typeof iqr[0] === "number" && typeof iqr[1] === "number" ? [iqr[0], iqr[1]] : null,
    horizonCells: arrayValue(duration.horizons),
    stratum: payloadStringValue(duration.stratum),
    factors: arrayValue(resolution.factors),
  });
  return parsed.success ? parsed.data : null;
}

function assessmentFromNoCall(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  publication: DdrFirstPublicationMembership,
): DdrrAssessment | null {
  const payload = recordValue(sealed.sealedPayload);
  const noCall = recordValue(payload.noCall);
  const missingReasons = arrayValue(noCall.missingReasons).filter((entry): entry is string => typeof entry === "string");
  const parsed = DdrrAssessmentSchema.safeParse({
    ...baseFieldsForSealedExposure(sealed, incident, payload),
    publicPredictionId: publicPredictionIdOf(sealed),
    assessmentId: sealed.assessmentId,
    lockedAt: sealed.lockedAt,
    publishedAt: publication.publishedAt,
    publicationSnapshotToken: publication.snapshotToken,
    assessedAt: sealed.lockedAt,
    eventAgeSec: sealed.eventAgeAtLockSec,
    checkpoint: "public_prediction",
    methodologyVersion: sealed.predictionMethodologyVersion,
    predictionMethodologyVersion: sealed.predictionMethodologyVersion,
    predictionPolicyVersion: sealed.predictionPolicyVersion,
    resolutionTier: "insufficient_signal",
    durationSuppressed: true,
    durationSuppressedReason: missingReasons[0] ?? "insufficient_signal",
    predictedRemainingSec: null,
    iqrRemainingSec: null,
    horizonCells: [],
    stratum: null,
    factors: [],
  });
  return parsed.success ? parsed.data : null;
}

function sourceEventState(actual: DdrrActualEvent | null): DdrrV2CoverageInput["sourceEventState"] {
  if (!actual) return "missing";
  if (hasTerminalEvidence(actual)) return "terminal";
  if (actual.endedAt != null && actual.recoveryPrice != null) return "recovered";
  if (actual.endedAt != null) return "orphan_closed";
  return "active";
}

function terminalEvidenceAtForEligibility(
  actual: DdrrActualEvent | null,
  eligibleAt: number,
): number | null {
  if (!actual) return null;
  const interval = actual.terminalEvidenceInterval ?? null;
  if (interval) {
    if (interval.end <= eligibleAt) return interval.start;
    if (interval.start >= eligibleAt) return interval.start;
    return null;
  }
  return actual.terminalEvidenceAt ?? null;
}

function hasTerminalBeforeEligibility(actual: DdrrActualEvent | null, eligibleAt: number): boolean {
  const evidenceAt = terminalEvidenceAtForEligibility(actual, eligibleAt);
  return evidenceAt != null && evidenceAt < eligibleAt;
}

function hasTerminalStatusOrEvidence(actual: DdrrActualEvent | null): boolean {
  return actual != null && hasTerminalEvidence(actual);
}

function terminalEvidenceSourceDate(actual: DdrrActualEvent | null): string | null {
  if (!actual || !("terminalEvidenceSourceDate" in actual)) return null;
  const value = actual.terminalEvidenceSourceDate;
  return typeof value === "string" ? value : null;
}

function coverageStateForIncident(
  incident: DdrCanonicalIncident,
  actual: DdrrActualEvent | null,
  nowSec: number,
): Pick<DdrrV2CoverageInput, "predictionState" | "coverageCause" | "operationalCoverageCause" | "outcomeQualityState" | "reason"> {
  const reviewEligibleAt = coverageEligibilityAt(incident);
  if (actual == null) {
    return {
      predictionState: "data_quality_gap",
      coverageCause: "data_quality_gap",
      operationalCoverageCause: null,
      outcomeQualityState: "data_quality_gap",
      reason: "source_event_missing",
    };
  }
  if (actual.endedAt != null && actual.recoveryPrice != null && actual.endedAt < reviewEligibleAt) {
    return {
      predictionState: "resolved_before_prediction",
      coverageCause: "pre_lock_recovered",
      operationalCoverageCause: null,
      outcomeQualityState: "classified",
      reason: null,
    };
  }
  if (hasTerminalStatusOrEvidence(actual) && hasTerminalBeforeEligibility(actual, reviewEligibleAt)) {
    return {
      predictionState: "terminal_before_prediction",
      coverageCause: "pre_lock_terminal",
      operationalCoverageCause: null,
      outcomeQualityState: "classified",
      reason: null,
    };
  }
  if (nowSec < reviewEligibleAt) {
    return {
      predictionState: "pending_lock",
      coverageCause: "active_pending_lock",
      operationalCoverageCause: null,
      outcomeQualityState: null,
      reason: null,
    };
  }
  if (actual.endedAt != null && actual.recoveryPrice != null) {
    return {
      predictionState: "missed_lock_recovered",
      coverageCause: "lock_missed",
      operationalCoverageCause: "lock_missed",
      outcomeQualityState: "classified",
      reason: "eligible_incident_closed_without_public_prediction",
    };
  }
  if (actual.endedAt != null) {
    return {
      predictionState: "orphan_closed",
      coverageCause: "orphan_closed",
      operationalCoverageCause: null,
      outcomeQualityState: "orphan_closed",
      reason: "closed_without_recovery_or_terminal_evidence",
    };
  }
  if (hasTerminalStatusOrEvidence(actual)) {
    return {
      predictionState: "missed_lock_terminal",
      coverageCause: "lock_missed",
      operationalCoverageCause: "lock_missed",
      outcomeQualityState: "classified",
      reason: "eligible_terminal_incident_without_public_prediction",
    };
  }
  if (incident.lockState?.lastState === "lock_deferred") {
    return {
      predictionState: "lock_deferred",
      coverageCause: "active_lock_deferred",
      operationalCoverageCause: "system_deferral",
      outcomeQualityState: null,
      reason: incident.lockState.lastDeferralReason,
    };
  }
  return {
    predictionState: "lock_deferred",
    coverageCause: "cron_gap",
    operationalCoverageCause: "cron_gap",
    outcomeQualityState: null,
    reason: "eligible_active_incident_without_public_prediction",
  };
}

function coverageRowForIncident(
  incident: DdrCanonicalIncident,
  actual: DdrrActualEvent | null,
  nowSec: number,
): DdrrV2CoverageInput {
  const state = coverageStateForIncident(incident, actual, nowSec);
  const terminalEvidenceAt = terminalEvidenceAtForEligibility(actual, coverageEligibilityAt(incident));
  return {
    ...baseFieldsForIncident(incident, {}),
    sourceEventState: sourceEventState(actual),
    terminalEvidenceAt,
    terminalEvidenceInterval: actual?.terminalEvidenceInterval ?? null,
    terminalEvidencePrecision: actual?.terminalEvidencePrecision ?? null,
    actualEndedAt: actual?.endedAt ?? null,
    terminalEvidenceSourceDate: terminalEvidenceSourceDate(actual),
    failedPublication: null,
    ...state,
  };
}

function failedPublicationCoverageRow(
  sealed: DdrSealedPublicPrediction,
  incident: DdrCanonicalIncident,
  actual: DdrrActualEvent | null,
): DdrrV2CoverageInput {
  const publicationFailed = actual != null && (
    actual.endedAt != null ||
    hasTerminalStatusOrEvidence(actual)
  );
  const predictionState = publicationFailed ? "publication_failed" : "publication_retry_pending";
  return {
    ...baseFieldsForIncident(incident, recordValue(sealed.sealedPayload)),
    eligibleAt: sealed.eligibleAt,
    sourceEventState: sourceEventState(actual),
    terminalEvidenceAt: actual?.terminalEvidenceAt ?? null,
    terminalEvidenceInterval: actual?.terminalEvidenceInterval ?? null,
    terminalEvidencePrecision: actual?.terminalEvidencePrecision ?? null,
    predictionState,
    actualEndedAt: actual?.endedAt ?? null,
    terminalEvidenceSourceDate: terminalEvidenceSourceDate(actual),
    coverageCause: predictionState,
    operationalCoverageCause: predictionState,
    outcomeQualityState: publicationFailed ? "classified" : null,
    reason: publicationFailed
      ? "sealed_prediction_closed_before_first_publication_manifest"
      : "sealed_prediction_not_in_first_publication_manifest",
    failedPublication: {
      publicPredictionId: publicPredictionIdOf(sealed),
      assessmentId: sealed.assessmentId,
      lockedAt: sealed.lockedAt,
      outcomeKind: sealed.outcomeKind,
      rowHash: sealed.rowHash,
      sealedPayloadRedacted: true,
      lastAttemptedAt: sealed.lockedAt,
    },
  };
}

function buildEffectiveIncidentByKey(incidents: readonly DdrCanonicalIncident[]): Map<string, DdrCanonicalIncident> {
  const byKey = new Map(incidents.map((incident) => [incident.incidentKey, incident]));
  const effective = new Map(byKey);

  for (const alias of incidents) {
    if (alias.incidentState !== "superseded" || !alias.supersededByIncidentKey) continue;
    const canonical = byKey.get(alias.supersededByIncidentKey);
    if (!canonical || canonical.incidentState === "superseded") continue;
    const existing = effective.get(canonical.incidentKey) ?? canonical;
    if (alias.startedAt <= existing.startedAt && alias.currentEventId <= existing.currentEventId) continue;
    effective.set(canonical.incidentKey, {
      ...canonical,
      eventId: alias.currentEventId,
      currentEventId: alias.currentEventId,
    });
  }

  return effective;
}

async function buildDurableDdrV2ReviewSnapshot(
  db: D1Database,
  source: DdrrV2ReviewSource,
  signal?: AbortSignal,
): Promise<DdrrResponse> {
  abortIf(signal, "compute-depeg-resolver-review");
  const incidentsByKey = new Map(source.incidents.map((incident) => [incident.incidentKey, incident]));
  const effectiveIncidentByKey = buildEffectiveIncidentByKey(source.incidents);
  const firstPublication = firstPublicationByPredictionId(source.firstPublication);
  const errataByPredictionId = latestErrataByPredictionId(source.errata);
  const actualEventsById = await loadActualEventsByEventIds(db, [
    ...[...effectiveIncidentByKey.values()].map((incident) => incident.currentEventId),
    ...source.sealedPublicPredictions.map((prediction) => prediction.eventId),
  ], signal);
  abortIf(signal, "compute-depeg-resolver-review");

  const assessments: DdrrAssessment[] = [];
  const noCalls: DdrrAssessment[] = [];
  const coverageRows: DdrrV2CoverageInput[] = [];
  const invalidatedPredictions: DdrrV2InvalidatedPredictionInput[] = [];
  const sealedIncidentKeys = new Set<string>();

  for (const sealed of source.sealedPublicPredictions) {
    abortIf(signal, "compute-depeg-resolver-review");
    const incident = effectiveIncidentByKey.get(sealed.incidentKey) ?? incidentsByKey.get(sealed.incidentKey);
    if (!incident) continue;
    sealedIncidentKeys.add(incident.incidentKey);
    const publicPredictionId = publicPredictionIdOf(sealed);
    const publication = firstPublication.get(publicPredictionId) ?? null;
    const actual = actualEventsById.get(incident.currentEventId) ?? actualEventsById.get(sealed.eventId) ?? null;
    const errata = errataByPredictionId.get(publicPredictionId);

    if (publication == null) {
      coverageRows.push(failedPublicationCoverageRow(sealed, incident, actual));
      continue;
    }

    if (errata) {
      const payload = recordValue(sealed.sealedPayload);
      const originalOutcome = (sealed.outcomeKind === "no_call" ? payload.noCall : payload.frozen) as DdrOfficialLockOutcome | undefined;
      if (originalOutcome) {
        invalidatedPredictions.push({
          ...baseFieldsForSealedExposure(sealed, incident, payload),
          sourceEventState: "invalidated",
          terminalEvidenceAt: actual?.terminalEvidenceAt ?? null,
          terminalEvidenceInterval: actual?.terminalEvidenceInterval ?? null,
          terminalEvidencePrecision: actual?.terminalEvidencePrecision ?? null,
          publicPredictionId,
          assessmentId: sealed.assessmentId,
          predictionMethodologyVersion: sealed.predictionMethodologyVersion,
          predictionPolicyVersion: sealed.predictionPolicyVersion,
          lockedAt: sealed.lockedAt,
          publishedAt: publication.publishedAt,
          publicationSnapshotToken: publication.snapshotToken,
          originalKind: sealed.outcomeKind,
          originalOutcome,
          latestErratum: errata.latest,
          errataCount: errata.history.length,
          errataHistory: errata.history,
        });
      }
      continue;
    }

    const assessment = sealed.outcomeKind === "no_call"
      ? assessmentFromNoCall(sealed, incident, publication)
      : assessmentFromPrediction(sealed, incident, publication);
    if (!assessment) {
      coverageRows.push({
        ...failedPublicationCoverageRow(sealed, incident, actual),
        predictionState: "data_quality_gap",
        coverageCause: "data_quality_gap",
        operationalCoverageCause: null,
        outcomeQualityState: "data_quality_gap",
        reason: "sealed_payload_parse_failed",
        failedPublication: null,
      });
      continue;
    }
    if (sealed.outcomeKind === "no_call") noCalls.push(assessment);
    else assessments.push(assessment);
  }

  for (const incident of source.incidents) {
    abortIf(signal, "compute-depeg-resolver-review");
    if (incident.incidentState === "superseded") continue;
    if (sealedIncidentKeys.has(incident.incidentKey)) continue;
    const effectiveIncident = effectiveIncidentByKey.get(incident.incidentKey) ?? incident;
    coverageRows.push(coverageRowForIncident(
      effectiveIncident,
      actualEventsById.get(effectiveIncident.currentEventId) ?? null,
      source.nowSec,
    ));
  }

  const { rows, summary } = reviewDdrrV2Rows({
    assessments,
    noCalls,
    coverageRows,
    invalidatedPredictions,
    actualEventsById,
    nowSec: source.nowSec,
  });
  const methodologyVersions = [...new Set(source.sealedPublicPredictions.map((prediction) => prediction.predictionMethodologyVersion))].sort();

  return buildDdrrResponseEnvelope({
    nowSec: source.nowSec,
    summary,
    rows,
    assessedEventCount: source.incidents.length,
    assessmentRowsTruncated: false,
    incidentRowLimit: source.incidentRowLimit,
    incidentRowsTruncated: source.incidentRowsTruncated,
    methodologyVersions,
    degradedReasons: source.incidentRowsTruncated ? ["incident-row-cap"] : [],
  });
}

async function maybeBuildDdrV2ReviewSnapshot(
  db: D1Database,
  nowSec: number,
  signal: AbortSignal | undefined,
  options: ComputeDepegResolverReviewOptions | undefined,
): Promise<DdrrResponse | null> {
  const stores = options?.storeContracts;
  const builder = options?.v2ReviewBuilder;
  if (!stores || !stores.loadCanonicalIncidents) return null;

  abortIf(signal, "compute-depeg-resolver-review");
  const loadedIncidents = await stores.loadCanonicalIncidents(db, {
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    policyUniverseIncluded: true,
    includeSuperseded: true,
    policyDelaySec: DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
    limit: DDRR_V2_INCIDENT_ROW_CAP + 1,
  });
  abortIf(signal, "compute-depeg-resolver-review");
  const incidentRowsTruncated = loadedIncidents.length > DDRR_V2_INCIDENT_ROW_CAP;
  const incidents = loadedIncidents.slice(0, DDRR_V2_INCIDENT_ROW_CAP);
  const incidentKeys = incidents.map((incident) => incident.incidentKey);
  const sealedPublicPredictions = await stores.loadSealedPublicPredictions(db, {
    incidentKeys,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    includeUnpublished: true,
  });
  abortIf(signal, "compute-depeg-resolver-review");
  const firstPublication = await stores.loadFirstPublicationMembership(db, {
    incidentKeys,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
  });
  abortIf(signal, "compute-depeg-resolver-review");
  const errata = stores.loadPredictionErrata
    ? await stores.loadPredictionErrata(db, {
        incidentKeys,
        publicPredictionIds: sealedPublicPredictions.map((prediction) => prediction.publicPredictionId ?? prediction.id),
      })
    : [];
  abortIf(signal, "compute-depeg-resolver-review");

  const source: DdrrV2ReviewSource = {
    incidents,
    firstPublication,
    sealedPublicPredictions,
    errata,
    nowSec,
    incidentRowLimit: DDRR_V2_INCIDENT_ROW_CAP,
    incidentRowsTruncated,
  };

  return builder ? builder(source, signal) : buildDurableDdrV2ReviewSnapshot(db, source, signal);
}

export async function buildDepegResolverReviewSnapshot(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
  signal?: AbortSignal,
  options?: ComputeDepegResolverReviewOptions,
): Promise<DdrrResponse> {
  abortIf(signal, "compute-depeg-resolver-review");
  const v2Snapshot = await maybeBuildDdrV2ReviewSnapshot(db, nowSec, signal, options);
  abortIf(signal, "compute-depeg-resolver-review");
  if (v2Snapshot) return v2Snapshot;

  const { assessments, parseIssueCount, truncated: assessmentRowsTruncated } = await loadAssessments(db);
  abortIf(signal, "compute-depeg-resolver-review");

  const actualEventsById = await loadActualEventsByEventIds(db, assessments.map((assessment) => assessment.eventId), signal);
  abortIf(signal, "compute-depeg-resolver-review");

  const { rows, summary } = assessments.length
    ? reviewDepegResolverAssessments({ assessments, actualEventsById, nowSec })
    : { rows: [], summary: buildEmptyDdrrSummary() };
  const methodologyVersions = [...new Set(assessments.map((assessment) => assessment.methodologyVersion))].sort();
  const degradedReasons = [
    parseIssueCount > 0 ? `assessment-parse-issues:${parseIssueCount}` : null,
    assessmentRowsTruncated ? "assessment-row-cap" : null,
  ].filter((reason): reason is string => reason != null);

  return buildDdrrResponseEnvelope({
    nowSec,
    summary,
    rows,
    assessedEventCount: new Set(assessments.map((assessment) => assessment.eventId)).size,
    assessmentRowsTruncated,
    methodologyVersions,
    degradedReasons,
  });
}

export async function computeAndStoreDepegResolverReview(
  db: D1Database,
  signal?: AbortSignal,
  options?: ComputeDepegResolverReviewOptions,
): Promise<CronResult> {
  const snapshot = await buildDepegResolverReviewSnapshot(db, Math.floor(Date.now() / 1000), signal, options);
  await writeDepegResolverReviewSnapshot(db, snapshot);

  return {
    itemCount: snapshot._meta.reviewedEventCount,
    metadata: JSON.stringify({
      assessedEvents: snapshot._meta.assessedEventCount,
      reviewedRows: snapshot._meta.reviewedEventCount,
      publicRows: snapshot.rows.length,
      verdictScored: snapshot.summary.headline.recoveryLikelihoodScoredCount,
      durationScored: snapshot.summary.headline.durationScoredCount,
      degraded: snapshot._meta.degraded,
      degradedReason: snapshot._meta.degradedReason,
      assessmentRowsTruncated: snapshot._meta.assessmentRowsTruncated,
      incidentRowsTruncated: snapshot._meta.incidentRowsTruncated,
      publicRowsTruncated: snapshot._meta.publicRowsTruncated,
    }),
  };
}
