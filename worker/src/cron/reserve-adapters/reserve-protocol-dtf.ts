import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type {
  LiveReserveRedemptionOutputValuation,
  LiveReserveRedemptionTelemetry,
  LiveReserveWarning,
  LiveReservesConfig,
} from "@shared/types/live-reserves";
import { decodeAbiParameters } from "viem/utils";
import { throwIfAborted } from "../../lib/abort";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR, encodeAddressCallData, encodeUint256 } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  isHttpJsonInput,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  parsePositiveNumericLike,
  requireJsonInputFromConfig,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromPercentages,
  slicesFromValues,
  unverifiedFreshnessMetadata,
} from "./helpers";
import { decodeAddressWord, decodeBoolWord } from "./abi-decode";
import { normalizeEvmAddress } from "./evm";
import { validateDecimals } from "./slice-math";

interface ReserveProtocolDtfBasketEntry {
  address?: string;
  symbol?: string;
  name?: string;
  weight?: string | number;
}

interface ReserveProtocolDtfRow {
  address?: string;
  name?: string;
  symbol?: string;
  price?: number;
  marketCap?: number;
  chainId?: number;
  type?: string;
  status?: string;
  basket?: ReserveProtocolDtfBasketEntry[];
}

interface ReserveProtocolDtfAssetDescriptor {
  address: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  blacklistable?: boolean;
}

interface ReserveProtocolDtfParams {
  assets?: ReserveProtocolDtfAssetDescriptor[];
  rpcUrl?: string;
  fallbackRpcUrl?: string;
}

const MAIN_SELECTOR = "0xdffeadd0";
const ASSET_REGISTRY_SELECTOR = "0x979d7e86";
const BASKET_HANDLER_SELECTOR = "0x2f2439b1";
const TO_ASSET_SELECTOR = "0xcde2be8a";
const BASKETS_NEEDED_SELECTOR = "0x7121c273";
const QUOTE_SELECTOR = "0x3913d11a";
const PRICE_SELECTOR = "0xa035b1fe";
const COLLATERAL_STATUS_SELECTOR = "0x200d2ed2";
const FULLY_COLLATERALIZED_SELECTOR = "0xe45a5b2d";
const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";
const ERC4626_ASSET_SELECTOR = "0x38d52e0f";
const EXCHANGE_RATE_SELECTOR = "0x3ba0b9a9";
const UNDERLYING_COMET_SELECTOR = "0x97008d6c";
const COMET_BASE_TOKEN_SELECTOR = "0xc55dae63";
// Verified CusdcV3Wrapper/CFiatV3Wrapper deployments expose exchangeRate(), not ERC-4626 convertToAssets().
const COMET_EXCHANGE_RATE_WRAPPERS = new Set([
  "0x27f2f159fe990ba83d57f39fd69661764bebf37a",
  "0xeb74ec1d4c1dab412d5d6674f6833fd19d3118ce",
]);
// Verified RTokenP1 implementation ABI for the USD3 proxy:
// https://eth.blockscout.com/api/v2/smart-contracts/0x258ce833CF9AD19208372763A00aA1565Dd40b3C
const REDEMPTION_AVAILABLE_SELECTOR = "0x9926020b";
const FLOOR_ROUNDING = 0n;
const APPLY_ISSUANCE_PREMIUM = 0n;
const PRICE_DECIMALS = 18;
const COLLATERAL_STATUS_SOUND = 0n;
const COLLATERAL_STATUS_IFFY = 1n;
const COLLATERAL_STATUS_DISABLED = 2n;

function buildDescriptorMap(
  assets: readonly ReserveProtocolDtfAssetDescriptor[] | undefined,
): Map<string, ReserveProtocolDtfAssetDescriptor> {
  const descriptors = new Map<string, ReserveProtocolDtfAssetDescriptor>();
  for (const asset of assets ?? []) {
    const address = normalizeEvmAddress(asset.address);
    if (address) descriptors.set(address, asset);
  }
  return descriptors;
}

