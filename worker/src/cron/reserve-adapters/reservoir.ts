import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  fetchOnchainMulticall3,
  makeOnchainCallers,
  reconcileRowsWithSourceTotal,
  reserveInfoWarning,
  SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
  unverifiedFreshnessMetadata,
  requireJsonInputFromConfig,
} from "./helpers";
import { classifyBucketedValues, type ValueBucketRule } from "./classification";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { PAUSED_SELECTOR } from "../../lib/evm-selectors";
import { wrapperAssetMeta } from "./wrapper-assets";
import { fetchWithBrowserFallback } from "./request";
import { rethrowIfAborted } from "../../lib/abort";
import { encodeFunctionData, parseAbi } from "viem/utils";
import {
  boolObservation, executeEvmObservationPlan, pinnedBlockPlan, rawObservation, uint256Observation,
  type AnyEvmObservationField, type EvmObservationValues,
} from "./evm-observation-plan";
import { buildRedemptionSnapshotMetadata } from "./redemption";

interface ReservoirBalanceItem {
  label: string;
  chainId?: number;
  address?: string;
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

type ReservoirBucketKey = "usd1" | "pyusd" | "rlusd" | "ausd" | "gho" | "usdt" | "usdc" | "agua" | "rusd" | "prime" | "prime-unverified" | "usdat" | "usdg";


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
    key: "usdg",
    name: "USDG deposited in Morpho Gauntlet USDG Premium vault",
    risk: "high",
    sourceKey: "reservoir:gauntlet-usdg-premium",
    coinId: "usdg-paxos",
    depType: "collateral",
    match: (item) => item.chainId === 42161
      && item.address?.toLowerCase() === "0x390c1bb01f3f627144a40617e287d4ce3d5abcfa",
  },
  {
    key: "prime",
    name: "PYUSD deposited in Morpho Sentora PRIME vault",
    risk: "high",
    sourceKey: "reservoir:prime",
    coinId: "pyusd-paypal",
    depType: "collateral",
    // Verified vault constructor fixes _asset to native Ethereum PYUSD.
    // PRIME names borrower collateral, not the asset held by Reservoir.
    match: (item) => item.chainId === 1
      && item.address?.toLowerCase() === "0xc21b08c16458202593d4d9b26b9984ee67b38bbd",
  },
  {
    key: "agua",
    name: "Agua Global Carry Vault (USDC-denominated ERC-4626)",
    risk: "high",
    sourceKey: "reservoir:agua",
    ...wrapperAssetMeta("usdc"),
    match: (item) => /\bAgua\b/i.test(item.label),
  },
  {
    key: "usd1",
    name: "USD1 lending markets",
    risk: "medium",
    sourceKey: "reservoir:usd1",
    ...wrapperAssetMeta("usd1"),
    // USD1 is the only "USD<digit>" label, so a word-boundary match is safe
    match: (item) => /\bUSD1\b/.test(item.label),
  },
  {
    key: "pyusd",
    name: "PYUSD lending markets",
    risk: "medium",
    sourceKey: "reservoir:pyusd",
    ...wrapperAssetMeta("pyusd"),
    match: (item) => /\bPYUSD\b/.test(item.label),
  },
  {
    key: "rlusd",
    name: "RLUSD lending markets",
    risk: "medium",
    sourceKey: "reservoir:rlusd",
    ...wrapperAssetMeta("rlusd"),
    match: (item) => /\bRLUSD\b/.test(item.label),
  },
  {
    key: "ausd",
    name: "AUSD lending markets",
    risk: "medium",
    sourceKey: "reservoir:ausd",
    ...wrapperAssetMeta("ausd"),
    match: (item) => /\bAUSD\b/.test(item.label),
  },
  {
    key: "gho",
    name: "GHO lending markets",
    risk: "medium",
    sourceKey: "reservoir:gho",
    ...wrapperAssetMeta("gho"),
    // Match GHO as a standalone token or sGHO; exclude RUSD/USDT labels that
    // happen to contain a G.
    match: (item) => /\b(?:s?GHO)\b/.test(item.label),
  },
  {
    key: "usdt",
    name: "USDT / USDT0 positions",
    risk: "medium",
    sourceKey: "reservoir:usdt",
    ...wrapperAssetMeta("usdt"),
    // USDT0 and plain USDT; exclude USDT-adjacent labels like "tUSD".
    match: (item) => /\bUSDT0?\b/.test(item.label),
  },
  {
    key: "usdc",
    name: "USDC positions",
    risk: "medium",
    sourceKey: "reservoir:usdc",
    ...wrapperAssetMeta("usdc"),
    // USDC standalone only; other stablecoins that contain "USD" (USD1/USDT/etc)
    // match their own rules first.
    match: (item) => /\bUSDC\b/.test(item.label) || /\bSteakhouse Prime Instant\b/i.test(item.label),
  },
  {
    key: "rusd",
    name: "rUSD strategy vaults",
    risk: "medium",
    sourceKey: "reservoir:rusd",
    match: (item) => /\bRUSD\b/.test(item.label),
  },
  {
    key: "prime-unverified",
    name: "Unverified PRIME credit allocations",
    risk: "high",
    sourceKey: "reservoir:prime-unverified",
    match: (item) => /\bPRIME\b/.test(item.label),
  },
  {
    key: "usdat",
    name: "Pendle PT USDat tokenized-treasury principal token",
    risk: "high",
    sourceKey: "reservoir:usdat",
    // Reservoir's raw row names the Pendle PT and Pendle resolves the market's
    // underlying asset to the tracked Saturn USDat Ethereum contract.
    coinId: "usdat-saturn",
    depType: "collateral",
    match: (item) => /\bUSDAT\b/i.test(item.label),
  },
];

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

