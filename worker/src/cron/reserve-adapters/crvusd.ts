import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { toErrorMessage } from "../../lib/error-utils";
import type { LiveReserveSnapshotMetadata, LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { CANONICAL_ETH_RESERVE_RISK, getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import type { Abi } from "abitype";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import { throwIfAborted } from "../../lib/abort";
import { mapWithConcurrency } from "../../lib/concurrency";
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
import type { OnchainMulticall3Call } from "./helpers";
import { validateDecimals, worseRisk } from "./slice-math";

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

interface YieldBasisMarketWithdrawCandidate {
  marketId: number;
  symbol: string;
  assetAddress: string;
  assetDecimals: number;
  ltAddress: string;
  supply: bigint;
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

type CrvUsdCollateralSource = "direct" | "yieldBasis";

interface CrvUsdCollateralBucketInput {
  source: CrvUsdCollateralSource;
  symbol?: string;
  usd: number;
  unknownWarning: (symbol: string) => string;
}

interface CrvUsdCollateralBucketSummary {
  slices: ReserveSlice[];
  warnings: LiveReserveWarning[];
  bucketCount: number;
  directActiveMarkets: number;
  yieldBasisActiveMarkets: number;
  directCollateralUsd: number;
  yieldBasisCollateralUsd: number;
  yieldBasisCollateralPct: number;
  unknownExposurePct: number;
}

interface CrvUsdMarketCounts {
  directMarketCount: number;
  yieldBasisMarketCount: number;
}

const ETHEREUM_CHAIN = "ethereum";
const ETHEREUM_RPC_URLS = [getPublicRpcUrl(ETHEREUM_CHAIN), getSecondaryFallbackRpcUrl(ETHEREUM_CHAIN)].filter(
  (url): url is string => typeof url === "string" && url.length > 0,
);
const CURVE_CONTROLLER_FACTORY = "0xC9332fdCB1C491Dcc683bAe86Fe3cb70360738BC";
const DIRECT_LLAMMA_MULTICALL_BATCH_SIZE = 500;
const CRVUSD_MARKET_READ_CONCURRENCY = 2;
const CRVUSD_MAX_LLAMMA_MARKETS = 256;
const CRVUSD_MAX_LLAMMA_BANDS_PER_MARKET = 2_048;
const CRVUSD_MAX_YIELD_BASIS_MARKETS = 256;
const YIELD_BASIS_FACTORY = "0x370a449febb9411c95bf897021377fe0b7d100c0";
const YIELD_BASIS_VIEW_GAS = "0x5B8D80";
const YIELD_BASIS_OPTIONAL_TIMEOUT_MS = 6_000;
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

function summarizeCrvUsdCollateralBuckets(
  entries: readonly CrvUsdCollateralBucketInput[],
): CrvUsdCollateralBucketSummary | null {
  const buckets = new Map<string, { usd: number; risk: ReserveSlice["risk"] }>();
  const warnings: LiveReserveWarning[] = [];
  let unknownUsd = 0;
  let directActiveMarkets = 0;
  let yieldBasisActiveMarkets = 0;
  let directCollateralUsd = 0;
  let yieldBasisCollateralUsd = 0;

  for (const entry of entries) {
    const { symbol, usd } = entry;
    if (!symbol || !Number.isFinite(usd) || usd <= 0) continue;

    if (entry.source === "direct") {
      directActiveMarkets++;
      directCollateralUsd += usd;
    } else {
      yieldBasisActiveMarkets++;
      yieldBasisCollateralUsd += usd;
    }

    const bucket = classifySymbol(symbol);
    if (!bucket) {
      warnings.push(reserveDegradedWarning("unknown-market", entry.unknownWarning(symbol)));
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
  if (totalWithUnknown <= 0) return null;

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
    bucketCount: buckets.size,
    directActiveMarkets,
    yieldBasisActiveMarkets,
    directCollateralUsd,
    yieldBasisCollateralUsd,
    yieldBasisCollateralPct: (yieldBasisCollateralUsd / totalWithUnknown) * 100,
    unknownExposurePct: (unknownUsd / totalWithUnknown) * 100,
  };
}

function buildCrvUsdResult(
  summary: CrvUsdCollateralBucketSummary,
  counts: CrvUsdMarketCounts,
  extraWarnings: readonly LiveReserveWarning[],
  metadata: LiveReserveSnapshotMetadata,
): AdapterResult {
  return {
    slices: summary.slices,
    warnings: [...summary.warnings, ...extraWarnings],
    metadata: {
      marketCount: counts.directMarketCount + counts.yieldBasisMarketCount,
      directMarketCount: counts.directMarketCount,
      yieldBasisMarketCount: counts.yieldBasisMarketCount,
      activeMarketCount: summary.directActiveMarkets + summary.yieldBasisActiveMarkets,
      directActiveMarketCount: summary.directActiveMarkets,
      yieldBasisActiveMarketCount: summary.yieldBasisActiveMarkets,
      bucketCount: summary.bucketCount,
      directCollateralUsd: summary.directCollateralUsd,
      yieldBasisCollateralUsd: summary.yieldBasisCollateralUsd,
      yieldBasisCollateralPct: summary.yieldBasisCollateralPct,
      unknownExposurePct: summary.unknownExposurePct,
      ...metadata,
    },
  };
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
    }),
  );
  if (!raw) {
    throw new Error(`crvUSD Yield Basis read failed for ${functionName} on ${address}`);
  }
  return decodeFunctionResult({
    abi,
    functionName,
    data: raw,
  });
}

async function fetchCrvUsdMulticallResults(
  calls: readonly OnchainMulticall3Call[],
  label: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Map<string, `0x${string}`>> {
  if (calls.length === 0) return new Map();

  const results = await fetchOnchainMulticall3({
    calls,
    chain: ETHEREUM_CHAIN,
    signal,
    ctx,
    rpcUrl: ETHEREUM_RPC_URLS[0],
    fallbackRpcUrl: ETHEREUM_RPC_URLS[1],
    timeoutMs: 12_000,
  });
  if (!results) {
    throw new Error(`crvUSD ${label} multicall failed`);
  }

  const byLabel = new Map<string, `0x${string}`>();
  for (const result of results) {
    if (!result.success) {
      throw new Error(`crvUSD ${label} multicall entry failed: ${result.label}`);
    }
    byLabel.set(result.label, result.returnData);
  }
  return byLabel;
}

function requireCrvUsdMulticallResult(
  results: ReadonlyMap<string, `0x${string}`>,
  label: string,
  groupLabel: string,
): `0x${string}` {
  const data = results.get(label);
  if (!data) {
    throw new Error(`crvUSD ${groupLabel} multicall missing result: ${label}`);
  }
  return data;
}

function safeInt256ToNumber(value: bigint, label: string): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`crvUSD ${label} out of safe integer range: ${value.toString()}`);
  }
  return asNumber;
}

