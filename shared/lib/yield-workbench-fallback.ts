import { isCanonicalStablecoinId } from "./stablecoin-id";

export const YIELD_WORKBENCH_FALLBACK_PARAM = "workbenchFallback";
export const MAX_YIELD_WORKBENCH_FALLBACK_ID_LENGTH = 64;

// This validates the transport boundary only. UI consumers must also resolve
// the result through the tracked registry before displaying coin metadata.
export function parseYieldWorkbenchFallbackId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_YIELD_WORKBENCH_FALLBACK_ID_LENGTH) return null;
  return isCanonicalStablecoinId(id) ? id : null;
}

export function setYieldWorkbenchFallbackParam(searchParams: URLSearchParams, stablecoinId: string): boolean {
  const id = parseYieldWorkbenchFallbackId(stablecoinId);
  if (!id) return false;
  searchParams.set(YIELD_WORKBENCH_FALLBACK_PARAM, id);
  return true;
}
