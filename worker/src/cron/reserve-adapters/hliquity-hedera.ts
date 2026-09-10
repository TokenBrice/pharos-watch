import { z } from "zod";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { decodeUint256Word } from "./abi-decode";
import { callHederaContractAtBlock, fetchHederaLatestBlock } from "./hedera-mirror";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchDefiLlamaPrices,
  fetchJsonWithRetry,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "hliquity-hedera";

// HLiquity is an immutable Liquity fork: the chain-295 mainnet deployment
// (version 30f7253f635f6015267b0fcdb5554d259b76e5db, deployed 2024-06-03) has
// never been re-deployed, so the contract set is pinned as constants. Sources:
// the production frontend bundle deployment manifest, the official docs
// token/contract registry, and the reviewed reserves sidecar (2026-08-23).
const TROVE_MANAGER_EVM_ADDRESS = "0x00000000000000000000000000000000005c9f66"; // 0.0.6070118
const STABILITY_POOL_EVM_ADDRESS = "0x00000000000000000000000000000000005c9f5c"; // 0.0.6070108
const PRICE_FEED_EVM_ADDRESS = "0x00000000000000000000000000000000005c9f42"; // 0.0.6070082
const HCHF_TOKEN_EVM_ADDRESS = "0x00000000000000000000000000000000005c9f6b"; // HTS token 0.0.6070123

const GET_ENTIRE_SYSTEM_COLL_SELECTOR = "0x887105d3";
const GET_ENTIRE_SYSTEM_DEBT_SELECTOR = "0x795d26c3";
const GET_TCR_SELECTOR = "0xb82f263d"; // getTCR(uint256 _price)
const MCR_SELECTOR = "0x794e5724";
const FETCH_PRICE_SELECTOR = "0x0fdb11cf"; // priceFeed.fetchPrice() -> HBAR/USD oracle word
const STABILITY_POOL_GET_ETH_SELECTOR = "0x14f6c3be";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

// HBAR collateral and HCHF debt are both tracked in Hedera-native 8-decimal
// units (tinybar / HCHF base units); ratio words share the same scale, so
// MCR() returns 110,000,000 for the documented 110% minimum ratio.
const HBAR_DECIMALS = 8;
const HCHF_DECIMALS = 8;
const RATIO_DECIMALS = 8;
const HLQT_CR_DEGRADED_THRESHOLD = 1.1;

// DefiLlama publishes HBAR under its CoinGecko id; the Hedera chain has no
// wrapped-native ERC-20-style address to key off.
const HBAR_DEFLILLAMA_KEY = { key: "HBAR", chain: "coingecko", address: "hedera-hashgraph" };

// The repo's own FX source (ECB daily reference rates via Frankfurter) also
// powers sync-fx-rates. A CHF quote older than a week means the daily
// business-day series has stalled, which must fail closed rather than valuing
// the liability with a stale franc.
const FRANKFURTER_CHF_USD_URL = "https://api.frankfurter.dev/v1/latest?base=CHF&symbols=USD";
const CHF_RATE_MAX_AGE_SEC = 7 * 86_400;

const HLIQUITY_PROOF_KIND = "hliquity-hedera-system-collateral";

