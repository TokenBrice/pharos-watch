import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { getPublicRpcUrl } from "../../lib/public-rpc-registry";
import { encodeAddress } from "../../lib/evm-selectors";
import { rethrowIfAborted } from "../../lib/abort";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveInfoWarning,
  type OnchainMulticall3Call,
} from "./helpers";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";

const ADAPTER_KEY = "anzen-usdz";
const SPCT_POOL_CONTRACT = "0xf30a29F1C540724Fd8c5c4Be1AF604a6C6800D29";
const SPCT_POOL_DECIMALS = 18;
const SUPPLY_CHAINS = ["ethereum", "base", "arbitrum", "blast", "manta"] as const;
type SupportedSupplyChain = (typeof SUPPLY_CHAINS)[number];

function getSupplyChainRpcUrl(chain: SupportedSupplyChain): string {
  const registryUrl = getPublicRpcUrl(chain);
  if (!registryUrl) {
    throw new Error(`${ADAPTER_KEY} no RPC URL available for chain ${chain}`);
  }
  return registryUrl;
}

function getRequiredContract(
  coin: StablecoinMeta,
  chain: SupportedSupplyChain,
): { address: string; decimals: number } {
  const contract = coin.contracts?.find((entry) => entry.chain === chain);
  if (!contract) {
    throw new Error(`${ADAPTER_KEY} missing ${chain} contract metadata for ${coin.id}`);
  }
  return { address: contract.address, decimals: contract.decimals };
}

// USDz.redeem() pays USDC out of the USDz contract after pulling it from the
// SPCT pool, so the route is only as deep as the SPCT pool's own USDC. The
// identities below are the pinned values USDz's immutable getters must still
// resolve to; any mismatch means the pinned route no longer describes this
// contract and the whole redemption surface is withheld.
// https://etherscan.io/address/0xa469b7ee9ee773642b3e93e842e5d9b5baa10067
const USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_DECIMALS = 6;
const SPCT_PRICE_ORACLE_CONTRACT = "0x900fff3bbf47ded50fd4940d055e1324f38b0d4f";
const ANZEN_REDEEM_DOC_URL = "https://docs.anzen.finance/usdz-101/overview";

const USDZ_USDC_SELECTOR = "0x3e413bee"; // usdc()
const USDZ_SPCT_SELECTOR = "0x090a1cc8"; // spct()
const USDZ_ORACLE_SELECTOR = "0x7dc0d1d0"; // oracle()
const USDZ_COLLATERAL_RATE_SELECTOR = "0x58a6be1c"; // collateralRate()
const PAUSED_SELECTOR = "0x5c975abb"; // paused()
const REDEEM_FEE_RATE_SELECTOR = "0x5872e6fa"; // redeemFeeRate()
const FEE_COEFFICIENT_SELECTOR = "0xf05a6b6d"; // FEE_COEFFICIENT()
const SPCT_RESERVE_USD_SELECTOR = "0x664692f2"; // reserveUSD()
const SPCT_IS_WHITELIST_SELECTOR = "0xc683630d"; // isWhitelist(address)
const BALANCE_OF_SELECTOR = "0x70a08231"; // balanceOf(address)
const ORACLE_GET_PRICE_SELECTOR = "0x98d5fdca"; // getPrice()
const ORACLE_PRICE_DECIMALS = 18;

interface AnzenRedemptionProbe {
  capacityUsd: number;
  reserveUsdRaw: string;
  spctUsdcRaw: string;
  usdzUsdcRaw: string;
  routeOpen: boolean;
  feeBps: number | null;
}

/**
 * Combined USDz + SPCT redeem fee, in basis points. `redeem()` charges the USDz
 * rate first and the SPCT rate on what is left, so the two compose rather than
 * add. Both rates are gov-settable against each contract's own coefficient, so
 * an unreadable or out-of-range pair yields null instead of a fee this run could
 * not observe.
 */
