import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { errorResponse } from "./api-response";

/** Reject write-side collection for every non-active tracked lifecycle. */
export function assertActiveStablecoin(
  stablecoinId: string,
  activeIds: ReadonlySet<string> = ACTIVE_IDS,
): Response | null {
  if (!activeIds.has(stablecoinId)) {
    return errorResponse(403, `Cannot run backfill for inactive stablecoin: ${stablecoinId}`);
  }
  return null;
}
