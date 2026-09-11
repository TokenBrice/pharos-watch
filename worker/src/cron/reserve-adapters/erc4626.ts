import type { LiveReserveInput, LiveReserveWarning } from "@shared/types/live-reserves";
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

interface Erc4626NavConsistencyResultOptions {
  totalAssetsRaw: bigint;
  totalSupplyRaw: bigint | undefined;
  convertResult: string | null;
  warningCode: string;
}

export interface Erc4626NavConsistencyResult {
  navConsistencyRatio?: number;
  convertToAssetsRaw?: bigint;
  warnings: LiveReserveWarning[];
}

/**
 * ERC-4626 implementation-conformance check: convertToAssets(totalSupply) vs
 * totalAssets(). For any spec-compliant vault this ratio is 1 by construction,
 * so it measures accounting consistency, not solvency. It is published as
 * `details.navConsistencyRatio` — never as `collateralizationRatio`.
 */
export function computeErc4626NavConsistencyFromResult({
  totalAssetsRaw,
  totalSupplyRaw,
  convertResult,
  warningCode,
}: Erc4626NavConsistencyResultOptions): Erc4626NavConsistencyResult {
  const warnings: LiveReserveWarning[] = [];

  if (totalSupplyRaw == null || totalSupplyRaw <= 0n || !convertResult) {
    return { warnings };
  }

  const convertToAssetsRaw = BigInt(convertResult);
  let navConsistencyRatio: number | undefined;
  if (totalAssetsRaw > 0n) {
    navConsistencyRatio = ratioToNumber(convertToAssetsRaw, 0, totalAssetsRaw, 0, 12);
    const absoluteDifference = convertToAssetsRaw >= totalAssetsRaw
      ? convertToAssetsRaw - totalAssetsRaw
      : totalAssetsRaw - convertToAssetsRaw;
    if (
      Number.isFinite(navConsistencyRatio)
      && absoluteDifference * 100n > totalAssetsRaw
    ) {
      warnings.push(reserveDegradedWarning(
        warningCode,
        `convertToAssets(totalSupply) diverges from totalAssets by ${((navConsistencyRatio - 1) * 100).toFixed(2)}%`,
      ));
    }
  }

  return {
    convertToAssetsRaw,
    ...(navConsistencyRatio != null ? { navConsistencyRatio } : {}),
    warnings,
  };
}
