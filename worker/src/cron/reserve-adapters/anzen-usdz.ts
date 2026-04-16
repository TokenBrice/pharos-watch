import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { getPublicRpcUrl } from "../../lib/public-rpc-registry";
import {
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";

const ADAPTER_KEY = "anzen-usdz";
const DEFAULT_SPCT_POOL_CONTRACT = "0xf30a29F1C540724Fd8c5c4Be1AF604a6C6800D29";
const SPCT_POOL_DECIMALS = 18;
const SUPPLY_CHAINS = ["ethereum", "base", "arbitrum", "blast", "manta"] as const;
type SupportedSupplyChain = (typeof SUPPLY_CHAINS)[number];

/** Blast and Manta are not in the public RPC registry — keep hardcoded fallbacks. */
const NON_REGISTRY_RPC_URLS: Partial<Record<SupportedSupplyChain, string>> = {
  blast: "https://rpc.blast.io",
  manta: "https://pacific-rpc.manta.network/http",
};

function getSupplyChainRpcUrl(chain: SupportedSupplyChain): string {
  const registryUrl = getPublicRpcUrl(chain);
  if (registryUrl) return registryUrl;
  const fallback = NON_REGISTRY_RPC_URLS[chain];
  if (fallback) return fallback;
  throw new Error(`${ADAPTER_KEY} no RPC URL available for chain ${chain}`);
}

function getRequiredContract(
  coin: StablecoinMeta,
  chain: SupportedSupplyChain,
): { address: string; decimals: number } {
  const contract = coin.contracts?.find((entry) => entry.chain === chain);
  if (!contract) {
    throw new Error(`${ADAPTER_KEY} missing ${chain} contract metadata for ${coin.id}`);
  }
  return { address: contract.address, decimals: contract.decimals };
}

export async function fetchAnzenUsdzReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const spctPoolAddress = params.spctPoolAddress ?? DEFAULT_SPCT_POOL_CONTRACT;

  const supplyEntries = await Promise.all(
    SUPPLY_CHAINS.map(async (chain) => {
      const contract = getRequiredContract(coin, chain);
      const rawSupply = await fetchErc20TotalSupply(
        { kind: "onchain-evm", chain, rpcMode: primaryInput.rpcMode },
        contract.address,
        signal,
        ctx,
        getSupplyChainRpcUrl(chain),
        undefined,
      );
      if (rawSupply == null || rawSupply <= 0n) {
        throw new Error(`${ADAPTER_KEY} totalSupply probe failed for ${coin.id} on ${chain}`);
      }
      return [chain, decimalNumberFromBigInt(rawSupply, contract.decimals)] as const;
    }),
  );

  const reserveRaw = await fetchErc20TotalSupply(
    { kind: "onchain-evm", chain: "ethereum", rpcMode: primaryInput.rpcMode },
    spctPoolAddress,
    signal,
    ctx,
    getSupplyChainRpcUrl("ethereum"),
    undefined,
  );
  if (reserveRaw == null || reserveRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} SPCT reserve totalSupply probe failed`);
  }

  const supplyByChainUsd = Object.fromEntries(supplyEntries) as Record<SupportedSupplyChain, number>;
  const supplyUsd = Object.values(supplyByChainUsd).reduce((sum, value) => sum + value, 0);
  const totalReserveUsd = decimalNumberFromBigInt(reserveRaw, SPCT_POOL_DECIMALS);

  if (!Number.isFinite(supplyUsd) || supplyUsd <= 0) {
    throw new Error(`${ADAPTER_KEY} computed invalid USDz multichain supply`);
  }
  if (!Number.isFinite(totalReserveUsd) || totalReserveUsd <= 0) {
    throw new Error(`${ADAPTER_KEY} computed invalid SPCT reserve size`);
  }

  return {
    slices: [
      {
        name: "SPCT (Secured Private Credit Token)",
        pct: 100,
        risk: "high",
      },
    ],
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "multichain-usdz-vs-spct-total-supply",
        reserveSourceLabel: "SPCT pool total supply",
        supplySourceLabel: "USDz total supply across official deployments",
      }),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio: totalReserveUsd / supplyUsd,
      details: {
        proofKind: "multichain-usdz-vs-spct-total-supply",
        reserveSourceLabel: "SPCT pool total supply",
        supplySourceLabel: "USDz total supply across official deployments",
        reserveContract: spctPoolAddress,
        reserveChain: "ethereum",
        supplyByChainUsd,
        supplyChains: SUPPLY_CHAINS,
      },
    },
  };
}
