import { SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES } from "@shared/lib/safety-score-v9-publication-limits";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES } from "../safety-score-v9/publication-codec";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../safety-score-v9/publication-health";

/** Ops-only early warning before the accepted publication hits a write cap. */
export const SAFETY_PUBLICATION_SIZE_HEADROOM_WARN_RATIO = 0.85;

export type SafetyPublicationSizeObservation =
  | { kind: "observed"; storedBytes: number; storedCapBytes: number; compressedBytes: number; compressedCapBytes: number }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: "safety-publication-size-read-failed" | "safety-publication-size-malformed" };

/**
 * Reads the stored size of the accepted `report-cards:v9` row and the
 * `compressedBytes` its envelope recorded at admission, without decoding the
 * publication. Caps come from the writer's own limits, so the warning tracks
 * any future cap change.
 */
export async function loadSafetyPublicationSize(db: D1Database): Promise<SafetyPublicationSizeObservation> {
  let row: { stored_bytes: unknown; compressed_bytes: unknown } | null;
  try {
    row = await db
      .prepare(
        "SELECT LENGTH(CAST(value AS BLOB)) AS stored_bytes, json_extract(value, '$.compressedBytes') AS compressed_bytes FROM cache WHERE key = ?",
      )
      .bind(SAFETY_SCORE_V9_CACHE_KEYS.publication)
      .first<{ stored_bytes: unknown; compressed_bytes: unknown }>();
  } catch {
    return { kind: "unavailable", reason: "safety-publication-size-read-failed" };
  }
  if (!row) return { kind: "absent" };
  const { stored_bytes: storedBytes, compressed_bytes: compressedBytes } = row;
  if (!Number.isSafeInteger(storedBytes) || (storedBytes as number) <= 0
    || !Number.isSafeInteger(compressedBytes) || (compressedBytes as number) <= 0) {
    return { kind: "unavailable", reason: "safety-publication-size-malformed" };
  }
  return {
    kind: "observed",
    storedBytes: storedBytes as number,
    storedCapBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES,
    compressedBytes: compressedBytes as number,
    compressedCapBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES,
  };
}
