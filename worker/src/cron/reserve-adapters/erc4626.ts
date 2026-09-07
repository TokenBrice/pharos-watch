import type { LiveReserveInput, LiveReserveWarning } from "@shared/types/live-reserves";
import { encodeUint256 } from "../../lib/evm-selectors";
import { ratioToNumber } from "../../lib/authoritative-price-sources/helpers";
import type { AdapterContext } from "./types";
import {
  makeOnchainCallers,
  reserveDegradedWarning,
} from "./helpers";

type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

export const ERC4626_TOTAL_ASSETS_SELECTOR = "0x01e1d114";
export const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
export const ERC4626_CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";

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
  const { raw } = makeOnchainCallers(
    { chain: options.chain, rpcMode: options.rpcMode },
    options,
  );
  return (data: string) => raw(options.contractAddress, data);
}

interface Erc4626CollateralizationRatioOptions {
  call: ContractRawCaller;
  totalAssetsRaw: bigint;
  totalSupplyRaw: bigint | undefined;
  warningCode: string;
}

interface Erc4626CollateralizationRatioResultOptions {
  totalAssetsRaw: bigint;
  totalSupplyRaw: bigint | undefined;
  convertResult: string | null;
  warningCode: string;
}

export interface Erc4626CollateralizationRatioResult {
  collateralizationRatio?: number;
  convertToAssetsRaw?: bigint;
  warnings: LiveReserveWarning[];
}

export function computeErc4626CollateralizationRatioFromResult({
  totalAssetsRaw,
  totalSupplyRaw,
  convertResult,
  warningCode,
}: Erc4626CollateralizationRatioResultOptions): Erc4626CollateralizationRatioResult {
  const warnings: LiveReserveWarning[] = [];

  if (totalSupplyRaw == null || totalSupplyRaw <= 0n || !convertResult) {
    return { warnings };
  }

  const convertToAssetsRaw = BigInt(convertResult);
  let collateralizationRatio: number | undefined;
  if (totalAssetsRaw > 0n) {
    collateralizationRatio = ratioToNumber(convertToAssetsRaw, 0, totalAssetsRaw, 0, 12);
    const absoluteDifference = convertToAssetsRaw >= totalAssetsRaw
      ? convertToAssetsRaw - totalAssetsRaw
      : totalAssetsRaw - convertToAssetsRaw;
    if (
      Number.isFinite(collateralizationRatio)
      && absoluteDifference * 100n > totalAssetsRaw
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

export async function computeErc4626CollateralizationRatio({
  call,
  totalAssetsRaw,
  totalSupplyRaw,
  warningCode,
}: Erc4626CollateralizationRatioOptions): Promise<Erc4626CollateralizationRatioResult> {
  if (totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    return { warnings: [] };
  }

  const convertResult = await call(
    `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(totalSupplyRaw)}`,
  );
  return computeErc4626CollateralizationRatioFromResult({
    totalAssetsRaw,
    totalSupplyRaw,
    convertResult,
    warningCode,
  });
}
