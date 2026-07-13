import { resolveChainId } from "./chains";
import { BRIDGE_ROUTE_RISK_SCORE } from "./report-card-governance";
import type { BridgeRouteRiskTier, StablecoinMeta } from "../types/core";

const BRIDGE_ROUTE_MATERIAL_SHARE_THRESHOLD = 0.1;

export type BridgeRouteMaterialityStatus = "complete" | "partial" | "unavailable" | "not-applicable";

export interface BridgeRouteMaterialityRow {
  routeId: string;
  chain: string;
  contractAddress: string;
  scope: "global" | "canonical" | "peripheral" | "unknown";
  tier: BridgeRouteRiskTier;
  supplyUsd: number;
  supplyRatio: number;
  material: boolean;
  reviewDisposition: "reviewed" | "unresolved";
}

export interface BridgeRouteMaterialityResult {
  status: BridgeRouteMaterialityStatus;
  effectiveTier: BridgeRouteRiskTier | null;
  selectedRouteId: string | null;
  totalSupplyUsd: number;
  matchedSupplyUsd: number;
  unknownSupplyUsd: number;
  matchedSupplyRatio: number;
  unknownSupplyRatio: number;
  unresolvedSupplyUsd: number;
  unresolvedSupplyRatio: number;
  unknownChains: string[];
  routes: BridgeRouteMaterialityRow[];
  reason: string;
}

export type BridgeChainCirculating = Record<string, { current?: number } | null | undefined>;

function canonicalChain(chain: string): string {
  return resolveChainId(chain) ?? chain.trim().toLowerCase();
}

