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
import {
  SafetyScoreV8PublicationIdentitySchema,
  type SafetyScoreV8PublicationIdentity,
} from "@shared/types/safety-score-publication";

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
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, version]) => typeof version === "string"),
    ) as Record<string, string>;
  } catch {
    return null;
  }
}

function safeParseSafetyScoreIdentity(value: string): SafetyScoreV8PublicationIdentity | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return SafetyScoreV8PublicationIdentitySchema.safeParse(
      (parsed as { safetyScoreIdentity?: unknown }).safetyScoreIdentity,
    ).data ?? null;
  } catch {
    return null;
  }
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

  let payload: string;
  try {
    payload = await gunzipToString(loaded.bytes);
  } catch (err) {
    console.error(`[snapshot-day] decompress failed for ${date}:`, err);
    return errorResponse(500, "Snapshot payload corrupted");
  }

  return new Response(payload, {
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

  let envelope: {
    snapshotDate?: string;
    generatedAt?: number;
    methodologyVersions?: Record<string, string>;
    safetyScoreIdentity?: SafetyScoreV8PublicationIdentity;
    stablecoins?: { id: string }[];
    reportCards?: { scores?: Record<string, unknown> } | null;
    psi?: unknown;
    dews?: { stablecoinId: string }[];
    liquidity?: { stablecoinId: string }[];
  };
  try {
    envelope = JSON.parse(await gunzipToString(loaded.bytes));
  } catch (err) {
    console.error(`[snapshot-coin] decompress/parse failed for ${date}:`, err);
    return errorResponse(500, "Snapshot payload corrupted");
  }

  const stablecoin = (envelope.stablecoins ?? []).find((coin) => coin.id === stablecoinId);
  if (!stablecoin) {
    return errorResponse(404, "Stablecoin not present in this snapshot");
  }

  const reportCard =
    envelope.reportCards && typeof envelope.reportCards === "object"
      ? (envelope.reportCards.scores ?? {})[stablecoinId] ?? null
      : null;

  const dews = (envelope.dews ?? []).find((row) => row.stablecoinId === stablecoinId) ?? null;
  const liquidity = (envelope.liquidity ?? []).find((row) => row.stablecoinId === stablecoinId) ?? null;

  const projected = {
    snapshotDate: envelope.snapshotDate ?? date,
    stablecoinId,
    generatedAt: envelope.generatedAt ?? loaded.row.created_at,
    methodologyVersions: envelope.methodologyVersions ?? safeParseMethodology(loaded.row.methodology_versions),
    safetyScoreIdentity: envelope.safetyScoreIdentity ?? safeParseSafetyScoreIdentity(loaded.row.methodology_versions),
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
