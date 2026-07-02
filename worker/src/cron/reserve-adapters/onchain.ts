import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEtherscanProxyHex,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;
type EvmCallInput = Pick<EvmInput, "chain"> & { rpcMode?: EvmInput["rpcMode"] };

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

interface BoundOnchainCallOptions {
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  timeoutMs?: number;
}

export type OnchainUint256Caller = (contract: string, data: string) => Promise<bigint | null>;
export type OnchainRawCaller = (contract: string, data: string) => Promise<string | null>;

export interface OnchainCallers {
  uint256: OnchainUint256Caller;
  raw: OnchainRawCaller;
}

export interface OnchainRateProbe {
  contract: string;
  selector: string;
  decimals?: number;
}

export interface OnchainMulticall3Call {
  label: string;
  contract: string;
  data: string;
  allowFailure?: boolean;
}

interface EvmMulticall3Options {
  calls: readonly OnchainMulticall3Call[];
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  chain?: string;
  timeoutMs?: number;
  multicallBatchSize?: number;
}

async function runWithRpcFallback<T>(
  options: EvmCallOptions,
  opLabel: string,
  runRpc: (extraRpcUrls: string[]) => Promise<T | null>,
  runEtherscan: () => Promise<T | null>,
): Promise<T | null> {
  return runAdapterIo(options.ctx, `${opLabel}:${options.chain ?? "unknown"}:${options.contract}`, async () => {
    const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );

    const rpcValue = await runRpc(extraRpcUrls);
    if (rpcValue != null) {
      return rpcValue;
    }

    if (options.rpcMode === "etherscan-proxy") {
      if (options.chain !== "ethereum") return null;
      return runEtherscan();
    }

    return null;
  });
}

export function makeOnchainCallers(input: EvmCallInput, options: BoundOnchainCallOptions): OnchainCallers {
  const callBase = {
    signal: options.signal,
    ctx: options.ctx,
    rpcUrl: options.rpcUrl,
    fallbackRpcUrl: options.fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
    timeoutMs: options.timeoutMs,
  };

  return {
    uint256: (contract: string, data: string) =>
      fetchOnchainUint256({
        ...callBase,
        contract,
        data,
      }),
    raw: (contract: string, data: string) =>
      fetchOnchainRawCall({
        ...callBase,
        contract,
        data,
      }),
  };
}

export async function fetchOnchainUint256(options: EvmCallOptions): Promise<bigint | null> {
  return runWithRpcFallback<bigint>(
    options,
    "evm-uint256",
    (extraRpcUrls) =>
      fetchEvmUint256AtBlock(options.chain, options.contract, options.data, "latest", {
        extraRpcUrls,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
        chainRpcs: options.ctx?.chainRpcs,
      }),
    () =>
      fetchEtherscanUint256AtBlock(1, options.contract, options.data, "latest", {
        apiKey: options.ctx?.etherscanApiKey,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
      }),
  );
}

export async function fetchOnchainMulticall3(options: EvmMulticall3Options): Promise<EvmMulticall3Result[] | null> {
  return runAdapterIo(options.ctx, `evm-multicall3:${options.chain ?? "unknown"}:${options.calls.length}`, async () => {
    const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );

    return fetchEvmMulticall3Aggregate3AtBlock(
      options.chain,
      options.calls.map((call) => ({
        label: call.label,
        target: call.contract,
        callData: call.data,
        allowFailure: call.allowFailure,
      })),
      "latest",
      {
        extraRpcUrls,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
        chainRpcs: options.ctx?.chainRpcs,
        multicallBatchSize: options.multicallBatchSize,
      },
    );
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
  return runWithRpcFallback<string>(
    options,
    "evm-call",
    (extraRpcUrls) =>
      fetchEvmCallHexAtBlock(options.chain, options.contract, options.data, "latest", {
        extraRpcUrls,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
        chainRpcs: options.ctx?.chainRpcs,
      }),
    () =>
      fetchEtherscanProxyHex({
        evmChainId: 1,
        action: "eth_call",
        to: options.contract,
        data: options.data,
        blockNumberOrTag: "latest",
        apiKey: options.ctx?.etherscanApiKey,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
      }),
  );
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
