import { ACTIVE_IDS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { errorResponse } from "./api-response";

/**
 * Returns a 403 Response if the given coin id is frozen, or null to continue.
 * Use at the entry of admin backfill endpoints to prevent re-collection of
 * data for a frozen coin.
 */
export function assertNotFrozen(
  stablecoinId: string,
  frozenIds: ReadonlySet<string> = FROZEN_IDS,
): Response | null {
  if (frozenIds.has(stablecoinId)) {
    return errorResponse(403, `Cannot run backfill for frozen stablecoin: ${stablecoinId}`);
  }
  return null;
}

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
