import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, toFunctionSelector } from "viem/utils";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { CIRCUIT_SOURCE } from "../constants";
import { UNISWAP_V2_EXACT_POOL_GUARD } from "../dex-cron-constants";
import { fetchEvmBlockHeader, fetchEvmRpcBatch } from "../evm-rpc";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { validateCompositePricingSourceFreshness } from "../pricing-source-freshness";
import { fetchPinnedEthereumRuntime } from "./pinned-ethereum-runtime";
import { resolveTrustedOverrideParent, type CurrentPriceOverride, type LivePriceContext, type PriceSourceProvider } from "./helpers";

const SOURCE = "uniswap-v2-exact";
const A7A5_ID = "a7a5-old-vector";
const USDT_TETHER_ID = "usdt-tether";
const A7A5 = "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const PAIR = "0x14d7aab5b4bca6a02e52ac22520b033bf35f4091";
const FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
// Ethereum block 26485668 (0x19423a4), observed 2026-11-24T14:38:59Z; canonical
// Uniswap V2 factory/pair and immutable non-proxy A7A5/USDT contracts verified.
const REVIEWED_RUNTIME = [
  [A7A5, "0x762de09de4267df1038313af242dd978f2835d193d90a51de836e808eae57dc9"],
  [USDT, "0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55"],
  [PAIR, "0x5b83bdbcc56b2e630f2807bbadd2b0c21619108066b92a58de081261089e9ce5"],
  [FACTORY, "0xbab145d02e7005f0d84c6c1639d39b799b0ea16df99ebbdaf5a14d9da820b4e0"],
] as const;
const UNIT = 10n ** 6n;
// 1,000 A7A5 (~$11.7) small quote vs 80,000 A7A5 (~$940) depth quote keeps the
// sibling exact-pool ~$1k / 500-bps impact check consistent down to the $50k TVL floor.
const SMALL_QUOTE_UNITS = 1_000n;
const DEPTH_MULTIPLE = 80n;
const RESERVES_TYPES = parseAbiParameters("uint112,uint112,uint32");
const UINT_TYPES = parseAbiParameters("uint256");
const ADDRESS_TYPES = parseAbiParameters("address");
const BOOL_TYPES = parseAbiParameters("bool");
const addressCalldata = (signature: string, address: string) =>
  toFunctionSelector(signature) + address.slice(2).padStart(64, "0");
const GET_PAIR_CALLDATA =
  toFunctionSelector("getPair(address,address)") +
  encodeAbiParameters(parseAbiParameters("address,address"), [A7A5, USDT]).slice(2);

/** Canonical Uniswap V2 constant-product exact-input quote (0.30% LP fee). */
export function quoteUniswapV2ExactIn(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * UNISWAP_V2_EXACT_POOL_GUARD.feeNumerator;
  const denominator = reserveIn * UNISWAP_V2_EXACT_POOL_GUARD.feeDenominator + amountInWithFee;
  return (amountInWithFee * reserveOut) / denominator;
}

