import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { throwIfAborted } from "../abort";
import { sha256HexFromUtf8Chunks } from "../hash";
import { SafetyScoreV9PublicationPayloadChunksSchema } from "./publication-codec";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "./publication-health";

/**
 * The canonical `report-cards:v9` row can hold either the single-row storage
 * envelope (`payload` inline) or a sharded envelope: identical metadata with
 * `payloadChunks` instead of `payload`, whose base64 text lives in immutable,
 * content-addressed chunk rows. Both shapes reassemble to the same
 * single-row-equivalent stored string, so codec parsing and every checksum are
 * unchanged, and no single D1 row approaches the 2 MB row limit.
 *
 * Readers accept both shapes. Writers shard only once every reader is live
 * (heavy `SAFETY_V9_CHUNKED_PUBLICATION_WRITES`).
 */
export const SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX = "report-cards:v9:payload-chunk:v1:";
// Base64 text is ASCII, so characters equal stored bytes.
export const SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES = 512 * 1024;
// ':' < ';', so [prefix:sha:, prefix:sha;) bounds one payload's chunk keys on the primary-key index.
const CHUNK_KEY_RANGE_END = ";";

function chunkKeyPrefix(payloadSha256: string): string {
  return `${SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX}${payloadSha256}:`;
}

function chunkKey(payloadSha256: string, index: number): string {
  // Zero-padded so lexicographic key order is chunk order.
  return `${chunkKeyPrefix(payloadSha256)}${String(index).padStart(3, "0")}`;
}

export interface ShardedSafetyScoreV9Publication {
  envelope: string;
  chunks: { key: string; value: string }[];
}

/** Split a single-row stored envelope into a sharded envelope and its chunk rows. */
export function shardSafetyScoreV9PublicationStoredValue(stored: string): ShardedSafetyScoreV9Publication {
  const { payload, ...metadata } = JSON.parse(stored) as { payload: unknown; payloadSha256: unknown };
  if (typeof payload !== "string" || payload.length === 0 || typeof metadata.payloadSha256 !== "string") {
    throw new Error("Safety Score v9 publication storage envelope has no inline payload to shard");
  }
  const chunks: { key: string; value: string }[] = [];
  for (let start = 0; start < payload.length; start += SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES) {
    chunks.push({
      key: chunkKey(metadata.payloadSha256, chunks.length),
      value: payload.slice(start, start + SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES),
    });
  }
  const envelope = stableJsonStringifyV1({
    ...metadata,
    payloadChunks: SafetyScoreV9PublicationPayloadChunksSchema.parse({
      count: chunks.length,
      payloadBytes: payload.length,
      payloadSha256: sha256HexFromUtf8Chunks([payload]),
      storedBytes: new TextEncoder().encode(stored).byteLength,
    }),
  });
  return { envelope, chunks };
}

/**
 * Rebuild the single-row-equivalent stored value from a sharded envelope and
 * the chunk rows read in the same statement. Inline envelopes pass through.
 */
export function reassembleSafetyScoreV9PublicationStoredValue(
  envelopeValue: string,
  chunks: readonly { key: string; value: string }[],
): string {
  const envelope = JSON.parse(envelopeValue) as Record<string, unknown>;
  if (!("payloadChunks" in envelope)) {
    if (chunks.length > 0) throw new Error("Safety Score v9 inline publication has unexpected payload chunks");
    return envelopeValue;
  }
  const { payloadChunks, ...metadata } = envelope;
  const manifest = SafetyScoreV9PublicationPayloadChunksSchema.parse(payloadChunks);
  if ("payload" in metadata || typeof metadata.payloadSha256 !== "string") {
    throw new Error("Safety Score v9 sharded publication envelope is malformed");
  }
  if (chunks.length !== manifest.count) {
    throw new Error(`Safety Score v9 publication has ${chunks.length} of ${manifest.count} payload chunks`);
  }
  chunks.forEach((chunk, index) => {
    if (chunk.key !== chunkKey(metadata.payloadSha256 as string, index)) {
      throw new Error("Safety Score v9 publication payload chunks are out of order");
    }
  });
  const payload = chunks.map((chunk) => chunk.value).join("");
  if (payload.length !== manifest.payloadBytes || sha256HexFromUtf8Chunks([payload]) !== manifest.payloadSha256) {
    throw new Error("Safety Score v9 publication payload chunk digest mismatch");
  }
  const stored = stableJsonStringifyV1({ ...metadata, payload });
  if (new TextEncoder().encode(stored).byteLength !== manifest.storedBytes) {
    throw new Error("Safety Score v9 publication reassembled byte length mismatch");
  }
  return stored;
}

