import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
} from "./helpers";
import { resolveCoinContractAddress } from "./evm";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "pusd-vault";

interface PusdVaultAssetConfig {
  address: string;
  decimals: number;
}

interface PusdVaultSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

function parseSliceConfig(
  params: ReturnType<typeof readParams>,
): PusdVaultSliceConfig {
  return {
    name: params.slice.name,
    risk: params.slice.risk,
    ...(params.slice.coinId ? { coinId: params.slice.coinId } : {}),
    ...(params.slice.depType ? { depType: params.slice.depType } : {}),
  };
}

function readParams(config: LiveReservesConfig) {
  return parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
}

/**
 * Reads a wrapper token's backing vault: sums `balanceOf(vaultAddress)` across
 * one or more underlying ERC-20 variants (e.g. native USDC + bridged USDC.e)
 * and compares it to the wrapper token's own `totalSupply()`. Built for
 * pUSD-Polymarket, whose immutable backing vault is a separate contract from
 * the CollateralToken itself rather than a value discoverable via a wrapper
 * selector (contrast `m0-wrapper-underlying`).
 */
export async function fetchPusdVaultReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readParams(config);
  const tokenAddress = resolveCoinContractAddress(coin, input.chain);
  if (!tokenAddress) {
    throw new Error(`${ADAPTER_KEY}: no ${input.chain} contract configured for ${coin.id}`);
  }
  const tokenDecimals = coin.contracts?.find((contract) => contract.chain === input.chain)?.decimals;
  if (tokenDecimals == null) {
    throw new Error(`${ADAPTER_KEY}: missing token decimals for ${coin.id}`);
  }

  const timeoutMs = 12_000;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  const assets: PusdVaultAssetConfig[] = params.assets;
  const [assetBalancesRaw, totalSupplyRaw] = await Promise.all([
    Promise.all(
      assets.map((asset) => onchain.uint256(asset.address, encodeBalanceOfCallData(params.vaultAddress))),
    ),
    onchain.uint256(tokenAddress, TOTAL_SUPPLY_SELECTOR),
  ]);

  if (totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY}: totalSupply() failed for ${coin.id}`);
  }

  let vaultBalanceUsd = 0;
  assetBalancesRaw.forEach((raw, index) => {
    if (raw == null) {
      throw new Error(`${ADAPTER_KEY}: balanceOf(vault) failed for asset ${assets[index].address}`);
    }
    vaultBalanceUsd += decimalNumberFromBigInt(raw, assets[index].decimals);
  });

  const supplyUsd = decimalNumberFromBigInt(totalSupplyRaw, tokenDecimals);
  const collateralizationRatio = supplyUsd > 0 ? vaultBalanceUsd / supplyUsd : undefined;
  const capacityRatioOfSupply = collateralizationRatio != null ? Math.min(1, collateralizationRatio) : undefined;
  const warnings = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `pUSD backing vault USDC balance covers ${pct}% of pUSD supply`,
    coverageRatio: collateralizationRatio,
  });

  const sliceConfig = parseSliceConfig(params);

  return {
    slices: [
      {
        name: sliceConfig.name,
        pct: 100,
        risk: sliceConfig.risk,
        ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
        ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
        blacklistable: true,
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "pusd-vault-balance" }),
      chain: input.chain,
      vaultAddress: params.vaultAddress,
      tokenAddress,
      totalSupplyRaw: totalSupplyRaw.toString(),
      vaultBalanceUsd,
      supplyUsd,
      ...(collateralizationRatio != null && Number.isFinite(collateralizationRatio)
        ? { collateralizationRatio }
        : {}),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: vaultBalanceUsd,
        ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
      }),
    },
  };
}
