import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { CANONICAL_ETH_RESERVE_RISK, getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { Abi } from "abitype";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";
import { getPublicRpcUrl, getSecondaryFallbackRpcUrl } from "../../lib/public-rpc-registry";
import type { AdapterContext, AdapterResult } from "./types";
import { runAdapterIo } from "./concurrency";
import {
  fetchDefiLlamaPrices,
  fetchJsonWithRetry,
  fetchOnchainMulticall3,
  normalizeSlices,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  requireOnchainInput,
  reserveDegradedWarning,
  unverifiedFreshnessMetadata,
  valueUsdFromBigIntPrice,
} from "./helpers";
import { worseRisk } from "./slice-math";

interface CurveMarketEntry {
  collateral_amount_usd?: number;
  collateral_token?: {
    symbol?: string;
  };
}

interface CurveMarketsPayload {
  chains?: {
    ethereum?: {
      data?: CurveMarketEntry[];
    };
  };
}

interface YieldBasisMarketExposure {
  marketId: number;
  symbol: string;
  usd: number;
}

interface YieldBasisMarketPosition {
  marketId: number;
  symbol: string;
  assetAddress: string;
  assetDecimals: number;
  assetAmount: bigint;
}

interface LlammaMarketDescriptor {
  marketId: number;
  collateralAddress: string;
  controllerAddress: string;
  ammAddress: string;
  symbol: string;
  minBand: number;
  maxBand: number;
}

interface LlammaMarketExposure {
  marketId: number;
  symbol: string;
  collateralAddress: string;
  ammAddress: string;
  collateralUsd: number;
  softLiquidatedCrvUsdUsd: number;
  minBand: number;
  maxBand: number;
  bandCount: number;
}

const ETHEREUM_CHAIN = "ethereum";
const ETHEREUM_RPC_URLS = [getPublicRpcUrl(ETHEREUM_CHAIN), getSecondaryFallbackRpcUrl(ETHEREUM_CHAIN)].filter(
  (url): url is string => typeof url === "string" && url.length > 0,
);
const CURVE_CONTROLLER_FACTORY = "0xC9332fdCB1C491Dcc683bAe86Fe3cb70360738BC";
const DIRECT_LLAMMA_MULTICALL_BATCH_SIZE = 500;
const YIELD_BASIS_FACTORY = "0x370a449febb9411c95bf897021377fe0b7d100c0";
const YIELD_BASIS_VIEW_GAS = "0x5B8D80";
const CURVE_CONTROLLER_FACTORY_ABI = parseAbi([
  "function n_collaterals() view returns (uint256)",
  "function collaterals(uint256) view returns (address)",
  "function controllers(uint256) view returns (address)",
  "function amms(uint256) view returns (address)",
]);
const CURVE_AMM_ABI = parseAbi([
  "function min_band() view returns (int256)",
  "function max_band() view returns (int256)",
  "function bands_x(int256) view returns (uint256)",
  "function bands_y(int256) view returns (uint256)",
]);
const YIELD_BASIS_FACTORY_ABI = parseAbi([
  "function market_count() view returns (uint256)",
  "function markets(uint256) view returns (address asset_token, address cryptopool, address amm, address lt, address price_oracle, address virtual_pool, address staker)",
]);
const YIELD_BASIS_LT_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function preview_emergency_withdraw(uint256 shares) view returns (uint256,int256)",
]);
const ERC20_METADATA_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

