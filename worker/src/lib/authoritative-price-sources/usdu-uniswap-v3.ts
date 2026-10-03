import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector } from "viem/utils";
import { CIRCUIT_SOURCE, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../constants";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmRpcBatch } from "../evm-rpc";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import { resolveTrustedOverrideParent, type CurrentPriceOverride, type LivePriceContext, type PriceSourceProvider } from "./helpers";

const USDU = "0xe4ca6596d2c28014c6f89964f57838e0be9f369b";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const POOL = "0x30bc4854086128ebb69ee6e67e2a51a87a0b41b0";
const FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const IMPLEMENTATION = "0x7df0b1f63e0a467b6aa95b4ed6d299dab9f73750";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// Ethereum block 0x18e5f38, observed 2026-10-02T22:44:14Z; canonical factory,
// exact token identities and executable $1k/$100k sell quotes independently verified.
const REVIEWED_RUNTIME = [
  [USDU, "0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e"],
  [USDT, "0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55"],
  [POOL, "0x430dbd2cb89620be019b1911854f6d71a497a0af0913708be46bde31796816e3"],
  [FACTORY, "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69"],
  [QUOTER, "0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b"],
  [IMPLEMENTATION, "0x89162509b689c9e4b5602db50f991928ce7cc922ca42d0ca1c315a3336a3719a"],
] as const;
const UNIT = 10n ** 6n;
const SAMPLE_UNITS = 1_000n;
const DEPTH_MULTIPLE = 100n;
const QUOTE_TYPES = parseAbiParameters("uint256,uint160,uint32,uint256");
const SLOT0_TYPES = parseAbiParameters("uint160,int24,uint16,uint16,uint16,uint8,bool");
const UINT_TYPES = parseAbiParameters("uint256");
const ADDRESS_TYPES = parseAbiParameters("address");
const BOOL_TYPES = parseAbiParameters("bool");
const quoteCalldata = (amountIn: bigint) => toFunctionSelector("quoteExactInputSingle((address,address,uint256,uint24,uint160))") +
  encodeAbiParameters(parseAbiParameters("(address,address,uint256,uint24,uint160)"), [[USDU, USDT, amountIn, 100, 0n]]).slice(2);
const addressCalldata = (signature: string, address: string) => toFunctionSelector(signature) + address.slice(2).padStart(64, "0");

export async function fetchUsduUniswapV3Price(context: LivePriceContext, signal?: AbortSignal): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => { context.lastRejectionReason = `uniswap-v3-exact:${reason}`; return null; };
  const parent = resolveTrustedOverrideParent(context, "usdt-tether", () => "USDU: trusted USDT unavailable",
    { allowFreshReplaySafeSingleSourceParent: true });
  if (!parent) return reject("parent-unavailable");
  const age = Math.floor(Date.now() / 1000) - parent.trustedParent.observedAt;
  if (age < 0 || age >= 300) return reject("parent-age");
  const options = { signal, chainRpcs: context.chainRpcs, extraRpcUrls: getPublicFallbackRpcUrls("ethereum"), maxRetries: 0 };
  const block = await fetchEvmBlockNumber("ethereum", options);
  if (block == null) return reject("block-unavailable");
  const head = await fetchEvmBlockHeader("ethereum", block, options);
  const now = Math.floor(Date.now() / 1000);
  if (!head || head.timestamp > now || now - head.timestamp >= 300) return reject("block-age");
  const tag = `0x${block.toString(16)}`;
  // Serial, body-consumed RPC batches occupy one connection per authoritative lane.
  const codes = await fetchEvmRpcBatch("ethereum", REVIEWED_RUNTIME.map(([address]) => ({ method: "eth_getCode", params: [address, tag] })), options);
  throwIfAborted(signal);
  if (!codes || codes.length !== REVIEWED_RUNTIME.length || codes.some((code, i) =>
    typeof code !== "string" || code.length % 2 !== 0 || !/^0x[0-9a-fA-F]+$/.test(code) ||
    keccak256(code as `0x${string}`) !== REVIEWED_RUNTIME[i][1])) return reject("runtime-code");
  // Direct eth_call preserves QuoterV2 callback/sender semantics. V3 pool balances
  // are real token inventory (including fees), never virtual sqrtPrice/L reserves.
  const calls = [
    [POOL, toFunctionSelector("token0()")], [POOL, toFunctionSelector("token1()")],
    [POOL, toFunctionSelector("factory()")], [POOL, toFunctionSelector("fee()")],
    [FACTORY, toFunctionSelector("getPool(address,address,uint24)") + encodeAbiParameters(parseAbiParameters("address,address,uint24"), [USDU, USDT, 100]).slice(2)],
    [QUOTER, toFunctionSelector("factory()")], [POOL, toFunctionSelector("slot0()")], [POOL, toFunctionSelector("liquidity()")],
    [USDU, toFunctionSelector("decimals()")], [USDT, toFunctionSelector("decimals()")],
    [USDU, toFunctionSelector("paused()")], [USDT, toFunctionSelector("paused()")],
    [USDU, addressCalldata("isBlacklisted(address)", POOL)], [USDT, addressCalldata("isBlackListed(address)", POOL)],
    [USDT, addressCalldata("isBlackListed(address)", QUOTER)], [USDU, toFunctionSelector("getBlacklister()")],
    [USDU, addressCalldata("balanceOf(address)", POOL)], [USDT, addressCalldata("balanceOf(address)", POOL)],
    [QUOTER, quoteCalldata(SAMPLE_UNITS * UNIT)], [QUOTER, quoteCalldata(SAMPLE_UNITS * DEPTH_MULTIPLE * UNIT)],
  ].map(([to, data]) => ({ method: "eth_call", params: [{ to, data }, tag] }));
  calls.push({ method: "eth_getStorageAt", params: [USDU, IMPLEMENTATION_SLOT, tag] });
  const rows = await fetchEvmRpcBatch("ethereum", calls, options);
  throwIfAborted(signal);
  if (!rows || rows.length !== calls.length || rows.some((r) => typeof r !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(r) || (r.length - 2) % 64 !== 0 || r.length === 2)) return reject("state-unavailable");
  const closing = await fetchEvmBlockHeader("ethereum", block, options);
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) return reject("canonical-check");
  try {
    const data = rows as `0x${string}`[];
    const uint = (i: number) => decodeAbiParameters(UINT_TYPES, data[i])[0];
    const address = (i: number) => decodeAbiParameters(ADDRESS_TYPES, data[i])[0].toLowerCase();
    const bool = (i: number) => decodeAbiParameters(BOOL_TYPES, data[i])[0];
    if (address(0) !== USDT || address(1) !== USDU || address(2) !== FACTORY || uint(3) !== 100n ||
      address(4) !== POOL || address(5) !== FACTORY || uint(8) !== 6n || uint(9) !== 6n ||
      address(20) !== IMPLEMENTATION) return reject("identity");
    const [sqrtPrice, , , , , , unlocked] = decodeAbiParameters(SLOT0_TYPES, data[6]);
    if (sqrtPrice <= 0n || uint(7) <= 0n || !unlocked) return reject("pool-state");
    // Reviewed TokenV1 transfer guards require a configured blacklister; a quote
    // does not simulate USDU payment or prove any individual holder's eligibility.
    if (bool(10) || bool(11) || bool(12) || bool(13) || bool(14) ||
      address(15) === "0x0000000000000000000000000000000000000000") return reject("execution-disabled");
    const inputBalance = uint(16), outputBalance = uint(17);
    if (inputBalance < 10_000n * UNIT || outputBalance < 10_000n * UNIT) return reject("inventory");
    const [small, smallSqrt] = decodeAbiParameters(QUOTE_TYPES, data[18]);
    const [depth, depthSqrt] = decodeAbiParameters(QUOTE_TYPES, data[19]);
    if (small <= 0n || depth <= 0n || small >= outputBalance || depth >= outputBalance ||
      smallSqrt <= sqrtPrice || depthSqrt < smallSqrt ||
      depth * 100n < small * DEPTH_MULTIPLE * 95n || depth * 100n > small * DEPTH_MULTIPLE * 105n) return reject("quote-depth");
    const price = Number(small) / Number(SAMPLE_UNITS * UNIT) * parent.trustedParent.price;
    if (!Number.isFinite(price) || price <= 0) return reject("price-invalid");
    const tvlUsd = Number(inputBalance) / 1e6 * price + Number(outputBalance) / 1e6 * parent.trustedParent.price;
    if (!Number.isFinite(tvlUsd) || tvlUsd < DEX_PRICE_OBSERVATION_MIN_TVL_USD) return reject("tvl-floor");
    const observedAt = Math.min(head.timestamp, parent.trustedParent.observedAt);
    if (Math.floor(Date.now() / 1000) - observedAt >= 300) return reject("dependency-age");
    return { price, source: "uniswap-v3-exact", confidence: "fallback", observedAt, observedAtMode: "upstream" };
  } catch { return reject("state-malformed"); }
}

export const usduUniswapV3Provider: PriceSourceProvider = {
  source: "uniswap-v3-exact", liveMissingOnly: true, liveCircuitSource: CIRCUIT_SOURCE.USDU_UNISWAP_V3,
  livePriority: 1, liveTimeoutMs: 6_000, matches: (id) => id === "usdu-universal",
  liveParentByAssetId: { "usdu-universal": "usdt-tether" },
  async fetchLivePrice(asset, context, signal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchUsduUniswapV3Price(context, signal);
  },
};