function findDtfRow(rows: readonly ReserveProtocolDtfRow[], coin: StablecoinMeta): ReserveProtocolDtfRow | null {
  const contractAddresses = new Set(
    (coin.contracts ?? [])
      .map((contract) => normalizeEvmAddress(contract.address))
      .filter((address): address is `0x${string}` => address != null),
  );

  for (const row of rows) {
    const address = normalizeEvmAddress(row.address);
    if (address && contractAddresses.has(address)) return row;
  }

  const expectedSymbol = coin.symbol.toLowerCase();
  return rows.find((row) => row.symbol?.trim().toLowerCase() === expectedSymbol) ?? null;
}

function parseDtfRows(payload: unknown): ReserveProtocolDtfRow[] {
  if (!Array.isArray(payload)) {
    throw new Error("reserve-protocol-dtf adapter expected the DTF discovery payload to be an array");
  }
  return payload as ReserveProtocolDtfRow[];
}

function parseAddressResult(raw: string | null, context: string): `0x${string}` {
  const address = decodeAddressWord(raw);
  if (!address) {
    throw new Error(`reserve-protocol-dtf ${context} returned an invalid address`);
  }
  return address.toLowerCase() as `0x${string}`;
}

function decodeDecimals(raw: bigint | null, context: string): number {
  if (raw == null) {
    throw new Error(`reserve-protocol-dtf ${context} decimals() call failed`);
  }
  try {
    return validateDecimals(raw, `reserve-protocol-dtf ${context} decimals`);
  } catch {
    throw new Error(`reserve-protocol-dtf ${context} decimals out of range (${raw})`);
  }
}

function decodeBoolResult(raw: string | null): boolean | null {
  return decodeBoolWord(raw);
}

function buildRedemptionTelemetry(
  rTokenAddress: string,
  rTokenDecimals: number,
  redemptionAvailable: bigint | null,
  totalSupply: bigint | null,
  fullyCollateralized: boolean,
  basketStatus: bigint | null,
): LiveReserveRedemptionTelemetry | undefined {
  if (redemptionAvailable == null || totalSupply == null || basketStatus == null) return undefined;

  const capacityRaw = redemptionAvailable < totalSupply ? redemptionAvailable : totalSupply;
  const capacityUsd = decimalNumberFromBigInt(capacityRaw, rTokenDecimals);
  const supplyUsd = decimalNumberFromBigInt(totalSupply, rTokenDecimals);
  if (!Number.isFinite(capacityUsd) || !Number.isFinite(supplyUsd)) return undefined;

  const basketSound = fullyCollateralized && basketStatus === COLLATERAL_STATUS_SOUND;
  return {
    capacityUsd,
    ...(supplyUsd > 0 ? { capacityRatioOfSupply: capacityUsd / supplyUsd } : {}),
    capacityKind: "live-direct",
    freshnessKind: "same-run-onchain",
    routeStatus: basketSound ? "open" : "degraded",
    routeStatusSource: "onchain",
    routeStatusReason: basketSound
      ? `Reserve Protocol RToken redemptionAvailable() throttle read returned ${redemptionAvailable} raw units; capacity is capped by totalSupply() at ${capacityRaw} raw units`
      : `Reserve Protocol RToken redemptionAvailable() throttle read returned ${redemptionAvailable} raw units, but basket status is ${basketStatus} and fullyCollateralized() is ${fullyCollateralized}`,
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
    sourceUrls: [`https://eth.blockscout.com/address/${rTokenAddress}`],
  };
}

function encodeQuoteCall(amount: bigint): `0x${string}` {
  return `${QUOTE_SELECTOR}${encodeUint256(amount)}${encodeUint256(APPLY_ISSUANCE_PREMIUM)}${encodeUint256(FLOOR_ROUNDING)}` as `0x${string}`;
}

function decodeQuoteResult(raw: string): Array<{ address: `0x${string}`; quantity: bigint }> {
  const [addresses, quantities] = decodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256[]" }],
    raw as `0x${string}`,
  ) as readonly [`0x${string}`[], bigint[]];
  if (addresses.length !== quantities.length) {
    throw new Error("reserve-protocol-dtf quote returned mismatched token and quantity arrays");
  }
  return addresses.map((address, index) => ({ address, quantity: quantities[index] ?? 0n }));
}

