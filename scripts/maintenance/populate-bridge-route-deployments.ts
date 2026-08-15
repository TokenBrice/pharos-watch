#!/usr/bin/env tsx

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type {
  BridgeRouteDeployment,
  BridgeRouteRiskProfile,
  BridgeRouteRiskTier,
  ContractDeployment,
} from "@shared/types/core";

const ROOT = resolve(import.meta.dirname, "../..");

export const BRIDGE_ROUTE_FACTS_MAPPING_VERSION = "bridge-route-facts-v1";

interface ReviewedRouteFact {
  chains: readonly string[];
  protocol: string;
  issuanceModel: BridgeRouteDeployment["issuanceModel"];
  routeClass: BridgeRouteDeployment["routeClass"];
  riskTier: BridgeRouteRiskTier;
  semantics: BridgeRouteDeployment["semantics"];
  scope: Exclude<BridgeRouteDeployment["scope"], "unknown">;
  sourceChain?: string;
  canonicalChain?: string;
}

// This is deliberately small. These facts are supported by the corresponding
// profile summaries and cited sources; an absent deployment remains unresolved.
const REVIEWED_ROUTE_FACTS_V1: Readonly<Record<string, readonly ReviewedRouteFact[]>> = {
  "aid-gaib": [
    {
      chains: ["ethereum"],
      protocol: "GAIB",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["arbitrum", "base", "bsc"],
      protocol: "LayerZero OFT",
      issuanceModel: "bridge-representation",
      routeClass: "third-party",
      riskTier: "external-validated-network",
      semantics: "burn-mint",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "bold-liquity": [
    {
      chains: ["ethereum"],
      protocol: "Liquity V2",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["arbitrum", "base", "optimism", "avalanche", "hyperevm", "sonic"],
      protocol: "Chainlink CCIP",
      issuanceModel: "bridge-representation",
      routeClass: "third-party",
      riskTier: "external-validated-network",
      semantics: "other",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "dai-makerdao": [
    {
      chains: ["ethereum"],
      protocol: "MakerDAO",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["optimism"],
      protocol: "MakerDAO Optimism DAI Bridge",
      issuanceModel: "bridge-representation",
      routeClass: "canonical",
      riskTier: "external-lock-mint",
      semantics: "lock-mint",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "buidl-blackrock": [
    {
      chains: ["ethereum"],
      protocol: "Securitize",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["bsc", "optimism", "arbitrum", "avalanche", "polygon", "solana", "aptos"],
      protocol: "Wormhole",
      issuanceModel: "bridge-representation",
      routeClass: "third-party",
      riskTier: "external-validated-network",
      semantics: "other",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "crvusd-curve": [
    {
      chains: ["ethereum"],
      protocol: "Curve",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["arbitrum", "base", "optimism", "zksync"],
      protocol: "Canonical rollup bridge",
      issuanceModel: "bridge-representation",
      routeClass: "canonical",
      riskTier: "canonical-rollup-bridge",
      semantics: "lock-mint",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "eurc-circle": [
    {
      chains: ["ethereum", "base", "avalanche", "solana"],
      protocol: "Circle CCTP v2",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "issuer-native-burn-mint",
      semantics: "burn-mint",
      scope: "canonical",
    },
  ],
  "frax-frax": [
    {
      chains: ["ethereum"],
      protocol: "Frax",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
  ],
  "gho-aave": [
    {
      chains: ["ethereum"],
      protocol: "Aave",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["arbitrum", "base", "gnosis", "ink", "avalanche", "mantle", "plasma", "monad"],
      protocol: "Chainlink CCIP",
      issuanceModel: "bridge-representation",
      routeClass: "third-party",
      riskTier: "external-validated-network",
      semantics: "other",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "lusd-liquity": [
    {
      chains: ["ethereum"],
      protocol: "Liquity V1",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["arbitrum", "optimism"],
      protocol: "Canonical rollup bridge",
      issuanceModel: "bridge-representation",
      routeClass: "canonical",
      riskTier: "canonical-rollup-bridge",
      semantics: "lock-mint",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "pyusd-paypal": [
    {
      chains: ["ethereum", "solana", "stellar"],
      protocol: "Paxos / PayPal",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "issuer-native-burn-mint",
      semantics: "native-mint",
      scope: "canonical",
    },
  ],
  "sdai-sky": [
    {
      chains: ["ethereum"],
      protocol: "Sky",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["base", "optimism"],
      protocol: "Sky cross-chain deployment",
      issuanceModel: "bridge-representation",
      routeClass: "third-party",
      riskTier: "external-lock-mint",
      semantics: "lock-mint",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "susde-ethena": [
    {
      chains: ["ethereum"],
      protocol: "Ethena",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: [
        "plasma",
        "linea",
        "fraxtal",
        "hyperevm",
        "berachain",
        "zircuit",
        "metis",
        "xlayer",
        "base",
        "bsc",
        "morph-l2",
        "scroll",
        "kava",
        "swellchain",
        "mode",
        "mantle",
        "arbitrum",
        "manta",
        "blast",
        "optimism",
        "ton",
        "solana",
        "zksync",
        "avalanche",
        "aptos",
      ],
      protocol: "LayerZero OFT",
      issuanceModel: "bridge-representation",
      routeClass: "third-party",
      riskTier: "external-lock-mint",
      semantics: "lock-mint",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "syrupusdc-maple": [
    {
      chains: ["ethereum"],
      protocol: "Maple",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["base", "arbitrum", "solana"],
      protocol: "Chainlink CCIP",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "external-validated-network",
      semantics: "burn-mint",
      scope: "peripheral",
      canonicalChain: "ethereum",
    },
  ],
  "usde-ethena": [
    {
      chains: ["ethereum"],
      protocol: "Ethena",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
  ],
  "usdc-circle": [
    {
      chains: ["ethereum"],
      protocol: "Circle",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "issuer-native-burn-mint",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
  ],
  "usdf-falcon": [
    {
      chains: ["ethereum"],
      protocol: "Falcon Finance",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["bsc", "base", "xdc"],
      protocol: "Chainlink CCIP",
      issuanceModel: "bridge-representation",
      routeClass: "third-party",
      riskTier: "external-validated-network",
      semantics: "other",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
  "usdp-paxos": [
    {
      chains: ["ethereum", "solana"],
      protocol: "Paxos",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "issuer-native-burn-mint",
      semantics: "native-mint",
      scope: "canonical",
    },
  ],
  "ustb-superstate": [
    {
      chains: ["ethereum", "plume", "solana"],
      protocol: "Superstate",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
    },
  ],
  "usds-sky": [
    {
      chains: ["ethereum"],
      protocol: "Sky",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      canonicalChain: "ethereum",
    },
    {
      chains: ["solana"],
      protocol: "LayerZero",
      issuanceModel: "bridge-representation",
      routeClass: "third-party",
      riskTier: "external-lock-mint",
      semantics: "lock-mint",
      scope: "peripheral",
      sourceChain: "ethereum",
      canonicalChain: "ethereum",
    },
  ],
};

function unresolvedRoute(contract: ContractDeployment, profile: BridgeRouteRiskProfile): BridgeRouteDeployment {
  return {
    id: `${contract.chain}:${contract.address}`,
    destinationChain: contract.chain,
    contractAddress: contract.address,
    protocol: "unresolved route",
    issuanceModel: "unknown",
    routeClass: "unknown",
    riskTier: "opaque-or-unknown",
    semantics: "unknown",
    scope: "unknown",
    reviewDisposition: "unresolved",
    reviewNote: "Profile-level evidence does not identify this deployment's route semantics or scope.",
    mappingVersion: BRIDGE_ROUTE_FACTS_MAPPING_VERSION,
    observedAt: profile.reviewedAt,
  };
}

export function buildProfileDeploymentRoutes(
  profile: BridgeRouteRiskProfile,
  contracts: readonly ContractDeployment[],
  coinId?: string,
): BridgeRouteDeployment[] {
  const facts = coinId ? (REVIEWED_ROUTE_FACTS_V1[coinId] ?? []) : [];
  return contracts.map((contract) => {
    const fact = facts.find((candidate) => candidate.chains.includes(contract.chain));
    if (!fact) return unresolvedRoute(contract, profile);
    const reviewed = fact;
    return {
      id: `${contract.chain}:${contract.address}`,
      sourceChain: reviewed.sourceChain,
      destinationChain: contract.chain,
      canonicalChain: reviewed.canonicalChain,
      contractAddress: contract.address,
      protocol: reviewed.protocol,
      issuanceModel: reviewed.issuanceModel,
      routeClass: reviewed.routeClass,
      riskTier: reviewed.riskTier,
      semantics: reviewed.semantics,
      scope: reviewed.scope,
      reviewDisposition: "reviewed",
      mappingVersion: BRIDGE_ROUTE_FACTS_MAPPING_VERSION,
      observedAt: profile.reviewedAt,
      sources: profile.sources,
    };
  });
}

function sourcePath(id: string): string {
  const sidecar = resolve(ROOT, `shared/data/stablecoins/domains/risk-review/${id}.json`);
  return existsSync(sidecar) ? sidecar : resolve(ROOT, `shared/data/stablecoins/coins/${id}.json`);
}

export function populateBridgeRouteDeployments(): string[] {
  const updated: string[] = [];
  for (const coin of ACTIVE_STABLECOINS) {
    if ((coin.contracts?.length ?? 0) < 2 || !coin.bridgeRouteRisk) continue;
    const path = sourcePath(coin.id);
    const source = JSON.parse(readFileSync(path, "utf8")) as { bridgeRouteRisk?: BridgeRouteRiskProfile };
    if (!source.bridgeRouteRisk) throw new Error(`${coin.id}: bridgeRouteRisk is missing from ${path}`);
    source.bridgeRouteRisk.routes = buildProfileDeploymentRoutes(source.bridgeRouteRisk, coin.contracts ?? [], coin.id);
    writeFileSync(path, `${JSON.stringify(source, null, 2)}\n`, "utf8");
    updated.push(coin.id);
  }
  return updated;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const updated = populateBridgeRouteDeployments();
  process.stdout.write(`Mapped route deployments for ${updated.length} bridge profile(s).\n`);
}
