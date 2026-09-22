import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import { DECIMALS_SELECTOR, encodeAddress, encodeBalanceOfCallData, TOTAL_VALUE_SELECTOR } from "../../lib/evm-selectors";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  slicesFromValues,
} from "./helpers";
import { validateDecimals } from "./slice-math";
import { pinnedBlockPlan } from "./evm-observation-plan";

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
  sourceKey?: string;
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
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "origin-vault-balances");
  const params = readParams(config);
  const coinDeployment = coin.contracts?.find((entry) => entry.chain === input.chain);
  if (!coinDeployment) {
    throw new Error(`origin-vault-balances has no reviewed ${input.chain} deployment for ${coin.id}`);
  }
  const timeoutMs = 12_000;
  const plan = await pinnedBlockPlan({ chain: input.chain, signal, ctx, rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl, timeoutMs });
  ctx = plan.ctx;
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
      sourceKey: `origin-vault-balances:${asset.address.toLowerCase()}`,
      value: decimalNumberFromBigInt(raw, asset.decimals),
      idleValue: decimalNumberFromBigInt(idleRaw, asset.decimals),
      idleRaw: idleRaw.toString(),
      name: asset.name,
      risk: asset.risk,
      ...(asset.coinId ? { coinId: asset.coinId } : {}),
      ...(asset.depType ? { depType: asset.depType } : {}),
    };
  }));

  // `totalValue()` is denominated in the coin's own unit, and the vault contract exposes no
  // ERC-20 `decimals()` of its own (verified live against the reviewed OUSD vault), so the
  // published scale comes from reading the tracked deployment's `decimals()` at the pinned
  // block and requiring it to match the reviewed deployment instead of assuming a scale.
  const [totalValueRaw, totalValueDecimalsRaw] = await Promise.all([
    onchain.uint256(params.vaultAddress, TOTAL_VALUE_SELECTOR),
    onchain.uint256(coinDeployment.address, DECIMALS_SELECTOR),
  ]);
  if (totalValueRaw == null || totalValueRaw <= 0n) {
    throw new Error("origin-vault-balances totalValue probe failed");
  }
  if (totalValueDecimalsRaw == null) {
    throw new Error(`origin-vault-balances decimals() probe failed for ${coin.id}`);
  }
  const totalValueDecimals = validateDecimals(totalValueDecimalsRaw, `origin-vault-balances ${coin.id} decimals()`);
  if (totalValueDecimals !== coinDeployment.decimals) {
    throw new Error(
      `origin-vault-balances ${coin.id} totalValue scale drifted (decimals() ${totalValueDecimals}, reviewed ${coinDeployment.decimals})`,
    );
  }

  const totalReserveUsd = values.reduce((sum, value) => sum + value.value, 0);
  if (totalReserveUsd <= 0) {
    throw new Error("origin-vault-balances produced zero reserve value");
  }
  const totalValueUsd = decimalNumberFromBigInt(totalValueRaw, totalValueDecimals);
  const immediateRedeemableUsd = values.reduce((sum, value) => sum + value.idleValue, 0);
  const assetCoverageRatio = totalReserveUsd / totalValueUsd;
  const unknownValue = Math.max(0, totalValueUsd - totalReserveUsd);
  const warnings = buildCoverageShortfallWarnings({
    code: "origin-vault-coverage-gap",
    message: (pct) => `Origin vault asset probes cover ${pct}% of totalValue()`,
    coverageRatio: assetCoverageRatio,
  });

  return {
    slices: slicesFromValues([
      ...values,
      { sourceKey: "origin-vault-balances:unknown", name: "Unmapped Origin vault exposure", value: unknownValue, risk: "high" },
    ]),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      observedBlock: plan.observedBlock,
      ...notApplicableFreshnessMetadata(),
      details: {
        proofKind: "origin-vault-check-balance",
        vaultAddress: params.vaultAddress,
        totalValueDecimals,
      },
      totalReserveUsd,
      totalValueUsd,
      assetCoverageRatio,
      unknownExposurePct: unknownValue / Math.max(totalReserveUsd, totalValueUsd) * 100,
      totalValueRaw: totalValueRaw.toString(),
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
