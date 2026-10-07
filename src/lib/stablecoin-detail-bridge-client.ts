import type {
  BridgeRouteDeployment,
  BridgeRouteRiskConfidence,
  BridgeRouteRiskTier,
  StablecoinLink,
  StablecoinMeta,
} from "@shared/types";
import {
  BRIDGE_THIRD_PARTY_TIERS,
  BRIDGE_TIER_LABELS,
  BRIDGE_TIER_POLICY_ORDER,
  getBridgeTierLabel,
  RESEARCH_REVIEW_CONFIDENCE_LABELS,
} from "@shared/lib/classification";
import { CHAIN_META, normalizeChainId } from "@shared/types/chain-identity";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import { titleCaseSlug } from "@/lib/title-case-slug";

/** Route cells shipped in static HTML; larger inventories (max 88) report the rest in `routesTruncated`. */
export const BRIDGE_ROUTE_PROJECTION_LIMIT = 40;

/** One reviewed route, sized for a deployment-strip cell. */
export interface BridgeRouteClientRow {
  /** Normalized deployment id (`<chain>:<address>`): joins `FailureDomainSpan.routeKeys` and control components. */
  key: string;
  chainId: string;
  chainLabel: string;
  tierKey: BridgeRouteRiskTier;
  /** `getBridgeTierLabel`: the native tier reads "Native" on a multi-chain asset. */
  tierLabel: string;
  /** Reviewed bridge protocol; null for native issuance, which crosses no bridge. */
  protocolLabel: string | null;
  /** The route's `protocol:<slug>` failure domain; joins `FailureDomainSpan.protocolKeys`. */
  protocolKey: string | null;
  /** False for an unresolved route: its tier is the schema's unknown placeholder, not a reviewed finding. */
  reviewed: boolean;
  /**
   * `card.breakdowns.control.components[].key` of this route's bridge component.
   * Null in the static projection (the card loads at runtime); fill it with
   * `bindBridgeRouteControlComponents`. Stays null when the engine compiled no
   * component for the route (native issuance, unresolved or immaterial routes).
   */
  controlComponentKey: string | null;
}

/**
 * Client-safe projection of the server-only `bridgeRouteRisk` profile, in the
 * `projectMintAuthorityClientSummary` pattern: bounded labels, counts and a
 * capped route list, so the full route review never ships to the browser.
 *
 * Every count describes the same route set the strip legend draws: tiers come
 * from the reviewed routes, and "third-party" means a reviewed route in a
 * third-party tier (`BRIDGE_THIRD_PARTY_TIERS`), so the verdict's count equals
 * the sum of those legend entries.
 */
export interface BridgeRouteRiskClientSummary {
  /** The reviewer's asset-wide tier (`bridgeRouteRisk.tier`); it can disagree with the route tiers. */
  authoredTier: BridgeRouteRiskTier;
  authoredTierLabel: string;
  /** Weakest reviewed route tier in published policy order; null when no route is reviewed. */
  weakestRouteTier: BridgeRouteRiskTier | null;
  summary: string;
  reviewedAt: string;
  confidence: BridgeRouteRiskConfidence;
  confidenceLabel: string;
  /** Every route in the inventory, reviewed or not. */
  routeCount: number;
  /** Routes whose review is unresolved; their tier is unknown, not opaque, and no tier count includes them. */
  unresolvedRouteCount: number;
  chainCount: number;
  /** Reviewed routes in a third-party tier. */
  thirdPartyRouteCount: number;
  /** Reviewed routes per tier over the full inventory, so legend totals survive truncation. */
  tierCounts: Partial<Record<BridgeRouteRiskTier, number>>;
  /** Chain the asset is natively issued from, when the review identifies one. */
  homeChainId: string | null;
  /** Home chain first, then published tier order, then chain name; tier mix kept proportional when capped. */
  routes: BridgeRouteClientRow[];
  routesTruncated: number;
  sources: StablecoinLink[];
}

/** Published policy order (`BRIDGE_ROUTE_RISK_TIER_VALUES`, `bridgeTierQuality` descending). */
const TIER_ORDER: readonly BridgeRouteRiskTier[] = BRIDGE_TIER_POLICY_ORDER;

export function bridgeRouteTierLabel(tier: string): string {
  return BRIDGE_TIER_LABELS[tier as BridgeRouteRiskTier] ?? tier;
}

function projectRoute(route: BridgeRouteDeployment, chainId: string, chainCount: number): BridgeRouteClientRow {
  const protocolDomain = route.failureDomainKeys?.find((key) => key.startsWith("protocol:"));
  return {
    key: normalizeDeploymentId(route.id) || route.id,
    chainId,
    chainLabel: CHAIN_META[chainId]?.name ?? titleCaseSlug(chainId),
    tierKey: route.riskTier,
    tierLabel: getBridgeTierLabel(route.riskTier, chainCount),
    protocolLabel: route.routeClass === "native" ? null : route.protocol,
    protocolKey: protocolDomain ? protocolDomain.slice("protocol:".length) : null,
    reviewed: route.reviewDisposition === "reviewed",
    controlComponentKey: null,
  };
}

/**
 * The single reviewed native chain; otherwise the chain most representations
 * name as canonical (a tie resolves to null), restricted to native chains when
 * the asset is natively issued on several.
 */
