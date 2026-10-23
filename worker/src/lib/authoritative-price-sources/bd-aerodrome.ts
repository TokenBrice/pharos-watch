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
// Aero (merged Aerodrome/Velodrome) BD/USDC stable pool. Legacy Aerodrome
// emissions ended 2026-10-22 and this pool already held ~2x the legacy
// pool's reserves at review (Base block 52996200, 2026-10-23).
const POOL = "0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f";
const FACTORY = "0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d";
const FEE_MODULE = "0x0195fc76da986d66b2a468133a1be41e90893da6";
const STABLE_POOL_TYPE = "0x56325f535441424c450000000000000000000000000000000000000000000000"; // "V2_STABLE"
// Quotes run through Multicall3, so it is the fee-module/MEV-tax `sender`.
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const REVIEWED_RUNTIME = [
  ["0x252d36f435582ecb01686448d21e8c9ea0b2ca65", "0x81f94655a3c2dde6c1c6d945f99cf7d5e9221a335c323aa67c712c0c55cdc099"],
  ["0x11cc6f32930c20e3cfb01fc35bd37ed20d3ed82f", "0x693de232c6013bfbfc2a85f5d0a0588bb5deae3ba013921cf26cf966135e0b5f"],
  ["0xf525988f88b7d8b64631d86070fec5bfdc50c174", "0x9d1476a920eac769acf23251d79fd656f5566538080c06fc05573e5946b64a91"],
  ["0x78589e876edcebdce72ee3436ab3c9ad3a7cef2d", "0x3b34cd7ed303be01986b097c49f1a29d211783ef63f5e920db0ffb9291396cc2"],
  ["0x0195fc76da986d66b2a468133a1be41e90893da6", "0xe0c19912c35391d5bd218fc0903c3116d9915dc36b4f0b93eb75cf19932c12ac"],
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
    call("poolType", POOL, "function POOL_TYPE() view returns(bytes32)"),
    call("factory", POOL, "function factory() view returns(address)"),
    call("registered", FACTORY, "function isPool(address) view returns(bool)", [POOL]),
    call("pool", FACTORY, "function getPool(address,address) view returns(address)", [BD, USDC]),
    call("paused", FACTORY, "function isPaused() view returns(bool)"),
    call("feeModule", FACTORY, "function feeModule() view returns(address)"),
    call("reserves", POOL, "function getReserves() view returns(uint256,uint256,uint256)"),
    call("inputBalance", BD, "function balanceOf(address) view returns(uint256)", [POOL]),
    call("outputBalance", USDC, "function balanceOf(address) view returns(uint256)", [POOL]),
    call("inputDecimals", BD, "function decimals() view returns(uint8)"),
    call("outputDecimals", USDC, "function decimals() view returns(uint8)"),
    call("outputPaused", USDC, "function paused() view returns(bool)"),
    call("outputBlocked", USDC, "function isBlacklisted(address) view returns(bool)", [POOL]),
    // Total-fee quotes include the fee module and any MEV tax actually charged.
    call("small", POOL, "function getAmountOutWithTotalFee(uint256,address) view returns(uint256)", [UNIT, BD]),
    call("depth", POOL, "function getAmountOutWithTotalFee(uint256,address) view returns(uint256)", [1_000n * UNIT, BD]),
  ];
  const rows = await fetchEvmMulticall3Aggregate3AtBlock("base", calls, block, options);
  throwIfAborted(signal);
  if (!rows || rows.length !== calls.length || rows.some((r, i) => !r.success || r.label !== calls[i].label)) return reject("state-unavailable");
  // The effective fee depends on the pinned reserves, so it is read in a second
  // aggregate at the same block for both quoted notionals.
  let reserves: readonly [bigint, bigint, bigint];
  try {
    reserves = decodeAbiParameters(parseAbiParameters("uint256,uint256,uint256"), rows.find((r) => r.label === "reserves")!.returnData);
  } catch { return reject("state-malformed"); }
  const feeSignature = "function getFee(address,address,uint256,uint256,uint256,uint256) view returns(uint256,uint256,bool)";
  const feeCalls = [
    call("smallFee", FACTORY, feeSignature, [POOL, MULTICALL3, UNIT, 0n, reserves[0], reserves[1]]),
    call("depthFee", FACTORY, feeSignature, [POOL, MULTICALL3, 1_000n * UNIT, 0n, reserves[0], reserves[1]]),
  ];
  const feeRows = await fetchEvmMulticall3Aggregate3AtBlock("base", feeCalls, block, options);
  throwIfAborted(signal);
  if (!feeRows || feeRows.length !== feeCalls.length || feeRows.some((r, i) => !r.success || r.label !== feeCalls[i].label)) return reject("state-unavailable");
  const closing = await fetchEvmBlockHeader("base", block, options);
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) return reject("canonical-check");
  const values = new Map([...rows, ...feeRows].map((r) => [r.label, r.returnData]));
  const raw = (label: string) => values.get(label)!;
  try {
    const uint = (label: string) => decodeAbiParameters(parseAbiParameters("uint256"), raw(label))[0];
    const address = (label: string) => decodeAbiParameters(parseAbiParameters("address"), raw(label))[0].toLowerCase();
    const bool = (label: string) => decodeAbiParameters(parseAbiParameters("bool"), raw(label))[0];
    if (address("token0") !== BD || address("token1") !== USDC || address("factory") !== FACTORY || address("pool") !== POOL
      || raw("poolType") !== STABLE_POOL_TYPE || address("feeModule") !== FEE_MODULE
      || !bool("registered") || uint("inputDecimals") !== 18n || uint("outputDecimals") !== 6n) return reject("identity");
    const fees = ["smallFee", "depthFee"].map((label) => decodeAbiParameters(parseAbiParameters("uint256,uint256,bool"), raw(label)));
    if (bool("paused") || bool("outputPaused") || bool("outputBlocked")
      || fees.some(([fee, , toxic]) => fee > 200n || toxic)) return reject("execution-disabled");
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
  liveParentByAssetId: { "bd-basedollar": "usdc-circle" },
  async fetchLivePrice(asset: PeggedAsset, context: LivePriceContext, signal?: AbortSignal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchBdAerodromePrice(context, signal);
  },
};
