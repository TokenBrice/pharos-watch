import { isActiveStablecoinMeta } from "../../shared/lib/stablecoins/status";
import type { BridgeRouteScope, StablecoinMeta } from "../../shared/types/core";

export interface BridgeRouteCoverageCoinRow {
  coinId: string;
  symbol: string;
  contractCount: number;
  routeCount: number;
  reasons: string[];
}

export interface BridgeRouteCoverageAudit {
  generatedAt: string;
  summary: {
    activeCoins: number;
    applicableMultiDeploymentCoins: number;
    reviewedProfiles: number;
    completeRouteProfiles: number;
    missingProfiles: number;
    incompleteRouteProfiles: number;
    sameChainAmbiguityProfiles: number;
    routes: number;
    routeScopes: Record<BridgeRouteScope, number>;
  };
  missingProfiles: BridgeRouteCoverageCoinRow[];
  incompleteRouteProfiles: BridgeRouteCoverageCoinRow[];
  sameChainAmbiguityProfiles: BridgeRouteCoverageCoinRow[];
}

function deploymentKey(chain: string, address: string): string {
  const trimmed = address.trim();
  const canonicalAddress = /^0x[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  return `${chain.trim().toLowerCase()}:${canonicalAddress}`;
}

function row(coin: StablecoinMeta, reasons: string[]): BridgeRouteCoverageCoinRow {
  return {
    coinId: coin.id,
    symbol: coin.symbol,
    contractCount: coin.contracts?.length ?? 0,
    routeCount: coin.bridgeRouteRisk?.routes?.length ?? 0,
    reasons,
  };
}

export function buildBridgeRouteCoverageAudit(
  coins: readonly StablecoinMeta[],
  generatedAt = new Date().toISOString(),
): BridgeRouteCoverageAudit {
  const active = coins.filter(isActiveStablecoinMeta);
  const applicable = active.filter((coin) => (coin.contracts?.length ?? 0) > 1);
  const missingProfiles: BridgeRouteCoverageCoinRow[] = [];
  const incompleteRouteProfiles: BridgeRouteCoverageCoinRow[] = [];
  const sameChainAmbiguityProfiles: BridgeRouteCoverageCoinRow[] = [];
  const routeScopes: Record<BridgeRouteScope, number> = { global: 0, canonical: 0, peripheral: 0, unknown: 0 };
  let routes = 0;
  let reviewedProfiles = 0;
  let completeRouteProfiles = 0;

  for (const coin of applicable) {
    const profile = coin.bridgeRouteRisk;
    if (!profile) {
      missingProfiles.push(row(coin, ["missing bridgeRouteRisk"]));
      continue;
    }
    reviewedProfiles += 1;
    const authoredRoutes = profile.routes ?? [];
    routes += authoredRoutes.length;
    for (const route of authoredRoutes) routeScopes[route.scope] += 1;

    const contractCounts = new Map<string, number>();
    for (const contract of coin.contracts ?? []) {
      const key = deploymentKey(contract.chain, contract.address);
      contractCounts.set(key, (contractCounts.get(key) ?? 0) + 1);
    }
    const routeCounts = new Map<string, number>();
    for (const route of authoredRoutes) {
      const key = deploymentKey(route.destinationChain, route.contractAddress);
      routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
    }
    const reasons: string[] = [];
    for (const key of contractCounts.keys()) {
      if ((routeCounts.get(key) ?? 0) !== 1) reasons.push(`${key} has ${routeCounts.get(key) ?? 0} reviewed routes`);
    }
    for (const key of routeCounts.keys()) {
      if (!contractCounts.has(key)) reasons.push(`${key} does not match catalog contracts`);
    }
    if (reasons.length > 0) incompleteRouteProfiles.push(row(coin, reasons));
    else completeRouteProfiles += 1;

    const chains = new Map<string, number>();
    for (const contract of coin.contracts ?? []) {
      const chain = contract.chain.trim().toLowerCase();
      chains.set(chain, (chains.get(chain) ?? 0) + 1);
    }
    const ambiguous = [...chains].filter(([, count]) => count > 1).map(([chain]) => chain);
    if (ambiguous.length > 0) {
      sameChainAmbiguityProfiles.push(
        row(
          coin,
          ambiguous.map((chain) => `${chain} has multiple contracts`),
        ),
      );
    }
  }

  const sort = (rows: BridgeRouteCoverageCoinRow[]) =>
    rows.sort((left, right) => left.coinId.localeCompare(right.coinId));
  return {
    generatedAt,
    summary: {
      activeCoins: active.length,
      applicableMultiDeploymentCoins: applicable.length,
      reviewedProfiles,
      completeRouteProfiles,
      missingProfiles: missingProfiles.length,
      incompleteRouteProfiles: incompleteRouteProfiles.length,
      sameChainAmbiguityProfiles: sameChainAmbiguityProfiles.length,
      routes,
      routeScopes,
    },
    missingProfiles: sort(missingProfiles),
    incompleteRouteProfiles: sort(incompleteRouteProfiles),
    sameChainAmbiguityProfiles: sort(sameChainAmbiguityProfiles),
  };
}
