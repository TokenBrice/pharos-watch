/**
 * Build the canonical relative URL for a stablecoin profile.
 *
 * The stablecoin id is always encoded as one path segment. Optional suffixes
 * are route-owned static paths, queries, or fragments; path suffixes are
 * normalized to the canonical trailing-slash form.
 */
export function buildStablecoinUrl(id: string, suffix?: string): string {
  const base = `/stablecoin/${encodeURIComponent(id)}/`;
  if (!suffix) return base;

  const normalizedSuffix = suffix.replace(/^\/+/, "");
  if (!normalizedSuffix || normalizedSuffix.startsWith("?") || normalizedSuffix.startsWith("#")) {
    return base + normalizedSuffix;
  }

  const boundaryIndex = normalizedSuffix.search(/[?#]/);
  const path = boundaryIndex === -1 ? normalizedSuffix : normalizedSuffix.slice(0, boundaryIndex);
  const queryOrFragment = boundaryIndex === -1 ? "" : normalizedSuffix.slice(boundaryIndex);
  const canonicalPath = path.replace(/\/+$/, "");

  return `${base}${canonicalPath}/${queryOrFragment}`;
}