function classifySymbol(symbol: string): { name: string; risk: ReserveSlice["risk"] } | null {
  const upper = symbol.toUpperCase();
  if (["WBTC", "CBBTC", "LBTC", "ZKBTC"].includes(upper)) {
    return { name: "Custodied BTC (ex: wBTC/cbBTC)", risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium" };
  }
  if (upper === "TBTC") {
    return { name: "tBTC", risk: getCanonicalReserveAssetRisk("TBTC") ?? "medium" };
  }
  if (["WSTETH", "SFRXETH", "WEETH"].includes(upper)) {
    return { name: "wstETH / sfrxETH / weETH", risk: getCanonicalReserveAssetRisk(upper) ?? "low" };
  }
  if (upper === "ETH" || upper === "WETH") {
    return { name: "ETH", risk: CANONICAL_ETH_RESERVE_RISK };
  }
  return null;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

async function readEthereumContract(
  address: string,
  abi: Abi,
  functionName: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  args: readonly unknown[] = [],
  gas?: string,
): Promise<unknown> {
  const data = encodeFunctionData({
    abi,
    functionName,
    args,
  });
  const raw = await runAdapterIo(ctx, `crvusd-evm-call:${address}:${functionName}`, () =>
    fetchEvmCallHexAtBlock(ETHEREUM_CHAIN, address, data, "latest", {
      signal,
      timeoutMs: 12_000,
      chainRpcs: ctx?.chainRpcs,
      extraRpcUrls: ETHEREUM_RPC_URLS,
      ...(gas ? { gas } : {}),
    }));
  if (!raw) {
    throw new Error(`crvUSD Yield Basis read failed for ${functionName} on ${address}`);
  }
  return decodeFunctionResult({
    abi,
    functionName,
    data: raw,
  });
}

function safeInt256ToNumber(value: bigint, label: string): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`crvUSD ${label} out of safe integer range: ${value.toString()}`);
  }
  return asNumber;
}

function decodeMulticallUint256(raw: `0x${string}`, functionName: "bands_x" | "bands_y"): bigint {
  return decodeFunctionResult({
    abi: CURVE_AMM_ABI,
    functionName,
    data: raw,
  }) as bigint;
}

async function fetchLlammaMarketDescriptors(signal: AbortSignal, ctx?: AdapterContext): Promise<LlammaMarketDescriptor[]> {
  const countRaw = (await readEthereumContract(
    CURVE_CONTROLLER_FACTORY,
    CURVE_CONTROLLER_FACTORY_ABI,
    "n_collaterals",
    signal,
    ctx,
  )) as bigint;
  const marketCount = Number(countRaw);
  if (!Number.isSafeInteger(marketCount) || marketCount < 0) {
    throw new Error(`crvUSD ControllerFactory n_collaterals invalid: ${String(countRaw)}`);
  }

  const descriptors: LlammaMarketDescriptor[] = [];
  for (let marketId = 0; marketId < marketCount; marketId += 1) {
    const [collateralAddress, controllerAddress, ammAddress] = await Promise.all([
      readEthereumContract(CURVE_CONTROLLER_FACTORY, CURVE_CONTROLLER_FACTORY_ABI, "collaterals", signal, ctx, [
        BigInt(marketId),
      ]) as Promise<string>,
      readEthereumContract(CURVE_CONTROLLER_FACTORY, CURVE_CONTROLLER_FACTORY_ABI, "controllers", signal, ctx, [
        BigInt(marketId),
      ]) as Promise<string>,
      readEthereumContract(CURVE_CONTROLLER_FACTORY, CURVE_CONTROLLER_FACTORY_ABI, "amms", signal, ctx, [
        BigInt(marketId),
      ]) as Promise<string>,
    ]);
    const [symbolRaw, minBandRaw, maxBandRaw] = await Promise.all([
      readEthereumContract(collateralAddress, ERC20_METADATA_ABI, "symbol", signal, ctx),
      readEthereumContract(ammAddress, CURVE_AMM_ABI, "min_band", signal, ctx),
      readEthereumContract(ammAddress, CURVE_AMM_ABI, "max_band", signal, ctx),
    ]);
    if (typeof symbolRaw !== "string") {
      throw new Error(`crvUSD LLAMMA symbol unreadable for market ${marketId}`);
    }
    const minBand = safeInt256ToNumber(minBandRaw as bigint, `market ${marketId} min_band`);
    const maxBand = safeInt256ToNumber(maxBandRaw as bigint, `market ${marketId} max_band`);
    if (maxBand < minBand) continue;
    descriptors.push({
      marketId,
      collateralAddress,
      controllerAddress,
      ammAddress,
      symbol: symbolRaw,
      minBand,
      maxBand,
    });
  }

  return descriptors;
}

