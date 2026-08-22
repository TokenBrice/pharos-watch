import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEtherscanProxyHex,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import { tronBase58ToHex } from "../../lib/tron-address";
import { rethrowIfAborted } from "../../lib/abort";
import { logWorkerEventArgs } from "../../lib/structured-log";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { fetchJsonPostWithRetry } from "./request";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;
type EvmCallInput = Pick<EvmInput, "chain"> & { rpcMode?: EvmInput["rpcMode"] };
type EvmBlockNumberOrTag = number | "latest";

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
  blockNumberOrTag?: EvmBlockNumberOrTag;
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
  blockNumberOrTag?: EvmBlockNumberOrTag;
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
  const blockNumberOrTag = options.blockNumberOrTag ?? "latest";
  return runWithRpcFallback<bigint>(
    options,
    "evm-uint256",
    (extraRpcUrls) =>
      fetchEvmUint256AtBlock(options.chain, options.contract, options.data, blockNumberOrTag, {
        extraRpcUrls,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
        chainRpcs: options.ctx?.chainRpcs,
      }),
    () =>
      fetchEtherscanUint256AtBlock(1, options.contract, options.data, blockNumberOrTag, {
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
      options.blockNumberOrTag ?? "latest",
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
  const decimals = probe.decimals;
  if (decimals == null) {
    logWorkerEventArgs("handler", "warn",
      `[onchain-rate] probe skipped for ${probe.contract}: decimals are missing`,
    );
    return null;
  }
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
  const blockNumberOrTag = options.blockNumberOrTag ?? "latest";
  return runWithRpcFallback<string>(
    options,
    "evm-call",
    (extraRpcUrls) =>
      fetchEvmCallHexAtBlock(options.chain, options.contract, options.data, blockNumberOrTag, {
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
        blockNumberOrTag,
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

const TRON_TOTAL_SUPPLY_FUNCTION_SELECTOR = "totalSupply()";
// Tron's constant-contract call requires a well-formed owner_address even for
// reads that never inspect msg.sender; the zero address is the standard filler.
const TRON_ZERO_OWNER_ADDRESS_HEX41 = "410000000000000000000000000000000000000000";

interface TronTriggerConstantContractResponse {
  result?: { result?: boolean };
  constant_result?: string[];
}

/**
 * TRC-20 totalSupply() via TronGrid's wallet/triggerconstantcontract endpoint.
 * Mirrors fetchErc20TotalSupply's fail-closed contract: any read failure
 * (bad address, HTTP error, contract revert) resolves to null rather than
 * throwing, so callers can fold it into the same success/failure aggregation.
 */
export async function fetchTronErc20TotalSupply(
  contractAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<bigint | null> {
  const contractHex = await tronBase58ToHex(contractAddress);
  if (!contractHex) return null;
  const contractHex41 = `41${contractHex.slice(2)}`;

  const headers: Record<string, string> = {};
  if (ctx?.trongridApiKey) headers["TRON-PRO-API-KEY"] = ctx.trongridApiKey;

  try {
    const json = await fetchJsonPostWithRetry<TronTriggerConstantContractResponse>(
      "https://api.trongrid.io/wallet/triggerconstantcontract",
      {
        owner_address: TRON_ZERO_OWNER_ADDRESS_HEX41,
        contract_address: contractHex41,
        function_selector: TRON_TOTAL_SUPPLY_FUNCTION_SELECTOR,
        parameter: "",
        visible: false,
      },
      signal,
      10_000,
      ctx,
      { headers },
    );

    if (json.result?.result !== true) return null;
    const raw = json.constant_result?.[0];
    if (!raw) return null;
    return BigInt(`0x${raw}`);
  } catch (error) {
    rethrowIfAborted(error, signal);
    // Null feeds the caller's omittedReadFailureChains degraded warning, which
    // already surfaces the failing chain on status surfaces.
    return null;
  }
}
