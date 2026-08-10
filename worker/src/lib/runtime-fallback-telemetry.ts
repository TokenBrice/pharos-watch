export type RuntimeFallbackFamily =
  | "dex-challenger-legacy"
  | "blacklist-current-balance-legacy-identity";

export function recordRuntimeFallbackUsage(
  family: RuntimeFallbackFamily,
  details: Record<string, unknown> = {},
): void {
  console.warn("[runtime-fallback]", JSON.stringify({
    family,
    ...details,
  }));
}
