import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import type { StablecoinMeta } from "@shared/types/core";

// Synthetic inventories exercise complete census and route joins, not the
// current eligibility or deployment inventory of the production asset IDs.
export const CENSUS_FIXTURE_CLOCK_SEC = Date.UTC(2026, 9, 2) / 1_000;
export const CENSUS_FIXTURE_INDEPENDENT_IDS = [
  "sfrxusd-frax", "wsrusd-reservoir", "ussd-sonic-labs",
  "usdai-usd-ai", "usbd-bima", "yusd-aegis",
];
const MINT_A = "USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A";
const MINT_B = "So11111111111111111111111111111111111111112";

function censusMeta(id: string, chains: string[], nativeCount: number): StablecoinMeta {
  const contracts = chains.map((chain, index) => ({
    chain,
    address: chain === "solana" ? id === "usdai-usd-ai" ? MINT_A : MINT_B
      : `0x${(index + 1).toString(16).padStart(chain === "aptos" || chain === "movement" ? 64 : 40, "0")}`,
    decimals: chain === "solana" ? id === "usdai-usd-ai" ? 6 : 9
      : chain === "aptos" || chain === "movement" || chain === "tempo" ? 6 : 18,
  }));
  return makeStablecoinMeta({
    id, mechanismArchetype: "fiat-cash", launchDate: "2020-01-01", contracts,
    bridgeRouteRisk: {
      tier: "external-validated-network", summary: "Synthetic disjoint native and burn/mint inventories.",
      reviewedAt: "2026-09-30", reviewer: "Fixture reviewer", confidence: "verified",
      sources: [{ label: "Fixture route evidence", url: "https://example.com/routes" }],
      routes: contracts.map((deployment, index) => {
        const native = index < nativeCount;
        const controllerAddress = `0x${(index + 100).toString(16).padStart(40, "0")}`;
        return {
          id: `${deployment.chain}:${deployment.address}`,
          destinationChain: deployment.chain, contractAddress: deployment.address,
          protocol: "Fixture issuance", issuanceModel: native ? "native-issuance" : "bridge-representation",
          routeClass: native ? "native" : "third-party", riskTier: native ? "single-chain-or-native" : "external-validated-network",
          semantics: native ? "native-mint" : "burn-mint", scope: native ? "canonical" : "peripheral",
          reviewDisposition: "reviewed", observedAt: "2026-09-30",
          sources: [{ label: "Fixture route evidence", url: "https://example.com/routes" }],
          ...(!native ? { controllerChain: deployment.chain, controllerAddress, failureDomainKeys: [`contract:${deployment.chain}:${controllerAddress}`] } : {}),
        };
      }),
    },
  });
}

// Repeated EVM chains intentionally exercise exact contract joins as well as
// whole-asset inventories; all addresses are generated, never production pins.
export const CENSUS_FIXTURE_META_BY_ID = new Map([
  censusMeta("sfrxusd-frax", ["ethereum", "base", "aptos", "movement", "polygon-zkevm", ...Array<string>(25).fill("ethereum")], 2),
  censusMeta("wsrusd-reservoir", ["ethereum", "solana", ...Array<string>(19).fill("ethereum")], 1),
  censusMeta("ussd-sonic-labs", ["sonic", "ethereum", "base", "arbitrum", "optimism", "polygon"], 1),
  censusMeta("usdai-usd-ai", ["arbitrum", "ethereum", "base", "berachain", "solana"], 1),
  censusMeta("usbd-bima", ["ethereum", "base", "arbitrum", "optimism", "polygon", "nibiru"], 1),
  censusMeta("yusd-aegis", ["ethereum", "base", "arbitrum", "optimism"], 1),
].map(meta => [meta.id, meta]));
