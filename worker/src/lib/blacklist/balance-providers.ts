import type { ContractEventConfig } from "../blacklist-contracts";
import { decimalNumberFromBigInt } from "../bigint";
import { encodeBalanceOfCallData } from "../evm-selectors";
import {
  type SubrequestBudget,
  type RateLimitedFetch,
  budgetExhausted,
} from "../evm-logs";
import { fetchEtherscanProxyHex, fetchJsonRpcHexAtUrl } from "../evm-rpc";
import { getChainRpc, type ChainRpcConfig } from "../chain-registry";
import { fetchJsonWithRetry } from "../fetch-retry";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import {
  normalizeTronAddress,
  tronBase58ToHex,
  tronHexAddressToBase58,
} from "../tron-address";
import { DRPC_NETWORK } from "../drpc";

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

  const data = encodeBalanceOfCallData(address);
  const blockNumberOrTag = tag === "latest" ? "latest" : Number.parseInt(tag, 16);
  if (typeof blockNumberOrTag === "number" && !Number.isFinite(blockNumberOrTag)) {
    console.warn(`[sync-blacklist] fetchEvmBalanceAtTag: invalid block tag "${tag}", returning null`);
    return null;
  }

  try {
    budget.count++;
    const result = await rateLimit(async () => fetchEtherscanProxyHex({
      evmChainId,
      action: "eth_call",
      to: contractAddress,
      data,
      blockNumberOrTag,
      apiKey,
      signal,
      timeoutMs: 10_000,
    }));

    if (!result) {
      return null;
    }

    return decimalNumberFromBigInt(BigInt(result), decimals);
  } catch (e) {
    rethrowIfAborted(e, signal);
    console.warn("[sync-blacklist] fetchEvmBalanceAtTag failed:", e);
    return null;
  }
}

// Fetch historical balanceOf via dRPC archive nodes.
// dRPC supports eth_call at arbitrary historical blocks on all supported EVM chains.
async function fetchBalanceViaDrpc(
  chainId: string,
  contractAddress: string,
  address: string,
  blockNumberOrTag: number | "latest",
  drpcApiKey: string,
  decimals: number,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  const network = DRPC_NETWORK[chainId];
  if (!network) return null;

  const data = encodeBalanceOfCallData(address);
  const blockTag = blockNumberOrTag === "latest" ? "latest" : "0x" + blockNumberOrTag.toString(16);

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
    return decimalNumberFromBigInt(BigInt(result), decimals);
  } catch (e) {
    rethrowIfAborted(e, signal);
    console.warn("[sync-blacklist] fetchBalanceViaDrpc failed:", e);
    return null;
  }
}

async function fetchBalanceViaChainRpc(
  chainId: string,
  contractAddress: string,
  address: string,
  blockNumberOrTag: number | "latest",
  decimals: number,
  budget: SubrequestBudget,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;
  if (!chainRpcs) return null;

  const rpc = getChainRpc(chainRpcs, chainId);
  if (!rpc) return null;

  const data = encodeBalanceOfCallData(address);
  const blockTag = blockNumberOrTag === "latest" ? "latest" : "0x" + blockNumberOrTag.toString(16);
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
      return decimalNumberFromBigInt(BigInt(result), decimals);
    } catch (e) {
      rethrowIfAborted(e, signal);
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
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<number | null> {
  // All EVM chains share the same fallback chain: dRPC -> chain-RPC -> Etherscan.
  throwIfAborted(signal);
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
    throwIfAborted(signal);
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
    chainRpcs,
  );
  throwIfAborted(signal);
  if (rpcAmount != null) return rpcAmount;

  // Etherscan is the last-resort fallback for all chains.
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

export async function fetchEvmTokenCurrentBalance(
  config: ContractEventConfig,
  address: string,
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<number | null> {
  if (config.chain.evmChainId == null) return null;

  // Mirror fetchEvmTokenBalance: dRPC -> chain-RPC -> Etherscan, so current-balance
  // snapshots use the same primary provider as the historical path when dRPC is configured.
  if (drpcApiKey) {
    const drpcAmount = await fetchBalanceViaDrpc(
      config.chain.chainId,
      config.contractAddress,
      address,
      "latest",
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
    "latest",
    config.decimals,
    budget,
    signal,
    chainRpcs,
  );
  if (rpcAmount != null) return rpcAmount;

  return fetchEvmBalanceAtTag(
    config.chain.evmChainId,
    config.contractAddress,
    address,
    "latest",
    etherscanApiKey,
    rateLimit,
    config.decimals,
    budget,
    signal,
  );
}

type TronAccountResponse = {
  data?: Array<{
    trc20?: Array<Record<string, string>>;
  }>;
};

async function fetchTronTokenCurrentBalanceViaJsonRpc(
  config: ContractEventConfig,
  address: string,
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;

  const accountHex = await normalizeTronAddress(address);
  const contractHex = await tronBase58ToHex(config.contractAddress);
  if (!accountHex || !contractHex) return null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  const data = encodeBalanceOfCallData(accountHex);

  try {
    budget.count++;
    const json = await rateLimit(async () => {
      const result = await fetchJsonWithRetry<{ result?: string }>(
        "https://api.trongrid.io/jsonrpc",
        {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: contractHex, data }, "latest"],
          }),
        },
      );
      if (!result?.response.ok) return null;
      return result.body;
    });

    if (!json?.result || !json.result.startsWith("0x")) return null;
    return decimalNumberFromBigInt(BigInt(json.result), config.decimals);
  } catch (error) {
    rethrowIfAborted(error, signal);
    console.warn("[sync-blacklist] fetchTronTokenCurrentBalanceViaJsonRpc failed:", error);
    return null;
  }
}

export async function fetchTronTokenCurrentBalance(
  config: ContractEventConfig,
  address: string,
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
): Promise<number | null> {
  if (budgetExhausted(budget)) return null;
  if (config.chain.type !== "tron") return null;

  const rpcAmount = await fetchTronTokenCurrentBalanceViaJsonRpc(
    config,
    address,
    apiKey,
    rateLimit,
    budget,
    signal,
  );
  throwIfAborted(signal);
  if (rpcAmount != null) return rpcAmount;

  const accountAddress = (await tronHexAddressToBase58(address)) ?? address;
  const headers: Record<string, string> = {};
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  try {
    budget.count++;
    const json = await rateLimit(async () => {
      const result = await fetchJsonWithRetry<TronAccountResponse>(
        `https://api.trongrid.io/v1/accounts/${accountAddress}`,
        { headers, signal },
      );
      if (!result?.response.ok) return null;
      return result.body;
    });

    const balances = json?.data?.[0]?.trc20;
    if (!Array.isArray(balances) || balances.length === 0) return null;

    const rawAmount = balances
      .map((entry) => entry[config.contractAddress])
      .find((value): value is string => typeof value === "string" && value.length > 0);
    if (!rawAmount) return null;

    return decimalNumberFromBigInt(BigInt(rawAmount), config.decimals);
  } catch (error) {
    rethrowIfAborted(error, signal);
    console.warn("[sync-blacklist] fetchTronTokenCurrentBalance failed:", error);
    return null;
  }
}
