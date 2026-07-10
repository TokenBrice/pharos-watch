import { getCache, setCache } from "./db-cache";
import { decodeCachedJson } from "./cache-json";
import { isRecord } from "@shared/lib/type-guards";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { ReportCard } from "@shared/types/report-cards";
import type { ReportCardsInputFreshness } from "./report-cards-snapshot-inputs";
import type { ReportCardPublicationCompleteness } from "./report-card-publication";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";

export interface ReportCardScoreEntry {
  score: number;
  grade: string;
}

export interface ReportCardCachePayload {
  scores: Record<string, ReportCardScoreEntry>;
  updatedAt: number;
  methodologyVersion: string;
  publicationGenerationId?: string;
  completeness?: ReportCardPublicationCompleteness;
  degradedInputs?: ReportCardCacheInputStatus;
}

type ParsedReportCardCachePayload = Omit<ReportCardCachePayload, "methodologyVersion"> & {
  methodologyVersion?: string;
};

interface ParsedReportCardCacheEnvelope {
  generation: number;
  methodologyVersion: string;
  payload: ParsedReportCardCachePayload;
}

export interface ReportCardCacheInputStatus {
  inputsStale: boolean;
  liquidityStale: boolean;
  redemptionStale: boolean;
  staleInputs: string[];
}

export type ReportCardCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload"
  | "invalid-envelope"
  | "generation-mismatch"
  | "methodology-mismatch"
  | "completeness-missing"
  | "completeness-mismatch"
  | "stale-cache";

export type ReportCardCacheLoadResult =
  | { kind: "ok"; payload: ReportCardCachePayload; updatedAt: number }
  | { kind: "error"; reason: ReportCardCacheFailureReason; updatedAt: number | null };

export interface LoadReportCardCacheOptions {
  maxAgeMs?: number;
  requireCompleteness?: boolean;
}

export interface WriteReportCardCacheOptions {
  liquidityStale?: boolean;
  redemptionStale?: boolean;
  inputFreshness?: ReportCardsInputFreshness;
  completeness?: ReportCardPublicationCompleteness;
}

/** Shared max-age budget for report-card-dependent read paths. */
export const REPORT_CARD_CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const REPORT_CARD_CACHE_GENERATION = 1;
export const REPORT_CARD_CACHE_KEY = "report_card_cache";

function isValidCompleteness(value: unknown): value is ReportCardPublicationCompleteness {
  if (!isRecord(value)) return false;
  return typeof value.generationId === "string"
    && value.generationId.length > 0
    && typeof value.methodologyVersion === "string"
    && value.methodologyVersion.length > 0
    && typeof value.expectedCount === "number"
    && Number.isInteger(value.expectedCount)
    && value.expectedCount >= 0
    && typeof value.scoredCount === "number"
    && Number.isInteger(value.scoredCount)
    && value.scoredCount >= 0
    && typeof value.notRatedCount === "number"
    && Number.isInteger(value.notRatedCount)
    && value.notRatedCount >= 0
    && Array.isArray(value.notRatedIds)
    && value.notRatedIds.every((id) => typeof id === "string")
    && value.notRatedIds.length === value.notRatedCount
    && value.expectedCount === value.scoredCount + value.notRatedCount;
}

function isValidReportCardCachePayload(value: unknown): value is ParsedReportCardCachePayload {
  if (!isRecord(value)) return false;
  const parsed = value as {
    scores?: unknown;
    updatedAt?: unknown;
    methodologyVersion?: unknown;
    publicationGenerationId?: unknown;
    completeness?: unknown;
    degradedInputs?: unknown;
  };
  return parsed.scores != null
    && typeof parsed.scores === "object"
    && typeof parsed.updatedAt === "number"
    && Number.isFinite(parsed.updatedAt)
    && (
      parsed.methodologyVersion == null
      || (typeof parsed.methodologyVersion === "string" && parsed.methodologyVersion.length > 0)
    )
    && (
      parsed.publicationGenerationId == null
      || (typeof parsed.publicationGenerationId === "string" && parsed.publicationGenerationId.length > 0)
    )
    && (parsed.completeness == null || isValidCompleteness(parsed.completeness))
    && (
      parsed.completeness == null
      || parsed.publicationGenerationId === parsed.completeness.generationId
    )
    && (
      parsed.degradedInputs == null
      || isValidReportCardCacheInputStatus(parsed.degradedInputs)
    );
}

