import { logWorkerEventArgs } from "../structured-log";
import type { ContractEventConfig } from "../blacklist-contracts";
import { decimalNumberFromBigInt } from "../bigint";
import { encodeBalanceOfCallData } from "../evm-selectors";
import {
  type SubrequestBudget,
  type RateLimitedFetch,
  budgetExhausted,
} from "../evm-logs";
import { fetchEtherscanProxyHex, fetchJsonRpcHexAtUrl, parseUint256Hex } from "../evm-rpc";
import { getChainRpc, hasRegistryRpc, registryRpcEndpoints, type ChainRpcConfig } from "../chain-registry";
import { fetchJsonWithRetry } from "../fetch-retry";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import {
  normalizeTronAddress,
  tronBase58ToHex,
  tronHexAddressToBase58,
} from "../tron-address";
import { DRPC_NETWORK } from "@shared/lib/drpc";

interface EvmBalanceOptions {
  deadlineMs?: number;
  onProviderAttempt?: (provider: "drpc" | "chain_rpc" | "etherscan") => void;
  maxRetries?: number;
}

async function fetchEvmBalanceAtTag(
  evmChainId: number,
  contractAddress: string,
  address: string,
  blockNumberOrTag: number | "latest",
  apiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal: AbortSignal | undefined,
  options: EvmBalanceOptions,
): Promise<bigint | null> {
  if (!apiKey) return null;
  const data = encodeBalanceOfCallData(address);

  try {
    const result = await rateLimit(async () => {
      throwIfAborted(signal);
      const remainingMs = options.deadlineMs == null ? 10_000 : options.deadlineMs - Date.now();
      if (budgetExhausted(budget) || remainingMs <= 0) return null;
      budget.count++;
      options.onProviderAttempt?.("etherscan");
      return fetchEtherscanProxyHex({
        evmChainId,
        action: "eth_call",
        to: contractAddress,
        data,
        blockNumberOrTag,
        apiKey,
        signal,
        timeoutMs: Math.min(10_000, remainingMs),
        deadlineMs: options.deadlineMs,
        maxRetries: options.maxRetries ?? 0,
      });
    });
    return parseUint256Hex(result);
  } catch (e) {
    rethrowIfAborted(e, signal);
    logWorkerEventArgs("lib", "warn", "[sync-blacklist] fetchEvmBalanceAtTag failed:", e);
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
  budget: SubrequestBudget,
  signal: AbortSignal | undefined,
  options: EvmBalanceOptions,
): Promise<bigint | null> {
  throwIfAborted(signal);
  const remainingMs = options.deadlineMs == null ? 10_000 : options.deadlineMs - Date.now();
  if (budgetExhausted(budget) || remainingMs <= 0) return null;

  const network = DRPC_NETWORK[chainId];
  if (!network) return null;

  const data = encodeBalanceOfCallData(address);
  const blockTag = blockNumberOrTag === "latest" ? "latest" : "0x" + blockNumberOrTag.toString(16);

  try {
    budget.count++;
    options.onProviderAttempt?.("drpc");
    const result = await fetchJsonRpcHexAtUrl(
      `https://lb.drpc.org/ogrpc?network=${network}&dkey=${drpcApiKey}`,
      "eth_call",
      [{ to: contractAddress, data }, blockTag],
      {
        signal,
        timeoutMs: Math.min(10_000, remainingMs),
        deadlineMs: options.deadlineMs,
        maxRetries: options.maxRetries ?? 0,
      },
    );
    return parseUint256Hex(result);
  } catch (e) {
    rethrowIfAborted(e, signal);
    logWorkerEventArgs("lib", "warn", "[sync-blacklist] fetchBalanceViaDrpc failed:", e);
    return null;
  }
}

async function fetchBalanceViaChainRpc(
  chainId: string,
  contractAddress: string,
  address: string,
  blockNumberOrTag: number | "latest",
  budget: SubrequestBudget,
  signal: AbortSignal | undefined,
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  options: EvmBalanceOptions,
): Promise<bigint | null> {
  if (!chainRpcs) return null;

  const rpc = getChainRpc(chainRpcs, chainId);
  if (!hasRegistryRpc(rpc)) return null;

  const data = encodeBalanceOfCallData(address);
  const blockTag = blockNumberOrTag === "latest" ? "latest" : "0x" + blockNumberOrTag.toString(16);
  // Balance recovery retains its incumbent operators, independent of state placement.
  const urls = registryRpcEndpoints(rpc).filter((endpoint) => endpoint.operator !== "dwellir").map((endpoint) => endpoint.url);

  for (const rpcUrl of urls) {
    throwIfAborted(signal);
    const remainingMs = options.deadlineMs == null ? 10_000 : options.deadlineMs - Date.now();
    if (budgetExhausted(budget) || remainingMs <= 0) return null;
    try {
      budget.count++;
      options.onProviderAttempt?.("chain_rpc");
      const result = await fetchJsonRpcHexAtUrl(
        rpcUrl,
        "eth_call",
        [{ to: contractAddress, data }, blockTag],
        {
          signal,
          timeoutMs: Math.min(10_000, remainingMs),
          deadlineMs: options.deadlineMs,
          maxRetries: options.maxRetries ?? 0,
        },
      );
      const raw = parseUint256Hex(result);
      if (raw != null) return raw;
    } catch (e) {
      rethrowIfAborted(e, signal);
      logWorkerEventArgs("lib", "warn", "[sync-blacklist] fetchBalanceViaChainRpc failed:", e);
    }
  }

  return null;
}

export async function fetchEvmTokenBalanceRaw(
  config: ContractEventConfig,
  address: string,
  blockNumberOrTag: number | "latest",
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  options: EvmBalanceOptions = {},
): Promise<bigint | null> {
  if (config.chain.evmChainId == null) return null;
  if (blockNumberOrTag !== "latest" && (!Number.isSafeInteger(blockNumberOrTag) || blockNumberOrTag < 0)) return null;

  // Transport fallback is shared; the caller retains historical/snapshot evidence semantics.
  if (drpcApiKey) {
    const drpcAmount = await fetchBalanceViaDrpc(
      config.chain.chainId,
      config.contractAddress,
      address,
      blockNumberOrTag,
      drpcApiKey,
      budget,
      signal,
      options,
    );
    if (drpcAmount != null) return drpcAmount;
  }

  const rpcAmount = await fetchBalanceViaChainRpc(
    config.chain.chainId,
    config.contractAddress,
    address,
    blockNumberOrTag,
    budget,
    signal,
    chainRpcs,
    options,
  );
  if (rpcAmount != null) return rpcAmount;

  return fetchEvmBalanceAtTag(
    config.chain.evmChainId,
    config.contractAddress,
    address,
    blockNumberOrTag,
    etherscanApiKey,
    rateLimit,
    budget,
    signal,
    options,
  );
}

export async function fetchEvmTokenBalance(
  config: ContractEventConfig,
  address: string,
  blockNumberOrTag: number | "latest",
  etherscanApiKey: string | null,
  drpcApiKey: string | null,
  rateLimit: RateLimitedFetch,
  budget: SubrequestBudget,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<number | null> {
  const raw = await fetchEvmTokenBalanceRaw(
    config, address, blockNumberOrTag, etherscanApiKey, drpcApiKey, rateLimit, budget, signal, chainRpcs,
    { maxRetries: 1 },
  );
  return raw == null ? null : decimalNumberFromBigInt(raw, config.decimals);
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
    logWorkerEventArgs("lib", "warn", "[sync-blacklist] fetchTronTokenCurrentBalanceViaJsonRpc failed:", error);
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
    logWorkerEventArgs("lib", "warn", "[sync-blacklist] fetchTronTokenCurrentBalance failed:", error);
    return null;
  }
}
