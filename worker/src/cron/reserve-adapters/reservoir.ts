import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  classifyBucketedValues,
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  makeOnchainCallers,
  reserveInfoWarning,
  unverifiedFreshnessMetadata,
  requireJsonInputFromConfig,
} from "./helpers";
import type { ValueBucketRule } from "./classification";
import { parseEvmAddressResult } from "./evm";
import { decodeStrictBoolWord } from "./abi-decode";
import { PAUSED_SELECTOR } from "../../lib/evm-selectors";
import { wrapperAssetMeta } from "./wrapper-assets";
import { buildBrowserHeaders, NEUTRAL_ADAPTER_HEADERS } from "./request";
import { rethrowIfAborted } from "../../lib/abort";
import { toErrorMessage } from "../../lib/error-utils";

interface ReservoirBalanceItem {
  label: string;
  description?: string;
  iconPath?: string;
  totalBalanceValue: string;
}

export interface ReservoirReservesResponse {
  assets: ReservoirBalanceItem[];
  liabilities: ReservoirBalanceItem[];
  totalAssets: string;
  totalLiabilities: string;
  equity: string;
}

type ReservoirBucketKey = "usd1" | "pyusd" | "rlusd" | "ausd" | "gho" | "usdt" | "usdc" | "agua" | "rusd" | "prime" | "usdat";

const RESERVOIR_BROWSER_HEADERS = buildBrowserHeaders(
  "https://app.reservoir.xyz",
  "https://app.reservoir.xyz/reserves",
);

// Stable buckets that provide broader balance-sheet liquidity context. This
// aggregate is diagnostic only: the modeled rUSD PSM exit terminates in USDC,
// so route capacity must be bound to the separately classified USDC bucket.
const RESERVOIR_STABLE_BUCKET_KEYS: readonly ReservoirBucketKey[] = [
  "usd1",
  "pyusd",
  "rlusd",
  "ausd",
  "gho",
  "usdt",
  "usdc",
];

// Word-boundary regex rules are single-token exclusive; for multi-token
// labels (e.g. "PYUSD/USDC") the first matching rule wins, so wrappers
// (USD1/PYUSD/RLUSD/GHO) are listed before USDT/USDC.
const RESERVOIR_BUCKETS: readonly ValueBucketRule<ReservoirBalanceItem, ReservoirBucketKey>[] = [
  {
    key: "usd1",
    name: "USD1 lending markets",
    risk: "medium",
    ...wrapperAssetMeta("usd1"),
    // USD1 is the only "USD<digit>" label, so a word-boundary match is safe
    match: (item) => /\bUSD1\b/.test(item.label),
  },
  {
    key: "pyusd",
    name: "PYUSD lending markets",
    risk: "medium",
    ...wrapperAssetMeta("pyusd"),
    match: (item) => /\bPYUSD\b/.test(item.label),
  },
  {
    key: "rlusd",
    name: "RLUSD lending markets",
    risk: "medium",
    ...wrapperAssetMeta("rlusd"),
    match: (item) => /\bRLUSD\b/.test(item.label),
  },
  {
    key: "ausd",
    name: "AUSD lending markets",
    risk: "medium",
    ...wrapperAssetMeta("ausd"),
    match: (item) => /\bAUSD\b/.test(item.label),
  },
  {
    key: "gho",
    name: "GHO lending markets",
    risk: "medium",
    ...wrapperAssetMeta("gho"),
    // Match GHO as a standalone token or sGHO; exclude RUSD/USDT labels that
    // happen to contain a G.
    match: (item) => /\b(?:s?GHO)\b/.test(item.label),
  },
  {
    key: "usdt",
    name: "USDT / USDT0 positions",
    risk: "medium",
    ...wrapperAssetMeta("usdt"),
    // USDT0 and plain USDT; exclude USDT-adjacent labels like "tUSD".
    match: (item) => /\bUSDT0?\b/.test(item.label),
  },
  {
    key: "usdc",
    name: "USDC positions",
    risk: "medium",
    ...wrapperAssetMeta("usdc"),
    // USDC standalone only; other stablecoins that contain "USD" (USD1/USDT/etc)
    // match their own rules first.
    match: (item) => /\bUSDC\b/.test(item.label) || /\bSteakhouse Prime Instant\b/i.test(item.label),
  },
  {
    key: "agua",
    name: "Agua Global Carry Vault (USDC-denominated ERC-4626)",
    risk: "high",
    ...wrapperAssetMeta("usdc"),
    match: (item) => /\bAgua\b/i.test(item.label),
  },
  {
    key: "rusd",
    name: "rUSD strategy vaults",
    risk: "medium",
    match: (item) => /\bRUSD\b/.test(item.label),
  },
  {
    key: "prime",
    name: "Hastra / Sentora PRIME credit allocations",
    risk: "high",
    match: (item) => /\bPRIME\b/.test(item.label),
  },
  {
    key: "usdat",
    name: "Pendle PT USDat tokenized-treasury principal token",
    risk: "high",
    // Reservoir's raw row names the Pendle PT and Pendle resolves the market's
    // underlying asset to the tracked Saturn USDat Ethereum contract.
    coinId: "usdat-saturn",
    depType: "collateral",
    match: (item) => /\bUSDAT\b/i.test(item.label),
  },
];

const SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT = 0.5;

// Reservoir's USDC Peg Stability Module. Every modeled rUSD / srUSD / wsrUSD
// exit terminates on this contract's USDC leg, so its current USDC balance —
// not the wider balance-sheet USDC bucket, which sits in lending vaults — is
// the binding holder capacity bound.
// https://docs.reservoir.xyz/security-and-compliance/smart-contract-addresses
const RESERVOIR_USDC_PSM_ADDRESS = "0x4809010926aec940b550d34a46a52739f996d75d";
// Circle USDC. The pinned PSM only describes the modeled route while its
// underlying() still resolves here, so an identity mismatch fails closed.
const RESERVOIR_PSM_UNDERLYING_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const RESERVOIR_PSM_UNDERLYING_DECIMALS = 6;
const RESERVOIR_PSM_DOC_URL = "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module";

// Reservoir's SavingModule. Its `_redeem` burns
// `previewRedeem(amount) * (1e6 + redeemFee) / 1e6`, so `redeemFee()` is a
// multiplicative exit fee charged on top of the NAV conversion rather than a
// spread already inside previewRedeem. It is MANAGER-settable behind only
// `require(1e6 > fee)`, so no static bound under the policy limit is
// defensible and the same-run read is the only honest source.
// https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd
const RESERVOIR_SAVING_MODULE_ADDRESS = "0x5475611dffb8ef4d697ae39df9395513b6e947d7";
const RESERVOIR_REDEEM_FEE_DENOMINATOR = 1_000_000n;

// Only srUSD and wsrUSD exit through the SavingModule; wsrUSD unwraps at NAV
// into srUSD and then takes the same redeem path. rUSD holders redeem straight
// at the PSM and never pay this fee, so it must not be attributed to them.
const SAVING_MODULE_EXIT_COIN_IDS = new Set(["srusd-reservoir", "wsrusd-reservoir"]);

// underlying() / underlyingBalance()
const PSM_UNDERLYING_SELECTOR = "0x6f307dc3";
const PSM_UNDERLYING_BALANCE_SELECTOR = "0x59356c5c";
// redeemFee()
const SAVING_MODULE_REDEEM_FEE_SELECTOR = "0x965fa21e";

/**
 * Same-run read of the srUSD exit fee, in basis points. Returns `null` when the
 * read fails or the value breaches the contract's own `1e6 > fee` bound, so the
 * caller falls back to the reviewed cost model instead of publishing a fee it
 * could not observe.
 */
