import type { RedemptionRouteSuspension } from "../types/redemption";
import type { RedemptionBackstopConfig } from "./redemption-backstop-configs/schema";

/** Capture-time, exact-route admission; other issuer channels and DEX routes are untouched. */
export function resolveReviewedRouteSuspension(
  config: RedemptionBackstopConfig | null | undefined,
  routeId: string,
  clockSec: number,
): RedemptionRouteSuspension | undefined {
  const suspension = config?.routeStatus === "suspended" ? config.routeSuspension : undefined;
  if (!suspension || suspension.routeId !== routeId) return undefined;
  const reviewedAtSec = Date.parse(`${suspension.reviewedAt}T00:00:00Z`) / 1_000;
  return reviewedAtSec <= clockSec ? suspension : undefined;
}
