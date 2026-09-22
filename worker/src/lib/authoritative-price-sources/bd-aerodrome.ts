import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, type ParseAbi } from "viem/utils";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmRpcBatch, fetchEvmMulticall3Aggregate3AtBlock } from "../evm-rpc";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import { resolveTrustedOverrideParent, type CurrentPriceOverride, type LivePriceContext, type PriceSourceProvider } from "./helpers";

const BD = "0x252d36f435582ecb01686448d21e8c9ea0b2ca65";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL = "0xffdf1e3160b60c2e499fa25e51b5c192b9b15e3b";
const FACTORY = "0x420dd381b31aef6683db6b902084cb0ffece40da";
const REVIEWED_RUNTIME = [
  ["0x252d36f435582ecb01686448d21e8c9ea0b2ca65", "0x81f94655a3c2dde6c1c6d945f99cf7d5e9221a335c323aa67c712c0c55cdc099"],
  ["0xffdf1e3160b60c2e499fa25e51b5c192b9b15e3b", "0x7dd6ffe6daf4e82054c91becd71b8c9ba0a135f0f403da1ef7b0f81bb8ba4408"],
  ["0xa4e46b4f701c62e14df11b48dce76a7d793cd6d7", "0xd22754a0a3b39db7298dbbc2be1e34b34320988ea67065c85fa28ae66c02d31e"],
  ["0x420dd381b31aef6683db6b902084cb0ffece40da", "0xe2a176e5d2bcfb214b784ec6d6733708a6376a464f203cc265c284c9f349fea3"],
] as const;
const UNIT = 10n ** 18n;

