const TERMINAL_STABLECOIN_STATUSES = new Set(["dead", "defunct", "failed", "frozen", "cemetery"]);

export function isTerminalStablecoinStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return TERMINAL_STABLECOIN_STATUSES.has(status.trim().toLowerCase());
}

/**
 * A coin is retired from the catalog when its id is absent from the tracked
 * registry. Callers pass their runtime registry index: the catalog is the only
 * authority, so there is no parallel retirement list to drift.
 */
export function isRetiredFromCatalog(
  stablecoinId: string,
  trackedById: Readonly<{ has(id: string): boolean }>,
): boolean {
  return !trackedById.has(stablecoinId);
}