const FrankfurterChfSchema = z.object({
  base: z.literal("CHF"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rates: z.object({ USD: z.number().finite().positive() }),
});

export interface HliquityHederaState {
  block: { number: number; timestampSec: number; fromIso: string };
  troveCollateralRaw: bigint;
  stabilityPoolCollateralRaw: bigint;
  debtRaw: bigint;
  supplyRaw: bigint;
  mcrRaw: bigint | null;
  tcrRaw: bigint | null;
  protocolPriceRaw: bigint | null;
  hbarPriceUsd: number | undefined;
  chfUsdRate: number;
  fxRateDate: string;
  nowSec: number;
}

function parseFxRateDate(value: string, label: string): number {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${ADAPTER_KEY}: ${label} is not a valid ISO date: ${value}`);
  }
  return Math.floor(parsed / 1_000);
}

async function fetchFrankfurterChfUsd(
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  nowSec: number,
): Promise<{ rate: number; date: string }> {
  const payload = await fetchJsonWithRetry<unknown>(FRANKFURTER_CHF_USD_URL, signal, 12_000, ctx);
  const parsed = FrankfurterChfSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`${ADAPTER_KEY}: Frankfurter CHF/USD response failed schema validation`);
  }
  const rateDateSec = parseFxRateDate(parsed.data.date, "CHF rate date");
  const ageSec = nowSec - rateDateSec;
  if (ageSec > CHF_RATE_MAX_AGE_SEC || ageSec < -86_400) {
    throw new Error(
      `${ADAPTER_KEY}: Frankfurter CHF/USD reference rate is dated ${parsed.data.date}, outside the accepted freshness window`,
    );
  }
  return { rate: parsed.data.rates.USD, date: parsed.data.date };
}

export function adaptHliquityHederaState(state: HliquityHederaState): AdapterResult {
  const warnings: LiveReserveWarning[] = [];

  const totalCollateralTinybar = state.troveCollateralRaw + state.stabilityPoolCollateralRaw;
  const totalCollateralHbar = decimalNumberFromBigInt(totalCollateralTinybar, HBAR_DECIMALS);
  const totalDebtHchf = decimalNumberFromBigInt(state.debtRaw, HCHF_DECIMALS);
  const supplyHchf = decimalNumberFromBigInt(state.supplyRaw, HCHF_DECIMALS);
  if (!Number.isFinite(totalCollateralHbar) || totalCollateralHbar <= 0) {
    throw new Error(`${ADAPTER_KEY}: measured HBAR collateral is not a finite positive quantity`);
  }
  if (!Number.isFinite(totalDebtHchf) || totalDebtHchf <= 0) {
    throw new Error(`${ADAPTER_KEY}: measured HCHF debt is not a finite positive quantity`);
  }

  // Liquity accounting makes HCHF supply equal system debt (mints only happen
  // at trove opening; redemptions burn supply and debt together), so a
  // mismatch is a data anomaly worth surfacing even though debt stays the
  // authoritative liability basis.
  const supplyDebtDeltaPct = Math.abs((supplyHchf - totalDebtHchf) / totalDebtHchf) * 100;
  if (!(supplyDebtDeltaPct <= 0.5)) {
    warnings.push(reserveInfoWarning(
      "debt-supply-mismatch",
      `${ADAPTER_KEY}: HCHF total supply ${supplyHchf.toFixed(8)} differs from system debt ${totalDebtHchf.toFixed(8)} by ${supplyDebtDeltaPct.toFixed(2)}% at the pinned block`,
    ));
  }

  const totalCollateralUsd =
    state.hbarPriceUsd != null && state.hbarPriceUsd > 0 ? totalCollateralHbar * state.hbarPriceUsd : undefined;
  const totalLiabilitiesUsd = totalDebtHchf * state.chfUsdRate;
  const collateralizationRatio =
    totalCollateralUsd != null && totalCollateralUsd > 0 ? totalCollateralUsd / totalLiabilitiesUsd : undefined;

  if (state.hbarPriceUsd == null || !(state.hbarPriceUsd > 0)) {
    warnings.push(reserveDegradedWarning(
      "hbar-price-unavailable",
      `${ADAPTER_KEY}: DefiLlama returned no usable HBAR/USD quote; collateral valuation and collateralization ratio omitted`,
    ));
  } else if (collateralizationRatio != null && collateralizationRatio < HLQT_CR_DEGRADED_THRESHOLD) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `${ADAPTER_KEY}: market-valued system collateral covers ${(collateralizationRatio * 100).toFixed(2)}% of HCHF debt at the pinned block`,
    ));
  }

  // `redeemCollateral()` reverts unless the protocol-priced TCR clears MCR, so
  // the holder-facing redemption route is open only while the gate holds.
  let routeStatus: "open" | "paused" | "unknown";
  let routeStatusReason: string | undefined;
  if (state.tcrRaw == null || state.mcrRaw == null || state.mcrRaw <= 0n) {
    routeStatus = "unknown";
    routeStatusReason = `Could not read the HLiquity redemption gate (protocol price, getTCR or MCR) at block ${state.block.number}`;
    warnings.push(reserveDegradedWarning("redemption-route-status-unreadable", routeStatusReason));
  } else if (state.tcrRaw >= state.mcrRaw) {
    routeStatus = "open";
  } else {
    routeStatus = "paused";
    routeStatusReason = `HLiquity reverts redemptions while the system TCR ${
      decimalNumberFromBigInt(state.tcrRaw, RATIO_DECIMALS).toFixed(4)
    } is below MCR ${decimalNumberFromBigInt(state.mcrRaw, RATIO_DECIMALS).toFixed(4)}`;
    warnings.push(reserveDegradedWarning("redemption-route-status-degraded", routeStatusReason));
  }

  const slices = slicesFromValues([
    {
      sourceKey: `${ADAPTER_KEY}:hbar`,
      name: "HBAR collateral (Troves + Stability Pool)",
      value: totalCollateralUsd ?? totalCollateralHbar,
      risk: "high" as ReserveSlice["risk"],
      assetClass: "cryptoasset" as const,
    },
  ]);

  const details: Record<string, unknown> = {
    proofKind: HLIQUITY_PROOF_KIND,
    blockNumber: state.block.number,
    blockTimeIso: state.block.fromIso,
    troveManagerAddress: TROVE_MANAGER_EVM_ADDRESS,
    stabilityPoolAddress: STABILITY_POOL_EVM_ADDRESS,
    priceFeedAddress: PRICE_FEED_EVM_ADDRESS,
    hchfTokenAddress: HCHF_TOKEN_EVM_ADDRESS,
    troveCollateralRaw: state.troveCollateralRaw.toString(),
    stabilityPoolCollateralRaw: state.stabilityPoolCollateralRaw.toString(),
    debtRaw: state.debtRaw.toString(),
    supplyRaw: state.supplyRaw.toString(),
    protocolPriceRaw: state.protocolPriceRaw?.toString() ?? null,
    tcrRaw: state.tcrRaw?.toString() ?? null,
    mcrRaw: state.mcrRaw?.toString() ?? null,
    totalCollateralHbar: totalCollateralHbar,
    debtHchf: totalDebtHchf,
    hbarPriceUsd: state.hbarPriceUsd ?? null,
    chfUsdRate: state.chfUsdRate,
    fxRateDate: state.fxRateDate,
  };

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      observedBlock: { chain: "hedera", number: state.block.number, timestamp: state.block.timestampSec },
      ...notApplicableFreshnessMetadata(details),
      totalReserveUsd: totalCollateralUsd,
      totalLiabilitiesUsd,
      supplyTokens: supplyHchf,
      supplyUsd: supplyHchf * state.chfUsdRate,
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: totalLiabilitiesUsd,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        ...(routeStatusReason ? { routeStatusReason } : {}),
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: [
          "https://docs.hliquity.org/deep-dive/redemptions-and-hchf-price-stability",
          "https://docs.hliquity.org/fundamentals/token-ids-pools-contracts",
        ],
      }),
    },
  };
}

/**
 * Reads HLiquity's Liquity-style CDP reserve on Hedera through the public
 * mirror node: the latest record-stream block is pinned, and a same-block
 * census of TroveManager.getEntireSystemColl(), getEntireSystemDebt(), MCR(),
 * getTCR(priceFeed.fetchPrice()), StabilityPool.getETH() and the HCHF token
 * totalSupply() is executed with every call addressed to that block. HBAR is
 * valued at the DefiLlama market price and HCHF debt at the ECB CHF/USD
 * reference rate; a missing or stale franc rate fails the attempt closed.
 */
export async function fetchHliquityHederaReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  const mirrorBaseUrl = input.url;
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1_000);

  const block = await fetchHederaLatestBlock(mirrorBaseUrl, signal, ctx);

  // Sequential pinned reads keep the attempt inside the orchestrator's
  // shared connection budget; every call runs through the adapter I/O limiter
  // and all six address the same pinned block for a same-block census.
  const troveCollateralRaw = decodeUint256Word(await callHederaContractAtBlock(
    mirrorBaseUrl,
    { to: TROVE_MANAGER_EVM_ADDRESS, data: GET_ENTIRE_SYSTEM_COLL_SELECTOR, blockNumber: block.number },
    signal,
    ctx,
  ));
  const debtRaw = decodeUint256Word(await callHederaContractAtBlock(
    mirrorBaseUrl,
    { to: TROVE_MANAGER_EVM_ADDRESS, data: GET_ENTIRE_SYSTEM_DEBT_SELECTOR, blockNumber: block.number },
    signal,
    ctx,
  ));
  const stabilityPoolCollateralRaw = decodeUint256Word(await callHederaContractAtBlock(
    mirrorBaseUrl,
    { to: STABILITY_POOL_EVM_ADDRESS, data: STABILITY_POOL_GET_ETH_SELECTOR, blockNumber: block.number },
    signal,
    ctx,
  ));
  const mcrRaw = decodeUint256Word(await callHederaContractAtBlock(
    mirrorBaseUrl,
    { to: TROVE_MANAGER_EVM_ADDRESS, data: MCR_SELECTOR, blockNumber: block.number },
    signal,
    ctx,
  ));
  const protocolPriceRaw = decodeUint256Word(await callHederaContractAtBlock(
    mirrorBaseUrl,
    { to: PRICE_FEED_EVM_ADDRESS, data: FETCH_PRICE_SELECTOR, blockNumber: block.number },
    signal,
    ctx,
  ));
  const supplyRaw = decodeUint256Word(await callHederaContractAtBlock(
    mirrorBaseUrl,
    { to: HCHF_TOKEN_EVM_ADDRESS, data: TOTAL_SUPPLY_SELECTOR, blockNumber: block.number },
    signal,
    ctx,
  ));

  if (troveCollateralRaw == null || troveCollateralRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY}: getEntireSystemColl() returned zero/unreadable collateral`);
  }
  if (debtRaw == null || debtRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY}: getEntireSystemDebt() returned zero/unreadable debt`);
  }
  if (stabilityPoolCollateralRaw == null) {
    throw new Error(`${ADAPTER_KEY}: StabilityPool.getETH() returned unreadable collateral`);
  }
  if (supplyRaw == null || supplyRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY}: HCHF totalSupply() returned zero/unreadable supply`);
  }

  // getTCR takes the protocol price word, so the gate call is composed after
  // the feed read; both are pinned to the same block as the reserve reads.
  const tcrRaw = protocolPriceRaw != null && protocolPriceRaw > 0n
    ? decodeUint256Word(await callHederaContractAtBlock(
        mirrorBaseUrl,
        { to: TROVE_MANAGER_EVM_ADDRESS, data: `${GET_TCR_SELECTOR}${protocolPriceRaw.toString(16).padStart(64, "0")}`, blockNumber: block.number },
        signal,
        ctx,
      ))
    : null;

  const { rate: chfUsdRate, date: fxRateDate } = await fetchFrankfurterChfUsd(signal, ctx, nowSec);
  const hbarPriceMap = await fetchDefiLlamaPrices([HBAR_DEFLILLAMA_KEY], signal, ctx);
  const hbarPriceUsd = hbarPriceMap.get("HBAR");

  return adaptHliquityHederaState({
    block,
    troveCollateralRaw,
    stabilityPoolCollateralRaw,
    debtRaw,
    supplyRaw,
    mcrRaw,
    tcrRaw,
    protocolPriceRaw,
    hbarPriceUsd,
    chfUsdRate,
    fxRateDate,
    nowSec,
  });
}
