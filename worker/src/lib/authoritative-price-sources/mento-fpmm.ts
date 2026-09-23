import { decodeAbiParameters, parseAbiParameters } from "viem/utils";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmMulticall3Aggregate3AtBlock, fetchEvmStorageAtBlock } from "../evm-rpc";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import { resolveTrustedOverrideParent, type CurrentPriceOverride, type LivePriceContext, type PriceSourceProvider } from "./helpers";

const CHFM = "0xb55a79f398e759e43c95b979163f30ec87ee131d";
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
const POOL = "0xdc81135fd82f02cae736e261fb676b716663e8b8";
// Both reviewed proxies use StableTokenV3's standard ERC20 transfers, without pause/blacklist hooks.
const TOKEN_IMPLEMENTATION = "0x815795c30d0758a297b08cd4e0643620c974c318";
const POOL_IMPLEMENTATION_WORD = "0x0000000000000000000000008cb0518a0510ab62450f79f3cd9ee0cbddb77f30";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const UNIT = 10n ** 18n;
const IMPACT_INPUT = 100n * UNIT;
const word = (value: string | bigint) => (typeof value === "bigint" ? value.toString(16) : value.slice(2)).padStart(64, "0");
const quoteData = (amount: bigint) => `0xf140a35a${word(amount)}${word(CHFM)}`;
const UINT = parseAbiParameters("uint256");
const ADDRESS = parseAbiParameters("address");
const RESERVES = parseAbiParameters("uint256,uint256,uint256");
const LIMITS = parseAbiParameters("int120,int120,uint8,uint32,uint32,int96,int96");
const REBALANCING = parseAbiParameters("uint256,uint256,uint256,uint256,bool,uint16,uint256");