function isValidReportCardCacheInputStatus(value: unknown): value is ReportCardCacheInputStatus {
  if (!value || typeof value !== "object") return false;
  const parsed = value as {
    inputsStale?: unknown;
    liquidityStale?: unknown;
    redemptionStale?: unknown;
    staleInputs?: unknown;
  };
  return typeof parsed.inputsStale === "boolean"
    && typeof parsed.liquidityStale === "boolean"
    && typeof parsed.redemptionStale === "boolean"
    && Array.isArray(parsed.staleInputs)
    && parsed.staleInputs.every((entry) => typeof entry === "string");
}

function hasExactReportCardCacheCompleteness(payload: ReportCardCachePayload): boolean {
  const completeness = payload.completeness;
  if (!payload.publicationGenerationId || !completeness) return false;
  if (
    completeness.generationId !== payload.publicationGenerationId
    || completeness.generationId !== `report-cards:${payload.methodologyVersion}:${payload.updatedAt}`
    || completeness.methodologyVersion !== payload.methodologyVersion
    || completeness.expectedCount !== ACTIVE_IDS.size
  ) {
    return false;
  }

  const scoreIds = Object.keys(payload.scores);
  const notRatedIds = completeness.notRatedIds;
  const notRatedIdSet = new Set(notRatedIds);
  if (
    scoreIds.length !== completeness.scoredCount
    || notRatedIds.length !== completeness.notRatedCount
    || new Set(scoreIds).size !== scoreIds.length
    || notRatedIdSet.size !== notRatedIds.length
  ) {
    return false;
  }
  const publishedIds = new Set([...scoreIds, ...notRatedIds]);
  if (publishedIds.size !== ACTIVE_IDS.size) return false;
  for (const id of ACTIVE_IDS) {
    if (!publishedIds.has(id)) return false;
  }
  for (const [id, score] of Object.entries(payload.scores)) {
    if (
      notRatedIdSet.has(id)
      || typeof score.score !== "number"
      || !Number.isFinite(score.score)
      || typeof score.grade !== "string"
      || score.grade.length === 0
    ) {
      return false;
    }
  }
  return true;
}

function isReportCardCacheEnvelope(value: unknown): value is ParsedReportCardCacheEnvelope {
  if (!isRecord(value) || !("payload" in value)) return false;
  const parsed = value as {
    generation?: unknown;
    methodologyVersion?: unknown;
    payload?: unknown;
  };
  return typeof parsed.generation === "number"
    && Number.isInteger(parsed.generation)
    && typeof parsed.methodologyVersion === "string"
    && parsed.methodologyVersion.length > 0
    && isValidReportCardCachePayload(parsed.payload);
}

function normalizeReportCardCacheJson(
  parsed: unknown,
):
  | { ok: true; payload: ParsedReportCardCachePayload }
  | { ok: false; reason: ReportCardCacheFailureReason } {
  if (isRecord(parsed) && "payload" in parsed) {
    if (!isReportCardCacheEnvelope(parsed)) {
      return { ok: false, reason: "invalid-envelope" };
    }
    if (parsed.generation !== REPORT_CARD_CACHE_GENERATION) {
      return { ok: false, reason: "generation-mismatch" };
    }
    return {
      ok: true,
      payload: {
        ...parsed.payload,
        methodologyVersion: parsed.methodologyVersion,
      },
    };
  }

  return isValidReportCardCachePayload(parsed)
    ? { ok: true, payload: parsed }
    : { ok: false, reason: "invalid-payload" };
}

