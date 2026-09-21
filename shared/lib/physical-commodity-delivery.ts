import type { z } from "zod";
import type { PhysicalCommodityDeliveryTermsSchema } from "./redemption-backstop-configs/schema";

/** Physical metal only: a minimum lot is not a promise of fiat settlement. */
export function valuePhysicalCommodityDelivery(
  terms: z.infer<typeof PhysicalCommodityDeliveryTermsSchema>,
  usdPerTroyOunce: number,
  requestedNotionalUsd: number,
): { unitValueUsd: number; expectedUnitValueUsd: number; minimumDeliveryUsd: number } | null {
  if (!Number.isFinite(usdPerTroyOunce) || usdPerTroyOunce <= 0 ||
      !Number.isFinite(requestedNotionalUsd) || requestedNotionalUsd <= 0) return null;
  const grossPerToken = usdPerTroyOunce * terms.deliverableOuncesPerToken;
  const minimumDeliveryUsd = grossPerToken * terms.minimumDeliveryTokens;
  // Below the documented delivery minimum none of the requested lot is deliverable.
  const netUsd = requestedNotionalUsd < minimumDeliveryUsd ? 0 : Math.max(0,
    requestedNotionalUsd * (1 - terms.feeModel.bps / 10_000) -
      terms.feeModel.flatUsd - terms.feeModel.deliveryUsd);
  return {
    unitValueUsd: grossPerToken * netUsd / requestedNotionalUsd,
    expectedUnitValueUsd: grossPerToken,
    minimumDeliveryUsd,
  };
}
