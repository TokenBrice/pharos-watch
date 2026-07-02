import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { encodeUint256 } from "../../lib/evm-selectors";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchOnchainRateBps,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  valueUsdFromBigIntPrice,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "liquity-native-active-pool";
const DEFAULT_DEBT_DECIMALS = 18;
const DEFAULT_PRICE_DECIMALS = 18;
const DEFAULT_REDEMPTION_RATE_DECIMALS = 18;

function encodeUint256SelectorCall(selector: string, value: bigint): `0x${string}` {
  return `${selector}${encodeUint256(value)}` as `0x${string}`;
}

function ratio18(raw: bigint | null): number | null {
  if (raw == null) return null;
  const value = decimalNumberFromBigInt(raw, 18);
  return Number.isFinite(value) ? value : null;
}

export async function fetchLiquityNativeActivePoolReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const timeoutMs = 12_000;
  const debtDecimals = params.debtDecimals ?? DEFAULT_DEBT_DECIMALS;
  const priceDecimals = params.priceDecimals ?? DEFAULT_PRICE_DECIMALS;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  const [debtRaw, collateralRaw, priceRaw, mcrRaw, redemptionFeeBps] = await Promise.all([
    onchain.uint256(params.activePoolAddress, params.debtSelector),
    onchain.uint256(params.activePoolAddress, params.collateralBalanceSelector),
    onchain.uint256(params.priceFeedAddress, params.priceSelector),
    onchain.uint256(params.troveManagerAddress, params.mcrSelector),
    params.borrowerOperationsAddress && params.redemptionRateSelector
      ? fetchOnchainRateBps(
          input,
          {
            contract: params.borrowerOperationsAddress,
            selector: params.redemptionRateSelector,
            decimals: params.redemptionRateDecimals ?? DEFAULT_REDEMPTION_RATE_DECIMALS,
          },
          signal,
          ctx,
          params.rpcUrl,
          params.fallbackRpcUrl,
        )
      : Promise.resolve(null),
  ]);

  if (debtRaw == null || debtRaw <= 0n) throw new Error(`${ADAPTER_KEY} active-pool debt read is zero/unreadable`);
  if (collateralRaw == null || collateralRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} native collateral balance read is zero/unreadable`);
  }
  if (priceRaw == null || priceRaw <= 0n) throw new Error(`${ADAPTER_KEY} collateral price read is zero/unreadable`);
  if (mcrRaw == null || mcrRaw <= 0n) throw new Error(`${ADAPTER_KEY} MCR read is zero/unreadable`);

  const tcrRaw = await onchain.uint256(
    params.troveManagerAddress,
    encodeUint256SelectorCall(params.tcrSelector, priceRaw),
  );

  const priceUsd = decimalNumberFromBigInt(priceRaw, priceDecimals);
  const collateralUsd = valueUsdFromBigIntPrice(collateralRaw, params.collateralDecimals, priceUsd);
  const totalDebtUsd = decimalNumberFromBigInt(debtRaw, debtDecimals);
  if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) {
    throw new Error(`${ADAPTER_KEY} collateral value is invalid`);
  }
  if (!Number.isFinite(totalDebtUsd) || totalDebtUsd <= 0) {
    throw new Error(`${ADAPTER_KEY} debt value is invalid`);
  }

  const collateralizationRatio = collateralUsd / totalDebtUsd;
  const tcr = ratio18(tcrRaw);
  const mcr = ratio18(mcrRaw);
  const routeOpen = tcrRaw != null && tcrRaw >= mcrRaw;
  const routeStatus = tcrRaw == null ? "unknown" : routeOpen ? "open" : "degraded";
  const routeStatusReason =
    tcrRaw == null
      ? "Could not verify system TCR against MCR"
      : routeOpen
        ? undefined
        : "System TCR is below MCR, so redemptions are not currently a healthy open route";
  const warnings: LiveReserveWarning[] = [];
  if (!routeOpen) {
    warnings.push(reserveDegradedWarning(
      "redemption-route-status-degraded",
      routeStatusReason ?? "Native active-pool redemption route status could not be verified as open",
    ));
  }

  return {
    slices: [
      {
        name: params.collateralLabel,
        pct: 100,
        risk: params.collateralRisk,
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "liquity-native-active-pool",
      }),
      chain: input.chain,
      activePoolAddress: params.activePoolAddress,
      totalDebtUsd,
      totalReserveUsd: collateralUsd,
      immediateRedeemableUsd: totalDebtUsd,
      collateralizationRatio,
      collateralPriceUsd: priceUsd,
      ...(tcr != null ? { totalCollateralRatio: tcr } : {}),
      ...(mcr != null ? { minimumCollateralRatio: mcr } : {}),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: totalDebtUsd,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        ...(routeStatusReason ? { routeStatusReason } : {}),
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
        feeBps: redemptionFeeBps,
      }),
      details: {
        debtRaw: debtRaw.toString(),
        collateralRaw: collateralRaw.toString(),
        priceRaw: priceRaw.toString(),
        mcrRaw: mcrRaw.toString(),
        tcrRaw: tcrRaw?.toString() ?? null,
      },
    },
  };
}
