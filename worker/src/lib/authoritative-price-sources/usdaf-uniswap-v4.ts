import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector } from "viem/utils";
import { CIRCUIT_SOURCE, DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../constants";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmRpcBatch } from "../evm-rpc";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import { resolveTrustedOverrideParent, type CurrentPriceOverride, type LivePriceContext, type PriceSourceProvider } from "./helpers";

const USDAF = "0x9cf12ccd6020b6888e4d4c4e4c7aca33c1eb91f8";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
const QUOTER = "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203";
const LENS = "0x0000001b173c3bbf3984d417d8614e3eed34865b";
const POOL_ID = "0xcd799508ddaa319e608547d3291a1a512da9a9acdd40599d89019ec82e3cf1e8";
const KEY = [USDAF, USDT, 500, 10, "0x0000000000000000000000000000000000000000"] as const;
// Canonical Uniswap deployments, reviewed against Ethereum on 2026-09-23.
const REVIEWED_RUNTIME = [
  [MANAGER, "0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293"],
  [QUOTER, "0x06de58fa119c5deaa7a667fb92d3894e25d9160e62fb82c8d86d43b47eefe441"],
  [LENS, "0x157a3174cbad65b8ff57b8fbf94253b58be07398593d7d677e4fd6051e16ca91"],
] as const;
const UNIT = 10n ** 18n;
const TVL_SELECTOR = toFunctionSelector("getPoolTVL(address,(address,address,uint24,int24,address))");
const QUOTE_SELECTOR = toFunctionSelector("quoteExactInput((address,(address,uint24,int24,address,bytes)[],uint128))");
const TVL_TYPES = parseAbiParameters("uint256,uint256,uint256,uint256,uint256,uint256,uint160,int24,uint128,uint256,address,uint16,bool,uint8");
const QUOTE_TYPES = parseAbiParameters("uint256,uint256");

function encodeQuoteCalldata(amountIn: bigint): string {
  return QUOTE_SELECTOR + encodeAbiParameters(parseAbiParameters("(address,(address,uint24,int24,address,bytes)[],uint128)"),
    [[USDAF, [[USDT, KEY[2], KEY[3], KEY[4], "0x"]], amountIn]]).slice(2);
}

export async function fetchUsdafUniswapV4Price(context: LivePriceContext, signal?: AbortSignal): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => { context.lastRejectionReason = `uniswap-v4-exact:${reason}`; return null; };
  const parent = resolveTrustedOverrideParent(context, "usdt-tether", () => "USDaf: trusted USDT unavailable",
    { allowFreshReplaySafeSingleSourceParent: true });
  if (!parent) return reject("parent-unavailable");
  const parentAge = Math.floor(Date.now() / 1000) - parent.trustedParent.observedAt;
  if (parentAge < 0 || parentAge >= 300) return reject("parent-age");
  if (keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), KEY)) !== POOL_ID) return reject("pool-identity");
  const options = { signal, chainRpcs: context.chainRpcs, extraRpcUrls: getPublicFallbackRpcUrls("ethereum"), maxRetries: 0 };
  const block = await fetchEvmBlockNumber("ethereum", options);
  if (block == null) return reject("block-unavailable");
  const head = await fetchEvmBlockHeader("ethereum", block, options);
  const now = Math.floor(Date.now() / 1000);
  if (!head || head.timestamp > now || now - head.timestamp >= 300) return reject("block-age");
  const tag = `0x${block.toString(16)}`;
  const codes = await fetchEvmRpcBatch("ethereum", REVIEWED_RUNTIME.map(([address]) => ({ method: "eth_getCode", params: [address, tag] })), options);
  throwIfAborted(signal);
  if (!codes || codes.length !== REVIEWED_RUNTIME.length || codes.some((code, i) =>
    typeof code !== "string" || code.length % 2 !== 0 || !/^0x[0-9a-fA-F]+$/.test(code) ||
    keccak256(code as `0x${string}`) !== REVIEWED_RUNTIME[i][1])) return reject("runtime-code");
  // Direct pinned calls preserve Quoter sender semantics. ReservesLens integrates
  // actual tick-range principal: active liquidity's virtual reserves are NOT TVL.
  const tvlCalldata = TVL_SELECTOR +
    encodeAbiParameters(parseAbiParameters("address,(address,address,uint24,int24,address)"), [MANAGER, KEY]).slice(2);
  const rows = await fetchEvmRpcBatch("ethereum", [
    [LENS, tvlCalldata], [QUOTER, encodeQuoteCalldata(UNIT)], [QUOTER, encodeQuoteCalldata(1_000n * UNIT)],
    [USDAF, "0x313ce567"], [USDT, "0x313ce567"],
    [USDT, toFunctionSelector("paused()")],
    [USDT, toFunctionSelector("isBlackListed(address)") + MANAGER.slice(2).padStart(64, "0")],
  ].map(([to, data]) => ({ method: "eth_call", params: [{ to, data }, tag] })), options);
  throwIfAborted(signal);
  if (!rows || rows.length !== 7 || rows.some((r) => typeof r !== "string" || !/^0x[0-9a-fA-F]+$/.test(r) || (r.length - 2) % 64 !== 0 || r.length === 2)) return reject("state-unavailable");
  const closing = await fetchEvmBlockHeader("ethereum", block, options);
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) return reject("canonical-check");
  try {
    const data = rows as `0x${string}`[];
    const [reserve0, reserve1, , , , , sqrtPrice, , liquidity, snapshotBlock, , , custom, hookStatus] = decodeAbiParameters(TVL_TYPES, data[0]);
    if (snapshotBlock !== BigInt(block) || sqrtPrice <= 0n || liquidity <= 0n || custom || hookStatus !== 0) return reject("pool-state");
    if (BigInt(data[3]) !== 18n || BigInt(data[4]) !== 6n) return reject("decimals");
    if (BigInt(data[5]) !== 0n || BigInt(data[6]) !== 0n) return reject("execution-disabled");
    const [small] = decodeAbiParameters(QUOTE_TYPES, data[1]);
    const [depth] = decodeAbiParameters(QUOTE_TYPES, data[2]);
    if (small <= 0n || depth <= 0n || small >= reserve1 || depth >= reserve1 ||
      depth * 100n < small * 1_000n * 95n || depth * 100n > small * 1_000n * 105n) return reject("quote-depth");
    const price = Number(small) / 1e6 * parent.trustedParent.price;
    if (!Number.isFinite(price) || price <= 0) return reject("price-invalid");
    const tvlUsd = Number(reserve0) / 1e18 * price + Number(reserve1) / 1e6 * parent.trustedParent.price;
    if (!Number.isFinite(tvlUsd) || tvlUsd < DEX_PRICE_OBSERVATION_MIN_TVL_USD) return reject("tvl-floor");
    const observedAt = Math.min(head.timestamp, parent.trustedParent.observedAt);
    if (Math.floor(Date.now() / 1000) - observedAt >= 300) return reject("dependency-age");
    return { price, source: "uniswap-v4-exact", confidence: "fallback", observedAt, observedAtMode: "upstream" };
  } catch { return reject("state-malformed"); }
}

export const usdafUniswapV4Provider: PriceSourceProvider = {
  source: "uniswap-v4-exact", liveMissingOnly: true, liveCircuitSource: CIRCUIT_SOURCE.USDAF_UNISWAP_V4,
  livePriority: 1, liveTimeoutMs: 6_000, matches: (id) => id === "usdaf-asymmetry",
  async fetchLivePrice(asset, context, signal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchUsdafUniswapV4Price(context, signal);
  },
};
