/**
 * Does a `Warning` response header signal degraded/stale freshness?
 *
 * Matches RFC 7234 warn-code 110 (revalidation failed) at the start of any
 * comma-separated element, plus the Pharos-authored "Response is degraded/stale"
 * texts. Shared so the API client and the endpoint prober cannot drift.
 */
export function isFreshnessWarningHeader(warningHeader: string): boolean {
  return /(?:^|,\s*)110\b/.test(warningHeader) || /Response is (?:degraded|stale)/i.test(warningHeader);
}

/**
 * Does a `Warning` response header describe a stale stablecoin-detail cache
 * refresh?
 *
 * The worker emits both scheduled and failed refresh variants. Match the
 * stable cache family instead of pinning the UI to one suffix so a harmless
 * rewording of the scheduled warning does not bypass the shared contract.
 */
export function isScheduledRefreshWarning(warningHeader: string): boolean {
  const normalized = warningHeader.replace(/\s+/g, " ");
  const prefix = /stablecoin detail cache (?:is )?stale\b/i.exec(normalized);
  if (!prefix) return false;
  return /\brefresh\b/i.test(normalized.slice(prefix.index + prefix[0].length));
}
