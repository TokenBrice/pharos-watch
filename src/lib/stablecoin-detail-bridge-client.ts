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

/**
 * One projected route as serialized into the page payload: only what the
 * client cannot derive. Optional fields are omitted at their default, never
 * null. `expandBridgeRoute` restores the full `BridgeRouteClientRow`.
 */
export interface BridgeRouteWireRow {
  /** Normalized deployment id (`<chain>:<address>`); its prefix is the route's chain id. */
  key: string;
  tierKey: BridgeRouteRiskTier;
  /** Slug of the route's `protocol:<slug>` failure domain, when it has one. */
  protocolKey?: string;
  /** The route crosses a bridge; absent for native issuance. */
  bridged?: true;
  /** Reviewed bridge protocol, shipped only where a cell names it: a chain carrying several drawn routes. */
  protocolLabel?: string;
  /** The review is unresolved: the tier is the schema's unknown placeholder, not a reviewed finding. */
  unresolved?: true;
}

/** One reviewed route, sized for a deployment-strip cell (`expandBridgeRoute`). */
export interface BridgeRouteClientRow {
  /** Normalized deployment id (`<chain>:<address>`): joins `FailureDomainSpan.routeKeys` and control components. */
  key: string;
  /** The deployment-key prefix. */
  chainId: string;
  chainLabel: string;
  tierKey: BridgeRouteRiskTier;
  /** `getBridgeTierLabel`: the native tier reads "Native" on a multi-chain asset. */
  tierLabel: string;
  /** False for native issuance, which crosses no bridge. */
  bridged: boolean;
  /**
   * Reviewed bridge protocol on a chain carrying several drawn routes, where
   * the cell names it; null otherwise, and always null for native issuance.
   */
  protocolLabel: string | null;
  /** The route's `protocol:<slug>` failure domain; joins `FailureDomainSpan.protocolKeys`. */
  protocolKey: string | null;
  /** False for an unresolved route: its tier is the schema's unknown placeholder, not a reviewed finding. */
  reviewed: boolean;
  /**
   * `card.breakdowns.control.components[].key` of this route's bridge component.
   * Null until `bindBridgeRouteControlComponents` joins the runtime card. Stays
   * null when the engine compiled no component for the route (native
   * issuance, unresolved or immaterial routes).
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
  routes: BridgeRouteWireRow[];
  routesTruncated: number;
  sources: StablecoinLink[];
}

/** Published policy order (`BRIDGE_ROUTE_RISK_TIER_VALUES`, `bridgeTierQuality` descending). */
const TIER_ORDER: readonly BridgeRouteRiskTier[] = BRIDGE_TIER_POLICY_ORDER;

export function bridgeRouteTierLabel(tier: string): string {
  return BRIDGE_TIER_LABELS[tier as BridgeRouteRiskTier] ?? tier;
}

/** A route's chain id: the prefix of its normalized deployment key. */
function bridgeRouteChainId(key: string): string {
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(0, separator) : key;
}

/** Restores the derivable fields of a serialized route; `chainCount` is the summary's. */
export function expandBridgeRoute(row: BridgeRouteWireRow, chainCount: number): BridgeRouteClientRow {
  const chainId = bridgeRouteChainId(row.key);
  return {
    key: row.key,
    chainId,
    chainLabel: CHAIN_META[chainId]?.name ?? titleCaseSlug(chainId),
    tierKey: row.tierKey,
    tierLabel: getBridgeTierLabel(row.tierKey, chainCount),
    bridged: row.bridged === true,
    protocolLabel: row.protocolLabel ?? null,
    protocolKey: row.protocolKey ?? null,
    reviewed: row.unresolved !== true,
    controlComponentKey: null,
  };
}

export function expandBridgeRoutes(summary: BridgeRouteRiskClientSummary): BridgeRouteClientRow[] {
  return summary.routes.map((row) => expandBridgeRoute(row, summary.chainCount));
}

/** A projected route with the server-side facts ordering, capping and labelling need. */
interface RouteEntry {
  row: BridgeRouteWireRow;
  chainId: string;
  chainLabel: string;
  /** Reviewed protocol of a bridged route; null for native issuance. */
  protocol: string | null;
}

function projectRoute(route: BridgeRouteDeployment): RouteEntry {
  const protocolDomain = route.failureDomainKeys?.find((key) => key.startsWith("protocol:"));
  const native = route.routeClass === "native";
  const row: BridgeRouteWireRow = { key: normalizeDeploymentId(route.id) || route.id, tierKey: route.riskTier };
  if (protocolDomain !== undefined) row.protocolKey = protocolDomain.slice("protocol:".length);
  if (!native) row.bridged = true;
  if (route.reviewDisposition !== "reviewed") row.unresolved = true;
  const chainId = bridgeRouteChainId(row.key);
  const chainLabel = CHAIN_META[chainId]?.name ?? titleCaseSlug(chainId);
  return { row, chainId, chainLabel, protocol: native ? null : route.protocol };
}

/**
 * The single reviewed native chain; otherwise the chain most representations
 * name as canonical (a tie resolves to null), restricted to native chains when
 * the asset is natively issued on several.
 */
function resolveHomeChain(routes: readonly BridgeRouteDeployment[], entries: readonly RouteEntry[]): string | null {
  const nativeChains = new Set(
    entries.filter((entry) => entry.protocol === null && entry.row.unresolved !== true).map((entry) => entry.chainId),
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
 * legend counts. `entries` arrive in display order and keep it.
 */
function capRoutes(entries: readonly RouteEntry[]): RouteEntry[] {
  if (entries.length <= BRIDGE_ROUTE_PROJECTION_LIMIT) return [...entries];
  const groupOf = ({ row }: RouteEntry): string => (row.unresolved ? "unresolved" : row.tierKey);
  const groupOrder: readonly string[] = [...TIER_ORDER, "unresolved"];
  const totals = new Map<string, number>();
  for (const entry of entries) totals.set(groupOf(entry), (totals.get(groupOf(entry)) ?? 0) + 1);
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
  return entries.filter((entry) => {
    const group = groupOf(entry);
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
  const entries = routes.map(projectRoute);
  const chainCount = new Set(entries.map((entry) => entry.chainId)).size;
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
  const homeChainId = resolveHomeChain(routes, entries);
  const ordered = [...entries].sort((left, right) =>
    Number(right.chainId === homeChainId) - Number(left.chainId === homeChainId)
    || TIER_ORDER.indexOf(left.row.tierKey) - TIER_ORDER.indexOf(right.row.tierKey)
    || left.chainLabel.localeCompare(right.chainLabel)
    || left.row.key.localeCompare(right.row.key),
  );
  const projected = capRoutes(ordered);
  const drawnPerChain = new Map<string, number>();
  for (const { chainId } of projected) drawnPerChain.set(chainId, (drawnPerChain.get(chainId) ?? 0) + 1);
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
    routes: projected.map(({ row, chainId, protocol }) =>
      protocol !== null && drawnPerChain.get(chainId)! > 1 ? { ...row, protocolLabel: protocol } : row,
    ),
    routesTruncated: entries.length - projected.length,
    sources: profile.sources ?? [],
  };
}

/**
 * Expand the projected routes and join each to its bridge component in the
 * runtime report card. The engine keys a bridge component
 * `bridge:<deploymentKey>:<controlKey>` and every bridge control key starts
 * `bridge-` (`bridge-meta:`, `bridge-supply:`, `bridge-group:`), so the prefix
 * match is exact; a route owns at most one. Before the card arrives every
 * `controlComponentKey` stays null.
 */
export function bindBridgeRouteControlComponents(
  summary: BridgeRouteRiskClientSummary,
  components: readonly { key: string; kind: string }[] | null | undefined,
): BridgeRouteClientRow[] {
  const routes = expandBridgeRoutes(summary);
  const bridgeKeys = (components ?? []).filter((component) => component.kind === "bridge").map((component) => component.key);
  if (bridgeKeys.length === 0) return routes;
  return routes.map((route) => ({
    ...route,
    controlComponentKey: bridgeKeys.find((key) => key.startsWith(`bridge:${route.key}:bridge-`)) ?? null,
  }));
}