/** Half-open key range covering every payload chunk row, for snapshot reads outside the Worker. */
export const SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_RANGE = [
  SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX,
  `${SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX.slice(0, -1)}${CHUNK_KEY_RANGE_END}`,
] as const;

/** Reassemble from a snapshot of cache rows that includes the chunk key range. */
export function reassembleSafetyScoreV9PublicationFromCacheRows(
  envelopeValue: string,
  rows: readonly { key: string; value: string }[],
): string {
  const payloadSha256: unknown = (JSON.parse(envelopeValue) as { payloadSha256?: unknown }).payloadSha256;
  const prefix = typeof payloadSha256 === "string" ? chunkKeyPrefix(payloadSha256) : null;
  const chunks = prefix === null ? [] : rows.filter((row) => row.key.startsWith(prefix))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return reassembleSafetyScoreV9PublicationStoredValue(envelopeValue, chunks);
}

/** Write statements for a sharded publication: content-addressed chunks plus deletion of every other payload's chunks. */
export function shardedSafetyScoreV9PublicationChunkStatements(
  db: D1Database,
  sharded: ShardedSafetyScoreV9Publication,
  payloadSha256: string,
  updatedAt: number,
): D1PreparedStatement[] {
  const prefix = chunkKeyPrefix(payloadSha256);
  return [
    // Readers fetch envelope and chunks in one statement, so superseded chunks
    // need no in-flight grace once the envelope moves in the same batch.
    db.prepare(`DELETE FROM cache WHERE key >= ? AND key < ? AND NOT (key >= ? AND key < ?)`)
      .bind(...SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_RANGE, prefix, `${prefix.slice(0, -1)}${CHUNK_KEY_RANGE_END}`),
    ...sharded.chunks.map((chunk) => db
      .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(chunk.key, chunk.value, updatedAt)),
  ];
}

/** Statement removing all payload chunks, for an inline (single-row) publication write. */
export function safetyScoreV9PublicationChunkCleanupStatement(db: D1Database): D1PreparedStatement {
  return db.prepare("DELETE FROM cache WHERE key >= ? AND key < ?").bind(...SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_RANGE);
}

/**
 * Read the canonical publication row and its payload chunks in ONE statement,
 * so a concurrent acceptance can never pair one generation's envelope with
 * another's chunks, then reassemble the single-row-equivalent stored value.
 */
export async function loadSafetyScoreV9PublicationStoredRow(
  db: D1Database,
  signal?: AbortSignal,
): Promise<{ value: string; updatedAt: number } | null> {
  throwIfAborted(signal);
  const result = await db.prepare(`SELECT p.value AS envelope, p.updated_at AS updated_at, c.key AS chunk_key, c.value AS chunk
    FROM cache p
    LEFT JOIN cache c ON json_valid(p.value) AND json_type(p.value, '$.payloadChunks') = 'object'
      AND c.key >= ? || json_extract(p.value, '$.payloadSha256') || ':'
      AND c.key < ? || json_extract(p.value, '$.payloadSha256') || ?
    WHERE p.key = ?
    ORDER BY c.key`)
    .bind(SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX, SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX,
      CHUNK_KEY_RANGE_END, SAFETY_SCORE_V9_CACHE_KEYS.publication)
    .all<{ envelope: string; updated_at: number; chunk_key: string | null; chunk: string | null }>();
  throwIfAborted(signal);
  const rows = result.results ?? [];
  if (rows.length === 0) return null;
  const chunks = rows.filter((row) => row.chunk_key !== null)
    .map((row) => ({ key: row.chunk_key!, value: row.chunk ?? "" }));
  return {
    value: reassembleSafetyScoreV9PublicationStoredValue(rows[0]!.envelope, chunks),
    updatedAt: rows[0]!.updated_at,
  };
}