export async function fetchBdAerodromePrice(context: LivePriceContext, signal?: AbortSignal): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => { context.lastRejectionReason = `aerodrome-exact:${reason}`; return null; };
  const parent = resolveTrustedOverrideParent(context, "usdc-circle", () => "BD: trusted USDC unavailable",
    { allowFreshReplaySafeSingleSourceParent: true });
  if (!parent) return reject("parent-unavailable");
  const age = Math.floor(Date.now() / 1000) - parent.trustedParent.observedAt;
  if (age < 0 || age >= 300) return reject("parent-age");
  const options = { signal, chainRpcs: context.chainRpcs, extraRpcUrls: getPublicFallbackRpcUrls("base"), maxRetries: 0 };
  const block = await fetchEvmBlockNumber("base", options);
  if (block == null) return reject("block-unavailable");
  const head = await fetchEvmBlockHeader("base", block, options);
  const now = Math.floor(Date.now() / 1000);
  if (!head || head.timestamp > now || now - head.timestamp >= 300) return reject("block-age");
  const codes = await fetchEvmRpcBatch("base", REVIEWED_RUNTIME.map(([address]) => ({
    method: "eth_getCode", params: [address, `0x${block.toString(16)}`],
  })), options);
  throwIfAborted(signal);
  if (!codes || codes.length !== REVIEWED_RUNTIME.length || codes.some((code, i) =>
    typeof code !== "string" || code.length % 2 !== 0 || !/^0x[0-9a-fA-F]+$/.test(code)
    || keccak256(code as `0x${string}`) !== REVIEWED_RUNTIME[i][1])) return reject("runtime-code");
  const call = (label: string, target: string, signature: string, args: readonly unknown[] = []) => ({ label, target,
    callData: encodeFunctionData({ abi: parseAbi([signature]) as ParseAbi<readonly string[]>, functionName: signature.match(/function (\w+)/)![1], args }) });
  const calls = [
    call("token0", POOL, "function token0() view returns(address)"),
    call("token1", POOL, "function token1() view returns(address)"),
    call("stable", POOL, "function stable() view returns(bool)"),
    call("factory", POOL, "function factory() view returns(address)"),
    call("registered", FACTORY, "function isPool(address) view returns(bool)", [POOL]),
    call("pool", FACTORY, "function getPool(address,address,bool) view returns(address)", [BD, USDC, true]),
    call("paused", FACTORY, "function isPaused() view returns(bool)"),
    call("fee", FACTORY, "function getFee(address,bool) view returns(uint256)", [POOL, true]),
    call("reserves", POOL, "function getReserves() view returns(uint256,uint256,uint256)"),
    call("inputBalance", BD, "function balanceOf(address) view returns(uint256)", [POOL]),
    call("outputBalance", USDC, "function balanceOf(address) view returns(uint256)", [POOL]),
    call("inputDecimals", BD, "function decimals() view returns(uint8)"),
    call("outputDecimals", USDC, "function decimals() view returns(uint8)"),
    call("outputPaused", USDC, "function paused() view returns(bool)"),
    call("outputBlocked", USDC, "function isBlacklisted(address) view returns(bool)", [POOL]),
    call("small", POOL, "function getAmountOut(uint256,address) view returns(uint256)", [UNIT, BD]),
    call("depth", POOL, "function getAmountOut(uint256,address) view returns(uint256)", [1_000n * UNIT, BD]),
  ];
  const rows = await fetchEvmMulticall3Aggregate3AtBlock("base", calls, block, options);
  throwIfAborted(signal);
  if (!rows || rows.length !== calls.length || rows.some((r, i) => !r.success || r.label !== calls[i].label)) return reject("state-unavailable");
  const closing = await fetchEvmBlockHeader("base", block, options);
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) return reject("canonical-check");
  const values = new Map(rows.map((r) => [r.label, r.returnData]));
  const raw = (label: string) => values.get(label)!;
  try {
    const uint = (label: string) => decodeAbiParameters(parseAbiParameters("uint256"), raw(label))[0];
    const address = (label: string) => decodeAbiParameters(parseAbiParameters("address"), raw(label))[0].toLowerCase();
    const bool = (label: string) => decodeAbiParameters(parseAbiParameters("bool"), raw(label))[0];
    if (address("token0") !== BD || address("token1") !== USDC || address("factory") !== FACTORY || address("pool") !== POOL
      || !bool("stable") || !bool("registered") || uint("inputDecimals") !== 18n || uint("outputDecimals") !== 6n) return reject("identity");
    if (bool("paused") || bool("outputPaused") || bool("outputBlocked") || uint("fee") > 200n) return reject("execution-disabled");
    const [inputReserve, outputReserve] = decodeAbiParameters(parseAbiParameters("uint256,uint256,uint256"), raw("reserves"));
    if (inputReserve !== uint("inputBalance") || outputReserve !== uint("outputBalance")
      || inputReserve < 10_000n * UNIT || outputReserve < 10_000n * 10n ** 6n) return reject("inventory");
    const small = uint("small"), depth = uint("depth");
    if (small <= 0n || depth <= 0n || small >= outputReserve || depth >= outputReserve
      || depth * 100n < small * 1_000n * 95n || depth * 100n > small * 1_000n * 105n) return reject("quote-depth");
    const observedAt = Math.min(head.timestamp, parent.trustedParent.observedAt);
    if (Math.floor(Date.now() / 1000) - observedAt >= 300) return reject("dependency-age");
    const price = Number(small) / 1e6 * parent.trustedParent.price;
    if (!Number.isFinite(price) || price <= 0) return reject("price-invalid");
    return { price, source: "aerodrome-exact", confidence: "fallback", observedAt, observedAtMode: "upstream" };
  } catch { return reject("state-malformed"); }
}

export const bdAerodromeProvider: PriceSourceProvider = {
  source: "aerodrome-exact", liveMissingOnly: true, liveCircuitSource: CIRCUIT_SOURCE.BD_AERODROME,
  livePriority: 1, liveTimeoutMs: 6_000, matches: (id) => id === "bd-basedollar",
  async fetchLivePrice(asset: PeggedAsset, context: LivePriceContext, signal?: AbortSignal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchBdAerodromePrice(context, signal);
  },
};
