import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";

export function resolveStaticCostScore(config: RedemptionBackstopConfig): number {
  if (config.costModel.kind === "dynamic-or-unclear") {
    return config.costModel.feeDescription && config.costModel.confidence !== "undisclosed-reviewed" ? 60 : 40;
  }
  const feeBps = Math.max(0, config.costModel.feeBps);
  if (feeBps <= 10) return 100;
  if (feeBps <= 50) return 80;
  if (feeBps <= 100) return 60;
  return 40;
}
