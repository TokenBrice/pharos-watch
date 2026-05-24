import type { RedemptionBackstopEntry } from "../types/redemption";
import type { RedemptionBackstopConfig, RedemptionCapacityModel } from "./redemption-backstop-configs/shared";

export type RedemptionCapacityFallbackSource = "none" | "reserve-sync-fallback-ratio" | "reserve-sync-fallback-usd";

export function resolveCapacityBasis(
  routeFamily: RedemptionBackstopConfig["routeFamily"] | null,
  model: RedemptionCapacityModel,
  capacityConfidence?: RedemptionBackstopEntry["capacityConfidence"],
): RedemptionBackstopEntry["capacityBasis"] | undefined {
  if (model.kind === "reserve-sync-metadata") {
    if (capacityConfidence === "live-direct") return "live-direct-telemetry";
    if (capacityConfidence === "live-proxy") return "live-proxy-buffer";
    if (model.basis) return model.basis;
    if (routeFamily === "psm-swap") return "psm-balance-share";
    if (routeFamily === "queue-redeem") return "strategy-buffer";
    return "hot-buffer";
  }

  if (model.basis) return model.basis;
  if (model.kind === "fixed-usd") return "fixed-buffer";
  if (model.kind === "supply-full") {
    return routeFamily === "offchain-issuer" || routeFamily === "stablecoin-redeem"
      ? "issuer-term-redemption"
      : "full-system-eventual";
  }

  if (routeFamily === "psm-swap") return "psm-balance-share";
  if (routeFamily === "queue-redeem") return "strategy-buffer";
  return "hot-buffer";
}

export function resolveCapacityFallbackSource(model: RedemptionCapacityModel): RedemptionCapacityFallbackSource {
  if (model.kind !== "reserve-sync-metadata") return "none";
  if (model.fallbackRatio != null) return "reserve-sync-fallback-ratio";
  if (model.fallbackUsd != null) return "reserve-sync-fallback-usd";
  return "none";
}

export function resolveCapacityDailyLimitUsd(model: RedemptionCapacityModel): number | null {
  if (model.kind === "fixed-usd" || model.kind === "supply-ratio") {
    return model.dailyLimitUsd ?? null;
  }
  return null;
}