const RESERVOIR_RUSD_ADDRESS = "0x09d4214c03d01f49544c0448dbe3a27f768f2b34";
const RESERVOIR_SRUSD_ADDRESS = "0x738d1115b90efa71ae468f1287fc864775e23a31";
const RESERVOIR_WSRUSD_ADDRESS = "0xd3fd63209fa2d55b07a0f6db36c2f43900be3094";
const SHARED_PSM_RESOURCE_KEY = `ethereum:reservoir-psm:${RESERVOIR_USDC_PSM_ADDRESS}`;
const RESERVOIR_PROBE_ABI = parseAbi([
  "function underlying() view returns (address)",
  "function underlyingBalance() view returns (uint256)",
  "function paused() view returns (bool)",
  "function rusd() view returns (address)",
  "function srusd() view returns (address)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function DECIMAL_FACTOR() view returns (uint8)",
  "function redeemFee() view returns (uint256)",
  "function currentPrice() view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function previewWithdraw(uint256) view returns (uint256)",
  "function MINTER() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
]);

const getter = (functionName: "underlying" | "underlyingBalance" | "rusd" | "srusd" | "asset" |
  "decimals" | "DECIMAL_FACTOR" | "redeemFee" | "currentPrice" | "MINTER") =>
  encodeFunctionData({ abi: RESERVOIR_PROBE_ABI, functionName });
