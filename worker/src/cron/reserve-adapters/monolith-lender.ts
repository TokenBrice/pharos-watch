import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveAdapterCoin } from "@shared/types/core";
import type {
  LiabilityRatioUnavailableReason,
  LiveReservesConfig,
  LiveReserveWarning,
} from "@shared/types/live-reserves";
import { decodeAbiParameters } from "viem/utils";
import {
  DECIMALS_SELECTOR,
  TOTAL_SUPPLY_SELECTOR,
  encodeAddressCallData,
  encodeBalanceOfCallData,
  encodeUint256,
} from "../../lib/evm-selectors";
import { getPublicRpcUrl, getSecondaryFallbackRpcUrl } from "../../lib/public-rpc-registry";
import type { AdapterContext, AdapterResult } from "./types";
import { resolveCoinContractAddress } from "./evm";
import {
  addressObservation,
  customObservation,
  executeEvmObservationPlan,
  pinnedBlockPlan,
  uint256Observation,
  type AnyEvmObservationField,
} from "./evm-observation-plan";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  decimalStringFromBigInt,
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";
import { ratioFromRaw } from "./slice-math";

const ADAPTER_KEY = "monolith-lender";
const SUPPORTED_CHAIN = "ethereum";
const RPC_TIMEOUT_MS = 12_000;
const PRICE_DECIMALS_TOTAL = 36;
const COIN_DECIMALS = 18;

/*
 * Monolith V2 Lender selectors from the Sourcify exact-match source of the
 * swanUSD instance 0x4ed5c72816abc1b67ac31ddabe31cff4a8c56a15 (Lender.sol,
 * solc 0.8.24). The Lender has no aggregate collateral getter — collateral is a
 * per-borrower `collateralBalances` mapping — so the complete held collateral is
 * the contract's own token balance (verified equal to the sum of per-borrower
 * balances at Ethereum block 26299913).
 */
const SELECTORS = {
  coin: "0x11df9995",
  collateral: "0xd8dfeb45",
  psmAsset: "0xbc1fc2bb",
  psmVault: "0xb4f38265",
  psmAssetDecimals: "0xe531aaeb",
  getCollateralPrice: "0xf7683bbc",
  getFeedPrice: "0x39cdab5c",
  stalenessThreshold: "0xa84f6ebb",
  getSellAmountOut: "0x82ca45d4",
  freePsmAssets: "0xfa5acb88",
  totalPaidDebt: "0xfb529d33",
  totalFreeDebt: "0xcb120c3a",
  vaultAsset: "0x38d52e0f",
  vaultMaxWithdraw: "0xce96cb77",
} as const;

function decodeCollateralPrice(
  raw: `0x${string}`,
): { price: bigint; reduceOnly: boolean; allowLiquidations: boolean } {
  try {
    const [price, reduceOnly, allowLiquidations] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "bool" }],
      raw,
    );
    return { price, reduceOnly, allowLiquidations };
  } catch {
    throw new Error(`${ADAPTER_KEY} getCollateralPrice returned malformed data`);
  }
}

function decodeFeedPrice(raw: `0x${string}`): { price: bigint; updatedAt: bigint } {
  try {
    const [price, updatedAt] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], raw);
    return { price, updatedAt };
  } catch {
    throw new Error(`${ADAPTER_KEY} getFeedPrice returned malformed data`);
  }
}

async function readPinnedValues<const Fields extends readonly AnyEvmObservationField[]>(options: {
  fields: Fields;
  chain: string;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}): Promise<Awaited<ReturnType<typeof executeEvmObservationPlan<Fields>>>> {
  return executeEvmObservationPlan({
    adapterKey: ADAPTER_KEY,
    fields: options.fields,
    read: (calls) => fetchOnchainMulticall3({
      calls,
      chain: options.chain,
      signal: options.signal,
      ctx: options.ctx,
      rpcUrl: options.rpcUrl,
      fallbackRpcUrl: options.fallbackRpcUrl,
      timeoutMs: RPC_TIMEOUT_MS,
    }),
  });
}