function decodePriceResult(raw: string | null, context: string): { low: bigint; high: bigint; mid: bigint } {
  if (typeof raw !== "string") {
    throw new Error(`reserve-protocol-dtf price() call failed for ${context}`);
  }
  const [low, high] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    raw as `0x${string}`,
  ) as readonly [bigint, bigint];
  if (low <= 0n || high <= 0n) {
    throw new Error(`reserve-protocol-dtf non-positive price for ${context}`);
  }
  return { low, high, mid: (low + high) / 2n };
}

interface ReserveProtocolDtfOutputLeg {
  address: `0x${string}`;
  quantity: bigint;
  tokenDecimals: number;
  assetId: string;
}

async function readOutputLegValueUsd(
  leg: ReserveProtocolDtfOutputLeg,
  onchain: ReturnType<typeof makeOnchainCallers>,
): Promise<number | null> {
  if (!COMET_EXCHANGE_RATE_WRAPPERS.has(leg.address.toLowerCase())) {
    const convertedAssets = await onchain.uint256(
      leg.address,
      `${CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(leg.quantity)}`,
    );
    if (convertedAssets == null) return null;
    const rawUnderlying = await onchain.raw(leg.address, ERC4626_ASSET_SELECTOR);
    const underlying = parseAddressResult(rawUnderlying, `asset() for ${leg.address}`);
    const underlyingDecimals = decodeDecimals(
      await onchain.uint256(underlying, DECIMALS_SELECTOR),
      `underlying ${underlying}`,
    );
    const valueUsd = decimalNumberFromBigInt(convertedAssets, underlyingDecimals);
    return Number.isFinite(valueUsd) && valueUsd > 0 ? valueUsd : null;
  }

  const [exchangeRate, rawComet] = await Promise.all([
    onchain.uint256(leg.address, EXCHANGE_RATE_SELECTOR),
    onchain.raw(leg.address, UNDERLYING_COMET_SELECTOR),
  ]);
  if (exchangeRate == null || exchangeRate <= 0n) return null;
  const comet = parseAddressResult(rawComet, `underlyingComet() for ${leg.address}`);
  const rawUnderlying = await onchain.raw(comet, COMET_BASE_TOKEN_SELECTOR);
  const underlying = parseAddressResult(rawUnderlying, `baseToken() for ${comet}`);
  const underlyingDecimals = decodeDecimals(
    await onchain.uint256(underlying, DECIMALS_SELECTOR),
    `underlying ${underlying}`,
  );
  const underlyingRaw = (leg.quantity * exchangeRate) / 10n ** BigInt(leg.tokenDecimals);
  const valueUsd = decimalNumberFromBigInt(underlyingRaw, underlyingDecimals);
  return Number.isFinite(valueUsd) && valueUsd > 0 ? valueUsd : null;
}

async function buildRedemptionOutputValuation(args: {
  coinId: string;
  rTokenAddress: string;
  rTokenDecimals: number;
  totalSupply: bigint;
  legs: readonly ReserveProtocolDtfOutputLeg[];
  onchain: ReturnType<typeof makeOnchainCallers>;
  observedAt: number;
}): Promise<LiveReserveRedemptionOutputValuation | null> {
  const configuredAssetIds = REDEMPTION_BACKSTOP_CONFIGS[args.coinId]?.outputAssets;
  if (!configuredAssetIds || configuredAssetIds.length < 2 || args.totalSupply <= 0n) return null;

  const liveAssetIds = [...new Set(args.legs.map((leg) => leg.assetId))].sort();
  const expectedAssetIds = [...configuredAssetIds].sort();
  if (
    liveAssetIds.length !== expectedAssetIds.length ||
    liveAssetIds.some((assetId, index) => assetId !== expectedAssetIds[index])
  ) {
    return null;
  }

  try {
    const legValues: Array<{ assetId: string; valueUsd: number | null }> = [];
    for (const leg of args.legs) {
      legValues.push({
        assetId: leg.assetId,
        valueUsd: await readOutputLegValueUsd(leg, args.onchain),
      });
    }
    if (legValues.some((leg) => leg.valueUsd == null)) return null;

    const valueByAssetId = new Map<string, number>();
    for (const leg of legValues) {
      valueByAssetId.set(leg.assetId, (valueByAssetId.get(leg.assetId) ?? 0) + leg.valueUsd!);
    }
    const totalValueUsd = [...valueByAssetId.values()].reduce((sum, value) => sum + value, 0);
    const supply = decimalNumberFromBigInt(args.totalSupply, args.rTokenDecimals);
    const unitValueUsd = totalValueUsd / supply;
    if (!Number.isFinite(totalValueUsd) || totalValueUsd <= 0 || !Number.isFinite(unitValueUsd) || unitValueUsd <= 0) {
      return null;
    }

    return {
      sourceId: `reserve-protocol-dtf:basket-nav:${args.rTokenAddress.toLowerCase()}`,
      observedAt: args.observedAt,
      unitValueUsd,
      basketWeights: configuredAssetIds.map((assetId) => ({
        assetId,
        weight: valueByAssetId.get(assetId)! / totalValueUsd,
      })),
    };
  } catch {
    return null;
  }
}

