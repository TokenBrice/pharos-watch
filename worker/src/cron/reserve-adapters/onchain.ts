import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEtherscanProxyHex,
} from "../../lib/evm-rpc";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

interface EvmCallOptions {
  contract: string;
  data: string;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  rpcMode?: EvmInput["rpcMode"];
  chain?: string;
  timeoutMs?: number;
}

export interface OnchainRateProbe {
  contract: string;
  selector: string;
  decimals?: number;
}

export async function fetchOnchainUint256(options: EvmCallOptions): Promise<bigint | null> {
  return runAdapterIo(options.ctx, `evm-uint256:${options.chain ?? "unknown"}:${options.contract}`, async () => {
    const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );

    const rpcValue = await fetchEvmUint256AtBlock(
      options.chain,
      options.contract,
      options.data,
      "latest",
      {
        extraRpcUrls,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
        chainRpcs: options.ctx?.chainRpcs,
      },
    );
    if (rpcValue != null) {
      return rpcValue;
    }

    if (options.rpcMode === "etherscan-proxy") {
      if (options.chain !== "ethereum") return null;
      return fetchEtherscanUint256AtBlock(
        1,
        options.contract,
        options.data,
        "latest",
        {
          apiKey: options.ctx?.etherscanApiKey,
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? 10_000,
        },
      );
    }

    return null;
  });
}

export async function fetchOnchainRateBps(
  input: EvmInput,
  probe: OnchainRateProbe,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<number | null> {
  const decimals = probe.decimals ?? 18;
  const scale = 10n ** BigInt(decimals);
  const raw = await fetchOnchainUint256({
    contract: probe.contract,
    data: probe.selector,
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  });
  if (raw == null) return null;

  const roundedBps = (raw * 10_000n + scale / 2n) / scale;
  return Number(roundedBps);
}

export async function fetchOnchainRawCall(options: EvmCallOptions): Promise<string | null> {
  return runAdapterIo(options.ctx, `evm-call:${options.chain ?? "unknown"}:${options.contract}`, async () => {
    const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );

    const rpcValue = await fetchEvmCallHexAtBlock(
      options.chain,
      options.contract,
      options.data,
      "latest",
      {
        extraRpcUrls,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
        chainRpcs: options.ctx?.chainRpcs,
      },
    );
    if (rpcValue != null) {
      return rpcValue;
    }

    if (options.rpcMode === "etherscan-proxy") {
      if (options.chain !== "ethereum") return null;
      return fetchEtherscanProxyHex({
        evmChainId: 1,
        action: "eth_call",
        to: options.contract,
        data: options.data,
        blockNumberOrTag: "latest",
        apiKey: options.ctx?.etherscanApiKey,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
      });
    }

    return null;
  });
}

export async function fetchErc20Balance(
  input: EvmInput,
  contract: string,
  holder: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint | null> {
  return fetchOnchainUint256({
    contract,
    data: encodeBalanceOfCallData(holder),
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  });
}

export async function fetchErc20TotalSupply(
  input: EvmInput,
  contract: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint | null> {
  return fetchOnchainUint256({
    contract,
    data: TOTAL_SUPPLY_SELECTOR,
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  });
}
