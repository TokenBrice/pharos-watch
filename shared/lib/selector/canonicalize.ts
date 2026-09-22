/**
 * Canonicalization for snapshot-id (`sid`) computation.
 *
 * The integration agent and the client share these rules so the `sid`
 * matches between browser pre-flight and Pages Function authoritative hash.
 * The strip-list removes every freshness-derived field so two readers with
 * the same content-level snapshot produce the same `sid`.
 *
 * Binding: see `docs/screener-picker-page.md` for the maintained snapshot
 * canonicalization contract.
 */

/**
 * Field names that are unconditionally stripped during canonical
 * serialization wherever they appear in the payload.
 */
const STRIP_TOP_LEVEL: ReadonlySet<string> = new Set([
  "debug",
  "provenance",
  "snapshotSchemaVersion",
  "timestamp",
  "perInputStaleness",
]);

/**
 * Field-name suffix pattern; any key matching this regex is stripped
 * regardless of nesting depth. Case-insensitive on the leading capital so
 * `dataUpdatedAt`, `lastFetchedAt`, etc. all match.
 */
const STRIP_NAME_PATTERN = /(ageSeconds|capturedAt|stalenessMs|UpdatedAt|updatedAt|FetchedAt|fetchedAt)$/;

/**
 * Recursively rebuild `value` with object keys sorted lexicographically,
 * stripped fields removed, and strings NFC-normalized. Arrays preserve
 * order. Numbers must be finite.
 */
function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (STRIP_TOP_LEVEL.has(key) || STRIP_NAME_PATTERN.test(key)) continue;
      const child = obj[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.normalize("NFC");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("[selector/canonicalize] non-finite number");
    }
    return value;
  }
  return value;
}

/**
 * Produce a stable JSON string of `value` for SHA-256 hashing.
 *
 * Hashing pipeline (must match server-side recomputation):
 *   1. Strip freshness-derived fields per the denylist.
 *   2. Lex-sort object keys recursively.
 *   3. NFC-normalize strings.
 *   4. `JSON.stringify` the result.
 */
export function canonicalizeForSid(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