function validateOnchainMarketCount(raw: bigint, label: string, maxCount: number): number {
  const marketCount = Number(raw);
  if (!Number.isSafeInteger(marketCount) || marketCount < 0 || marketCount > maxCount) {
    throw new Error(`crvUSD ${label} invalid: ${String(raw)} (max ${maxCount})`);
  }
  return marketCount;
}

function validateLlammaBandCount(minBand: number, maxBand: number, marketId: number): number {
  const bandCount = maxBand - minBand + 1;
  if (!Number.isSafeInteger(bandCount) || bandCount < 1) {
    throw new Error(`crvUSD LLAMMA band range invalid for market ${marketId}: ${minBand}..${maxBand}`);
  }
  if (bandCount > CRVUSD_MAX_LLAMMA_BANDS_PER_MARKET) {
    throw new Error(
      `crvUSD LLAMMA band span exceeds operational cap for market ${marketId}: ` +
        `${bandCount} > ${CRVUSD_MAX_LLAMMA_BANDS_PER_MARKET}`,
    );
  }
  return bandCount;
}

async function fetchLlammaMarketDescriptors(
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<LlammaMarketDescriptor[]> {
  const countRaw = (await readEthereumContract(
    CURVE_CONTROLLER_FACTORY,
    CURVE_CONTROLLER_FACTORY_ABI,
    "n_collaterals",
    signal,
    ctx,
  )) as bigint;
  const marketCount = validateOnchainMarketCount(
    countRaw,
    "ControllerFactory n_collaterals",
    CRVUSD_MAX_LLAMMA_MARKETS,
  );
  if (marketCount === 0) return [];

  const marketIds = Array.from({ length: marketCount }, (_, marketId) => marketId);
  const factoryResults = await fetchCrvUsdMulticallResults(
    marketIds.flatMap((marketId): OnchainMulticall3Call[] => [
      {
        label: `${marketId}:collateral`,
        contract: CURVE_CONTROLLER_FACTORY,
        data: encodeFunctionData({
          abi: CURVE_CONTROLLER_FACTORY_ABI,
          functionName: "collaterals",
          args: [BigInt(marketId)],
        }),
      },
      {
        label: `${marketId}:controller`,
        contract: CURVE_CONTROLLER_FACTORY,
        data: encodeFunctionData({
          abi: CURVE_CONTROLLER_FACTORY_ABI,
          functionName: "controllers",
          args: [BigInt(marketId)],
        }),
      },
      {
        label: `${marketId}:amm`,
        contract: CURVE_CONTROLLER_FACTORY,
        data: encodeFunctionData({
          abi: CURVE_CONTROLLER_FACTORY_ABI,
          functionName: "amms",
          args: [BigInt(marketId)],
        }),
      },
    ]),
    "LLAMMA factory",
    signal,
    ctx,
  );

  const factoryDescriptors = marketIds.map((marketId) => ({
    marketId,
    collateralAddress: decodeFunctionResult({
      abi: CURVE_CONTROLLER_FACTORY_ABI,
      functionName: "collaterals",
      data: requireCrvUsdMulticallResult(factoryResults, `${marketId}:collateral`, "LLAMMA factory"),
    }) as string,
    controllerAddress: decodeFunctionResult({
      abi: CURVE_CONTROLLER_FACTORY_ABI,
      functionName: "controllers",
      data: requireCrvUsdMulticallResult(factoryResults, `${marketId}:controller`, "LLAMMA factory"),
    }) as string,
    ammAddress: decodeFunctionResult({
      abi: CURVE_CONTROLLER_FACTORY_ABI,
      functionName: "amms",
      data: requireCrvUsdMulticallResult(factoryResults, `${marketId}:amm`, "LLAMMA factory"),
    }) as string,
  }));

  const metadataResults = await fetchCrvUsdMulticallResults(
    factoryDescriptors.flatMap((market): OnchainMulticall3Call[] => [
      {
        label: `${market.marketId}:symbol`,
        contract: market.collateralAddress,
        data: encodeFunctionData({ abi: ERC20_METADATA_ABI, functionName: "symbol" }),
      },
      {
        label: `${market.marketId}:min_band`,
        contract: market.ammAddress,
        data: encodeFunctionData({ abi: CURVE_AMM_ABI, functionName: "min_band" }),
      },
      {
        label: `${market.marketId}:max_band`,
        contract: market.ammAddress,
        data: encodeFunctionData({ abi: CURVE_AMM_ABI, functionName: "max_band" }),
      },
    ]),
    "LLAMMA metadata",
    signal,
    ctx,
  );

  const descriptors = factoryDescriptors.map((market): LlammaMarketDescriptor | null => {
    throwIfAborted(signal);
    const symbolRaw = decodeFunctionResult({
      abi: ERC20_METADATA_ABI,
      functionName: "symbol",
      data: requireCrvUsdMulticallResult(metadataResults, `${market.marketId}:symbol`, "LLAMMA metadata"),
    });
    if (typeof symbolRaw !== "string") {
      throw new Error(`crvUSD LLAMMA symbol unreadable for market ${market.marketId}`);
    }
    const minBand = safeInt256ToNumber(
      decodeFunctionResult({
        abi: CURVE_AMM_ABI,
        functionName: "min_band",
        data: requireCrvUsdMulticallResult(metadataResults, `${market.marketId}:min_band`, "LLAMMA metadata"),
      }) as bigint,
      `market ${market.marketId} min_band`,
    );
    const maxBand = safeInt256ToNumber(
      decodeFunctionResult({
        abi: CURVE_AMM_ABI,
        functionName: "max_band",
        data: requireCrvUsdMulticallResult(metadataResults, `${market.marketId}:max_band`, "LLAMMA metadata"),
      }) as bigint,
      `market ${market.marketId} max_band`,
    );
    if (maxBand < minBand) return null;
    validateLlammaBandCount(minBand, maxBand, market.marketId);
    return {
      ...market,
      symbol: symbolRaw,
      minBand,
      maxBand,
    };
  });

  return descriptors.filter((descriptor): descriptor is LlammaMarketDescriptor => descriptor != null);
}

async function fetchLlammaMarketExposures(signal: AbortSignal, ctx?: AdapterContext): Promise<LlammaMarketExposure[]> {
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

  return mapWithConcurrency(descriptors, CRVUSD_MARKET_READ_CONCURRENCY, async (market) => {
    const calls: OnchainMulticall3Call[] = [];
    for (let band = market.minBand; band <= market.maxBand; band += 1) {
      throwIfAborted(signal);
      calls.push({
        label: `${market.marketId}:y:${band}`,
        contract: market.ammAddress,
        data: encodeFunctionData({ abi: CURVE_AMM_ABI, functionName: "bands_y", args: [BigInt(band)] }),
      });
      calls.push({
        label: `${market.marketId}:x:${band}`,
        contract: market.ammAddress,
        data: encodeFunctionData({ abi: CURVE_AMM_ABI, functionName: "bands_x", args: [BigInt(band)] }),
      });
    }

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
      throw new Error(`crvUSD LLAMMA band multicall failed for market ${market.marketId}`);
    }

    const totals = { y: 0n, x: 0n };
    for (const result of results) {
      if (!result.success) {
        throw new Error(`crvUSD LLAMMA band call failed: ${result.label}`);
      }
      const [, axis] = result.label.split(":");
      if (axis === "y") {
        totals.y += decodeFunctionResult({
          abi: CURVE_AMM_ABI,
          functionName: "bands_y",
          data: result.returnData,
        }) as bigint;
      } else if (axis === "x") {
        totals.x += decodeFunctionResult({
          abi: CURVE_AMM_ABI,
          functionName: "bands_x",
          data: result.returnData,
        }) as bigint;
      } else {
        throw new Error(`crvUSD LLAMMA band call returned invalid axis: ${result.label}`);
      }
    }

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
  const marketCount = validateOnchainMarketCount(
    marketCountRaw,
    "Yield Basis market_count",
    CRVUSD_MAX_YIELD_BASIS_MARKETS,
  );
  if (marketCount === 0) return [];

  const marketIds = Array.from({ length: marketCount }, (_, marketId) => marketId);
  const marketResults = await fetchCrvUsdMulticallResults(
    marketIds.map((marketId) => ({
      label: `${marketId}:market`,
      contract: YIELD_BASIS_FACTORY,
      data: encodeFunctionData({ abi: YIELD_BASIS_FACTORY_ABI, functionName: "markets", args: [BigInt(marketId)] }),
    })),
    "Yield Basis markets",
    signal,
    ctx,
  );

  const marketContracts = marketIds.map((marketId) => {
    const market = decodeFunctionResult({
      abi: YIELD_BASIS_FACTORY_ABI,
      functionName: "markets",
      data: requireCrvUsdMulticallResult(marketResults, `${marketId}:market`, "Yield Basis markets"),
    }) as readonly [string, string, string, string, string, string, string];
    return {
      marketId,
      assetAddress: market[0],
      ltAddress: market[3],
    };
  });

  const metadataResults = await fetchCrvUsdMulticallResults(
    marketContracts.flatMap((market): OnchainMulticall3Call[] => [
      {
        label: `${market.marketId}:symbol`,
        contract: market.assetAddress,
        data: encodeFunctionData({ abi: ERC20_METADATA_ABI, functionName: "symbol" }),
      },
      {
        label: `${market.marketId}:decimals`,
        contract: market.assetAddress,
        data: encodeFunctionData({ abi: ERC20_METADATA_ABI, functionName: "decimals" }),
      },
      {
        label: `${market.marketId}:totalSupply`,
        contract: market.ltAddress,
        data: encodeFunctionData({ abi: YIELD_BASIS_LT_ABI, functionName: "totalSupply" }),
      },
    ]),
    "Yield Basis metadata",
    signal,
    ctx,
  );

  const withdrawCandidates = marketContracts
    .map((market): YieldBasisMarketWithdrawCandidate | null => {
      throwIfAborted(signal);
      const symbolRaw = decodeFunctionResult({
        abi: ERC20_METADATA_ABI,
        functionName: "symbol",
        data: requireCrvUsdMulticallResult(metadataResults, `${market.marketId}:symbol`, "Yield Basis metadata"),
      });
      if (typeof symbolRaw !== "string") {
        throw new Error(`crvUSD Yield Basis symbol unreadable for market ${market.marketId}`);
      }

      const assetDecimals = validateDecimals(
        decodeFunctionResult({
          abi: ERC20_METADATA_ABI,
          functionName: "decimals",
          data: requireCrvUsdMulticallResult(metadataResults, `${market.marketId}:decimals`, "Yield Basis metadata"),
        }),
        `crvUSD Yield Basis decimals for market ${market.marketId}`,
      );

      const supply = decodeFunctionResult({
        abi: YIELD_BASIS_LT_ABI,
        functionName: "totalSupply",
        data: requireCrvUsdMulticallResult(metadataResults, `${market.marketId}:totalSupply`, "Yield Basis metadata"),
      }) as bigint;
      if (supply <= 0n) return null;

      return {
        marketId: market.marketId,
        symbol: symbolRaw,
        assetAddress: market.assetAddress,
        assetDecimals,
        ltAddress: market.ltAddress,
        supply,
      };
    })
    .filter((market): market is YieldBasisMarketWithdrawCandidate => market != null);

  const positions = await mapWithConcurrency(
    withdrawCandidates,
    CRVUSD_MARKET_READ_CONCURRENCY,
    async (market): Promise<YieldBasisMarketPosition | null> => {
      throwIfAborted(signal);
      // Newer YB markets can revert on preview_withdraw(totalSupply); preview_emergency_withdraw
      // still exposes the full-market external asset balance without relying on that swap path.
      const emergencyWithdraw = (await readEthereumContract(
        market.ltAddress,
        YIELD_BASIS_LT_ABI,
        "preview_emergency_withdraw",
        signal,
        ctx,
        [market.supply],
        YIELD_BASIS_VIEW_GAS,
      )) as readonly [bigint, bigint];
      const assetAmount = emergencyWithdraw[0];
      if (assetAmount <= 0n) return null;

      return {
        marketId: market.marketId,
        symbol: market.symbol,
        assetAddress: market.assetAddress,
        assetDecimals: market.assetDecimals,
        assetAmount,
      };
    },
  );

  return positions.filter((position): position is YieldBasisMarketPosition => position != null);
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

async function fetchOptionalYieldBasisMarketExposures(
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<{ markets: YieldBasisMarketExposure[]; warnings: LiveReserveWarning[] }> {
  const timeout = createTimeoutSignal({
    timeoutMs: YIELD_BASIS_OPTIONAL_TIMEOUT_MS,
    timeoutReason: new Error("crvUSD Yield Basis optional leg timed out"),
    parentSignal: signal,
  });

  try {
    const markets = await fetchYieldBasisMarketExposures(timeout.signal, ctx);
    return { markets, warnings: [] };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    const message = toErrorMessage(error);
    return {
      markets: [],
      warnings: [
        reserveDegradedWarning(
          "yield-basis-read-failed",
          `crvUSD Yield Basis collateral leg unavailable; using direct Curve collateral only. ${message}`,
        ),
      ],
    };
  } finally {
    timeout.dispose();
  }
}

export function adaptCrvUsd(
  payload: CurveMarketsPayload,
  yieldBasisMarkets: YieldBasisMarketExposure[] = [],
  extraWarnings: LiveReserveWarning[] = [],
): AdapterResult {
  const markets = payload.chains?.ethereum?.data ?? [];
  const summary = summarizeCrvUsdCollateralBuckets([
    ...markets.map((market) => ({
      source: "direct" as const,
      symbol: market.collateral_token?.symbol,
      usd: market.collateral_amount_usd ?? 0,
      unknownWarning: (symbol: string) => `Unmapped crvUSD collateral market: ${symbol}`,
    })),
    ...yieldBasisMarkets.map((market) => ({
      source: "yieldBasis" as const,
      symbol: market.symbol,
      usd: market.usd,
      unknownWarning: (symbol: string) => `Unmapped crvUSD Yield Basis collateral market: ${symbol}`,
    })),
  ]);
  if (!summary) return { slices: [], warnings: [] };

  return buildCrvUsdResult(
    summary,
    {
      directMarketCount: markets.length,
      yieldBasisMarketCount: yieldBasisMarkets.length,
    },
    extraWarnings,
    unverifiedFreshnessMetadata(
      "curve-market-api + yield-basis-onchain",
      "Curve market payload does not expose a trustworthy source timestamp even though the Yield Basis leg is current-state on-chain",
    ),
  );
}

export function adaptCrvUsdOnchain(
  llammaMarkets: readonly LlammaMarketExposure[],
  yieldBasisMarkets: readonly YieldBasisMarketExposure[] = [],
  extraWarnings: LiveReserveWarning[] = [],
): AdapterResult {
  let softLiquidatedCrvUsdUsd = 0;
  let bandReadCount = 0;

  for (const market of llammaMarkets) {
    softLiquidatedCrvUsdUsd += market.softLiquidatedCrvUsdUsd;
    bandReadCount += market.bandCount;
  }
  const summary = summarizeCrvUsdCollateralBuckets([
    ...llammaMarkets.map((market) => ({
      source: "direct" as const,
      symbol: market.symbol,
      usd: market.collateralUsd,
      unknownWarning: (symbol: string) => `Unmapped crvUSD LLAMMA collateral market: ${symbol}`,
    })),
    ...yieldBasisMarkets.map((market) => ({
      source: "yieldBasis" as const,
      symbol: market.symbol,
      usd: market.usd,
      unknownWarning: (symbol: string) => `Unmapped crvUSD Yield Basis collateral market: ${symbol}`,
    })),
  ]);
  if (!summary) return { slices: [], warnings: [] };

  return buildCrvUsdResult(
    summary,
    {
      directMarketCount: llammaMarkets.length,
      yieldBasisMarketCount: yieldBasisMarkets.length,
    },
    extraWarnings,
    {
      softLiquidatedCrvUsdUsd,
      bandReadCount,
      ...notApplicableFreshnessMetadata({
        proofKind: "curve-llamma-direct-onchain",
        directSource: "Curve ControllerFactory + LLAMMA band balances",
        yieldBasisSource: "Yield Basis factory + LT preview emergency withdrawal",
      }),
    },
  );
}

export async function fetchCrvUsdReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (config.inputs.primary.kind === "onchain-evm") {
    requireOnchainInput(config.inputs.primary, "crvusd");
    const [llammaMarkets, yieldBasis] = await Promise.all([
      fetchLlammaMarketExposures(signal, ctx),
      fetchOptionalYieldBasisMarketExposures(signal, ctx),
    ]);
    return adaptCrvUsdOnchain(llammaMarkets, yieldBasis.markets, yieldBasis.warnings);
  }

  const input = requireJsonInput(config.inputs.primary, "crvusd");
  const [payload, yieldBasis] = await Promise.all([
    fetchJsonWithRetry<CurveMarketsPayload>(input.url, signal, 12_000, ctx),
    fetchOptionalYieldBasisMarketExposures(signal, ctx),
  ]);
  return adaptCrvUsd(payload, yieldBasis.markets, yieldBasis.warnings);
}