function resolveHomeChain(routes: readonly BridgeRouteDeployment[], rows: readonly BridgeRouteClientRow[]): string | null {
  const nativeChains = new Set(
    rows.filter((row, index) => routes[index]!.routeClass === "native" && row.reviewed).map((row) => row.chainId),
  );
  if (nativeChains.size === 1) return [...nativeChains][0]!;
  const votes = new Map<string, number>();
  for (const route of routes) {
    const chainId = normalizeChainId(route.canonicalChain);
    if (chainId && (nativeChains.size === 0 || nativeChains.has(chainId))) votes.set(chainId, (votes.get(chainId) ?? 0) + 1);
  }
  const ranked = [...votes.entries()].sort((left, right) => right[1] - left[1]);
  if (ranked.length === 0 || ranked[0]![1] === ranked[1]?.[1]) return null;
  return ranked[0]![0];
}

/**
 * Cap with proportional representation (D'Hondt: every present group keeps a
 * cell, then each slot goes to the group with the most routes per cell), so a
 * truncated strip keeps the inventory's real mix instead of its first rows.
 * Groups are the reviewed tiers plus the unresolved routes, the entries the
 * legend counts. `rows` arrive in display order and keep it.
 */
function capRoutes(rows: readonly BridgeRouteClientRow[]): BridgeRouteClientRow[] {
  if (rows.length <= BRIDGE_ROUTE_PROJECTION_LIMIT) return [...rows];
  const groupOf = (row: BridgeRouteClientRow): string => (row.reviewed ? row.tierKey : "unresolved");
  const groupOrder: readonly string[] = [...TIER_ORDER, "unresolved"];
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(groupOf(row), (totals.get(groupOf(row)) ?? 0) + 1);
  const quotas = new Map<string, number>([...totals.keys()].map((group) => [group, 1]));
  for (let slots = quotas.size; slots < BRIDGE_ROUTE_PROJECTION_LIMIT; slots += 1) {
    let next: string | null = null;
    for (const group of groupOrder) {
      const total = totals.get(group) ?? 0;
      const quota = quotas.get(group) ?? 0;
      if (quota >= total) continue;
      if (next === null || total / (quota + 1) > totals.get(next)! / (quotas.get(next)! + 1)) next = group;
    }
    if (next === null) break;
    quotas.set(next, quotas.get(next)! + 1);
  }
  const taken = new Map<string, number>();
  return rows.filter((row) => {
    const group = groupOf(row);
    const count = taken.get(group) ?? 0;
    if (count >= quotas.get(group)!) return false;
    taken.set(group, count + 1);
    return true;
  });
}

export function projectBridgeRouteRiskClientSummary(coin: StablecoinMeta): BridgeRouteRiskClientSummary | null {
  const profile = coin.bridgeRouteRisk;
  if (!profile) return null;
  const routes = profile.routes ?? [];
  const chainIds = routes.map((route) => normalizeChainId(route.destinationChain) ?? route.destinationChain);
  const chainCount = new Set(chainIds).size;
  const rows = routes.map((route, index) => projectRoute(route, chainIds[index]!, chainCount));
  const tierCounts: Partial<Record<BridgeRouteRiskTier, number>> = {};
  let weakestRouteTier: BridgeRouteRiskTier | null = null;
  let thirdPartyRouteCount = 0;
  let unresolvedRouteCount = 0;
  for (const route of routes) {
    if (route.reviewDisposition !== "reviewed") {
      unresolvedRouteCount += 1;
      continue;
    }
    tierCounts[route.riskTier] = (tierCounts[route.riskTier] ?? 0) + 1;
    if (BRIDGE_THIRD_PARTY_TIERS[route.riskTier]) thirdPartyRouteCount += 1;
    if (weakestRouteTier === null || TIER_ORDER.indexOf(route.riskTier) > TIER_ORDER.indexOf(weakestRouteTier)) {
      weakestRouteTier = route.riskTier;
    }
  }
  const homeChainId = resolveHomeChain(routes, rows);
  const ordered = [...rows].sort((left, right) =>
    Number(right.chainId === homeChainId) - Number(left.chainId === homeChainId)
    || TIER_ORDER.indexOf(left.tierKey) - TIER_ORDER.indexOf(right.tierKey)
    || left.chainLabel.localeCompare(right.chainLabel)
    || left.key.localeCompare(right.key),
  );
  const projected = capRoutes(ordered);
  return {
    authoredTier: profile.tier,
    authoredTierLabel: getBridgeTierLabel(profile.tier, chainCount),
    weakestRouteTier,
    summary: profile.summary,
    reviewedAt: profile.reviewedAt,
    confidence: profile.confidence,
    confidenceLabel: RESEARCH_REVIEW_CONFIDENCE_LABELS[profile.confidence] ?? profile.confidence,
    routeCount: routes.length,
    unresolvedRouteCount,
    chainCount,
    thirdPartyRouteCount,
    tierCounts,
    homeChainId,
    routes: projected,
    routesTruncated: rows.length - projected.length,
    sources: profile.sources ?? [],
  };
}

/**
 * Join each projected route to its bridge component in the runtime report card.
 * The engine keys a bridge component `bridge:<deploymentKey>:<controlKey>` and
 * every bridge control key starts `bridge-` (`bridge-meta:`, `bridge-supply:`,
 * `bridge-group:`), so the prefix match is exact; a route owns at most one.
 */
export function bindBridgeRouteControlComponents(
  summary: BridgeRouteRiskClientSummary,
  components: readonly { key: string; kind: string }[] | null | undefined,
): BridgeRouteRiskClientSummary {
  const bridgeKeys = (components ?? []).filter((component) => component.kind === "bridge").map((component) => component.key);
  if (bridgeKeys.length === 0) return summary;
  return {
    ...summary,
    routes: summary.routes.map((route) => ({
      ...route,
      controlComponentKey: bridgeKeys.find((key) => key.startsWith(`bridge:${route.key}:bridge-`)) ?? null,
    })),
  };
}
