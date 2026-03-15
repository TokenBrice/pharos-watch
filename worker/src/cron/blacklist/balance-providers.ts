import type { ContractEventConfig } from "../../lib/blacklist-contracts";
import { bigIntToDecimal } from "../../lib/bigint";
import {
  type SubrequestBudget,
  type RateLimitedFetch,
  budgetExhausted,
} from "../../lib/evm-logs";
import { fetchEtherscanProxyHex, fetchJsonRpcHexAtUrl } from "../../lib/evm-rpc";
import { getChainRpc } from "../../lib/chain-registry";

// dRPC network names for L2 chains (used to build RPC URL)
const DRPC_NETWORK: Record<string, string> = {
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  bsc: "bsc",
};

async function fetchEvmBalanceAtTag(
  evmChainId: number,
  contractAddress: string,
  address: string,
  tag: string,
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  decimals: number,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  // balanceOf(address) selector = 0x70a08231
  const addr = (address.startsWith("0x") ? address.slice(2) : address).toLowerCase();
  const data = "0x70a08231" + addr.padStart(64, "0");
  const blockNumberOrTag = tag === "latest" ? "latest" : Number.parseInt(tag, 16);

  try {
    budget.count++;
    const result = await rateLimit(async () => fetchEtherscanProxyHex({
      evmChainId,
      action: "eth_call",
      to: contractAddress,
      data,
      blockNumberOrTag: Number.isFinite(blockNumberOrTag) ? blockNumberOrTag : "latest",
      apiKey,
      signal,
      timeoutMs: 10_000,
    }));

    if (!result) {
      return null;
    }

    return bigIntToDecimal(BigInt(result), decimals);
  } catch (e) {
    console.warn("[sync-blacklist] fetchEvmBalanceAtTag failed:", e);
    return null;
  }
}

// Fetch historical balanceOf via dRPC archive nodes.
// dRPC supports eth_call at arbitrary historical blocks on all L2 chains.
async function fetchBalanceViaDrpc(
  chainId: string,
  contractAddress: string,
  address: string,
  blockNumber: number,
  drpcApiKey: string,
  decimals: number,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  const network = DRPC_NETWORK[chainId];
  if (!network) return null;

  const addr = (address.startsWith("0x") ? address.slice(2) : address).toLowerCase();
  const data = "0x70a08231" + addr.padStart(64, "0");
  const blockTag = "0x" + blockNumber.toString(16);

  try {
    budget.count++;
    const result = await fetchJsonRpcHexAtUrl(
      `https://lb.drpc.org/ogrpc?network=${network}&dkey=${drpcApiKey}`,
      "eth_call",
      [{ to: contractAddress, data }, blockTag],
      {
        signal,
        timeoutMs: 10_000,
      },
    );
    if (!result) return null;
    return bigIntToDecimal(BigInt(result), decimals);
  } catch (e) {
    console.warn("[sync-blacklist] fetchBalanceViaDrpc failed:", e);
    return null;
  }
}

async function fetchBalanceViaChainRpc(
  chainId: string,
  contractAddress: string,
  address: string,
  blockNumber: number,
  decimals: number,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  const rpc = getChainRpc(chainId);
  if (!rpc) return null;

  const addr = (address.startsWith("0x") ? address.slice(2) : address).toLowerCase();
  const data = "0x70a08231" + addr.padStart(64, "0");
  const blockTag = "0x" + blockNumber.toString(16);
  const urls = [rpc.rpcUrl, rpc.fallbackRpcUrl].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const rpcUrl of urls) {
    if (budgetExhausted(budget)) return null;
    try {
      budget.count++;
      const result = await fetchJsonRpcHexAtUrl(
        rpcUrl,
        "eth_call",
        [{ to: contractAddress, data }, blockTag],
        {
          signal,
          timeoutMs: 10_000,
        },
      );
      if (!result) continue;
      return bigIntToDecimal(BigInt(result), decimals);
    } catch (e) {
      console.warn("[sync-blacklist] fetchBalanceViaChainRpc failed:", e);
    }
  }

  return null;
}

export async function fetchEvmTokenBalance(
  config: ContractEventConfig,
  address: string,
  blockNumber: number,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  // Non-mainnet EVM chains prefer dRPC archive reads, but keep falling back through the
  // shared chain registry (Alchemy/public RPC) and Etherscan best-effort paths so one
  // provider outage does not strand amount backfills indefinitely.
  if (config.chain.evmChainId !== 1) {
    if (drpcApiKey) {
      const drpcAmount = await fetchBalanceViaDrpc(
        config.chain.chainId,
        config.contractAddress,
        address,
        blockNumber,
        drpcApiKey,
        config.decimals,
        budget,
        signal,
      );
      if (drpcAmount != null) return drpcAmount;
    }

    const rpcAmount = await fetchBalanceViaChainRpc(
      config.chain.chainId,
      config.contractAddress,
      address,
      blockNumber,
      config.decimals,
      budget,
      signal,
    );
    if (rpcAmount != null) return rpcAmount;
  }

  // Ethereum mainnet uses Etherscan directly; non-mainnet chains only reach this point
  // after dRPC and chain-RPC fallbacks have both missed.
  const blockTag = "0x" + blockNumber.toString(16);
  return fetchEvmBalanceAtTag(
    config.chain.evmChainId!,
    config.contractAddress,
    address,
    blockTag,
    etherscanApiKey,
    rateLimit,
    config.decimals,
    budget,
    signal,
  );
}
