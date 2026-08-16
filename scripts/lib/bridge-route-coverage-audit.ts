import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import type { BridgeRouteDeployment, BridgeRouteScope, StablecoinMeta } from "@shared/types/core";

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
    unresolvedRouteProfiles: number;
    missingProfiles: number;
    incompleteRouteProfiles: number;
    invalidEvidenceProfiles: number;
    coverageTheaterProfiles: number;
    sameChainAmbiguityProfiles: number;
    routes: number;
    reviewedRoutes: number;
    unresolvedRoutes: number;
    routeScopes: Record<BridgeRouteScope, number>;
  };
  missingProfiles: BridgeRouteCoverageCoinRow[];
  incompleteRouteProfiles: BridgeRouteCoverageCoinRow[];
  unresolvedRouteProfiles: BridgeRouteCoverageCoinRow[];
  invalidEvidenceProfiles: BridgeRouteCoverageCoinRow[];
  coverageTheaterProfiles: BridgeRouteCoverageCoinRow[];
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

function evidenceReasons(route: BridgeRouteDeployment): string[] {
  const prefix = route.id;
  if (route.reviewDisposition === "reviewed") {
    const reasons: string[] = [];
    if ((route.sources?.length ?? 0) === 0) reasons.push(`${prefix} reviewed without route-level sources`);
    if (route.observedAt == null && route.observedBlock == null) reasons.push(`${prefix} reviewed without observation point`);
    if (
      route.scope === "unknown" ||
      route.routeClass === "unknown" ||
      route.issuanceModel === "unknown" ||
      route.semantics === "unknown"
    ) {
      reasons.push(`${prefix} reviewed with unknown classification facts`);
    }
    if (route.routeClass === "native" && route.issuanceModel !== "native-issuance") {
      reasons.push(`${prefix} native deployment is mislabeled as a bridge representation`);
    }
    if (route.semantics === "native-mint" && route.issuanceModel !== "native-issuance") {
      reasons.push(`${prefix} native-mint semantics conflict with issuance model`);
    }
    return reasons;
  }
  const reasons: string[] = [];
  if ((route.reviewNote?.trim().length ?? 0) < 12) reasons.push(`${prefix} unresolved without an explicit reason`);
  if (
    route.scope !== "unknown" ||
    route.routeClass !== "unknown" ||
    route.issuanceModel !== "unknown" ||
    route.semantics !== "unknown" ||
    route.riskTier !== "opaque-or-unknown"
  ) {
    reasons.push(`${prefix} unresolved row claims classified route facts`);
  }
  return reasons;
}

function coverageTheaterReasons(profile: NonNullable<StablecoinMeta["bridgeRouteRisk"]>): string[] {
  const routes = profile.routes ?? [];
  if (routes.length < 2) return [];
  const reasons: string[] = [];
  if (routes.every((route) => route.scope === "global")) {
    reasons.push("all deployment rows copy global scope");
  }
  if (routes.every((route) => route.protocol === "profile-reviewed route")) {
    reasons.push("all deployment rows use the profile placeholder protocol");
  }
  if (
    routes.every(
      (route) =>
        route.riskTier === profile.tier &&
        (route.sources?.length ?? 0) === 0 &&
        route.reviewDisposition === "reviewed",
    )
  ) {
    reasons.push("profile tier was copied to every reviewed row without route-level evidence");
  }
  return reasons;
}

export function buildBridgeRouteCoverageAudit(
  coins: readonly StablecoinMeta[],
  generatedAt = new Date().toISOString(),
): BridgeRouteCoverageAudit {
  const active = coins.filter(isActiveStablecoinMeta);
  const applicable = active.filter((coin) => (coin.contracts?.length ?? 0) > 1);
  const missingProfiles: BridgeRouteCoverageCoinRow[] = [];
  const incompleteRouteProfiles: BridgeRouteCoverageCoinRow[] = [];
  const unresolvedRouteProfiles: BridgeRouteCoverageCoinRow[] = [];
  const invalidEvidenceProfiles: BridgeRouteCoverageCoinRow[] = [];
  const coverageTheaterProfiles: BridgeRouteCoverageCoinRow[] = [];
  const sameChainAmbiguityProfiles: BridgeRouteCoverageCoinRow[] = [];
  const routeScopes: Record<BridgeRouteScope, number> = { global: 0, canonical: 0, peripheral: 0, unknown: 0 };
  let routes = 0;
  let reviewedRoutes = 0;
  let unresolvedRoutes = 0;
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
    for (const route of authoredRoutes) {
      routeScopes[route.scope] += 1;
      if (route.reviewDisposition === "reviewed") reviewedRoutes += 1;
      else unresolvedRoutes += 1;
    }

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
    const completenessReasons: string[] = [];
    for (const key of contractCounts.keys()) {
      if ((routeCounts.get(key) ?? 0) !== 1) {
        completenessReasons.push(`${key} has ${routeCounts.get(key) ?? 0} route dispositions`);
      }
    }
    for (const key of routeCounts.keys()) {
      if (!contractCounts.has(key)) completenessReasons.push(`${key} does not match catalog contracts`);
    }
    if (completenessReasons.length > 0) incompleteRouteProfiles.push(row(coin, completenessReasons));

    const unresolvedReasons = authoredRoutes
      .filter((route) => route.reviewDisposition === "unresolved")
      .map((route) => `${route.id}: ${route.reviewNote ?? "unresolved"}`);
    if (unresolvedReasons.length > 0) unresolvedRouteProfiles.push(row(coin, unresolvedReasons));

    const invalidReasons = authoredRoutes.flatMap(evidenceReasons);
    if (invalidReasons.length > 0) invalidEvidenceProfiles.push(row(coin, invalidReasons));

    const theaterReasons = coverageTheaterReasons(profile);
    if (theaterReasons.length > 0) coverageTheaterProfiles.push(row(coin, theaterReasons));

    if (
      completenessReasons.length === 0 &&
      unresolvedReasons.length === 0 &&
      invalidReasons.length === 0 &&
      theaterReasons.length === 0
    ) {
      completeRouteProfiles += 1;
    }

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
          ambiguous.map((chain) => `${chain} has multiple contracts; runtime supply stays unknown`),
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
      unresolvedRouteProfiles: unresolvedRouteProfiles.length,
      missingProfiles: missingProfiles.length,
      incompleteRouteProfiles: incompleteRouteProfiles.length,
      invalidEvidenceProfiles: invalidEvidenceProfiles.length,
      coverageTheaterProfiles: coverageTheaterProfiles.length,
      sameChainAmbiguityProfiles: sameChainAmbiguityProfiles.length,
      routes,
      reviewedRoutes,
      unresolvedRoutes,
      routeScopes,
    },
    missingProfiles: sort(missingProfiles),
    incompleteRouteProfiles: sort(incompleteRouteProfiles),
    unresolvedRouteProfiles: sort(unresolvedRouteProfiles),
    invalidEvidenceProfiles: sort(invalidEvidenceProfiles),
    coverageTheaterProfiles: sort(coverageTheaterProfiles),
    sameChainAmbiguityProfiles: sort(sameChainAmbiguityProfiles),
  };
}
