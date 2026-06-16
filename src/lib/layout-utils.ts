/**
 * Shared layout utility helpers used across visual modules.
 */

/**
 * djb2-style deterministic hash for a string id with an optional salt.
 * Same id + salt always returns the same non-negative 32-bit integer.
 * Suitable for stable per-id visual jitter and radius offsets.
 */
export function deterministicHash(id: string, salt = 0): number {
  let hash = salt;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 33 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
}