const RESERVOIR_PSM_FIELDS = [
  rawObservation({ label: "underlying", contract: RESERVOIR_USDC_PSM_ADDRESS, data: getter("underlying") }),
  rawObservation({ label: "balance", contract: RESERVOIR_USDC_PSM_ADDRESS, data: getter("underlyingBalance") }),
  rawObservation({ label: "paused", contract: RESERVOIR_USDC_PSM_ADDRESS, data: PAUSED_SELECTOR }),
  rawObservation({ label: "usdcDecimals", contract: RESERVOIR_PSM_UNDERLYING_ADDRESS, data: getter("decimals") }),
  rawObservation({ label: "decimalFactor", contract: RESERVOIR_USDC_PSM_ADDRESS, data: getter("DECIMAL_FACTOR") }),
  rawObservation({ label: "rusd", contract: RESERVOIR_USDC_PSM_ADDRESS, data: getter("rusd") }),
  rawObservation({ label: "rusdDecimals", contract: RESERVOIR_RUSD_ADDRESS, data: getter("decimals") }),
] as const;
const RESERVOIR_MINTER_FIELD = rawObservation({
  label: "minter", contract: RESERVOIR_RUSD_ADDRESS, data: getter("MINTER"), optional: true, allowFailure: true,
});
// Optional savings fields preserve a valid terminal PSM observation when only
// the preceding leg fails; the wrapper itself still fails every guard closed.
const RESERVOIR_WSRUSD_FIELDS = [
  ...RESERVOIR_PSM_FIELDS, RESERVOIR_MINTER_FIELD,
  rawObservation({ label: "wrapperAsset", contract: RESERVOIR_WSRUSD_ADDRESS, data: getter("asset"), optional: true, allowFailure: true }),
  rawObservation({ label: "wrapperDecimals", contract: RESERVOIR_WSRUSD_ADDRESS, data: getter("decimals"), optional: true, allowFailure: true }),
  rawObservation({ label: "unitOutput", contract: RESERVOIR_WSRUSD_ADDRESS,
    data: encodeFunctionData({ abi: RESERVOIR_PROBE_ABI, functionName: "previewRedeem", args: [10n ** 18n] }),
    optional: true, allowFailure: true }),
] as const;
const RESERVOIR_SRUSD_FIELDS = [
  ...RESERVOIR_PSM_FIELDS, RESERVOIR_MINTER_FIELD,
  rawObservation({ label: "savingsRusd", contract: RESERVOIR_SAVING_MODULE_ADDRESS, data: getter("rusd"), optional: true, allowFailure: true }),
  rawObservation({ label: "savingsSrusd", contract: RESERVOIR_SAVING_MODULE_ADDRESS, data: getter("srusd"), optional: true, allowFailure: true }),
  rawObservation({ label: "savingsFee", contract: RESERVOIR_SAVING_MODULE_ADDRESS, data: getter("redeemFee"), optional: true, allowFailure: true }),
  rawObservation({ label: "savingsPrice", contract: RESERVOIR_SAVING_MODULE_ADDRESS, data: getter("currentPrice"), optional: true, allowFailure: true }),
  rawObservation({ label: "savingsDecimals", contract: RESERVOIR_SRUSD_ADDRESS, data: getter("decimals"), optional: true, allowFailure: true }),
] as const;
type ReservoirIdentityValues = EvmObservationValues<
  typeof RESERVOIR_PSM_FIELDS | typeof RESERVOIR_WSRUSD_FIELDS | typeof RESERVOIR_SRUSD_FIELDS
>;

async function readReservoirBatch<const Fields extends readonly AnyEvmObservationField[]>(
  fields: Fields,
  signal: AbortSignal,
  ctx: AdapterContext,
): Promise<EvmObservationValues<Fields>> {
  return (await executeEvmObservationPlan({
    adapterKey: "reservoir", fields,
    read: (calls) => fetchOnchainMulticall3({ chain: "ethereum", calls, signal, ctx }),
  })).values;
}

interface ReservoirSavingsProbe {
  feeBps: number;
  previewAmountRaw: string;
  burnAmountRaw: string;
  conversionRateRaw: string;
}

