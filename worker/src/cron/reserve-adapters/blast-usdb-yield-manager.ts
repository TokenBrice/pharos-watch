import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TOTAL_SUPPLY_SELECTOR, TOTAL_VALUE_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";

interface BlastUsdbYieldManagerParams {
  yieldManagerAddress: string;
  supplyChain: string;
  supplyTokenAddress: string;
  supplyRpcUrl: string;
  fallbackSupplyRpcUrl?: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}

function readParams(config: LiveReservesConfig): BlastUsdbYieldManagerParams {
  return parseLiveReserveAdapterParams("blast-usdb-yield-manager", config.params);
}

export async function fetchBlastUsdbYieldManagerReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "blast-usdb-yield-manager");
  const params = readParams(config);
  const timeoutMs = 12_000;
  const managerOnchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });
  const supplyOnchain = makeOnchainCallers(
    { chain: params.supplyChain, rpcMode: "public-rpc" },
    {
      signal,
      ctx,
      rpcUrl: params.supplyRpcUrl,
      fallbackRpcUrl: params.fallbackSupplyRpcUrl,
      timeoutMs,
    },
  );
  const [totalValueRaw, totalSupplyRaw] = await Promise.all([
    managerOnchain.uint256(params.yieldManagerAddress, TOTAL_VALUE_SELECTOR),
    supplyOnchain.uint256(params.supplyTokenAddress, TOTAL_SUPPLY_SELECTOR),
  ]);
  if (totalValueRaw == null || totalValueRaw <= 0n) {
    throw new Error("blast-usdb-yield-manager totalValue probe failed");
  }
  if (totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    throw new Error("blast-usdb-yield-manager totalSupply probe failed");
  }

  const totalReserveUsd = decimalNumberFromBigInt(totalValueRaw, 18);
  const supplyUsd = decimalNumberFromBigInt(totalSupplyRaw, 18);
  const collateralizationRatio = totalReserveUsd / supplyUsd;
  const warnings = buildCoverageShortfallWarnings({
    code: "blast-usdb-undercollateralized",
    message: (pct) => `Blast USDYieldManager totalValue() is ${pct}% of USDB supply`,
    coverageRatio: collateralizationRatio,
  });

  return {
    slices: [
      {
        name: "MakerDAO DSR / DAI yield manager",
        pct: 100,
        risk: "low",
        coinId: "dai-makerdao",
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(),
      details: {
        proofKind: "blast-usdb-yield-manager-total-value",
        yieldManagerAddress: params.yieldManagerAddress,
        supplyChain: params.supplyChain,
        supplyTokenAddress: params.supplyTokenAddress,
      },
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio,
      totalValueRaw: totalValueRaw.toString(),
      totalSupplyRaw: totalSupplyRaw.toString(),
    },
  };
}