function buildReportCardCacheInputStatus(
  options: WriteReportCardCacheOptions = {},
): ReportCardCacheInputStatus {
  const liquidityStale = Boolean(
    options.liquidityStale
    || options.inputFreshness?.dexLiquidity.stale,
  );
  const redemptionStale = Boolean(
    options.redemptionStale
    || options.inputFreshness?.redemptionBackstops.stale,
  );
  const staleInputs = [
    ...(liquidityStale ? ["dexLiquidity"] : []),
    ...(redemptionStale ? ["redemptionBackstops"] : []),
  ];
  return {
    inputsStale: staleInputs.length > 0,
    liquidityStale,
    redemptionStale,
    staleInputs,
  };
}

export async function loadReportCardCache(
  db: D1Database,
  options: LoadReportCardCacheOptions = {},
): Promise<ReportCardCacheLoadResult> {
  const decoded = decodeCachedJson<ParsedReportCardCachePayload, ReportCardCacheFailureReason>(
    await getCache(db, REPORT_CARD_CACHE_KEY),
    {
      mode: "strict",
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: normalizeReportCardCacheJson,
    },
  );
  if (!decoded.ok) {
    return { kind: "error", reason: decoded.reason, updatedAt: decoded.updatedAt };
  }

  if (decoded.payload.methodologyVersion !== SAFETY_SCORE_METHODOLOGY_VERSION) {
    return { kind: "error", reason: "methodology-mismatch", updatedAt: decoded.payload.updatedAt };
  }
  const payload: ReportCardCachePayload = {
    ...decoded.payload,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
  };

  if (options.requireCompleteness) {
    if (!payload.publicationGenerationId || !payload.completeness) {
      return { kind: "error", reason: "completeness-missing", updatedAt: payload.updatedAt };
    }
    if (!hasExactReportCardCacheCompleteness(payload)) {
      return { kind: "error", reason: "completeness-mismatch", updatedAt: payload.updatedAt };
    }
  }

  if (options.maxAgeMs != null) {
    const ageMs = Date.now() - payload.updatedAt * 1000;
    if (ageMs > options.maxAgeMs) {
      return { kind: "error", reason: "stale-cache", updatedAt: payload.updatedAt };
    }
  }

  return { kind: "ok", payload, updatedAt: payload.updatedAt };
}

export async function writeReportCardCache(
  db: D1Database,
  cards: readonly ReportCard[],
  updatedAt: number,
  options: WriteReportCardCacheOptions = {},
): Promise<{ writtenCount: number }> {
  const entry = buildReportCardCacheEntry(cards, updatedAt, options);
  await setCache(db, entry.key, entry.value);
  return { writtenCount: entry.writtenCount };
}

export function buildReportCardCacheEntry(
  cards: readonly ReportCard[],
  updatedAt: number,
  options: WriteReportCardCacheOptions = {},
): { key: string; value: string; writtenCount: number } {
  if (
    options.completeness
    && options.completeness.methodologyVersion !== SAFETY_SCORE_METHODOLOGY_VERSION
  ) {
    throw new Error(
      `Report-card publication methodology ${options.completeness.methodologyVersion} does not match ${SAFETY_SCORE_METHODOLOGY_VERSION}`,
    );
  }
  const scores: ReportCardCachePayload["scores"] = {};
  for (const card of cards) {
    if (card.isDefunct || card.overallScore === null) continue;
    scores[card.id] = {
      score: card.overallScore,
      grade: card.overallGrade,
    };
  }

  const cachePayload: ReportCardCachePayload = {
    scores,
    updatedAt,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    ...(options.completeness
      ? {
          publicationGenerationId: options.completeness.generationId,
          completeness: options.completeness,
        }
      : {}),
    degradedInputs: buildReportCardCacheInputStatus(options),
  };
  return {
    key: REPORT_CARD_CACHE_KEY,
    value: JSON.stringify({
      generation: REPORT_CARD_CACHE_GENERATION,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      payload: cachePayload,
    }),
    writtenCount: Object.keys(scores).length,
  };
}