export function adaptReserveProtocolDtfRows(
  payload: unknown,
  coin: StablecoinMeta,
  assets: readonly ReserveProtocolDtfAssetDescriptor[] | undefined,
  sourceUrl: string,
): AdapterResult {
  const rows = parseDtfRows(payload);
  const dtf = findDtfRow(rows, coin);
  if (!dtf) {
    throw new Error(`reserve-protocol-dtf could not find ${coin.id} in Reserve Protocol discovery payload`);
  }

  const descriptorByAddress = buildDescriptorMap(assets);
  const values: Array<{
    pct: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
    blacklistable?: boolean;
  }> = [];
  const warnings: LiveReserveWarning[] = [];
  let unknownWeight = 0;
  let totalWeight = 0;

  for (const component of dtf.basket ?? []) {
    const pct = parsePositiveNumericLike(component.weight);
    if (pct == null) continue;
    totalWeight += pct;

    const address = normalizeEvmAddress(component.address);
    const descriptor = address ? descriptorByAddress.get(address) : undefined;
    if (!descriptor) {
      unknownWeight += pct;
      values.push({
        pct,
        name: `Unmapped Reserve Protocol DTF asset: ${component.symbol ?? component.name ?? component.address ?? "unknown"}`,
        risk: "high",
      });
      continue;
    }

    values.push({
      pct,
      name: descriptor.name,
      risk: descriptor.risk,
      coinId: descriptor.coinId,
      depType: descriptor.depType,
      blacklistable: descriptor.blacklistable,
    });
  }

  if (values.length === 0) {
    throw new Error(`reserve-protocol-dtf found no positive basket weights for ${coin.id}`);
  }

  const unknownExposurePct = computeUnknownExposurePct(unknownWeight, totalWeight);
  if (unknownExposurePct > 0) {
    warnings.push(
      buildUnknownExposureWarning({
        code: "reserve-protocol-dtf-unknown-component",
        message: "Unmapped Reserve Protocol DTF basket components",
        unknownExposurePct,
      }),
    );
  }
  if (dtf.status && dtf.status !== "active") {
    warnings.push(
      reserveInfoWarning("reserve-protocol-dtf-status", `Reserve Protocol reports DTF status "${dtf.status}"`),
    );
  }

  const freshness = unverifiedFreshnessMetadata(
    "reserve-protocol-api",
    "Reserve Protocol DTF discovery payload does not expose a source timestamp",
  );

  return {
    slices: slicesFromPercentages(values, {
      decimals: 1,
      tolerancePct: 2,
      context: `${coin.id} Reserve Protocol basket`,
    }),
    warnings,
    metadata: {
      ...freshness,
      unknownExposurePct,
      marketPriceUsd: parsePositiveNumericLike(dtf.price) ?? undefined,
      marketCapUsd: parsePositiveNumericLike(dtf.marketCap) ?? undefined,
      chainId: dtf.chainId,
      dtfStatus: dtf.status,
      dtfType: dtf.type,
      componentCount: values.length,
      details: {
        ...freshness.details,
        sourceUrl,
        dtfAddress: dtf.address,
        dtfSymbol: dtf.symbol,
      },
    },
  };
}

export async function fetchReserveProtocolDtfReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (!isHttpJsonInput(config.inputs.primary)) {
    return fetchReserveProtocolDtfOnchainReserves(coin, config, signal, ctx);
  }

  const input = requireJsonInputFromConfig(config, "reserve-protocol-dtf");
  const params = parseLiveReserveAdapterParams("reserve-protocol-dtf", config.params) as ReserveProtocolDtfParams;
  const payload = await fetchJsonWithRetry<unknown>(input.url, signal, 10_000, ctx);
  return adaptReserveProtocolDtfRows(payload, coin, params.assets, input.url);
}

async function fetchReserveProtocolDtfOnchainReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "reserve-protocol-dtf");
  const params = parseLiveReserveAdapterParams("reserve-protocol-dtf", config.params) as ReserveProtocolDtfParams;
  const descriptorByAddress = buildDescriptorMap(params.assets);
  const rTokenContract = coin.contracts?.find((contract) => contract.chain === input.chain);
  if (!rTokenContract) {
    throw new Error(`reserve-protocol-dtf found no ${input.chain} RToken contract for ${coin.id}`);
  }
  const rTokenAddress = rTokenContract.address;
  const rTokenDecimals = validateDecimals(rTokenContract.decimals, `reserve-protocol-dtf ${coin.id} RToken decimals`);

  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs: 12_000,
  });
  const rawMain = await onchain.raw(rTokenAddress, MAIN_SELECTOR);
  const mainAddress = parseAddressResult(rawMain, "main()");
  const [rawAssetRegistry, rawBasketHandler, rawBasketsNeeded] = await Promise.all([
    onchain.raw(mainAddress, ASSET_REGISTRY_SELECTOR),
    onchain.raw(mainAddress, BASKET_HANDLER_SELECTOR),
    onchain.uint256(rTokenAddress, BASKETS_NEEDED_SELECTOR),
  ]);
  const assetRegistry = parseAddressResult(rawAssetRegistry, "assetRegistry()");
  const basketHandler = parseAddressResult(rawBasketHandler, "basketHandler()");
  if (rawBasketsNeeded == null || rawBasketsNeeded <= 0n) {
    throw new Error("reserve-protocol-dtf basketsNeeded() call failed");
  }
  const quoteAmount = rawBasketsNeeded;
  const [rawFullyCollateralized, rawBasketStatus, rawQuote, rawRedemptionAvailable, rawTotalSupply] =
    await Promise.all([
      onchain.raw(basketHandler, FULLY_COLLATERALIZED_SELECTOR),
      onchain.uint256(basketHandler, COLLATERAL_STATUS_SELECTOR),
      onchain.raw(basketHandler, encodeQuoteCall(quoteAmount)),
      onchain.uint256(rTokenAddress, REDEMPTION_AVAILABLE_SELECTOR),
      onchain.uint256(rTokenAddress, TOTAL_SUPPLY_SELECTOR),
    ]);
  if (!rawQuote) {
    throw new Error("reserve-protocol-dtf quote() call failed");
  }
  const quoteEntries = decodeQuoteResult(rawQuote).filter((entry) => entry.quantity > 0n);
  if (quoteEntries.length === 0) {
    throw new Error(`reserve-protocol-dtf quote returned no positive basket quantities for ${coin.id}`);
  }

  const warnings: LiveReserveWarning[] = [];
  const values: Array<{
    value: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
    blacklistable?: boolean;
  }> = [];
  let unknownValue = 0;
  let totalValue = 0;
  const componentMetadata: Array<Record<string, unknown>> = [];
  const outputLegs: ReserveProtocolDtfOutputLeg[] = [];

  for (const entry of quoteEntries) {
    throwIfAborted(signal);
    const [rawDecimals, rawAsset] = await Promise.all([
      onchain.uint256(entry.address, DECIMALS_SELECTOR),
      onchain.raw(assetRegistry, encodeAddressCallData(TO_ASSET_SELECTOR, entry.address)),
    ]);
    const tokenDecimals = decodeDecimals(rawDecimals, entry.address);
    const assetAddress = parseAddressResult(rawAsset, `toAsset(${entry.address})`);
    const [rawPrice, rawStatus] = await Promise.all([
      onchain.raw(assetAddress, PRICE_SELECTOR),
      onchain.uint256(assetAddress, COLLATERAL_STATUS_SELECTOR),
    ]);
    const price = decodePriceResult(rawPrice, entry.address);
    const value = decimalNumberFromBigInt(entry.quantity * price.mid, tokenDecimals + PRICE_DECIMALS);
    totalValue += value;
    const normalizedAddress = normalizeEvmAddress(entry.address);
    const descriptor = normalizedAddress ? descriptorByAddress.get(normalizedAddress) : undefined;
    componentMetadata.push({
      tokenAddress: entry.address,
      assetPlugin: assetAddress,
      rawQuantity: entry.quantity.toString(),
      tokenDecimals,
      priceLow: price.low.toString(),
      priceHigh: price.high.toString(),
      collateralStatus: rawStatus?.toString(),
    });

    if (rawStatus === COLLATERAL_STATUS_IFFY) {
      warnings.push(
        reserveDegradedWarning(
          "reserve-protocol-dtf-collateral-status",
          `Reserve Protocol collateral status is IFFY (${COLLATERAL_STATUS_IFFY}) for ${entry.address}`,
        ),
      );
    } else if (rawStatus === COLLATERAL_STATUS_DISABLED) {
      throw new Error(
        `reserve-protocol-dtf collateral status is DISABLED (${COLLATERAL_STATUS_DISABLED}) for ${entry.address}`,
      );
    } else if (rawStatus != null && rawStatus !== COLLATERAL_STATUS_SOUND) {
      warnings.push(
        reserveDegradedWarning(
          "reserve-protocol-dtf-collateral-status",
          `Reserve Protocol collateral status is unknown (${rawStatus}) for ${entry.address}`,
        ),
      );
    }
    if (!descriptor) {
      unknownValue += value;
      values.push({
        value,
        name: `Unmapped Reserve Protocol DTF asset: ${entry.address}`,
        risk: "high",
      });
      continue;
    }
    if (descriptor.coinId) {
      outputLegs.push({
        address: entry.address,
        quantity: entry.quantity,
        tokenDecimals,
        assetId: descriptor.coinId,
      });
    }
    values.push({
      value,
      name: descriptor.name,
      risk: descriptor.risk,
      coinId: descriptor.coinId,
      depType: descriptor.depType,
      blacklistable: descriptor.blacklistable,
    });
  }

  const unknownExposurePct = computeUnknownExposurePct(unknownValue, totalValue);
  if (unknownExposurePct > 0) {
    warnings.push(
      buildUnknownExposureWarning({
        code: "reserve-protocol-dtf-unknown-component",
        message: "Unmapped Reserve Protocol DTF basket components",
        unknownExposurePct,
      }),
    );
  }
  const fullyCollateralized = decodeBoolResult(rawFullyCollateralized);
  if (fullyCollateralized == null) {
    throw new Error("reserve-protocol-dtf fullyCollateralized() call failed");
  }
  if (fullyCollateralized === false) {
    warnings.push(
      reserveDegradedWarning(
        "reserve-protocol-dtf-undercollateralized",
        "Reserve Protocol reports the RToken is not fully collateralized",
      ),
    );
  }
  let redemption = buildRedemptionTelemetry(
    rTokenAddress,
    rTokenDecimals,
    rawRedemptionAvailable,
    rawTotalSupply,
    fullyCollateralized,
    rawBasketStatus,
  );
  if (redemption && rawTotalSupply != null && outputLegs.length === quoteEntries.length) {
    const outputValuation = await buildRedemptionOutputValuation({
      coinId: coin.id,
      rTokenAddress,
      rTokenDecimals,
      totalSupply: rawTotalSupply,
      legs: outputLegs,
      onchain,
      observedAt: Math.floor(ctx?.nowSec ?? Date.now() / 1_000),
    });
    if (outputValuation) redemption = { ...redemption, outputValuation };
  }

  return {
    slices: slicesFromValues(values),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "reserve-protocol-dtf-direct-onchain",
        rTokenAddress,
        mainAddress,
        assetRegistry,
        basketHandler,
        quoteAmount: quoteAmount.toString(),
        components: componentMetadata,
      }),
      unknownExposurePct,
      componentCount: values.length,
      totalQuotedValueUsd: totalValue,
      fullyCollateralized,
      ...(rawBasketStatus != null ? { basketStatus: rawBasketStatus.toString() } : {}),
      ...(redemption ? { redemption } : {}),
    },
  };
}
