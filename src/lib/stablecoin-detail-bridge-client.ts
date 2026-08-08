import type { BridgeRouteRiskConfidence, StablecoinLink, StablecoinMeta } from "@shared/types";

/**
 * Client-safe projection of the server-only `bridgeRouteRisk` profile, in the
 * `projectMintAuthorityClientSummary` pattern: bounded labels and counts only,
 * so the full route review never ships to the browser.
 */
export interface BridgeRouteRiskClientSummary {
  tier: string;
  tierLabel: string;
  tierToneClass: string;
  summary: string;
  reviewedAt: string;
  confidence: BridgeRouteRiskConfidence;
  confidenceLabel: string;
  routeCount: number;
  chainCount: number;
  canonicalRouteCount: number;
  thirdPartyRouteCount: number;
  sources: StablecoinLink[];
}

const TIER_LABELS: Record<string, string> = {
  "single-chain-or-native": "Single-chain / native",
  "issuer-native-burn-mint": "Issuer burn & mint",
  "canonical-rollup-bridge": "Canonical rollup bridge",
  "issuer-native-lock-mint": "Issuer lock & mint",
  "external-validated-network": "External validator network",
  "liquidity-or-intent-route": "Liquidity / intent routes",
  "external-lock-mint": "External lock & mint",
  "opaque-or-unknown": "Opaque / unknown",
};

const TIER_TONES: Record<string, string> = {
  "single-chain-or-native": "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "issuer-native-burn-mint": "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "canonical-rollup-bridge": "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  "issuer-native-lock-mint": "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  "external-validated-network": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "liquidity-or-intent-route": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "external-lock-mint": "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  "opaque-or-unknown": "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  verified: "Verified",
  probable: "Probable",
  "manual-review": "Manual review",
  unknown: "Unknown",
};

export function projectBridgeRouteRiskClientSummary(coin: StablecoinMeta): BridgeRouteRiskClientSummary | null {
  const profile = coin.bridgeRouteRisk;
  if (!profile) return null;
  const routes = profile.routes ?? [];
  const chains = new Set<string>();
  let canonicalRouteCount = 0;
  let thirdPartyRouteCount = 0;
  for (const route of routes) {
    if (route.destinationChain) chains.add(route.destinationChain);
    if (route.routeClass === "canonical" || route.routeClass === "native") canonicalRouteCount += 1;
    if (route.routeClass === "third-party") thirdPartyRouteCount += 1;
  }
  return {
    tier: profile.tier,
    tierLabel: TIER_LABELS[profile.tier] ?? profile.tier,
    tierToneClass: TIER_TONES[profile.tier] ?? "border-border/60 bg-muted/30 text-muted-foreground",
    summary: profile.summary,
    reviewedAt: profile.reviewedAt,
    confidence: profile.confidence,
    confidenceLabel: CONFIDENCE_LABELS[profile.confidence] ?? profile.confidence,
    routeCount: routes.length,
    chainCount: chains.size,
    canonicalRouteCount,
    thirdPartyRouteCount,
    sources: profile.sources ?? [],
  };
}
