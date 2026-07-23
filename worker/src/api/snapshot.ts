/**
 * Public snapshot API handlers (ideas 12.6 + 11.14).
 *
 * Three URL shapes share a thin family of handlers backed by the
 * `public_snapshots` D1 table (written daily by snapshot-public-dataset):
 *
 *   GET /api/snapshots/index                                    — listing
 *   GET /api/snapshots/<YYYY-MM-DD>.json                        — full day
 *   GET /api/snapshot/<YYYY-MM-DD>/stablecoin/<id>              — projection
 *
 * Per-day payloads are stored gzipped in D1 and round-trip through
 * DecompressionStream before serving. The index uses the archive cache profile;
 * dated payload and per-coin projection responses are immutable.
 */
import {
  SNAPSHOT_DATE_PATTERN,
} from "@shared/lib/api-endpoints";
import { errorResponse, jsonResponse, withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { tryParseJson } from "../lib/json-parse";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import { safetyScorePublicationIdentitiesMatch } from "@shared/lib/safety-score-publication";
import { ReportCardsV9ResponseSchema } from "@shared/types/report-cards-v9";

const IMMUTABLE_CACHE_CONTROL = "public, s-maxage=31536000, max-age=31536000, immutable";

interface PublicSnapshotIndexRow {
  snapshot_date: string;
  methodology_versions: string;
  content_hash: string;
  byte_size: number;
  created_at: number;
}

interface PublicSnapshotRow {
  payload_gz: ArrayBuffer | Uint8Array | number[];
  methodology_versions: string;
  content_hash: string;
  byte_size: number;
  created_at: number;
}

function toUint8Array(value: ArrayBuffer | Uint8Array | number[] | unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  return null;
}

async function gunzipToString(bytes: Uint8Array): Promise<string> {
  const stream = new Response(Uint8Array.from(bytes)).body!.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function safeParseMethodology(value: string): Record<string, string> | null {
  const parsed = tryParseJson(value, { onFailure: () => undefined });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return Object.fromEntries(
    Object.entries(parsed).filter(([, version]) => typeof version === "string"),
  ) as Record<string, string>;
}

function safeParseSafetyScoreIdentity(value: string): SafetyScorePublicationIdentity | null {
  const parsed = tryParseJson(value, { onFailure: () => undefined });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parseSafetyScoreIdentity((parsed as { safetyScoreIdentity?: unknown }).safetyScoreIdentity);
}

function parseSafetyScoreIdentity(value: unknown): SafetyScorePublicationIdentity | null {
  return SafetyScorePublicationIdentitySchema.safeParse(value).data ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface StoredSnapshotEnvelope {
  snapshotDate?: string;
  generatedAt?: number;
  methodologyVersions?: Record<string, string>;
  safetyScoreIdentity?: unknown;
  stablecoins?: { id: string }[];
  reportCards?: unknown;
  psi?: unknown;
  dews?: { stablecoinId: string }[];
  liquidity?: { stablecoinId: string }[];
}

type StoredSafetyValidation =
  | { kind: "identified"; identity: SafetyScorePublicationIdentity }
  | { kind: "legacy"; identity: null }
  | { kind: "error"; reason: string };

const TRANSITIONAL_IDENTITY_START_DATE = "2026-07-13";
const TRANSITIONAL_IDENTITY_END_DATE = "2026-07-15";

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidScoreEntry(value: unknown): boolean {
  return (
    isRecord(value)
    && typeof value.score === "number"
    && Number.isFinite(value.score)
    && typeof value.grade === "string"
    && value.grade.length > 0
  );
}

function validateLegacyReportCards(reportCards: Record<string, unknown>): string | null {
  if (!isRecord(reportCards.scores)) return "safety-score-cards-invalid";
  return Object.values(reportCards.scores).every(isValidScoreEntry)
    ? null
    : "safety-score-cards-invalid";
}

function validateV8ReportCards(
  reportCards: Record<string, unknown>,
  identity: Extract<SafetyScorePublicationIdentity, { model: "v8" }>,
): string | null {
  if (
    reportCards.methodologyVersion !== identity.methodologyVersion
    || reportCards.publicationGenerationId !== identity.publicationGenerationId
    || typeof reportCards.updatedAt !== "number"
    || !Number.isInteger(reportCards.updatedAt)
    || reportCards.updatedAt < 0
    || identity.publicationGenerationId
      !== `report-cards:${identity.methodologyVersion}:${reportCards.updatedAt}`
    || !isRecord(reportCards.scores)
    || !isRecord(reportCards.completeness)
  ) {
    return "safety-score-publication-invalid";
  }

  const completeness = reportCards.completeness;
  const notRatedIds = completeness.notRatedIds;
  if (
    completeness.generationId !== identity.publicationGenerationId
    || completeness.methodologyVersion !== identity.methodologyVersion
    || typeof completeness.expectedCount !== "number"
    || !Number.isInteger(completeness.expectedCount)
    || typeof completeness.scoredCount !== "number"
    || !Number.isInteger(completeness.scoredCount)
    || typeof completeness.notRatedCount !== "number"
    || !Number.isInteger(completeness.notRatedCount)
    || !Array.isArray(notRatedIds)
    || !notRatedIds.every((id): id is string => typeof id === "string")
  ) {
    return "safety-score-completeness-invalid";
  }

  const scoreIds = Object.keys(reportCards.scores);
  const scoreIdSet = new Set(scoreIds);
  const notRatedIdSet = new Set(notRatedIds);
  const publishedIds = [...scoreIds, ...notRatedIds];
  if (
    scoreIdSet.size !== scoreIds.length
    || notRatedIdSet.size !== notRatedIds.length
    || scoreIds.some((id) => notRatedIdSet.has(id))
    || !Object.values(reportCards.scores).every(isValidScoreEntry)
    || completeness.scoredCount !== scoreIds.length
    || completeness.notRatedCount !== notRatedIds.length
    || completeness.expectedCount !== scoreIds.length + notRatedIds.length
    || new Set(publishedIds).size !== completeness.expectedCount
  ) {
    return "safety-score-completeness-mismatch";
  }
  return null;
}

function validateV9ReportCards(
  reportCards: Record<string, unknown>,
  identity: Extract<SafetyScorePublicationIdentity, { model: "v9" }>,
): string | null {
  const parsed = ReportCardsV9ResponseSchema.safeParse(reportCards);
  if (!parsed.success || parsed.data.lifecycle !== "active") {
    return "safety-score-publication-invalid";
  }
  if (!safetyScorePublicationIdentitiesMatch(identity, parsed.data.safetyScoreIdentity)) {
    return "safety-score-identity-mismatch";
  }
  return null;
}

function validateReportCardsForIdentity(
  reportCards: Record<string, unknown>,
  identity: SafetyScorePublicationIdentity,
): string | null {
  return identity.model === "v9"
    ? validateV9ReportCards(reportCards, identity)
    : validateV8ReportCards(reportCards, identity);
}

function isTransitionalIdentityDate(date: string): boolean {
  return date >= TRANSITIONAL_IDENTITY_START_DATE && date <= TRANSITIONAL_IDENTITY_END_DATE;
}

function validateStoredSafetyPublication(
  row: PublicSnapshotRow,
  envelope: StoredSnapshotEnvelope,
  date: string,
): StoredSafetyValidation {
  const metadata = tryParseJson(row.methodology_versions, { onFailure: () => undefined });
  const metadataRecord = isRecord(metadata) ? metadata : null;
  const reportCards = isRecord(envelope.reportCards) ? envelope.reportCards : null;
  const stablecoinIds = Array.isArray(envelope.stablecoins)
    && envelope.stablecoins.every((coin) => isRecord(coin) && typeof coin.id === "string")
    ? envelope.stablecoins.map((coin) => coin.id)
    : null;

  if (
    metadataRecord === null
    || !isRecord(envelope.methodologyVersions)
    || reportCards === null
    || stablecoinIds === null
    || new Set(stablecoinIds).size !== stablecoinIds.length
    || envelope.snapshotDate !== date
  ) {
    return { kind: "error", reason: "snapshot-envelope-invalid" };
  }

  const metadataHasIdentity = hasOwn(metadataRecord, "safetyScoreIdentity");
  const envelopeHasIdentity = hasOwn(envelope as unknown as Record<string, unknown>, "safetyScoreIdentity");
  const reportCardsHasIdentity = hasOwn(reportCards, "safetyScoreIdentity");
  const identityValues = [
    ...(metadataHasIdentity ? [metadataRecord.safetyScoreIdentity] : []),
    ...(envelopeHasIdentity ? [envelope.safetyScoreIdentity] : []),
    ...(reportCardsHasIdentity ? [reportCards.safetyScoreIdentity] : []),
  ];

  if (!metadataHasIdentity && !envelopeHasIdentity && !reportCardsHasIdentity) {
    if (date > TRANSITIONAL_IDENTITY_END_DATE) {
      return { kind: "error", reason: "safety-score-identity-missing" };
    }
    const legacyError = validateLegacyReportCards(reportCards);
    return legacyError === null
      ? { kind: "legacy", identity: null }
      : { kind: "error", reason: legacyError };
  }
  if (!metadataHasIdentity || !envelopeHasIdentity || !reportCardsHasIdentity) {
    if (!isTransitionalIdentityDate(date)) {
      return { kind: "error", reason: "safety-score-identity-incomplete" };
    }
    const transitionalIdentities = identityValues.map(parseSafetyScoreIdentity);
    if (
      transitionalIdentities.some((identity) => identity === null)
      || transitionalIdentities.some(
        (identity) => !safetyScorePublicationIdentitiesMatch(
          transitionalIdentities[0]!,
          identity!,
        ),
      )
    ) {
      return { kind: "error", reason: "safety-score-identity-invalid" };
    }
    const transitionalIdentity = transitionalIdentities[0]!;
    const transitionalError = reportCardsHasIdentity
      ? validateReportCardsForIdentity(reportCards, transitionalIdentity)
      : validateLegacyReportCards(reportCards);
    return transitionalError === null
      ? { kind: "legacy", identity: null }
      : { kind: "error", reason: transitionalError };
  }

  const metadataIdentity = parseSafetyScoreIdentity(metadataRecord.safetyScoreIdentity);
  const envelopeIdentity = parseSafetyScoreIdentity(envelope.safetyScoreIdentity);
  const reportCardsIdentity = parseSafetyScoreIdentity(reportCards.safetyScoreIdentity);
  if (!metadataIdentity || !envelopeIdentity || !reportCardsIdentity) {
    return { kind: "error", reason: "safety-score-identity-invalid" };
  }
  if (
    !safetyScorePublicationIdentitiesMatch(metadataIdentity, envelopeIdentity)
    || !safetyScorePublicationIdentitiesMatch(envelopeIdentity, reportCardsIdentity)
  ) {
    return { kind: "error", reason: "safety-score-identity-mismatch" };
  }
  if (
    envelope.methodologyVersions.reportCard !== envelopeIdentity.methodologyVersion
    || metadataRecord.reportCard !== envelopeIdentity.methodologyVersion
  ) {
    return { kind: "error", reason: "safety-score-methodology-mismatch" };
  }
  const publicationError = validateReportCardsForIdentity(
    reportCards,
    envelopeIdentity,
  );
  if (publicationError !== null) {
    return { kind: "error", reason: publicationError };
  }

  return { kind: "identified", identity: envelopeIdentity };
}

async function parseStoredSnapshot(
  row: PublicSnapshotRow,
  date: string,
): Promise<{ payload: string; envelope: StoredSnapshotEnvelope; identity: SafetyScorePublicationIdentity | null } | Response> {
  let payload: string;
  let envelope: StoredSnapshotEnvelope;
  try {
    payload = await gunzipToString(toUint8Array(row.payload_gz)!);
    const parsed = tryParseJson(payload, { onFailure: () => undefined });
    if (!isRecord(parsed)) {
      throw new Error("Snapshot envelope is not an object");
    }
    envelope = parsed as StoredSnapshotEnvelope;
  } catch (err) {
    console.error(`[snapshot] decompress/parse failed for ${date}:`, err);
    return errorResponse(500, "Snapshot payload corrupted");
  }

  const safetyValidation = validateStoredSafetyPublication(row, envelope, date);
  if (safetyValidation.kind === "error") {
    console.error(`[snapshot] safety identity validation failed for ${date}: ${safetyValidation.reason}`);
    return errorResponse(500, "Snapshot safety identity corrupted");
  }
  return { payload, envelope, identity: safetyValidation.identity };
}

async function loadSnapshotRow(db: D1Database, date: string): Promise<PublicSnapshotRow | null> {
  return db
    .prepare(
      "SELECT payload_gz, methodology_versions, content_hash, byte_size, created_at FROM public_snapshots WHERE snapshot_date = ?",
    )
    .bind(date)
    .first<PublicSnapshotRow>();
}

async function loadSnapshotBytes(
  db: D1Database,
  date: string,
): Promise<{ row: PublicSnapshotRow; bytes: Uint8Array } | Response> {
  if (!SNAPSHOT_DATE_PATTERN.test(date)) {
    return errorResponse(400, "Invalid snapshot date — expected YYYY-MM-DD");
  }

  const row = await loadSnapshotRow(db, date);
  if (!row) {
    return errorResponse(404, "No snapshot for this date");
  }

  const bytes = toUint8Array(row.payload_gz);
  if (!bytes) {
    return errorResponse(500, "Snapshot payload unreadable");
  }

  return { row, bytes };
}

export const handleSnapshotsIndex = withErrorHandler("snapshots-index", async (db: D1Database): Promise<Response> => {
  const result = await db
    .prepare(
      "SELECT snapshot_date, methodology_versions, content_hash, byte_size, created_at FROM public_snapshots ORDER BY snapshot_date DESC",
    )
    .all<PublicSnapshotIndexRow>();

  const snapshots = (result.results ?? []).map((row) => ({
    snapshotDate: row.snapshot_date,
    methodologyVersions: safeParseMethodology(row.methodology_versions),
    safetyScoreIdentity: safeParseSafetyScoreIdentity(row.methodology_versions),
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    createdAt: row.created_at,
  }));

  return jsonResponse({ snapshots }, { "Cache-Control": CACHE_PROFILES.archive });
});

export const handleSnapshotDay = withErrorHandler("snapshot-day", async (
  db: D1Database,
  date: string,
): Promise<Response> => {
  const loaded = await loadSnapshotBytes(db, date);
  if (loaded instanceof Response) return loaded;

  const parsed = await parseStoredSnapshot(loaded.row, date);
  if (parsed instanceof Response) return parsed;

  return new Response(parsed.payload, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": IMMUTABLE_CACHE_CONTROL,
      ETag: `"${loaded.row.content_hash}"`,
    },
  });
});

export const handleSnapshotCoin = withErrorHandler("snapshot-coin", async (
  db: D1Database,
  date: string,
  stablecoinId: string,
): Promise<Response> => {
  const loaded = await loadSnapshotBytes(db, date);
  if (loaded instanceof Response) return loaded;

  const parsed = await parseStoredSnapshot(loaded.row, date);
  if (parsed instanceof Response) return parsed;
  const { envelope, identity: safetyScoreIdentity } = parsed;

  const stablecoin = (envelope.stablecoins ?? []).find((coin) => coin.id === stablecoinId);
  if (!stablecoin) {
    return errorResponse(404, "Stablecoin not present in this snapshot");
  }

  const reportCards = isRecord(envelope.reportCards) ? envelope.reportCards : null;
  let reportCard: unknown = null;
  if (reportCards && safetyScoreIdentity?.model === "v9" && Array.isArray(reportCards.cards)) {
    reportCard = reportCards.cards.find(
      (card): card is Record<string, unknown> => isRecord(card) && card.id === stablecoinId,
    ) ?? null;
  } else if (reportCards && isRecord(reportCards.scores)) {
    reportCard = reportCards.scores[stablecoinId] ?? null;
  }

  const dews = (envelope.dews ?? []).find((row) => row.stablecoinId === stablecoinId) ?? null;
  const liquidity = (envelope.liquidity ?? []).find((row) => row.stablecoinId === stablecoinId) ?? null;

  const projected = {
    snapshotDate: envelope.snapshotDate ?? date,
    stablecoinId,
    generatedAt: envelope.generatedAt ?? loaded.row.created_at,
    methodologyVersions: envelope.methodologyVersions ?? safeParseMethodology(loaded.row.methodology_versions),
    safetyScoreIdentity,
    stablecoin,
    scores: {
      reportCard,
      psi: envelope.psi ?? null,
      dews,
      liquidity,
    },
  };

  return jsonResponse(projected, {
    headers: {
      "Cache-Control": IMMUTABLE_CACHE_CONTROL,
      ETag: `"${loaded.row.content_hash}-${stablecoinId}"`,
    },
  });
});
