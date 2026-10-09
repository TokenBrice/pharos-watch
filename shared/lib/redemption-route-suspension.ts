import type { RedemptionRouteSuspension } from "../types/redemption";
import type { RedemptionBackstopConfig } from "./redemption-backstop-configs/schema";
import { allocationReviewClockSec as reviewAdmissionClockSec } from "../types/safety-score-v9-allocation";

/** Capture-time, exact-route admission; other issuer channels and DEX routes are untouched. */
export function resolveReviewedRouteSuspension(
  config: RedemptionBackstopConfig | null | undefined,
  routeId: string,
  clockSec: number,
): RedemptionRouteSuspension | undefined {
  const suspension = config?.routeStatus === "suspended" ? config.routeSuspension : undefined;
  if (!suspension || suspension.routeId !== routeId) return undefined;
  const reviewedAtSec = reviewAdmissionClockSec(suspension.reviewedAt);
  return reviewedAtSec <= clockSec ? suspension : undefined;
}