export async function fetchA7a5UniswapV2Price(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => {
    context.lastRejectionReason = `${SOURCE}:${reason}`;
    return null;
  };
  const parent = resolveTrustedOverrideParent(
    context,
    USDT_TETHER_ID,
    () => "A7A5: trusted USDT unavailable",
    { allowFreshReplaySafeSingleSourceParent: true },
  );
  if (!parent) return reject("parent-unavailable");
  const maxObservationAgeSec = getPricingSourceRegistryEntry(SOURCE)?.maxTrustedAgeSec ?? null;
  if (maxObservationAgeSec == null) return reject("dependency-age");
  const parentAge = Math.floor(Date.now() / 1000) - parent.trustedParent.observedAt;
  if (parentAge < 0 || parentAge >= maxObservationAgeSec) return reject("parent-age");

  const pinned = await fetchPinnedEthereumRuntime(context, REVIEWED_RUNTIME, reject, signal);
  if (!pinned) return null;
  const { options, block, head, tag } = pinned;

  const calls = [
    [PAIR, toFunctionSelector("token0()")],
    [PAIR, toFunctionSelector("token1()")],
    [PAIR, toFunctionSelector("factory()")],
    [FACTORY, GET_PAIR_CALLDATA],
    [PAIR, toFunctionSelector("getReserves()")],
    [A7A5, toFunctionSelector("decimals()")],
    [USDT, toFunctionSelector("decimals()")],
    [A7A5, toFunctionSelector("paused()")],
    [USDT, toFunctionSelector("paused()")],
    [A7A5, addressCalldata("isBlackListed(address)", PAIR)],
    [USDT, addressCalldata("isBlackListed(address)", PAIR)],
    [USDT, toFunctionSelector("deprecated()")],
    [A7A5, toFunctionSelector("basisPointsRate()")],
    [USDT, toFunctionSelector("basisPointsRate()")],
    [A7A5, addressCalldata("balanceOf(address)", PAIR)],
    [USDT, addressCalldata("balanceOf(address)", PAIR)],
  ].map(([to, data]) => ({ method: "eth_call", params: [{ to, data }, tag] }));

  const rows = await fetchEvmRpcBatch("ethereum", calls, options);
  throwIfAborted(signal);
  if (
    !rows ||
    rows.length !== calls.length ||
    rows.some((r) => typeof r !== "string" || !/^0x[0-9a-fA-F]+$/.test(r) || (r.length - 2) % 64 !== 0 || r.length === 2)
  ) {
    return reject("state-unavailable");
  }
  const closing = await fetchEvmBlockHeader("ethereum", block, options);
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) return reject("canonical-check");

  try {
    const data = rows as `0x${string}`[];
    const uint = (i: number) => decodeAbiParameters(UINT_TYPES, data[i])[0];
    const address = (i: number) => decodeAbiParameters(ADDRESS_TYPES, data[i])[0].toLowerCase();
    const bool = (i: number) => decodeAbiParameters(BOOL_TYPES, data[i])[0];
    if (
      address(0) !== A7A5 ||
      address(1) !== USDT ||
      address(2) !== FACTORY ||
      address(3) !== PAIR ||
      uint(5) !== 6n ||
      uint(6) !== 6n
    ) {
      return reject("identity");
    }
    if (
      bool(7) ||
      bool(8) ||
      bool(9) ||
      bool(10) ||
      bool(11) ||
      uint(12) !== 0n ||
      uint(13) !== 0n
    ) {
      return reject("execution-disabled");
    }
    const [reserve0, reserve1, blockTimestampLast] = decodeAbiParameters(RESERVES_TYPES, data[4]);
    if (reserve0 <= 0n || reserve1 <= 0n) return reject("pool-state");
    if (
      blockTimestampLast <= 0 ||
      blockTimestampLast > head.timestamp ||
      head.timestamp - blockTimestampLast > UNISWAP_V2_EXACT_POOL_GUARD.maxLastTradeAgeSec
    ) {
      return reject("pool-stale");
    }
    const inputBalance = uint(14);
    const outputBalance = uint(15);
    const maxDriftBps = BigInt(UNISWAP_V2_EXACT_POOL_GUARD.maxReserveBalanceDriftBps);
    if (
      inputBalance < reserve0 ||
      outputBalance < reserve1 ||
      (inputBalance - reserve0) * 10_000n > reserve0 * maxDriftBps ||
      (outputBalance - reserve1) * 10_000n > reserve1 * maxDriftBps
    ) {
      return reject("inventory-drift");
    }
    const smallOut = quoteUniswapV2ExactIn(SMALL_QUOTE_UNITS * UNIT, reserve0, reserve1);
    const depthOut = quoteUniswapV2ExactIn(SMALL_QUOTE_UNITS * DEPTH_MULTIPLE * UNIT, reserve0, reserve1);
    const minRetainedBps = BigInt(10_000 - UNISWAP_V2_EXACT_POOL_GUARD.maxQuoteImpactBps);
    if (
      smallOut <= 0n ||
      depthOut <= 0n ||
      smallOut >= reserve1 ||
      depthOut >= reserve1 ||
      depthOut * 10_000n < smallOut * DEPTH_MULTIPLE * minRetainedBps ||
      depthOut > smallOut * DEPTH_MULTIPLE
    ) {
      return reject("quote-depth");
    }
    const price = (Number(smallOut) / Number(SMALL_QUOTE_UNITS * UNIT)) * parent.trustedParent.price;
    if (!Number.isFinite(price) || price <= 0) return reject("price-invalid");
    const inputSideUsd = (Number(reserve0) / 1e6) * price;
    const outputSideUsd = (Number(reserve1) / 1e6) * parent.trustedParent.price;
    const tvlUsd = inputSideUsd + outputSideUsd;
    if (
      !Number.isFinite(inputSideUsd) ||
      !Number.isFinite(outputSideUsd) ||
      !Number.isFinite(tvlUsd) ||
      inputSideUsd < UNISWAP_V2_EXACT_POOL_GUARD.minSideLiquidityUsd ||
      outputSideUsd < UNISWAP_V2_EXACT_POOL_GUARD.minSideLiquidityUsd
    ) {
      return reject("inventory");
    }
    if (tvlUsd < UNISWAP_V2_EXACT_POOL_GUARD.minTvlUsd) return reject("tvl-floor");

    const nowSec = Math.floor(Date.now() / 1000);
    const parentClockSelected = parent.trustedParent.observedAt < head.timestamp;
    const observedAt = parentClockSelected ? parent.trustedParent.observedAt : head.timestamp;
    if (
      !validateCompositePricingSourceFreshness({ ...parent.trustedParent, nowSec, requireObservedAt: true }).accepted ||
      head.timestamp > nowSec ||
      parent.trustedParent.observedAt > nowSec ||
      nowSec - observedAt >= maxObservationAgeSec
    ) {
      return reject("dependency-age");
    }
    const observedAtMode = parentClockSelected ? (parent.trustedParent.observedAtMode ?? "upstream") : "upstream";
    return { price, source: SOURCE, confidence: "fallback", observedAt, observedAtMode };
  } catch {
    return reject("state-malformed");
  }
}

export const a7a5UniswapV2Provider: PriceSourceProvider = {
  source: SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.A7A5_UNISWAP_V2,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  matches: (id) => id === A7A5_ID,
  liveParentByAssetId: { [A7A5_ID]: USDT_TETHER_ID },
  async fetchLivePrice(asset, context, signal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchA7a5UniswapV2Price(context, signal);
  },
};
