import type { BridgeRouteRiskProfile } from "@shared/types/core";
import { resolveChainId } from "@shared/lib/chains";
import type { SafetyScoreV9FactSetExtensionV2 } from "./safety-score-v9-fact-set";
import type { ReportCardsFixedInput } from "./report-cards-fixed-input";

type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
type SupplyReview = NonNullable<ExtensionAsset["supplyReview"]>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalChainKey(raw: string): string {
  return resolveChainId(raw) ?? raw.toLowerCase();
}

function routeChain(routeId: string): string | null {
  const separator = routeId.indexOf(":");
  return separator > 0 ? canonicalChainKey(routeId.slice(0, separator)) : null;
}

/**
 * Reconciles the exact captured per-chain circulating supply against the
 * reviewed bridge-route rows. Chains without a unique reviewed route row stay
 * in the unknown share instead of being attributed to any route.
 */
export function buildSafetyScoreV9SupplyReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
  profile: BridgeRouteRiskProfile | undefined,
): SupplyReview | null {
  const chainRows = fixedInput.chainCirculatingById[assetId] ?? {};
  const chains = Object.keys(chainRows).sort(compareText);
  const totalUsd = chains.reduce((sum, chain) => sum + chainRows[chain]!.current, 0);
  if (chains.length === 0 || totalUsd <= 0) return null;

  const routes = profile?.routes ?? [];
  if (chains.length > 1 && routes.length === 0) return null;

  const routesByChain = new Map<string, typeof routes>();
  for (const route of routes) {
    const chain = routeChain(route.id);
    if (chain === null) continue;
    routesByChain.set(chain, [...(routesByChain.get(chain) ?? []), route]);
  }

  const selectedBridgeRoutes: SupplyReview["selectedBridgeRoutes"][number][] = [];
  let unknownUsd = 0;
  let unreviewedUsd = 0;
  const failureDomains: SupplyReview["failureDomains"][number][] = [];
  for (const chain of chains) {
    const supplyUsd = chainRows[chain]!.current;
    const chainRoutes = routesByChain.get(canonicalChainKey(chain)) ?? [];
    if (chainRoutes.length !== 1) {
      // Zero rows means the chain has no reviewed route; multiple rows cannot
      // be split with per-chain supply alone. Both stay unknown.
      unknownUsd += supplyUsd;
      continue;
    }
    const route = chainRoutes[0]!;
    const reviewed = route.reviewDisposition === "reviewed";
    if (!reviewed) unreviewedUsd += supplyUsd;
    selectedBridgeRoutes.push({
      deploymentRouteKey: route.id,
      supplyUsd,
      supplyShare: supplyUsd / totalUsd,
      reviewState: reviewed ? "selected-reviewed" : "selected-unresolved",
    });
    for (const key of route.failureDomainKeys?.length ? route.failureDomainKeys : [route.id]) {
      failureDomains.push({ kind: "bridge-route", key });
    }
  }
  const reviewedSelectedUsd = selectedBridgeRoutes.reduce(
    (sum, route) => sum + (route.reviewState === "selected-reviewed" ? route.supplyUsd : 0),
    0,
  );
  return {
    selectedBridgeRoutes: selectedBridgeRoutes.sort((left, right) =>
      compareText(left.deploymentRouteKey, right.deploymentRouteKey),
    ),
    selectedRouteSupplyShare: Math.min(1, reviewedSelectedUsd / totalUsd),
    unknownRouteSupplyShare: Math.min(1, unknownUsd / totalUsd),
    unreviewedRouteSupplyShare: Math.min(1, unreviewedUsd / totalUsd),
    failureDomains: [...new Map(failureDomains.map((domain) => [`${domain.kind}:${domain.key}`, domain])).values()].sort(
      (left, right) => compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
    ),
  };
}

/** Supply share reconciled to one reviewed route row, for control materiality. */
export function safetyScoreV9RouteSupplyShare(review: SupplyReview | null, deploymentRouteKey: string): number | null {
  if (review === null) return null;
  const route = review.selectedBridgeRoutes.find((candidate) => candidate.deploymentRouteKey === deploymentRouteKey);
  return route?.supplyShare ?? 0;
}