async function probeSavingModuleRedeemFeeBps(signal: AbortSignal, ctx?: AdapterContext): Promise<number | null> {
  const onchain = makeOnchainCallers({ chain: "ethereum" }, { signal, ctx });
  try {
    const raw = await onchain.uint256(RESERVOIR_SAVING_MODULE_ADDRESS, SAVING_MODULE_REDEEM_FEE_SELECTOR);
    if (raw == null || raw < 0n || raw >= RESERVOIR_REDEEM_FEE_DENOMINATOR) return null;
    // Keep the fraction: at the current 134/1e6 the fee is 1.34 bps, and
    // rounding here would understate it by a quarter.
    const feeBps = (Number(raw) / Number(RESERVOIR_REDEEM_FEE_DENOMINATOR)) * 10_000;
    return Number.isFinite(feeBps) && feeBps >= 0 ? feeBps : null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

interface ReservoirPsmProbe {
  capacityUsd: number;
  capacityRaw: string;
  paused: boolean;
}

/**
 * Same-run read of the terminal USDC PSM leg. Returns `null` when any read
 * fails or the underlying identity no longer matches the pinned USDC address,
 * so the caller can withhold redemption telemetry rather than publish an
 * unproven route.
 */
async function probeReservoirUsdcPsm(signal: AbortSignal, ctx?: AdapterContext): Promise<ReservoirPsmProbe | null> {
  const onchain = makeOnchainCallers({ chain: "ethereum" }, { signal, ctx });
  try {
    const [underlyingHex, balanceRaw, pausedHex] = await Promise.all([
      onchain.raw(RESERVOIR_USDC_PSM_ADDRESS, PSM_UNDERLYING_SELECTOR),
      onchain.uint256(RESERVOIR_USDC_PSM_ADDRESS, PSM_UNDERLYING_BALANCE_SELECTOR),
      onchain.raw(RESERVOIR_USDC_PSM_ADDRESS, PAUSED_SELECTOR),
    ]);

    const underlying = underlyingHex ? parseEvmAddressResult(underlyingHex as `0x${string}`) : null;
    if (underlying !== RESERVOIR_PSM_UNDERLYING_ADDRESS) return null;

    const paused = decodeStrictBoolWord(pausedHex);
    if (paused == null) return null;

    if (balanceRaw == null || balanceRaw < 0n) return null;
    const capacityUsd = decimalNumberFromBigInt(balanceRaw, RESERVOIR_PSM_UNDERLYING_DECIMALS);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

    return { capacityUsd, capacityRaw: balanceRaw.toString(), paused };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

export interface AdaptReservoirResult {
  slices: ReserveSlice[];
  unknownAssets: string[];
  unknownExposurePct: number;
  sourceTotalGapPct: number;
  stableBucketLiquidityUsd: number;
  immediateRedeemableUsd: number;
  supplyUsd: number | null;
}

export function adaptReservoirReserves(payload: ReservoirReservesResponse): AdaptReservoirResult {
  const totalAssets = Number(payload.totalAssets);
  if (!Number.isFinite(totalAssets) || totalAssets <= 0) {
    return {
      slices: [],
      unknownAssets: [],
      unknownExposurePct: 0,
      sourceTotalGapPct: 0,
      stableBucketLiquidityUsd: 0,
      immediateRedeemableUsd: 0,
      supplyUsd: null,
    };
  }

  const disclosedAssetValue = payload.assets.reduce((sum, asset) => {
    const value = Number(asset.totalBalanceValue);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);
  const sourceTotalGapUsd = Math.max(0, totalAssets - disclosedAssetValue);
  const sourceTotalGapPct = (sourceTotalGapUsd / totalAssets) * 100;
  const assets =
    sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT
      ? [
          ...payload.assets,
          {
            label: "Unmapped Reservoir balance-sheet total-assets gap",
            totalBalanceValue: String(sourceTotalGapUsd),
          },
        ]
      : payload.assets;

  const classified = classifyBucketedValues({
    items: assets,
    rules: RESERVOIR_BUCKETS,
    getValue: (asset) => Number(asset.totalBalanceValue),
    getUnknownLabel: (asset) => asset.label,
    totalValue: totalAssets,
    unknownSliceName: "Unmapped reserve positions",
  });

  const totalLiabilities = Number(payload.totalLiabilities);
  const supplyUsd = Number.isFinite(totalLiabilities) && totalLiabilities > 0 ? totalLiabilities : null;
  const stableBucketUsd = RESERVOIR_STABLE_BUCKET_KEYS.reduce(
    (sum, key) => sum + (classified.bucketTotals.get(key) ?? 0),
    0,
  );
  const usdcBucketUsd = classified.bucketTotals.get("usdc") ?? 0;
  const stableBucketLiquidityUsd = supplyUsd != null ? Math.min(stableBucketUsd, supplyUsd) : stableBucketUsd;
  // Fail closed to the asset actually returned by the modeled terminal route.
  // Other stable buckets may support Reservoir generally, but converting them
  // to USDC requires an additional route that this adapter does not observe.
  const immediateRedeemableUsd = supplyUsd != null ? Math.min(usdcBucketUsd, supplyUsd) : usdcBucketUsd;

  return {
    slices: classified.slices,
    unknownAssets: classified.unknownItems,
    unknownExposurePct: classified.unknownExposurePct,
    sourceTotalGapPct,
    stableBucketLiquidityUsd,
    immediateRedeemableUsd,
    supplyUsd,
  };
}

async function fetchReservoirPayload(
  url: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<ReservoirReservesResponse> {
  try {
    return await fetchJsonWithRetry<ReservoirReservesResponse>(url, signal, 20_000, ctx, {
      headers: RESERVOIR_BROWSER_HEADERS,
    });
  } catch (primaryError) {
    if (signal.aborted) throw primaryError;
    try {
      return await fetchJsonWithRetry<ReservoirReservesResponse>(url, signal, 20_000, ctx, {
        headers: NEUTRAL_ADAPTER_HEADERS,
      });
    } catch (fallbackError) {
      if (signal.aborted) throw fallbackError;
      throw new Error(
        `browser fetch failed: ${toErrorMessage(primaryError)}; neutral fetch failed: ${toErrorMessage(fallbackError)}`,
      );
    }
  }
}

export async function fetchReservoirReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "reservoir");

  const [payload, psm, redeemFeeBps] = await Promise.all([
    fetchReservoirPayload(primaryInput.url, signal, ctx),
    probeReservoirUsdcPsm(signal, ctx),
    SAVING_MODULE_EXIT_COIN_IDS.has(coin.id) ? probeSavingModuleRedeemFeeBps(signal, ctx) : Promise.resolve(null),
  ]);
  const adapted = adaptReservoirReserves(payload);
  const totalAssetsUsd = Number(payload.totalAssets);
  const totalLiabilitiesUsd = Number(payload.totalLiabilities);
  const shareholderEquityUsd = Number(payload.equity);
  const warnings: LiveReserveWarning[] =
    adapted.unknownAssets.length > 0
      ? [
          buildUnknownExposureWarning({
            code: "unknown-position",
            message: `Unmapped reserve positions: ${adapted.unknownAssets.join(", ")}`,
            unknownExposurePct: adapted.unknownExposurePct,
          }),
        ]
      : [];
  if (adapted.sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    warnings.push(
      buildUnknownExposureWarning({
        code: "source-total-gap",
        message: "Reservoir totalAssets exceeds disclosed asset rows",
        unknownExposurePct: adapted.sourceTotalGapPct,
        thresholdPct: SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
      }),
    );
  }
  if (
    Number.isFinite(totalAssetsUsd) &&
    Number.isFinite(totalLiabilitiesUsd) &&
    totalAssetsUsd > 0 &&
    totalLiabilitiesUsd > totalAssetsUsd
  ) {
    warnings.push({
      code: "reservoir-insolvent",
      message: `Reservoir total liabilities (${totalLiabilitiesUsd}) exceed total assets (${totalAssetsUsd})`,
      severity: "warning",
      effect: "degraded",
    });
  }
  if (psm == null) {
    warnings.push(
      reserveInfoWarning(
        "reservoir-psm-unreadable",
        `Reservoir USDC PSM ${RESERVOIR_USDC_PSM_ADDRESS} did not return a matching underlying()/underlyingBalance()/paused() set this run; redemption telemetry withheld`,
      ),
    );
  }

  // The PSM's own USDC balance is the only observed exit capacity. Withhold the
  // whole redemption surface when the same-run reads fail rather than falling
  // back to the balance-sheet USDC bucket, which sits in lending vaults and is
  // not reachable without a route this adapter does not observe.
  const psmCapacityUsd =
    psm == null
      ? null
      : adapted.supplyUsd != null
        ? Math.min(psm.capacityUsd, adapted.supplyUsd)
        : psm.capacityUsd;

  return {
    slices: adapted.slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      assetCount: payload.assets.length,
      liabilityCount: payload.liabilities.length,
      totalAssets: payload.totalAssets,
      totalLiabilities: payload.totalLiabilities,
      equity: payload.equity,
      unknownAssetCount: adapted.unknownAssets.length,
      ...(adapted.unknownAssets.length > 0 ? { unknownAssetLabels: adapted.unknownAssets } : {}),
      ...(adapted.sourceTotalGapPct > 0 ? { sourceTotalGapPct: adapted.sourceTotalGapPct } : {}),
      ...unverifiedFreshnessMetadata(
        "protocol-balance-sheet-api",
        "Reservoir's timestamp-less protocol API payload is not independently freshness-verified during this adapter run",
      ),
      unknownExposurePct: adapted.unknownExposurePct,
      ...(Number.isFinite(totalAssetsUsd) && totalAssetsUsd > 0 ? { totalAssetsUsd } : {}),
      ...(Number.isFinite(totalLiabilitiesUsd) && totalLiabilitiesUsd > 0 ? { totalLiabilitiesUsd } : {}),
      ...(Number.isFinite(shareholderEquityUsd) ? { shareholderEquityUsd } : {}),
      ...(Number.isFinite(totalAssetsUsd) &&
      totalAssetsUsd > 0 &&
      Number.isFinite(totalLiabilitiesUsd) &&
      totalLiabilitiesUsd > 0
        ? { collateralizationRatio: totalAssetsUsd / totalLiabilitiesUsd }
        : {}),
      ...(adapted.supplyUsd != null
        ? {
            supplyUsd: adapted.supplyUsd,
            stableBucketLiquidityUsd: adapted.stableBucketLiquidityUsd,
            // Diagnostic only: the balance-sheet USDC bucket is not the exit
            // bound, so it must not travel under an immediateRedeemable key.
            balanceSheetUsdcBucketUsd: adapted.immediateRedeemableUsd,
          }
        : {}),
      ...(psm != null && psmCapacityUsd != null
        ? {
            psmUnderlyingBalanceRaw: psm.capacityRaw,
            ...(redeemFeeBps != null ? { redemptionFeeBps: redeemFeeBps } : {}),
            immediateRedeemableUsd: psmCapacityUsd,
            ...(adapted.supplyUsd != null && adapted.supplyUsd > 0
              ? { immediateRedeemableRatio: psmCapacityUsd / adapted.supplyUsd }
              : {}),
            redemption: {
              capacityUsd: psmCapacityUsd,
              ...(adapted.supplyUsd != null && adapted.supplyUsd > 0
                ? { capacityRatioOfSupply: psmCapacityUsd / adapted.supplyUsd }
                : {}),
              capacityKind: "live-direct" as const,
              freshnessKind: "same-run-onchain" as const,
              routeStatus: psm.paused ? ("paused" as const) : ("open" as const),
              routeStatusSource: "onchain" as const,
              routeStatusReason: psm.paused
                ? `Reservoir USDC PSM ${RESERVOIR_USDC_PSM_ADDRESS} paused() returned true in the same run`
                : `Reservoir USDC PSM ${RESERVOIR_USDC_PSM_ADDRESS} read in the same run: underlying() is Circle USDC, paused() is false, underlyingBalance() is ${psm.capacityRaw} (6 decimals)`,
              holderEligibility: "any-holder" as const,
              settlementDelaySec: 0,
              ...(redeemFeeBps != null ? { feeBps: redeemFeeBps } : {}),
              sourceUrls: [primaryInput.url, RESERVOIR_PSM_DOC_URL],
            },
          }
        : {}),
    },
  };
}
