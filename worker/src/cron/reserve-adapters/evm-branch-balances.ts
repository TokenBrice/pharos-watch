import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  probeOptionalRedemptionRateBps,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";
import {
  adaptBranchBalanceReserves,
  fetchBranchBalances,
  fetchBranchPriceMap,
  readBranchBalanceParams,
} from "./branch-balances";

const ADAPTER_KEY = "evm-branch-balances";
const DEFAULT_DEBT_DECIMALS = 18;

export async function fetchEvmBranchBalancesReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readBranchBalanceParams(config, ADAPTER_KEY);
  const debtSelector = params.debtSelector;
  const debtDecimals = params.debtDecimals ?? DEFAULT_DEBT_DECIMALS;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  const [balances, redemptionFeeBps, debtRaw] = await Promise.all([
    fetchBranchBalances(input, params, signal, ctx),
    probeOptionalRedemptionRateBps(
      input,
      params.redemptionRateProbe,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
    debtSelector
      ? onchain.uint256(params.debtContract ?? params.branches[0].holder, debtSelector)
      : Promise.resolve(null),
  ]);

  const priceMapWarnings: LiveReserveWarning[] = [];
  const priceMap = await fetchBranchPriceMap(balances, signal, priceMapWarnings, ctx);

  const baseMetadata = redemptionFeeBps != null
    ? buildRedemptionSnapshotMetadata({
        feeBps: redemptionFeeBps,
        freshnessKind: "same-run-onchain",
      })
    : undefined;

  // If debt reconciliation is configured, compute collateralizationRatio from
  // the sum of priced branch balances and the on-chain debt read.
  if (debtSelector && debtRaw != null) {
    const totalDebtUsd = decimalNumberFromBigInt(debtRaw, debtDecimals);
    const totalCollateralUsd = balances.reduce((sum, entry) => {
      if (entry.balanceRaw == null || entry.balanceRaw <= 0n) return sum;
      const price = entry.branch.priceUsd ?? priceMap.get(entry.branch.name);
      if (price == null) return sum;
      return sum + decimalNumberFromBigInt(entry.balanceRaw, entry.branch.token.decimals) * price;
    }, 0);
    const collateralizationRatio = totalDebtUsd > 0 ? totalCollateralUsd / totalDebtUsd : null;
    const warnings: LiveReserveWarning[] = [];
    if (collateralizationRatio != null && collateralizationRatio < 1.0) {
      warnings.push(reserveDegradedWarning(
        "undercollateralized",
        `${ADAPTER_KEY} collateralization ratio ${collateralizationRatio.toFixed(4)} below 1.0 (collateral ${totalCollateralUsd.toFixed(2)} USD vs debt ${totalDebtUsd.toFixed(2)} USD)`,
      ));
    }
    const result = adaptBranchBalanceReserves({
      adapterKey: ADAPTER_KEY,
      balances,
      priceMap,
      metadata: {
        ...(baseMetadata ?? {}),
        totalDebtUsd,
        ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
      },
    });
    const merged = [...warnings, ...priceMapWarnings];
    return merged.length > 0
      ? { ...result, warnings: [...(result.warnings ?? []), ...merged] }
      : result;
  }

  const result = adaptBranchBalanceReserves({
    adapterKey: ADAPTER_KEY,
    balances,
    priceMap,
    metadata: baseMetadata,
  });
  return priceMapWarnings.length > 0
    ? { ...result, warnings: [...(result.warnings ?? []), ...priceMapWarnings] }
    : result;
}