/** Bind the exact preceding leg, not merely the common terminal PSM. */
async function probeReservoirSavings(
  coinId: string,
  psm: ReservoirPsmProbe,
  signal: AbortSignal,
  ctx: AdapterContext,
  identity: ReservoirIdentityValues,
): Promise<ReservoirSavingsProbe | null> {
  const amount = BigInt(psm.capacityRaw) * 10n ** 12n;
  const preview = (shares: bigint) => encodeFunctionData({
    abi: RESERVOIR_PROBE_ABI, functionName: "previewRedeem", args: [shares],
  });
  try {
    const minter = identity.minter;
    if (!minter || !/^0x[a-fA-F0-9]{64}$/.test(minter)) return null;
    const wrapped = coinId === "wsrusd-reservoir";
    const unitOutput = wrapped ? decodeUint256Word(identity.unitOutput) : null;
    const fee = wrapped ? 0n : decodeUint256Word(identity.savingsFee);
    const price = wrapped ? null : decodeUint256Word(identity.savingsPrice);
    if (wrapped) {
      // Current verified Savingcoin burns its shares and mints rUSD directly;
      // it does not transit srUSD/SavingModule or incur that module's fee.
      if (decodeStrictAddressWord(identity.wrapperAsset) !== RESERVOIR_RUSD_ADDRESS ||
        decodeUint256Word(identity.wrapperDecimals) !== 18n || unitOutput == null || unitOutput <= 0n) return null;
    } else if (
      decodeStrictAddressWord(identity.savingsRusd) !== RESERVOIR_RUSD_ADDRESS ||
      decodeStrictAddressWord(identity.savingsSrusd) !== RESERVOIR_SRUSD_ADDRESS ||
      decodeUint256Word(identity.savingsDecimals) !== 18n ||
      fee == null || fee < 0n || fee >= RESERVOIR_REDEEM_FEE_DENOMINATOR || price == null || price < 100_000_000n
    ) return null;
    // Only the role argument and full-notional preview depend on the first
    // batch's observed MINTER word and PSM cash. Read them together at its pin.
    const { authorized, previewAmount } = await readReservoirBatch([
      boolObservation({ label: "authorized", contract: RESERVOIR_RUSD_ADDRESS,
        data: encodeFunctionData({ abi: RESERVOIR_PROBE_ABI, functionName: "hasRole",
          args: [minter as `0x${string}`, wrapped ? RESERVOIR_WSRUSD_ADDRESS : RESERVOIR_SAVING_MODULE_ADDRESS] }) }),
      uint256Observation({ label: "previewAmount",
        contract: wrapped ? RESERVOIR_WSRUSD_ADDRESS : RESERVOIR_SAVING_MODULE_ADDRESS,
        data: wrapped
          ? encodeFunctionData({ abi: RESERVOIR_PROBE_ABI, functionName: "previewWithdraw", args: [amount] })
          : preview(amount) }),
    ] as const, signal, ctx);
    if (!authorized) return null;
    if (wrapped) {
      const onchain = makeOnchainCallers({ chain: "ethereum" }, { signal, ctx });
      // The verified wrapper ignores rounding direction. This is the only
      // genuinely dependent ladder: the adjacent share input depends on the
      // measured floor output. Reuse that output rather than querying it twice.
      const floorOutput = await onchain.uint256(RESERVOIR_WSRUSD_ADDRESS, preview(previewAmount));
      if (floorOutput == null) return null;
      const shares = floorOutput >= amount ? previewAmount : previewAmount + 1n;
      const adjacentOutput = await onchain.uint256(RESERVOIR_WSRUSD_ADDRESS,
        preview(floorOutput >= amount ? (shares > 0n ? shares - 1n : 0n) : shares));
      if (adjacentOutput == null) return null;
      const output = floorOutput >= amount ? floorOutput : adjacentOutput;
      const previousOutput = floorOutput >= amount ? adjacentOutput : floorOutput;
      if (output < amount || (shares > 0n && previousOutput >= amount)) return null;
      return { feeBps: 0, previewAmountRaw: amount.toString(), burnAmountRaw: shares.toString(), conversionRateRaw: unitOutput!.toString() };
    }
    if (price == null || fee == null || previewAmount !== (amount * 100_000_000n + price - 1n) / price) return null;
    const burnWithFee = previewAmount * (RESERVOIR_REDEEM_FEE_DENOMINATOR + fee) / RESERVOIR_REDEEM_FEE_DENOMINATOR;
    return {
      feeBps: Number(fee) / Number(RESERVOIR_REDEEM_FEE_DENOMINATOR) * 10_000,
      previewAmountRaw: amount.toString(), burnAmountRaw: burnWithFee.toString(), conversionRateRaw: price.toString(),
    };
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
async function probeReservoirUsdcPsm(
  coinId: string, signal: AbortSignal, ctx: AdapterContext,
): Promise<{ psm: ReservoirPsmProbe; identity: ReservoirIdentityValues } | null> {
  try {
    const identity = await readReservoirBatch(
      coinId === "rusd-reservoir" ? RESERVOIR_PSM_FIELDS :
        coinId === "wsrusd-reservoir" ? RESERVOIR_WSRUSD_FIELDS : RESERVOIR_SRUSD_FIELDS,
      signal, ctx,
    );
    if (decodeStrictAddressWord(identity.underlying) !== RESERVOIR_PSM_UNDERLYING_ADDRESS ||
      decodeStrictAddressWord(identity.rusd) !== RESERVOIR_RUSD_ADDRESS ||
      decodeUint256Word(identity.usdcDecimals) !== 6n ||
      decodeUint256Word(identity.decimalFactor) !== 6n || decodeUint256Word(identity.rusdDecimals) !== 18n) return null;
    const paused = decodeStrictBoolWord(identity.paused);
    const balanceRaw = decodeUint256Word(identity.balance);
    if (paused == null || balanceRaw == null || balanceRaw < 0n) return null;
    const capacityUsd = decimalNumberFromBigInt(balanceRaw, RESERVOIR_PSM_UNDERLYING_DECIMALS);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;
    return { psm: { capacityUsd, capacityRaw: balanceRaw.toString(), paused }, identity };
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
  /** Fatal when the asset rows materially exceed totalAssets; the attempt must not publish. */
  rowsExceedTotalWarning?: LiveReserveWarning;
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

  // Signed: a contra row nets against the total rather than being dropped, so it
  // cannot fabricate an overstatement. The shared classifier below still rejects
  // negative and non-finite rows, so a contra row fails the attempt instead of
  // being attributed to an arbitrary bucket.
  const disclosedAssetValue = payload.assets.reduce((sum, asset) => {
    const value = Number(asset.totalBalanceValue);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  const {
    gapUsd: sourceTotalGapUsd,
    gapPct: sourceTotalGapPct,
    rowsExceedTotalWarning,
  } = reconcileRowsWithSourceTotal({
    rowTotalUsd: disclosedAssetValue,
    sourceTotalUsd: totalAssets,
    exceedsMessage: "Reservoir asset rows exceed totalAssets",
  });
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
    decimals: null,
    unknownSliceName: "Unmapped reserve positions",
    unknownSourceKey: "reservoir:unknown",
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
    ...(rowsExceedTotalWarning ? { rowsExceedTotalWarning } : {}),
  };
}

async function fetchReservoirPayload(
  url: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<ReservoirReservesResponse> {
  // The same-origin fetch identity must follow the configured input host: the
  // three coins now fetch the protocol application's un-geofenced Vercel
  // deployment because the canonical app.reservoir.xyz zone answers Worker
  // egress with a country-gate 403 (the restricted list includes the US, and
  // both the browser-style and neutral identities receive it).
  const requestUrl = new URL(url);
  return fetchWithBrowserFallback(
    requestUrl.origin,
    new URL("/reserves", requestUrl.origin).toString(),
    (headers) => {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("Accept", "application/json, text/plain, */*");
      requestHeaders.set("Sec-Fetch-Dest", "empty");
      requestHeaders.set("Sec-Fetch-Mode", "cors");
      requestHeaders.set("Sec-Fetch-Site", "same-origin");
      return fetchJsonWithRetry<ReservoirReservesResponse>(url, signal, 20_000, ctx, {
        headers: requestHeaders,
      });
    },
    signal,
  );
}

export async function fetchReservoirReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "reservoir");

  const [payload, observed] = await Promise.all([
    fetchReservoirPayload(primaryInput.url, signal, ctx),
    (async () => {
      try {
        const plan = await pinnedBlockPlan({ chain: "ethereum", signal, ctx });
        const terminal = await probeReservoirUsdcPsm(coin.id, signal, plan.ctx);
        const savings = terminal && coin.id !== "rusd-reservoir"
          ? await probeReservoirSavings(coin.id, terminal.psm, signal, plan.ctx, terminal.identity)
          : null;
        return { ...plan, psm: terminal?.psm ?? null, savings };
      } catch (error) {
        rethrowIfAborted(error, signal);
        return null;
      }
    })(),
  ]);
  const psm = observed?.psm ?? null;
  const routeObserved = psm != null && (coin.id === "rusd-reservoir" || observed?.savings != null);
  const adapted = adaptReservoirReserves(payload);
  const totalAssetsUsd = Number(payload.totalAssets);
  const totalLiabilitiesUsd = Number(payload.totalLiabilities);
  const shareholderEquityUsd = Number(payload.equity);
  const warnings: LiveReserveWarning[] =
    adapted.unknownAssets.length > 0
      ? [
          buildUnknownExposureWarning({ adapterKey: "reservoir", code: "unknown-position",
          message: `Unmapped reserve positions: ${adapted.unknownAssets.join(", ")}`,
          unknownExposurePct: adapted.unknownExposurePct, }),
        ]
      : [];
  if (adapted.rowsExceedTotalWarning) warnings.push(adapted.rowsExceedTotalWarning);
  if (adapted.slices.some((slice) => slice.sourceKey === "reservoir:prime-unverified")) {
    warnings.push(reserveInfoWarning(
      "reservoir-prime-identity-unverified",
      "PRIME position does not match the reviewed Ethereum Sentora vault; its composition remains unlinked",
    ));
  }
  if (adapted.sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    warnings.push(
      buildUnknownExposureWarning({ adapterKey: "reservoir", code: "source-total-gap",
      message: "Reservoir totalAssets exceeds disclosed asset rows",
      unknownExposurePct: adapted.sourceTotalGapPct,  }),
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

  if (psm && !routeObserved) {
    warnings.push(reserveInfoWarning("reservoir-savings-unreadable",
      "Reservoir savings identity/conversion/fee leg was not established at the pinned PSM block; wrapper capacity withheld"));
  }

  return {
    slices: adapted.slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...(observed ? { observedBlock: observed.observedBlock } : {}),
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
      ...(routeObserved && psm != null && observed != null
        ? {
            psmUnderlyingBalanceRaw: psm.capacityRaw,
            ...(observed.savings ? { savingsExit: observed.savings } : {}),
            ...buildRedemptionSnapshotMetadata({
              capacityUsd: psm.paused ? 0 : psm.capacityUsd,
              capacityKind: "live-direct",
              freshnessKind: "same-run-onchain",
              sourceTimestamp: observed.observedBlock.timestamp,
              blockNumber: observed.observedBlock.number,
              outputAssetKeys: ["usdc-circle"],
              sharedResourceKey: SHARED_PSM_RESOURCE_KEY,
              routeObserved: true,
              routeStatus: psm.paused ? "paused" : "open",
              routeStatusSource: "onchain",
              routeStatusReason: psm.paused
                ? `Reservoir USDC PSM ${RESERVOIR_USDC_PSM_ADDRESS} paused() returned true at the pinned block`
                : `Reservoir exact-output USDC exit and preceding savings leg verified at block ${observed.observedBlock.number}`,
              holderEligibility: "any-holder",
              settlementDelaySec: 0,
              ...(observed.savings ? { feeBps: observed.savings.feeBps } : {}),
              sourceUrls: [RESERVOIR_PSM_DOC_URL,
                ...(coin.id !== "rusd-reservoir" ? ["https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd"] : [])],
            }),
          }
        : {}),
    },
  };
}