function canonicalAddress(address: string): string {
  const trimmed = address.trim();
  return /^0x[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function ratio(value: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
}

export function resolveBridgeRouteMateriality(
  meta: Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk">,
  chainCirculating: BridgeChainCirculating | null | undefined,
): BridgeRouteMaterialityResult {
  const profile = meta.bridgeRouteRisk;
  if (!profile) {
    return {
      status: "not-applicable",
      effectiveTier: null,
      selectedRouteId: null,
      totalSupplyUsd: 0,
      matchedSupplyUsd: 0,
      unknownSupplyUsd: 0,
      matchedSupplyRatio: 0,
      unknownSupplyRatio: 0,
      unresolvedSupplyUsd: 0,
      unresolvedSupplyRatio: 0,
      unknownChains: [],
      routes: [],
      reason: "No reviewed bridge-route profile.",
    };
  }
  if ((profile.routes?.length ?? 0) === 0) {
    return {
      status: "not-applicable",
      effectiveTier: profile.tier,
      selectedRouteId: null,
      totalSupplyUsd: 0,
      matchedSupplyUsd: 0,
      unknownSupplyUsd: 0,
      matchedSupplyRatio: 0,
      unknownSupplyRatio: 0,
      unresolvedSupplyUsd: 0,
      unresolvedSupplyRatio: 0,
      unknownChains: [],
      routes: [],
      reason: "The reviewed profile has no applicable multi-deployment route rows.",
    };
  }

  const supplyByChain = new Map<string, number>();
  for (const [chain, point] of Object.entries(chainCirculating ?? {})) {
    const current = point?.current;
    if (typeof current !== "number" || !Number.isFinite(current) || current <= 0) continue;
    const canonical = canonicalChain(chain);
    supplyByChain.set(canonical, (supplyByChain.get(canonical) ?? 0) + current);
  }
  const totalSupplyUsd = [...supplyByChain.values()].reduce((sum, value) => sum + value, 0);
  if (totalSupplyUsd <= 0) {
    return {
      status: "unavailable",
      effectiveTier: null,
      selectedRouteId: null,
      totalSupplyUsd: 0,
      matchedSupplyUsd: 0,
      unknownSupplyUsd: 0,
      matchedSupplyRatio: 0,
      unknownSupplyRatio: 0,
      unresolvedSupplyUsd: 0,
      unresolvedSupplyRatio: 0,
      unknownChains: [],
      routes: [],
      reason: "Runtime chain supply is unavailable.",
    };
  }

  const contractsByChain = new Map<string, string[]>();
  for (const contract of meta.contracts ?? []) {
    const chain = canonicalChain(contract.chain);
    contractsByChain.set(chain, [...(contractsByChain.get(chain) ?? []), canonicalAddress(contract.address)]);
  }
  const routesByDeployment = new Map<string, NonNullable<typeof profile.routes>>();
  for (const route of profile.routes ?? []) {
    const key = `${canonicalChain(route.destinationChain)}:${canonicalAddress(route.contractAddress)}`;
    routesByDeployment.set(key, [...(routesByDeployment.get(key) ?? []), route]);
  }

  const rows: BridgeRouteMaterialityRow[] = [];
  const unknownChains: string[] = [];
  let matchedSupplyUsd = 0;
  let unknownSupplyUsd = 0;
  let unresolvedSupplyUsd = 0;
  for (const [chain, supplyUsd] of [...supplyByChain].sort(([left], [right]) => left.localeCompare(right))) {
    const contracts = contractsByChain.get(chain) ?? [];
    if (contracts.length !== 1) {
      unknownSupplyUsd += supplyUsd;
      unknownChains.push(chain);
      continue;
    }
    const matches = routesByDeployment.get(`${chain}:${contracts[0]}`) ?? [];
    if (matches.length !== 1) {
      unknownSupplyUsd += supplyUsd;
      unknownChains.push(chain);
      continue;
    }
    const route = matches[0]!;
    const supplyRatio = ratio(supplyUsd, totalSupplyUsd);
    matchedSupplyUsd += supplyUsd;
    if (route.reviewDisposition === "unresolved") unresolvedSupplyUsd += supplyUsd;
    rows.push({
      routeId: route.id,
      chain,
      contractAddress: contracts[0]!,
      scope: route.scope,
      tier: route.riskTier,
      supplyUsd,
      supplyRatio,
      material:
        route.scope === "global" ||
        route.scope === "canonical" ||
        ((route.scope === "peripheral" || route.scope === "unknown") &&
          supplyRatio >= BRIDGE_ROUTE_MATERIAL_SHARE_THRESHOLD),
      reviewDisposition: route.reviewDisposition,
    });
  }

  const unknownSupplyRatio = ratio(unknownSupplyUsd, totalSupplyUsd);
  const unresolvedSupplyRatio = ratio(unresolvedSupplyUsd, totalSupplyUsd);
  const eligible = rows.filter((row) => row.material);
  const unresolvedScope = eligible
    .filter((row) => row.scope === "unknown")
    .sort((left, right) => right.supplyRatio - left.supplyRatio || left.routeId.localeCompare(right.routeId))[0];
  let selected: BridgeRouteMaterialityRow | undefined = eligible.sort(
    (left, right) =>
      BRIDGE_ROUTE_RISK_SCORE[left.tier] - BRIDGE_ROUTE_RISK_SCORE[right.tier] ||
      right.supplyRatio - left.supplyRatio ||
      left.routeId.localeCompare(right.routeId),
  )[0];

  if (unresolvedScope) {
    selected = unresolvedScope;
  }
  if (unknownSupplyRatio >= BRIDGE_ROUTE_MATERIAL_SHARE_THRESHOLD) {
    selected = undefined;
  }
  const effectiveTier =
    unknownSupplyRatio >= BRIDGE_ROUTE_MATERIAL_SHARE_THRESHOLD || unresolvedScope
      ? "opaque-or-unknown"
      : (selected?.tier ?? null);
  const status: BridgeRouteMaterialityStatus = unknownSupplyUsd > 0 || unresolvedSupplyUsd > 0 ? "partial" : "complete";
  return {
    status,
    effectiveTier,
    selectedRouteId: selected?.routeId ?? null,
    totalSupplyUsd,
    matchedSupplyUsd,
    unknownSupplyUsd,
    matchedSupplyRatio: ratio(matchedSupplyUsd, totalSupplyUsd),
    unknownSupplyRatio,
    unresolvedSupplyUsd,
    unresolvedSupplyRatio,
    unknownChains,
    routes: rows.sort((left, right) => left.routeId.localeCompare(right.routeId)),
    reason:
      unknownSupplyRatio >= BRIDGE_ROUTE_MATERIAL_SHARE_THRESHOLD
        ? `At least ${Math.round(unknownSupplyRatio * 100)}% of runtime supply cannot be assigned to one reviewed route.`
        : unresolvedScope
          ? `Route ${unresolvedScope.routeId} has unresolved route facts and represents ${Math.round(unresolvedScope.supplyRatio * 100)}% of supply.`
          : selected
            ? `Selected ${selected.routeId} as the weakest reviewed material route (${Math.round(selected.supplyRatio * 100)}% of supply).`
            : "No reviewed route is currently material.",
  };
}