async function fetchLlammaMarketExposures(
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<LlammaMarketExposure[]> {
  const descriptors = await fetchLlammaMarketDescriptors(signal, ctx);
  if (descriptors.length === 0) return [];

  const priceMap = await fetchDefiLlamaPrices(
    Array.from(
      new Map(
        descriptors.map((market) => [
          normalizeAddress(market.collateralAddress),
          {
            key: normalizeAddress(market.collateralAddress),
            chain: ETHEREUM_CHAIN,
            address: market.collateralAddress,
          },
        ]),
      ).values(),
    ),
    signal,
    ctx,
  );

  const calls = descriptors.flatMap((market) => {
    const marketCalls = [];
    for (let band = market.minBand; band <= market.maxBand; band += 1) {
      marketCalls.push({
        label: `${market.marketId}:y:${band}`,
        contract: market.ammAddress,
        data: encodeFunctionData({ abi: CURVE_AMM_ABI, functionName: "bands_y", args: [BigInt(band)] }),
      });
      marketCalls.push({
        label: `${market.marketId}:x:${band}`,
        contract: market.ammAddress,
        data: encodeFunctionData({ abi: CURVE_AMM_ABI, functionName: "bands_x", args: [BigInt(band)] }),
      });
    }
    return marketCalls;
  });

  const results = await fetchOnchainMulticall3({
    calls,
    chain: ETHEREUM_CHAIN,
    signal,
    ctx,
    rpcUrl: ETHEREUM_RPC_URLS[0],
    fallbackRpcUrl: ETHEREUM_RPC_URLS[1],
    timeoutMs: 20_000,
    multicallBatchSize: DIRECT_LLAMMA_MULTICALL_BATCH_SIZE,
  });
  if (!results) {
    throw new Error("crvUSD LLAMMA band multicall failed");
  }

  const byMarket = new Map<number, { y: bigint; x: bigint }>();
  for (const result of results) {
    if (!result.success) {
      throw new Error(`crvUSD LLAMMA band call failed: ${result.label}`);
    }
    const [marketIdRaw, axis] = result.label.split(":");
    const marketId = Number(marketIdRaw);
    if (!Number.isSafeInteger(marketId)) {
      throw new Error(`crvUSD LLAMMA band call returned invalid label: ${result.label}`);
    }
    const current = byMarket.get(marketId) ?? { y: 0n, x: 0n };
    if (axis === "y") {
      current.y += decodeMulticallUint256(result.returnData, "bands_y");
    } else if (axis === "x") {
      current.x += decodeMulticallUint256(result.returnData, "bands_x");
    } else {
      throw new Error(`crvUSD LLAMMA band call returned invalid axis: ${result.label}`);
    }
    byMarket.set(marketId, current);
  }

  return descriptors.map((market) => {
    const totals = byMarket.get(market.marketId) ?? { y: 0n, x: 0n };
    const price = priceMap.get(normalizeAddress(market.collateralAddress));
    if (price == null) {
      throw new Error(`crvUSD LLAMMA missing DefiLlama price for market ${market.marketId} (${market.symbol})`);
    }
    return {
      marketId: market.marketId,
      symbol: market.symbol,
      collateralAddress: market.collateralAddress,
      ammAddress: market.ammAddress,
      // Curve LLAMMA `bands_y` is normalized to 18 decimals by the AMM.
      collateralUsd: valueUsdFromBigIntPrice(totals.y, 18, price),
      softLiquidatedCrvUsdUsd: valueUsdFromBigIntPrice(totals.x, 18, 1),
      minBand: market.minBand,
      maxBand: market.maxBand,
      bandCount: market.maxBand - market.minBand + 1,
    };
  });
}

async function fetchYieldBasisMarketPositions(
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<YieldBasisMarketPosition[]> {
  const marketCountRaw = (await readEthereumContract(
    YIELD_BASIS_FACTORY,
    YIELD_BASIS_FACTORY_ABI,
    "market_count",
    signal,
    ctx,
  )) as bigint;
  const marketCount = Number(marketCountRaw);
  if (!Number.isSafeInteger(marketCount) || marketCount < 0) {
    throw new Error(`crvUSD Yield Basis market_count invalid: ${String(marketCountRaw)}`);
  }

  const positions: YieldBasisMarketPosition[] = [];
  for (let marketId = 0; marketId < marketCount; marketId += 1) {
    const market = (await readEthereumContract(YIELD_BASIS_FACTORY, YIELD_BASIS_FACTORY_ABI, "markets", signal, ctx, [
      BigInt(marketId),
    ])) as readonly [string, string, string, string, string, string, string];
    const assetAddress = market[0];
    const ltAddress = market[3];
    const [symbolRaw, decimalsRaw, totalSupply] = await Promise.all([
      readEthereumContract(assetAddress, ERC20_METADATA_ABI, "symbol", signal, ctx),
      readEthereumContract(assetAddress, ERC20_METADATA_ABI, "decimals", signal, ctx),
      readEthereumContract(ltAddress, YIELD_BASIS_LT_ABI, "totalSupply", signal, ctx),
    ]);

    if (typeof symbolRaw !== "string") {
      throw new Error(`crvUSD Yield Basis symbol unreadable for market ${marketId}`);
    }

    const assetDecimals = Number(decimalsRaw);
    if (!Number.isInteger(assetDecimals) || assetDecimals < 0) {
      throw new Error(`crvUSD Yield Basis decimals invalid for market ${marketId}`);
    }

    const supply = totalSupply as bigint;
    if (supply <= 0n) continue;

    // Newer YB markets can revert on preview_withdraw(totalSupply); preview_emergency_withdraw
    // still exposes the full-market external asset balance without relying on that swap path.
    const emergencyWithdraw = (await readEthereumContract(
      ltAddress,
      YIELD_BASIS_LT_ABI,
      "preview_emergency_withdraw",
      signal,
      ctx,
      [supply],
      YIELD_BASIS_VIEW_GAS,
    )) as readonly [bigint, bigint];
    const assetAmount = emergencyWithdraw[0];
    if (assetAmount <= 0n) continue;

    positions.push({
      marketId,
      symbol: symbolRaw,
      assetAddress,
      assetDecimals,
      assetAmount,
    });
  }

  return positions;
}

async function fetchYieldBasisMarketExposures(
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<YieldBasisMarketExposure[]> {
  const positions = await fetchYieldBasisMarketPositions(signal, ctx);
  if (positions.length === 0) return [];

  const priceMap = await fetchDefiLlamaPrices(
    Array.from(
      new Map(
        positions.map((position) => [
          normalizeAddress(position.assetAddress),
          {
            key: normalizeAddress(position.assetAddress),
            chain: ETHEREUM_CHAIN,
            address: position.assetAddress,
          },
        ]),
      ).values(),
    ),
    signal,
    ctx,
  );

  return positions.map((position) => {
    const price = priceMap.get(normalizeAddress(position.assetAddress));
    if (price == null) {
      throw new Error(
        `crvUSD Yield Basis missing DefiLlama price for market ${position.marketId} (${position.symbol})`,
      );
    }
    return {
      marketId: position.marketId,
      symbol: position.symbol,
      usd: valueUsdFromBigIntPrice(position.assetAmount, position.assetDecimals, price),
    };
  });
}

export function adaptCrvUsd(
  payload: CurveMarketsPayload,
  yieldBasisMarkets: YieldBasisMarketExposure[] = [],
): AdapterResult {
  const markets = payload.chains?.ethereum?.data ?? [];
  const buckets = new Map<string, { usd: number; risk: ReserveSlice["risk"] }>();
  const warnings: LiveReserveWarning[] = [];
  let unknownUsd = 0;
  let directActiveMarkets = 0;
  let yieldBasisActiveMarkets = 0;
  let directCollateralUsd = 0;
  let yieldBasisCollateralUsd = 0;

  for (const market of markets) {
    const symbol = market.collateral_token?.symbol;
    const usd = market.collateral_amount_usd ?? 0;
    if (!symbol || !Number.isFinite(usd) || usd <= 0) continue;
    directActiveMarkets++;
    directCollateralUsd += usd;

    const bucket = classifySymbol(symbol);
    if (!bucket) {
      warnings.push(reserveDegradedWarning("unknown-market", `Unmapped crvUSD collateral market: ${symbol}`));
      unknownUsd += usd;
      continue;
    }

    const existing = buckets.get(bucket.name);
    if (existing) {
      existing.usd += usd;
      existing.risk = worseRisk(existing.risk, bucket.risk);
    } else {
      buckets.set(bucket.name, { usd, risk: bucket.risk });
    }
  }

  for (const market of yieldBasisMarkets) {
    const usd = market.usd;
    if (!Number.isFinite(usd) || usd <= 0) continue;
    yieldBasisActiveMarkets++;
    yieldBasisCollateralUsd += usd;

    const bucket = classifySymbol(market.symbol);
    if (!bucket) {
      warnings.push(
        reserveDegradedWarning("unknown-market", `Unmapped crvUSD Yield Basis collateral market: ${market.symbol}`),
      );
      unknownUsd += usd;
      continue;
    }

    const existing = buckets.get(bucket.name);
    if (existing) {
      existing.usd += usd;
      existing.risk = worseRisk(existing.risk, bucket.risk);
    } else {
      buckets.set(bucket.name, { usd, risk: bucket.risk });
    }
  }

  const total = Array.from(buckets.values()).reduce((acc, bucket) => acc + bucket.usd, 0);
  const totalWithUnknown = total + unknownUsd;
  if (totalWithUnknown <= 0) return { slices: [], warnings };

  if (unknownUsd > 0) {
    buckets.set("Other / unmapped collateral markets", {
      usd: unknownUsd,
      risk: "high",
    });
  }

  const slices = normalizeSlices(
    Array.from(buckets.entries()).map(([name, bucket]) => ({
      name,
      pct: (bucket.usd / totalWithUnknown) * 100,
      risk: bucket.risk,
    })),
    1,
  );

  return {
    slices,
    warnings,
    metadata: {
      marketCount: markets.length + yieldBasisMarkets.length,
      directMarketCount: markets.length,
      yieldBasisMarketCount: yieldBasisMarkets.length,
      activeMarketCount: directActiveMarkets + yieldBasisActiveMarkets,
      directActiveMarketCount: directActiveMarkets,
      yieldBasisActiveMarketCount: yieldBasisActiveMarkets,
      bucketCount: buckets.size,
      directCollateralUsd,
      yieldBasisCollateralUsd,
      yieldBasisCollateralPct: totalWithUnknown > 0 ? (yieldBasisCollateralUsd / totalWithUnknown) * 100 : 0,
      unknownExposurePct: totalWithUnknown > 0 ? (unknownUsd / totalWithUnknown) * 100 : 0,
      ...unverifiedFreshnessMetadata(
        "curve-market-api + yield-basis-onchain",
        "Curve market payload does not expose a trustworthy source timestamp even though the Yield Basis leg is current-state on-chain",
      ),
    },
  };
}

export function adaptCrvUsdOnchain(
  llammaMarkets: readonly LlammaMarketExposure[],
  yieldBasisMarkets: readonly YieldBasisMarketExposure[] = [],
): AdapterResult {
  const buckets = new Map<string, { usd: number; risk: ReserveSlice["risk"] }>();
  const warnings: LiveReserveWarning[] = [];
  let unknownUsd = 0;
  let directActiveMarkets = 0;
  let yieldBasisActiveMarkets = 0;
  let directCollateralUsd = 0;
  let yieldBasisCollateralUsd = 0;
  let softLiquidatedCrvUsdUsd = 0;
  let bandReadCount = 0;

  for (const market of llammaMarkets) {
    const usd = market.collateralUsd;
    softLiquidatedCrvUsdUsd += market.softLiquidatedCrvUsdUsd;
    bandReadCount += market.bandCount;
    if (!Number.isFinite(usd) || usd <= 0) continue;
    directActiveMarkets++;
    directCollateralUsd += usd;

    const bucket = classifySymbol(market.symbol);
    if (!bucket) {
      warnings.push(reserveDegradedWarning("unknown-market", `Unmapped crvUSD LLAMMA collateral market: ${market.symbol}`));
      unknownUsd += usd;
      continue;
    }

    const existing = buckets.get(bucket.name);
    if (existing) {
      existing.usd += usd;
      existing.risk = worseRisk(existing.risk, bucket.risk);
    } else {
      buckets.set(bucket.name, { usd, risk: bucket.risk });
    }
  }

  for (const market of yieldBasisMarkets) {
    const usd = market.usd;
    if (!Number.isFinite(usd) || usd <= 0) continue;
    yieldBasisActiveMarkets++;
    yieldBasisCollateralUsd += usd;

    const bucket = classifySymbol(market.symbol);
    if (!bucket) {
      warnings.push(
        reserveDegradedWarning("unknown-market", `Unmapped crvUSD Yield Basis collateral market: ${market.symbol}`),
      );
      unknownUsd += usd;
      continue;
    }

    const existing = buckets.get(bucket.name);
    if (existing) {
      existing.usd += usd;
      existing.risk = worseRisk(existing.risk, bucket.risk);
    } else {
      buckets.set(bucket.name, { usd, risk: bucket.risk });
    }
  }

  const total = Array.from(buckets.values()).reduce((acc, bucket) => acc + bucket.usd, 0);
  const totalWithUnknown = total + unknownUsd;
  if (totalWithUnknown <= 0) return { slices: [], warnings };

  if (unknownUsd > 0) {
    buckets.set("Other / unmapped collateral markets", {
      usd: unknownUsd,
      risk: "high",
    });
  }

  const slices = normalizeSlices(
    Array.from(buckets.entries()).map(([name, bucket]) => ({
      name,
      pct: (bucket.usd / totalWithUnknown) * 100,
      risk: bucket.risk,
    })),
    1,
  );

  return {
    slices,
    warnings,
    metadata: {
      marketCount: llammaMarkets.length + yieldBasisMarkets.length,
      directMarketCount: llammaMarkets.length,
      yieldBasisMarketCount: yieldBasisMarkets.length,
      activeMarketCount: directActiveMarkets + yieldBasisActiveMarkets,
      directActiveMarketCount: directActiveMarkets,
      yieldBasisActiveMarketCount: yieldBasisActiveMarkets,
      bucketCount: buckets.size,
      directCollateralUsd,
      yieldBasisCollateralUsd,
      yieldBasisCollateralPct: totalWithUnknown > 0 ? (yieldBasisCollateralUsd / totalWithUnknown) * 100 : 0,
      unknownExposurePct: totalWithUnknown > 0 ? (unknownUsd / totalWithUnknown) * 100 : 0,
      softLiquidatedCrvUsdUsd,
      bandReadCount,
      ...notApplicableFreshnessMetadata({
        proofKind: "curve-llamma-direct-onchain",
        directSource: "Curve ControllerFactory + LLAMMA band balances",
        yieldBasisSource: "Yield Basis factory + LT preview emergency withdrawal",
      }),
    },
  };
}

export async function fetchCrvUsdReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (config.inputs.primary.kind === "onchain-evm") {
    requireOnchainInput(config.inputs.primary, "crvusd");
    const [llammaMarkets, yieldBasisMarkets] = await Promise.all([
      fetchLlammaMarketExposures(signal, ctx),
      fetchYieldBasisMarketExposures(signal, ctx),
    ]);
    return adaptCrvUsdOnchain(llammaMarkets, yieldBasisMarkets);
  }

  const input = requireJsonInput(config.inputs.primary, "crvusd");
  const [payload, yieldBasisMarkets] = await Promise.all([
    fetchJsonWithRetry<CurveMarketsPayload>(input.url, signal, 12_000, ctx),
    fetchYieldBasisMarketExposures(signal, ctx),
  ]);
  return adaptCrvUsd(payload, yieldBasisMarkets);
}
