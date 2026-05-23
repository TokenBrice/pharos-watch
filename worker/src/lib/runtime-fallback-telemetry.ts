export type RuntimeFallbackFamily =
  | "stablecoins-cache-legacy-array"
  | "dex-challenger-legacy"
  | "redemption-backstop-legacy-current"
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