export async function fetchMentoFpmmPrice(context: LivePriceContext, signal?: AbortSignal): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => {
    context.lastRejectionReason = `mento-fpmm:${reason}`;
    return null;
  };
  const parent = resolveTrustedOverrideParent(context, MENTO_FPMM_PARENT_ID,
    () => "[authoritative-price-sources] CHFm: trusted USDm quote unavailable",
    { allowFreshReplaySafeSingleSourceParent: true });
  if (!parent) return null;
  const parentAge = Math.floor(Date.now() / 1000) - parent.trustedParent.observedAt;
  if (parentAge < 0 || parentAge >= 300) return reject("parent-age");
  const options = { signal, chainRpcs: context.chainRpcs, extraRpcUrls: getPublicFallbackRpcUrls("celo"), maxRetries: 0 };
  const block = await fetchEvmBlockNumber("celo", options);
  if (block == null) return reject("block-unavailable");
  const head = await fetchEvmBlockHeader("celo", block, options);
  const timestamp = head?.timestamp;
  const now = Math.floor(Date.now() / 1000);
  if (timestamp == null || timestamp > now || now - timestamp >= 300) return reject("block-age");
  const implementation = await fetchEvmStorageAtBlock("celo", POOL, IMPLEMENTATION_SLOT, block, options);
  throwIfAborted(signal);
  if (implementation?.toLowerCase() !== POOL_IMPLEMENTATION_WORD) return reject("pool-implementation");

  // All pool state and both quotes share one block and one bounded multicall.
  const calls = [
    ["token0", POOL, "0x0dfe1681"], ["token1", POOL, "0xd21220a7"],
    ["reserves", POOL, "0x0902f1ac"],
    ["inputBalance", CHFM, `0x70a08231${word(POOL)}`], ["outputBalance", USDM, `0x70a08231${word(POOL)}`],
    ["inputDecimals", CHFM, "0x313ce567"], ["outputDecimals", USDM, "0x313ce567"],
    ["inputImplementation", CHFM, "0x42404e07"], ["outputImplementation", USDM, "0x42404e07"],
    ["lpFee", POOL, "0x704ce43e"], ["protocolFee", POOL, "0xb0e21e8a"],
    ["feeRecipient", POOL, "0x64df049e"],
    ["inputLimits", POOL, `0x6391f7db${word(CHFM)}`], ["outputLimits", POOL, `0x6391f7db${word(USDM)}`],
    ["smallQuote", POOL, quoteData(UNIT)], ["impactQuote", POOL, quoteData(IMPACT_INPUT)],
    ["rate", POOL, "0x93965ec9"], // getRebalancingState()
  ].map(([label, target, callData]) => ({ label, target, callData }));
  const rows = await fetchEvmMulticall3Aggregate3AtBlock("celo", calls, block, options);
  throwIfAborted(signal);
  if (!rows) return reject(`state-rpc-null:block-${block}`);
  if (rows.length !== calls.length || rows.some((row, index) => row.label !== calls[index].label)) {
    return reject(`state-batch-shape:block-${block}`);
  }
  const failedCall = rows.findIndex((row) => !row.success);
  if (failedCall >= 0) return reject(`state-subcall-${calls[failedCall].label}:block-${block}`);
  const closing = await fetchEvmBlockHeader("celo", block, options);
  throwIfAborted(signal);
  if (!head || closing?.hash !== head.hash) return reject("canonical-check");
  const values = new Map(rows.map((row) => [row.label, row.returnData]));
  const raw = (label: string) => values.get(label)!;
  try {
    const uint = (label: string) => decodeAbiParameters(UINT, raw(label))[0];
    const address = (label: string) => decodeAbiParameters(ADDRESS, raw(label))[0].toLowerCase();
    if (address("token0") !== USDM || address("token1") !== CHFM ||
      uint("inputDecimals") !== 18n || uint("outputDecimals") !== 18n ||
      address("inputImplementation") !== TOKEN_IMPLEMENTATION || address("outputImplementation") !== TOKEN_IMPLEMENTATION) return reject("token-identity");
    const [outputReserve, inputReserve] = decodeAbiParameters(RESERVES, raw("reserves"));
    if (outputReserve !== uint("outputBalance") || inputReserve !== uint("inputBalance") ||
      outputReserve < 1_000n * UNIT || inputReserve < 1_000n * UNIT) return reject("inventory");
    const fee = uint("lpFee") + uint("protocolFee");
    if (fee > 200n || (uint("protocolFee") > 0n && address("feeRecipient") === "0x0000000000000000000000000000000000000000")) return reject("fees");
    const [numerator, denominator] = decodeAbiParameters(REBALANCING, raw("rate"));
    if (numerator <= 0n || denominator <= 0n) return reject("rate-invalid");
    const small = uint("smallQuote");
    const impact = uint("impactQuote");
    // getAmountOut and swap call getFXRateIfValid: stale/closed/broken oracle states revert.
    // Quotes alone omit inventory, limits and reserve-value protection; verify those too.
    for (const [amountIn, amountOut] of [[UNIT, small], [IMPACT_INPUT, impact]]) {
      if (amountOut <= 0n || amountOut >= outputReserve ||
        amountOut !== amountIn * denominator * (10_000n - fee) / (numerator * 10_000n)) return reject("quote-invalid");
      const oldValue = outputReserve * numerator / denominator + inputReserve;
      const newValue = (outputReserve - amountOut) * numerator / denominator + inputReserve + amountIn;
      const feeValue = (amountOut * fee / (10_000n - fee)) * numerator / denominator;
      if (newValue < oldValue + feeValue) return reject("reserve-value");
    }
    for (const [label, amount] of [["inputLimits", IMPACT_INPUT], ["outputLimits", impact]] as const) {
      const limits = decodeAbiParameters(LIMITS, raw(label));
      if (limits[2] !== 18) return reject("limit-decimals");
      const scaled = (amount + 999n) / 1_000n;
      for (const index of [0, 1] as const) {
        const limit = limits[index];
        const flow = limits[index + 5] as bigint;
        // Ignoring resets and fee deductions is conservative in both trade directions.
        const absoluteFlow = flow < 0n ? -flow : flow;
        if (limit < 0n || (limit > 0n && (scaled > limit - absoluteFlow || absoluteFlow + scaled > (1n << 95n) - 1n))) return reject("trading-limits");
      }
    }
    const price = Number(small) / Number(UNIT) * parent.trustedParent.price;
    if (!Number.isFinite(price) || price <= 0) return reject("price-invalid");
    const observedAt = Math.min(timestamp, parent.trustedParent.observedAt);
    if (Math.floor(Date.now() / 1000) - observedAt >= 300) return reject("expired-during-fetch");
    return { price, source: "mento-fpmm", confidence: "fallback",
      observedAt, observedAtMode: "upstream" };
  } catch {
    return reject("state-malformed");
  }
}

const CHFM_MENTO_ID = "chfm-mento";
/** Celo USDm row this route multiplies its pool quote by. */
const MENTO_FPMM_PARENT_ID = "cusd-celo";

export const mentoFpmmProvider: PriceSourceProvider = {
  source: "mento-fpmm", liveMissingOnly: true, liveCircuitSource: CIRCUIT_SOURCE.MENTO_FPMM,
  livePriority: 1, liveTimeoutMs: 6_000,
  liveParentByAssetId: { [CHFM_MENTO_ID]: MENTO_FPMM_PARENT_ID },
  matches: (id) => id === CHFM_MENTO_ID,
  async fetchLivePrice(asset: PeggedAsset, context: LivePriceContext, signal?: AbortSignal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchMentoFpmmPrice(context, signal);
  },
};