function combinedRedeemFeeBps(
  usdzRate: bigint | null,
  usdzCoefficient: bigint | null,
  spctRate: bigint | null,
  spctCoefficient: bigint | null,
): number | null {
  if (usdzRate == null || spctRate == null) return null;
  if (usdzCoefficient == null || spctCoefficient == null) return null;
  if (usdzCoefficient <= 0n || spctCoefficient <= 0n) return null;
  if (usdzRate < 0n || usdzRate > usdzCoefficient) return null;
  if (spctRate < 0n || spctRate > spctCoefficient) return null;

  const denominator = usdzCoefficient * spctCoefficient;
  const retained = (usdzCoefficient - usdzRate) * (spctCoefficient - spctRate);
  const feeBps = ((denominator - retained) * 10_000n + denominator / 2n) / denominator;
  return Number(feeBps);
}

/**
 * Same-run read of the USDz -> USDC redemption route. `redeem()` is capped by
 * `spct.reserveUSD()` and settles out of USDC the SPCT pool hands to USDz, so
 * capacity is the lower of the accounted reserve and the USDC actually sitting
 * in the two contracts. Returns `null` when any read fails or an identity no
 * longer matches, so the caller withholds the whole redemption surface rather
 * than publishing an unproven route.
 */
async function probeAnzenRedemption(
  usdzAddress: string,
  chain: string,
  rpcUrl: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AnzenRedemptionProbe | null> {
  const calls: OnchainMulticall3Call[] = [
    { label: "usdz:usdc", contract: usdzAddress, data: USDZ_USDC_SELECTOR },
    { label: "usdz:spct", contract: usdzAddress, data: USDZ_SPCT_SELECTOR },
    { label: "usdz:oracle", contract: usdzAddress, data: USDZ_ORACLE_SELECTOR },
    { label: "usdz:paused", contract: usdzAddress, data: PAUSED_SELECTOR },
    { label: "usdz:collateral-rate", contract: usdzAddress, data: USDZ_COLLATERAL_RATE_SELECTOR },
    { label: "usdz:redeem-fee-rate", contract: usdzAddress, data: REDEEM_FEE_RATE_SELECTOR },
    { label: "usdz:fee-coefficient", contract: usdzAddress, data: FEE_COEFFICIENT_SELECTOR },
    { label: "spct:reserve-usd", contract: SPCT_POOL_CONTRACT, data: SPCT_RESERVE_USD_SELECTOR },
    { label: "spct:paused", contract: SPCT_POOL_CONTRACT, data: PAUSED_SELECTOR },
    { label: "spct:redeem-fee-rate", contract: SPCT_POOL_CONTRACT, data: REDEEM_FEE_RATE_SELECTOR },
    { label: "spct:fee-coefficient", contract: SPCT_POOL_CONTRACT, data: FEE_COEFFICIENT_SELECTOR },
    {
      label: "spct:usdz-whitelisted",
      contract: SPCT_POOL_CONTRACT,
      data: `${SPCT_IS_WHITELIST_SELECTOR}${encodeAddress(usdzAddress)}`,
    },
    {
      label: "usdc:spct-balance",
      contract: USDC_CONTRACT,
      data: `${BALANCE_OF_SELECTOR}${encodeAddress(SPCT_POOL_CONTRACT)}`,
    },
    {
      label: "usdc:usdz-balance",
      contract: USDC_CONTRACT,
      data: `${BALANCE_OF_SELECTOR}${encodeAddress(usdzAddress)}`,
    },
    { label: "oracle:price", contract: SPCT_PRICE_ORACLE_CONTRACT, data: ORACLE_GET_PRICE_SELECTOR },
  ];

  try {
    const results = await fetchOnchainMulticall3({ calls, chain, signal, ctx, rpcUrl, timeoutMs: 12_000 });
    if (!results) return null;

    const byLabel = new Map<string, `0x${string}`>();
    for (const result of results) {
      if (!result.success) return null;
      byLabel.set(result.label, result.returnData);
    }

    if (decodeStrictAddressWord(byLabel.get("usdz:usdc")) !== USDC_CONTRACT) return null;
    if (decodeStrictAddressWord(byLabel.get("usdz:spct")) !== SPCT_POOL_CONTRACT.toLowerCase()) return null;
    if (decodeStrictAddressWord(byLabel.get("usdz:oracle")) !== SPCT_PRICE_ORACLE_CONTRACT) return null;

    const usdzPaused = decodeStrictBoolWord(byLabel.get("usdz:paused"));
    const spctPaused = decodeStrictBoolWord(byLabel.get("spct:paused"));
    const usdzWhitelisted = decodeStrictBoolWord(byLabel.get("spct:usdz-whitelisted"));
    const reserveUsdRaw = decodeUint256Word(byLabel.get("spct:reserve-usd"));
    const spctUsdcRaw = decodeUint256Word(byLabel.get("usdc:spct-balance"));
    const usdzUsdcRaw = decodeUint256Word(byLabel.get("usdc:usdz-balance"));
    const collateralRate = decodeUint256Word(byLabel.get("usdz:collateral-rate"));
    const oraclePriceRaw = decodeUint256Word(byLabel.get("oracle:price"));
    if (usdzPaused == null || spctPaused == null || usdzWhitelisted == null) return null;
    if (reserveUsdRaw == null || spctUsdcRaw == null || usdzUsdcRaw == null) return null;
    if (collateralRate == null || oraclePriceRaw == null) return null;

    const settleableRaw = spctUsdcRaw + usdzUsdcRaw;
    const bindingRaw = reserveUsdRaw < settleableRaw ? reserveUsdRaw : settleableRaw;
    const capacityUsd = decimalNumberFromBigInt(bindingRaw, USDC_DECIMALS);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

    // redeem() is guarded by whenNotPaused and checkCollateralRate, and settles
    // through the SPCT pool, so the pool must be live and must still recognise
    // USDz as a whitelisted holder. No whitelist applies to the redeemer itself:
    // the only caller gate on redeem() is the USDz blacklist.
    const collateralRateOk = oraclePriceRaw / 10n ** BigInt(ORACLE_PRICE_DECIMALS) >= collateralRate;
    const routeOpen = !usdzPaused && !spctPaused && usdzWhitelisted && collateralRateOk;

    return {
      capacityUsd,
      reserveUsdRaw: reserveUsdRaw.toString(),
      spctUsdcRaw: spctUsdcRaw.toString(),
      usdzUsdcRaw: usdzUsdcRaw.toString(),
      routeOpen,
      feeBps: combinedRedeemFeeBps(
        decodeUint256Word(byLabel.get("usdz:redeem-fee-rate")),
        decodeUint256Word(byLabel.get("usdz:fee-coefficient")),
        decodeUint256Word(byLabel.get("spct:redeem-fee-rate")),
        decodeUint256Word(byLabel.get("spct:fee-coefficient")),
      ),
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

export async function fetchAnzenUsdzReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const redemptionProbe = probeAnzenRedemption(
    getRequiredContract(coin, "ethereum").address,
    "ethereum",
    getSupplyChainRpcUrl("ethereum"),
    signal,
    ctx,
  );

  const supplyEntries = await Promise.all(
    SUPPLY_CHAINS.map(async (chain) => {
      const contract = getRequiredContract(coin, chain);
      const rawSupply = await fetchErc20TotalSupply(
        { kind: "onchain-evm", chain, rpcMode: primaryInput.rpcMode },
        contract.address,
        signal,
        ctx,
        getSupplyChainRpcUrl(chain),
        undefined,
      );
      if (rawSupply == null || rawSupply <= 0n) {
        throw new Error(`${ADAPTER_KEY} totalSupply probe failed for ${coin.id} on ${chain}`);
      }
      return [chain, decimalNumberFromBigInt(rawSupply, contract.decimals)] as const;
    }),
  );

  const reserveRaw = await fetchErc20TotalSupply(
    { kind: "onchain-evm", chain: "ethereum", rpcMode: primaryInput.rpcMode },
    SPCT_POOL_CONTRACT,
    signal,
    ctx,
    getSupplyChainRpcUrl("ethereum"),
    undefined,
  );
  if (reserveRaw == null || reserveRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY} SPCT reserve totalSupply probe failed`);
  }

  const supplyByChainUsd = Object.fromEntries(supplyEntries) as Record<SupportedSupplyChain, number>;
  const supplyUsd = Object.values(supplyByChainUsd).reduce((sum, value) => sum + value, 0);
  const totalReserveUsd = decimalNumberFromBigInt(reserveRaw, SPCT_POOL_DECIMALS);

  if (!Number.isFinite(supplyUsd) || supplyUsd <= 0) {
    throw new Error(`${ADAPTER_KEY} computed invalid USDz multichain supply`);
  }
  if (!Number.isFinite(totalReserveUsd) || totalReserveUsd <= 0) {
    throw new Error(`${ADAPTER_KEY} computed invalid SPCT reserve size`);
  }

  const redemption = await redemptionProbe;
  const warnings: LiveReserveWarning[] = redemption == null
    ? [
        reserveInfoWarning(
          "anzen-usdz-redeem-route-unreadable",
          `USDz ${coin.id} did not return a matching usdc()/spct()/oracle() set with readable SPCT reserve and USDC balances this run; redemption telemetry withheld`,
        ),
      ]
    : [];

  return {
    slices: [
      {
        name: "SPCT (Secured Private Credit Token)",
        pct: 100,
        risk: "high",
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "multichain-usdz-vs-spct-total-supply",
        reserveSourceLabel: "SPCT pool total supply",
        supplySourceLabel: "USDz total supply across official deployments",
      }),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio: totalReserveUsd / supplyUsd,
      ...(redemption != null
        ? buildRedemptionSnapshotMetadata({
            capacityUsd: redemption.capacityUsd,
            capacityKind: "live-direct",
            freshnessKind: "same-run-onchain",
            // redeem() gates only on the USDz blacklist; the SPCT whitelist
            // applies to the USDz contract, not to the redeeming holder.
            holderEligibility: "any-holder",
            settlementDelaySec: 0,
            // An empty route is not a closed one, and zero measured capacity is
            // no evidence of an open route either, so openness is asserted only
            // when the contract gates pass and the route can actually pay out.
            ...(redemption.routeOpen && redemption.capacityUsd > 0
              ? {
                  routeStatus: "open" as const,
                  routeStatusSource: "onchain" as const,
                  routeStatusReason:
                    `USDz redeem() read in the same run: spct() is ${SPCT_POOL_CONTRACT}, ` +
                    `reserveUSD() is ${redemption.reserveUsdRaw} and the SPCT pool plus USDz hold ` +
                    `${redemption.spctUsdcRaw} + ${redemption.usdzUsdcRaw} USDC (6 decimals)`,
                }
              : {}),
            ...(redemption.feeBps != null ? { feeBps: redemption.feeBps } : {}),
            sourceUrls: [ANZEN_REDEEM_DOC_URL],
          })
        : {}),
      details: {
        proofKind: "multichain-usdz-vs-spct-total-supply",
        reserveSourceLabel: "SPCT pool total supply",
        supplySourceLabel: "USDz total supply across official deployments",
        reserveContract: SPCT_POOL_CONTRACT,
        reserveChain: "ethereum",
        supplyByChainUsd,
        supplyChains: SUPPLY_CHAINS,
        ...(redemption != null
          ? {
              redeemRoute: {
                proofKind: "usdz-redeem-spct-reserve-and-usdc-settlement",
                spctReserveUsdRaw: redemption.reserveUsdRaw,
                spctUsdcBalanceRaw: redemption.spctUsdcRaw,
                usdzUsdcBalanceRaw: redemption.usdzUsdcRaw,
                usdcDecimals: USDC_DECIMALS,
                routeOpen: redemption.routeOpen,
              },
            }
          : {}),
      },
    },
  };
}
