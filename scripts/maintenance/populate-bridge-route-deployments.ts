#!/usr/bin/env tsx

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVE_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import type {
  BridgeRouteDeployment,
  BridgeRouteRiskProfile,
  BridgeRouteRiskTier,
  ContractDeployment,
} from "../../shared/types/core";

const ROOT = resolve(import.meta.dirname, "../..");

interface RouteDefaults {
  issuanceModel: BridgeRouteDeployment["issuanceModel"];
  routeClass: BridgeRouteDeployment["routeClass"];
  semantics: BridgeRouteDeployment["semantics"];
}

const ROUTE_DEFAULTS: Record<BridgeRouteRiskTier, RouteDefaults> = {
  "single-chain-or-native": {
    issuanceModel: "native-issuance",
    routeClass: "native",
    semantics: "native-mint",
  },
  "issuer-native-burn-mint": {
    issuanceModel: "native-issuance",
    routeClass: "native",
    semantics: "burn-mint",
  },
  "canonical-rollup-bridge": {
    issuanceModel: "bridge-representation",
    routeClass: "canonical",
    semantics: "lock-mint",
  },
  "issuer-native-lock-mint": {
    issuanceModel: "bridge-representation",
    routeClass: "native",
    semantics: "lock-mint",
  },
  "external-validated-network": {
    issuanceModel: "bridge-representation",
    routeClass: "third-party",
    semantics: "other",
  },
  "liquidity-or-intent-route": {
    issuanceModel: "liquidity-settlement",
    routeClass: "third-party",
    semantics: "liquidity",
  },
  "external-lock-mint": {
    issuanceModel: "bridge-representation",
    routeClass: "third-party",
    semantics: "lock-mint",
  },
  "opaque-or-unknown": {
    issuanceModel: "unknown",
    routeClass: "third-party",
    semantics: "unknown",
  },
};

export function buildProfileDeploymentRoutes(
  profile: BridgeRouteRiskProfile,
  contracts: readonly ContractDeployment[],
): BridgeRouteDeployment[] {
  const defaults = ROUTE_DEFAULTS[profile.tier];
  const protocol = profile.protocols?.[0]?.name ?? "profile-reviewed route";
  return contracts.map((contract) => ({
    id: `${contract.chain}:${contract.address}`,
    destinationChain: contract.chain,
    contractAddress: contract.address,
    protocol,
    issuanceModel: defaults.issuanceModel,
    routeClass: defaults.routeClass,
    riskTier: profile.tier,
    semantics: defaults.semantics,
    // The existing asset-level profile applied to every deployment. Marking the
    // migrated rows global preserves that reviewed v8 decision; future reviews
    // can narrow a genuinely peripheral route without changing other rows.
    scope: "global",
    observedAt: profile.reviewedAt,
  }));
}

function sourcePath(id: string): string {
  const sidecar = resolve(ROOT, `shared/data/stablecoins/domains/risk-review/${id}.json`);
  return existsSync(sidecar) ? sidecar : resolve(ROOT, `shared/data/stablecoins/coins/${id}.json`);
}

export function populateBridgeRouteDeployments(): string[] {
  const updated: string[] = [];
  for (const coin of ACTIVE_STABLECOINS) {
    if ((coin.contracts?.length ?? 0) < 2 || !coin.bridgeRouteRisk || coin.bridgeRouteRisk.routes?.length) continue;
    const path = sourcePath(coin.id);
    const source = JSON.parse(readFileSync(path, "utf8")) as { bridgeRouteRisk?: BridgeRouteRiskProfile };
    if (!source.bridgeRouteRisk) throw new Error(`${coin.id}: bridgeRouteRisk is missing from ${path}`);
    source.bridgeRouteRisk.routes = buildProfileDeploymentRoutes(source.bridgeRouteRisk, coin.contracts ?? []);
    writeFileSync(path, `${JSON.stringify(source, null, 2)}\n`, "utf8");
    updated.push(coin.id);
  }
  return updated;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const updated = populateBridgeRouteDeployments();
  process.stdout.write(`Populated route deployments for ${updated.length} bridge profile(s).\n`);
}
