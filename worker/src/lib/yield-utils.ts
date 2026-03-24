export function buildOnChainSourceKey(stablecoinId: string): string {
  return `onchain:${stablecoinId}`;
}

export function parseYieldWarningSignals(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn("[yield-sync] warning_signals is not an array:", typeof parsed);
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch (e) {
    console.warn("[yield-sync] failed to parse warning_signals:", e instanceof Error ? e.message : String(e));
    return [];
  }
}
