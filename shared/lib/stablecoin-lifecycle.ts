const TERMINAL_STABLECOIN_STATUSES = new Set(["dead", "defunct", "failed", "frozen", "cemetery"]);

export function isTerminalStablecoinStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return TERMINAL_STABLECOIN_STATUSES.has(status.trim().toLowerCase());
}
