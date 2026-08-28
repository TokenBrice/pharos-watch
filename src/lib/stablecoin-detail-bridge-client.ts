import type { BridgeRouteRiskConfidence, StablecoinLink, StablecoinMeta } from "@shared/types";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";

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
  "single-chain-or-native": SEVERITY_TONE_CLASS.ok.pill,
  "issuer-native-burn-mint": SEVERITY_TONE_CLASS.ok.pill,
  "canonical-rollup-bridge": SEVERITY_TONE_CLASS.info.pill,
  "issuer-native-lock-mint": SEVERITY_TONE_CLASS.info.pill,
  "external-validated-network": SEVERITY_TONE_CLASS.watch.pill,
  "liquidity-or-intent-route": SEVERITY_TONE_CLASS.watch.pill,
  "external-lock-mint": "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  "opaque-or-unknown": SEVERITY_TONE_CLASS.alert.pill,
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
    tierToneClass: TIER_TONES[profile.tier] ?? SEVERITY_TONE_CLASS.neutral.pill,
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