export async function fetchMonolithLenderReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  if (input.chain !== SUPPORTED_CHAIN) {
    throw new Error(`${ADAPTER_KEY} only supports ${SUPPORTED_CHAIN}, got "${input.chain}"`);
  }
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const coinAddress = resolveCoinContractAddress(coin, input.chain);
  if (!coinAddress) {
    throw new Error(`${ADAPTER_KEY} missing ${input.chain} coin contract metadata`);
  }
  const expectedCoin = coinAddress.toLowerCase();
  const lender = params.lenderAddress;
  const collateral = params.collateral.address;
  const psmAsset = params.psmAsset.address;
  const psmVault = params.psmVault.address;
  const rpcUrl = params.rpcUrl ?? getPublicRpcUrl(input.chain);
  const fallbackRpcUrl = params.fallbackRpcUrl ?? getSecondaryFallbackRpcUrl(input.chain);

  const blockPlan = await pinnedBlockPlan({
    chain: input.chain,
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    timeoutMs: RPC_TIMEOUT_MS,
  });

  // One whole coin must convert to exactly one whole PSM asset: `sell()` only
  // rescales decimals and carries no fee or pause branch.
  const sellProbeIn = 10n ** BigInt(COIN_DECIMALS);
  const expectedSellOut = 10n ** BigInt(params.psmAsset.decimals);
  const plan = await readPinnedValues({
    fields: [
      // Wiring identities. The Lender's wiring is immutable constructor state,
      // so any drift means the reviewed route no longer describes this contract.
      addressObservation({
        label: "lender-coin",
        contract: lender,
        data: SELECTORS.coin,
        verify: (value) => value === expectedCoin ? null : `coin() mismatch (${value} != ${expectedCoin})`,
      }),
      addressObservation({
        label: "lender-collateral",
        contract: lender,
        data: SELECTORS.collateral,
        verify: (value) => value === collateral.toLowerCase()
          ? null
          : `collateral() mismatch (${value} != ${collateral})`,
      }),
      addressObservation({
        label: "lender-psm-asset",
        contract: lender,
        data: SELECTORS.psmAsset,
        verify: (value) => value === psmAsset.toLowerCase()
          ? null
          : `psmAsset() mismatch (${value} != ${psmAsset})`,
      }),
      addressObservation({
        label: "lender-psm-vault",
        contract: lender,
        data: SELECTORS.psmVault,
        verify: (value) => value === psmVault.toLowerCase()
          ? null
          : `psmVault() mismatch (${value} != ${psmVault})`,
      }),
      uint256Observation({ label: "collateral-decimals", contract: collateral, data: DECIMALS_SELECTOR }),
      uint256Observation({ label: "psm-asset-decimals", contract: psmAsset, data: DECIMALS_SELECTOR }),
      uint256Observation({ label: "lender-psm-asset-decimals", contract: lender, data: SELECTORS.psmAssetDecimals }),
      addressObservation({
        label: "psm-vault-asset",
        contract: psmVault,
        data: SELECTORS.vaultAsset,
        verify: (value) => value === psmAsset.toLowerCase()
          ? null
          : `psmVault.asset() mismatch (${value} != ${psmAsset})`,
      }),
      uint256Observation({
        label: "coin-decimals",
        contract: coinAddress,
        data: DECIMALS_SELECTOR,
        verify: (value) => value === BigInt(COIN_DECIMALS) ? null : "coin decimals drifted from reviewed 18",
      }),
      // Holdings, valuation and liabilities.
      uint256Observation({ label: "collateral-balance", contract: collateral, data: encodeBalanceOfCallData(lender) }),
      customObservation({
        label: "collateral-price",
        contract: lender,
        data: SELECTORS.getCollateralPrice,
        decode: decodeCollateralPrice,
      }),
      customObservation({
        label: "feed-price",
        contract: lender,
        data: SELECTORS.getFeedPrice,
        optional: true,
        decode: decodeFeedPrice,
      }),
      uint256Observation({
        label: "staleness-threshold",
        contract: lender,
        data: SELECTORS.stalenessThreshold,
        optional: true,
      }),
      uint256Observation({ label: "psm-vault-shares", contract: psmVault, data: encodeBalanceOfCallData(lender) }),
      uint256Observation({
        label: "psm-vault-max-withdraw",
        contract: psmVault,
        data: encodeAddressCallData(SELECTORS.vaultMaxWithdraw, lender),
        optional: true,
      }),
      uint256Observation({ label: "free-psm-assets", contract: lender, data: SELECTORS.freePsmAssets }),
      uint256Observation({ label: "total-paid-debt", contract: lender, data: SELECTORS.totalPaidDebt }),
      uint256Observation({ label: "total-free-debt", contract: lender, data: SELECTORS.totalFreeDebt }),
      uint256Observation({ label: "coin-total-supply", contract: coinAddress, data: TOTAL_SUPPLY_SELECTOR }),
      uint256Observation({
        label: "sell-amount-out-unit",
        contract: lender,
        data: `${SELECTORS.getSellAmountOut}${encodeUint256(sellProbeIn)}`,
        verify: (value) => value === expectedSellOut
          ? null
          : `getSellAmountOut(${sellProbeIn}) returned ${value} instead of ${expectedSellOut}, so the PSM sell is no longer a 1:1 conversion`,
      }),
    ] as const,
    chain: input.chain,
    signal,
    ctx: blockPlan.ctx,
    rpcUrl,
    fallbackRpcUrl,
  });
  const values = plan.values;

  const collateralDecimals = Number(values["collateral-decimals"]);
  const psmAssetDecimals = Number(values["psm-asset-decimals"]);
  if (collateralDecimals !== params.collateral.decimals) {
    throw new Error(
      `${ADAPTER_KEY} collateral decimals drifted (${collateralDecimals} != configured ${params.collateral.decimals})`,
    );
  }
  if (psmAssetDecimals !== params.psmAsset.decimals) {
    throw new Error(
      `${ADAPTER_KEY} PSM asset decimals drifted (${psmAssetDecimals} != configured ${params.psmAsset.decimals})`,
    );
  }
  if (Number(values["lender-psm-asset-decimals"]) !== psmAssetDecimals) {
    throw new Error(`${ADAPTER_KEY} Lender psmAssetDecimals() no longer matches the configured PSM asset`);
  }

  const collateralBalance = values["collateral-balance"];
  const { price: priceRaw, reduceOnly, allowLiquidations } = values["collateral-price"];
  if (priceRaw <= 0n || !allowLiquidations) {
    // getCollateralPrice() substitutes 1 for an unreadable or zero feed price and
    // clears allowLiquidations, so this read cannot value the collateral.
    throw new Error(
      `${ADAPTER_KEY} collateral oracle is unusable this run (price ${priceRaw}, reduceOnly ${reduceOnly}, allowLiquidations ${allowLiquidations})`,
    );
  }
  const priceDecimals = PRICE_DECIMALS_TOTAL - collateralDecimals;
  if (priceDecimals < 0) {
    throw new Error(`${ADAPTER_KEY} collateral decimals exceed the reviewed price scale`);
  }
  const collateralPriceUsd = decimalNumberFromBigInt(priceRaw, priceDecimals);
  // A measured zero balance is a valid state: every borrower repaid and
  // withdrew, and only the PSM leg remains. Only an unreadable read (which the
  // observation plan already rejects) or an invalid valuation fails here.
  const collateralUsd = valueUsdFromBigIntPrice(collateralBalance, collateralDecimals, collateralPriceUsd);
  if (!Number.isFinite(collateralUsd) || collateralUsd < 0) {
    throw new Error(`${ADAPTER_KEY} collateral valuation is invalid`);
  }

  const freePsmAssets = values["free-psm-assets"];
  const psmVaultShares = values["psm-vault-shares"];
  if (freePsmAssets > 0n && psmVaultShares <= 0n) {
    throw new Error(`${ADAPTER_KEY} Lender accounts PSM assets while holding no PSM vault shares`);
  }
  const totalPaidDebt = values["total-paid-debt"];
  const totalFreeDebt = values["total-free-debt"];
  // Both counters are direct reads, so a zero sum is a measured state (every
  // borrower repaid or was written off), not a missing liability; an unreadable
  // counter already fails the observation plan. Whether the surviving supply is
  // actually backed is reconciled below.
  const debtRaw = totalPaidDebt + totalFreeDebt;
  const totalSupplyRaw = values["coin-total-supply"];
  if (totalSupplyRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} coin totalSupply is zero or unreadable`);
  }
  const supplyTokens = decimalNumberFromBigInt(totalSupplyRaw, COIN_DECIMALS);
  const totalDebtUsd = decimalNumberFromBigInt(debtRaw, COIN_DECIMALS);
  if (!Number.isFinite(supplyTokens) || supplyTokens <= 0) {
    throw new Error(`${ADAPTER_KEY} coin supply is invalid`);
  }
  if (!Number.isFinite(totalDebtUsd) || totalDebtUsd < 0) {
    throw new Error(`${ADAPTER_KEY} CDP debt value is invalid`);
  }
  /*
   * Every mint path raises a recognised liability: borrow mints against new
   * debt, `buy()` mints against `freePsmAssets`, and interest mints only what
   * `accrueInterest()` has already added to `totalPaidDebt`. Every burn path
   * lowers the matching liability: `adjust()` repayment, `liquidate()`,
   * `redeem()` and `sell()` burn exactly the coin they remove from debt or
   * `freePsmAssets`. `writeOff()` is the exception: it deletes the borrower's
   * debt without burning its coin, and only for the LAST borrower, because the
   * redistribution across remaining borrowers is skipped once
   * `totalFreeDebt + totalPaidDebt` reaches 0. A healthy book therefore keeps
   * totalSupply <= totalPaidDebt + totalFreeDebt + freePsmAssets (the pinned
   * block reconciles exactly), and any excess is supply the Lender's
   * accounting does not back.
   */
  const freePsmAssetsInCoinUnits = psmAssetDecimals === COIN_DECIMALS
    ? freePsmAssets
    : freePsmAssets * 10n ** BigInt(COIN_DECIMALS) / 10n ** BigInt(psmAssetDecimals);
  const supplyBackingRaw = debtRaw + freePsmAssetsInCoinUnits;
  const supplyShortfallRaw = totalSupplyRaw > supplyBackingRaw ? totalSupplyRaw - supplyBackingRaw : 0n;
  const supplyShortfallTokens = decimalNumberFromBigInt(supplyShortfallRaw, COIN_DECIMALS);
  // The tolerance absorbs base-unit rescaling only (a coarser PSM asset scale
  // truncates in `freePsmAssetsInCoinUnits`); share and interest rounding all
  // favour the backing side. It stays small enough to keep every write-off
  // visible: a written-off position clears at least `minDebt` (1,000 tokens for
  // this Lender), which is 24x the 1 bp tolerance at the pinned supply (42
  // tokens).
  const supplyShortfallToleranceRaw = totalSupplyRaw / 10_000n > 10n ** BigInt(COIN_DECIMALS)
    ? totalSupplyRaw / 10_000n
    : 10n ** BigInt(COIN_DECIMALS);
  // Without recognised debt the collateral ratio has no denominator: publish
  // the composition and the measured zero counters, and withhold the ratio under
  // the shared reason vocabulary instead of dividing by zero.
  const ratioUnavailableReason: LiabilityRatioUnavailableReason | null =
    totalDebtUsd > 0 ? null : "zero-liability-denominator";

  /*
   * The PSM sell is bounded by the Lender's own accounting: `sell()` subtracts
   * the nominal asset output from `freePsmAssets` before paying, so a larger
   * sell underflows. `freePsmAssets` is raised only by `buy()` and by the
   * permissionless `pullLocalReserves()` sUSDS profit recognition, so share
   * appreciation alone never inflates it. The sUSDS payout ceiling is the
   * corroborating second bound because the payout is a same-transaction vault
   * redemption; capacity is the lower of the two, and it is only published when
   * both bounds are observed.
   */
  const psmVaultCeiling = values["psm-vault-max-withdraw"];
  const vaultCeilingBinds = psmVaultCeiling != null && psmVaultCeiling < freePsmAssets;
  // `freePsmAssets` is an accounting limit, not proof the sUSDS payout is
  // deliverable: with `maxWithdraw()` unreadable the sell cannot be shown to
  // execute, so capacity is withheld instead of published at the higher bound.
  // A supply shortfall never changes capacity: the bound is what `sell()`
  // actually pays out, and unbacked supply elsewhere does not make this route
  // pay more or less.
  const capacityRaw = psmVaultCeiling == null
    ? null
    : vaultCeilingBinds ? psmVaultCeiling : freePsmAssets;
  const capacityBindingSource = capacityRaw == null
    ? null
    : vaultCeilingBinds ? "psm-vault-max-withdraw" : "lender-free-psm-assets";
  const capacityUsd = capacityRaw == null
    ? null
    : decimalNumberFromBigInt(capacityRaw, psmAssetDecimals) * params.psmAssetUnitValueUsd;
  if (capacityUsd != null && (!Number.isFinite(capacityUsd) || capacityUsd < 0)) {
    throw new Error(`${ADAPTER_KEY} PSM sell capacity is invalid`);
  }
  const psmReserveUsd = decimalNumberFromBigInt(freePsmAssets, psmAssetDecimals) * params.psmAssetUnitValueUsd;
  const totalReserveUsd = collateralUsd + psmReserveUsd;
  if (!Number.isFinite(totalReserveUsd) || totalReserveUsd <= 0) {
    // An all-zero book has no slices to publish (output validation rejects an
    // empty composition), so name the measured state instead of the arithmetic.
    throw new Error(totalReserveUsd === 0
      ? `${ADAPTER_KEY} Lender collateral and PSM reserve are both measured zero, so there is no composition to publish`
      : `${ADAPTER_KEY} measured reserve value is invalid`);
  }

  const warnings: LiveReserveWarning[] = [];
  const feed = values["feed-price"];
  const stalenessThreshold = values["staleness-threshold"];
  const feedUpdatedAt = feed != null && feed.updatedAt > 0n && feed.updatedAt <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(feed.updatedAt)
    : null;
  const stalenessThresholdSec = stalenessThreshold == null ? null : Number(stalenessThreshold);
  const feedAgeSec = feedUpdatedAt != null ? Math.max(0, blockPlan.observedBlock.timestamp - feedUpdatedAt) : null;
  if (reduceOnly) {
    // The Lender prices redemptions off this oracle, so a reduce-only oracle is
    // published as adverse evidence rather than valued silently.
    const cause = feedAgeSec != null && stalenessThresholdSec != null && feedAgeSec > stalenessThresholdSec
      ? `the composite feed is ${feedAgeSec}s old against a ${stalenessThresholdSec}s staleness threshold, so the protocol is unwinding its price`
      : "the Lender reports collateral value at or below outstanding debt";
    warnings.push(reserveDegradedWarning(
      "monolith-lender-oracle-degraded",
      `getCollateralPrice() is reduce-only: ${cause}`,
    ));
  }
  if (psmVaultCeiling == null) {
    // Composition reads all succeeded, so this stays informational; the withheld
    // capacity itself is published as absent telemetry, not as a number.
    warnings.push(reserveInfoWarning(
      "monolith-lender-psm-vault-ceiling-unobserved",
      `sUSDS maxWithdraw() was unreadable, so the PSM payout ceiling is unobserved and redeemable capacity is withheld rather than assumed from freePsmAssets() ${freePsmAssets}`,
    ));
  } else if (vaultCeilingBinds) {
    warnings.push(reserveInfoWarning(
      "monolith-lender-psm-vault-ceiling-binds",
      `sUSDS maxWithdraw() ${psmVaultCeiling} is below the Lender's freePsmAssets accounting ${freePsmAssets}`,
    ));
  }
  if (supplyShortfallRaw > supplyShortfallToleranceRaw) {
    // Supply the Lender's recognised debt plus free PSM assets do not cover is
    // unbacked, so it is published as adverse evidence that keeps the snapshot
    // out of independent reserve scoring, never as clean coverage. The published
    // ratio is already collateral-over-debt and never a cover-of-supply claim.
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `coin.totalSupply() ${totalSupplyRaw} exceeds recognised backing (totalPaidDebt + totalFreeDebt + freePsmAssets) ${supplyBackingRaw} by ${decimalStringFromBigInt(supplyShortfallRaw, COIN_DECIMALS)} tokens: writeOff() deletes a last borrower's debt without burning its coin, so that supply is unbacked`,
    ));
  }

  const routeStatus = capacityUsd == null ? "unknown" : capacityUsd > 0 ? "open" : "degraded";
  const routeStatusReason = capacityUsd == null
    ? `sUSDS maxWithdraw() behind the same-transaction redemption was unreadable, so the PSM payout ceiling is unobserved; capacity is withheld and the sell is not claimed executable even though freePsmAssets() is ${freePsmAssets}`
    : capacityUsd > 0
      ? `Lender.sell() carries no fee, pause or allowlist branch: freePsmAssets() is ${freePsmAssets} at ${params.psmAssetUnitValueUsd} USD per unit and ${capacityBindingSource} binds, so the 1:1 payout is executable in one transaction`
      : "Lender.freePsmAssets() is zero, so the 1:1 PSM sell currently pays out nothing";

  return {
    slices: slicesFromValues([
      {
        sourceKey: `${ADAPTER_KEY}:${input.chain}:${collateral.toLowerCase()}`,
        name: params.collateral.name,
        value: collateralUsd,
        risk: params.collateral.risk,
        ...(params.collateral.coinId ? { coinId: params.collateral.coinId } : {}),
        ...(params.collateral.depType ? { depType: params.collateral.depType } : {}),
      },
      {
        sourceKey: `${ADAPTER_KEY}:${input.chain}:${psmVault.toLowerCase()}`,
        name: params.psmVault.name,
        value: psmReserveUsd,
        risk: params.psmVault.risk,
        ...(params.psmVault.coinId ? { coinId: params.psmVault.coinId } : {}),
        ...(params.psmVault.depType ? { depType: params.psmVault.depType } : {}),
      },
    ]),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: `${ADAPTER_KEY}-cdp-accounting`,
        chain: input.chain,
        lenderAddress: lender.toLowerCase(),
        coinAddress: expectedCoin,
        collateralAddress: collateral.toLowerCase(),
        psmAssetAddress: psmAsset.toLowerCase(),
        psmVaultAddress: psmVault.toLowerCase(),
        collateralDecimals,
        psmAssetDecimals,
        collateralUnitsRaw: collateralBalance.toString(),
        collateralPriceRaw: priceRaw.toString(),
        collateralPriceDecimals: priceDecimals,
        collateralPriceUsd,
        collateralPriceReduceOnly: reduceOnly,
        collateralAllowLiquidations: allowLiquidations,
        collateralFeedUpdatedAt: feedUpdatedAt,
        collateralFeedAgeSec: feedAgeSec,
        collateralStalenessThresholdSec: stalenessThresholdSec,
        collateralValuationBasis:
          "Lender.getCollateralPrice() protocol oracle at the pinned block, scaled to (36 - collateralDecimals); no external price lookup is mixed in",
        psmVaultSharesRaw: psmVaultShares.toString(),
        psmVaultMaxWithdrawRaw: psmVaultCeiling?.toString() ?? null,
        freePsmAssetsRaw: freePsmAssets.toString(),
        psmAssetUnitValueUsd: params.psmAssetUnitValueUsd,
        psmAssetUnitValuationBasis:
          `${params.psmAsset.name} valued at its reviewed ${params.psmAssetUnitValueUsd} USD par, which sell() pays 1:1 without a fee`,
        capacityBindingSource,
        // Both sides of the published ratio are reviewed at the same par
        // valuation: capacity in PSM-asset units over the coin's totalSupply.
        capacityRatioDenominator: "coin.totalSupply()",
        totalPaidDebtRaw: totalPaidDebt.toString(),
        totalFreeDebtRaw: totalFreeDebt.toString(),
        coinTotalSupplyRaw: totalSupplyRaw.toString(),
        // Supply reconciliation against the Lender's own accounting. The
        // backing sum is rescaled to coin base units; the shortfall is published
        // even below the warning tolerance so sub-tolerance drift stays visible.
        supplyBackingRaw: supplyBackingRaw.toString(),
        supplyBackingBasis:
          "totalPaidDebt + totalFreeDebt + freePsmAssets, with the PSM leg rescaled to coin base units by the reviewed 1:1 sell conversion",
        supplyShortfallRaw: supplyShortfallRaw.toString(),
        supplyShortfallTokens,
        supplyShortfallToleranceRaw: supplyShortfallToleranceRaw.toString(),
        ...(ratioUnavailableReason
          ? {}
          : {
              ratioBasis: "collateral-value-over-cdp-debt",
              ratioNumeratorUsd: collateralUsd,
              ratioDenominatorUsd: totalDebtUsd,
              ratioDenominatorNote:
                "CDP debt recognised by the Lender (totalPaidDebt + totalFreeDebt): interest not yet accrued and the separately PSM-issued supply are excluded",
            }),
        debtShareOfSupply: totalDebtUsd / supplyTokens,
      }),
      totalReserveUsd,
      // The ratio and its denominator are withheld together: zero recognised
      // debt leaves nothing to divide by, and the measured zero counters stay
      // published above under the shared withheld-ratio reason vocabulary.
      ...(ratioUnavailableReason
        ? { ratioUnavailableReason }
        : { totalDebtUsd, collateralizationRatio: collateralUsd / totalDebtUsd }),
      supplyTokens,
      // The roster is closed by construction: the Lender's immutable
      // collateral/psmAsset/psmVault wiring is the complete set of tokens the
      // verified source can hold or transfer.
      unknownExposurePct: 0,
      ...buildRedemptionSnapshotMetadata({
        ...(capacityUsd != null && capacityRaw != null
          ? {
              capacityUsd,
              capacityRatioOfSupply: ratioFromRaw(capacityRaw, totalSupplyRaw),
              capacityKind: "live-direct" as const,
            }
          : {}),
        freshnessKind: "same-run-onchain",
        routeStatus,
        // An unobserved payout bound is not a live route observation: the status
        // is published as unknown without onchain attribution, the same branch
        // liquity-v2-branches and escrow-balance use when their gate is unread.
        ...(capacityRaw != null
          ? { routeStatusSource: "onchain" as const, routeObserved: true as const }
          : { routeStatusSource: "static-config" as const }),
        routeStatusReason,
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: 0,
        blockNumber: blockPlan.observedBlock.number,
        outputAssetKeys: [params.redemptionOutputAssetKey],
        sourceUrls: params.sourceUrls,
      }),
    },
  };
}
