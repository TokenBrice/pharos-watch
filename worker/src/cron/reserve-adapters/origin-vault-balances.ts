import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { encodeAddress, encodeBalanceOfCallData, TOTAL_VALUE_SELECTOR } from "../../lib/evm-selectors";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  slicesFromValues,
} from "./helpers";

const CHECK_BALANCE_SELECTOR = "0x5f515226";

interface OriginVaultAssetConfig {
  address: string;
  decimals: number;
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

interface OriginVaultBalancesParams {
  vaultAddress: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  assets: OriginVaultAssetConfig[];
}

interface OriginVaultAssetState {
  value: number;
  idleValue: number;
  idleRaw: string;
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

function readParams(config: LiveReservesConfig): OriginVaultBalancesParams {
  return parseLiveReserveAdapterParams("origin-vault-balances", config.params);
}

export async function fetchOriginVaultBalancesReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "origin-vault-balances");
  const params = readParams(config);
  const timeoutMs = 12_000;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });
  const values: OriginVaultAssetState[] = await Promise.all(params.assets.map(async (asset) => {
    const [raw, idleRaw] = await Promise.all([
      onchain.uint256(params.vaultAddress, `${CHECK_BALANCE_SELECTOR}${encodeAddress(asset.address)}`),
      onchain.uint256(asset.address, encodeBalanceOfCallData(params.vaultAddress)),
    ]);
    if (raw == null) {
      throw new Error(`origin-vault-balances checkBalance failed for ${asset.name}`);
    }
    if (idleRaw == null) {
      throw new Error(`origin-vault-balances idle balance probe failed for ${asset.name}`);
    }
    return {
      value: decimalNumberFromBigInt(raw, asset.decimals),
      idleValue: decimalNumberFromBigInt(idleRaw, asset.decimals),
      idleRaw: idleRaw.toString(),
      name: asset.name,
      risk: asset.risk,
      ...(asset.coinId ? { coinId: asset.coinId } : {}),
      ...(asset.depType ? { depType: asset.depType } : {}),
    };
  }));

  const totalValueRaw = await onchain.uint256(params.vaultAddress, TOTAL_VALUE_SELECTOR);
  if (totalValueRaw == null || totalValueRaw <= 0n) {
    throw new Error("origin-vault-balances totalValue probe failed");
  }

  const totalReserveUsd = values.reduce((sum, value) => sum + value.value, 0);
  if (totalReserveUsd <= 0) {
    throw new Error("origin-vault-balances produced zero reserve value");
  }
  const totalValueUsd = decimalNumberFromBigInt(totalValueRaw, 18);
  const immediateRedeemableUsd = values.reduce((sum, value) => sum + value.idleValue, 0);
  const assetCoverageRatio = totalReserveUsd / totalValueUsd;
  const warnings = buildCoverageShortfallWarnings({
    code: "origin-vault-coverage-gap",
    message: (pct) => `Origin vault asset probes cover ${pct}% of totalValue()`,
    coverageRatio: assetCoverageRatio,
  });

  return {
    slices: slicesFromValues(values),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(),
      details: {
        proofKind: "origin-vault-check-balance",
        vaultAddress: params.vaultAddress,
      },
      totalReserveUsd,
      totalValueUsd,
      assetCoverageRatio,
      totalValueRaw: totalValueRaw.toString(),
      immediateRedeemableUsd,
      idleVaultBalances: values.map((value) => ({
        name: value.name,
        value: value.idleValue,
        raw: value.idleRaw,
        ...(value.coinId ? { coinId: value.coinId } : {}),
      })),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: immediateRedeemableUsd,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        ...(config.display?.url ? { sourceUrls: [config.display.url] } : {}),
      }),
    },
  };
}
