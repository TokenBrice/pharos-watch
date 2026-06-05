import type { LiveReserveInput, LiveReserveWarning } from "@shared/types/live-reserves";
import { encodeUint256Arg } from "../../lib/evm-selectors";
import type { AdapterContext } from "./types";
import {
  fetchOnchainRawCall,
  reserveDegradedWarning,
} from "./helpers";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

export const ERC4626_TOTAL_ASSETS_SELECTOR = "0x01e1d114";
export const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
const ERC4626_CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";

export type ContractRawCaller = (data: string) => Promise<string | null>;

interface ContractRawCallerOptions {
  contractAddress: string;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcMode?: EvmInput["rpcMode"];
  chain: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  timeoutMs: number;
}

export function makeContractRawCaller(options: ContractRawCallerOptions): ContractRawCaller {
  return (data: string) =>
    fetchOnchainRawCall({
      contract: options.contractAddress,
      data,
      signal: options.signal,
      ctx: options.ctx,
      rpcMode: options.rpcMode,
      chain: options.chain,
      rpcUrl: options.rpcUrl,
      fallbackRpcUrl: options.fallbackRpcUrl,
      timeoutMs: options.timeoutMs,
    });
}

interface Erc4626CollateralizationRatioOptions {
  call: ContractRawCaller;
  totalAssetsRaw: bigint;
  totalSupplyRaw: bigint | undefined;
  warningCode: string;
}

export interface Erc4626CollateralizationRatioResult {
  collateralizationRatio?: number;
  convertToAssetsRaw?: bigint;
  warnings: LiveReserveWarning[];
}

export async function computeErc4626CollateralizationRatio({
  call,
  totalAssetsRaw,
  totalSupplyRaw,
  warningCode,
}: Erc4626CollateralizationRatioOptions): Promise<Erc4626CollateralizationRatioResult> {
  const warnings: LiveReserveWarning[] = [];

  if (totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    return { warnings };
  }

  const convertResult = await call(
    `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256Arg(totalSupplyRaw)}`,
  );
  if (!convertResult) {
    return { warnings };
  }

  const convertToAssetsRaw = BigInt(convertResult);
  let collateralizationRatio: number | undefined;
  if (totalAssetsRaw > 0n) {
    collateralizationRatio = Number(convertToAssetsRaw) / Number(totalAssetsRaw);
    if (
      Number.isFinite(collateralizationRatio)
      && Math.abs(collateralizationRatio - 1) > 0.01
    ) {
      warnings.push(reserveDegradedWarning(
        warningCode,
        `convertToAssets(totalSupply) diverges from totalAssets by ${((collateralizationRatio - 1) * 100).toFixed(2)}%`,
      ));
    }
  }

  return {
    convertToAssetsRaw,
    ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
    warnings,
  };
}
