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
 * Nested paths to strip. Each entry is matched against the dot-joined key
 * path during recursion. (Currently empty — `coverageWarnings.newListingCount`
 * was previously stripped on the assumption it was timestamp-derived; in the
 * implemented engine it is computed from content-level `isRecentListing`
 * flags so it must contribute to `sid` to preserve cross-client agreement.)
 */
const STRIP_PATHS: ReadonlySet<string> = new Set([]);

function shouldStrip(key: string, path: string): boolean {
  if (STRIP_TOP_LEVEL.has(key)) return true;
  if (STRIP_NAME_PATTERN.test(key)) return true;
  if (STRIP_PATHS.has(path)) return true;
  return false;
}

/**
 * Recursively rebuild `value` with object keys sorted lexicographically,
 * stripped fields removed, and strings NFC-normalized. Arrays preserve
 * order. Numbers must be finite.
 */
function canonicalize(value: unknown, path: string): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item, i) => canonicalize(item, `${path}[${i}]`));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (shouldStrip(key, childPath)) continue;
      const child = obj[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child, childPath);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.normalize("NFC");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `[selector/canonicalize] non-finite number at path "${path}"`,
      );
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
  return JSON.stringify(canonicalize(value, ""));
}

/**
 * Content-only canonicalization for `datasetHash`. Same rules as
 * `canonicalizeForSid` plus an extra guard: callers must pass an object
 * containing only the content-level fields per coin (`id`, `safetyGrade`,
 * `overallScore`, `pegScore`, `dewsScore`, `liquidityScore`, sub-dimensions,
 * `pharosYieldScore`, `apy30d`, `bluechipGrade`, `supplyUsd`). The strip
 * pattern handles any straggling freshness keys.
 */
export function canonicalizeForDatasetHash(content: unknown): string {
  return canonicalizeForSid(content);
}
