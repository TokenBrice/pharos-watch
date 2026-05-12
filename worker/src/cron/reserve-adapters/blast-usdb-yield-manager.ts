import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchOnchainUint256,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";

const TOTAL_VALUE_SELECTOR = "0xd4c3eea0";

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
  const [totalValueRaw, totalSupplyRaw] = await Promise.all([
    fetchOnchainUint256({
      contract: params.yieldManagerAddress,
      data: TOTAL_VALUE_SELECTOR,
      signal,
      ctx,
      rpcMode: input.rpcMode,
      chain: input.chain,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      timeoutMs,
    }),
    fetchOnchainUint256({
      contract: params.supplyTokenAddress,
      data: TOTAL_SUPPLY_SELECTOR,
      signal,
      ctx,
      rpcMode: "public-rpc",
      chain: params.supplyChain,
      rpcUrl: params.supplyRpcUrl,
      fallbackRpcUrl: params.fallbackSupplyRpcUrl,
      timeoutMs,
    }),
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
  const warnings = collateralizationRatio < 0.995
    ? [
      reserveDegradedWarning(
        "blast-usdb-undercollateralized",
        `Blast USDYieldManager totalValue() is ${(collateralizationRatio * 100).toFixed(2)}% of USDB supply`,
      ),
    ]
    : undefined;

  return {
    slices: [
      {
        name: "MakerDAO DSR / DAI yield manager",
        pct: 100,
        risk: "low",
        coinId: "dai-makerdao",
      },
    ],
    ...(warnings ? { warnings } : {}),
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
