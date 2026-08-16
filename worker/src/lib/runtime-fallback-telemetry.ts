import { logWorkerEventArgs } from "./structured-log";
export type RuntimeFallbackFamily =
  | "dex-challenger-legacy"
  | "blacklist-current-balance-legacy-identity";

export function recordRuntimeFallbackUsage(
  family: RuntimeFallbackFamily,
  details: Record<string, unknown> = {},
): void {
  logWorkerEventArgs("lib", "warn", "[runtime-fallback]", JSON.stringify({
    family,
    ...details,
  }));
}
