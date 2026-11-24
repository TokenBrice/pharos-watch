import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters } from "viem/utils";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { throwIfAborted } from "../abort";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmRpcBatch, type EvmRpcBatchCall } from "../evm-rpc";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  ETHEREUM_CHAIN,
  PROTOCOL_REDEEM_SOURCE,
  quoteUsdcPrice,
  resolveTrustedOverrideParent,
  USDC_CIRCLE_ID,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const NUSD_ID = "nusd-nexus";
const NEXUS_POOL = "0x1116898dda4015ed8ddefb84b6e8bc24528af2d8";
const NEXUS_POOL_IMPL = "0x5a5fff6f753d7c11a56a52fe47a177a87e431655";
const NUSD = "0x1b84765de8b7566e4ceaf4d0fd3c5af52d3dde4f";
const NUSD_IMPL = "0x6c8c6e68604e78b549c96907bfe9ebdaac04e3b3";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
// Immutable EIP-1167 clones + verified SwapFlashLoan/LPToken implementations
// pinned against Ethereum mainnet on 2026-11-24.
const REVIEWED_CODE_HASHES = [
  [NEXUS_POOL, "0xb5fcd450a5d5f8d96ebfe2e33ac19e9dbbb3fbbdf265dca614f99f7c2cd2272e"],
  [NEXUS_POOL_IMPL, "0xea8d43a3273ccd9860533623bda6cb8f2c159f107b2299444821cd71d5f76be7"],
  [NUSD, "0xec18ea395f4146acc7ba73abd350d1a8a87059af9e7485e21ab2e419812a899d"],
  [NUSD_IMPL, "0xe1ca4284dea0eaee3bd8ff878ae634f8fd1337e95fb7d76a92fe38f75c7d26e4"],
] as const;
const UNIT_18 = 10n ** 18n;
const SMALL_NUSD = 1;
const DEPTH_NUSD = 1_000;
const MIN_USDC_RESERVE_RAW = 10_000n * 10n ** 6n;
const MAX_QUOTE_IMPACT_RATIO = 0.05;
const MAX_BLOCK_AGE_SEC = 5 * 60;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x[0-9a-fA-F]+$/;

const ABI = parseAbi([
  "function paused() view returns (bool)",
  "function swapStorage() view returns (uint256,uint256,uint256,uint256,uint256,uint256,address)",
  "function getToken(uint8) view returns (address)",
  "function getTokenBalance(uint8) view returns (uint256)",
  "function calculateRemoveLiquidityOneToken(uint256,uint8) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function isBlacklisted(address) view returns (bool)",
]);
const ADDR = parseAbiParameters("address");
const BOOL = parseAbiParameters("bool");
const UINT = parseAbiParameters("uint256");
const SWAP_STORAGE = parseAbiParameters("uint256,uint256,uint256,uint256,uint256,uint256,address");

/**
 * Executable on-chain redemption quote for Ethereum Synapse `nusd-nexus`.
 *
 * Ethereum `0x1b84765de8b7566e4ceaf4d0fd3c5af52d3dde4f` is the immutable
 * EIP-1167 `LPToken` of Synapse's Ethereum DAI/USDC/USDT `NexusPool`
 * (`0x1116898dda4015ed8ddefb84b6e8bc24528af2d8`). Any holder can burn it
 * permissionlessly via `removeLiquidityOneToken(amount, 1, minAmount, deadline)`
 * for USDC. Because bridged L2 nUSD holders still rely on Synapse Bridge to
 * reach this Ethereum pool, the quote publishes at `fallback` confidence
 * (`confirm_required`, never standalone depeg authority) and `liveMissingOnly`.
 */
async function fetchNusdSynapsePoolPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => {
    context.lastRejectionReason = `nusd-synapse-pool:${reason}`;
    return null;
  };
  const parent = resolveTrustedOverrideParent(
    context,
    USDC_CIRCLE_ID,
    () => "[authoritative-price-sources] nusd-nexus: trusted USDC quote dependency unavailable",
    { allowFreshReplaySafeSingleSourceParent: true },
  );
  if (!parent) return null;

  const options = {
    signal,
    extraRpcUrls: getPublicFallbackRpcUrls(ETHEREUM_CHAIN),
    chainRpcs: context.chainRpcs,
    maxRetries: 0,
  };
  const head = (await fetchEvmRpcBatch(ETHEREUM_CHAIN, [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
  ], options))?.[0] as { number?: string; hash?: string; timestamp?: string } | undefined;
  throwIfAborted(signal);
  if (!head) return reject("head-unavailable");
  if (!/^0x[0-9a-f]+$/i.test(head.number ?? "") || !WORD.test(head.hash ?? "") ||
      !/^0x[0-9a-f]+$/i.test(head.timestamp ?? "")) return reject("head-invalid");
  const blockNumber = Number(BigInt(head.number!));
  const blockTs = Number(BigInt(head.timestamp!));
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0 || BigInt(head.hash!) === 0n) return reject("head-invalid");
  if (!Number.isSafeInteger(blockTs) || blockTs <= 0 || blockTs > nowSec + 60 || nowSec - blockTs > MAX_BLOCK_AGE_SEC) {
    return reject("head-stale-or-invalid");
  }

  const block = { blockHash: head.hash, requireCanonical: true };
  const call = (to: string, data: string): EvmRpcBatchCall => ({ method: "eth_call", params: [{ to, data }, block] });
  const batch: EvmRpcBatchCall[] = [
    ...REVIEWED_CODE_HASHES.map(([address]): EvmRpcBatchCall => ({ method: "eth_getCode", params: [address, block] })),
    call(NEXUS_POOL, encodeFunctionData({ abi: ABI, functionName: "paused" })),
    call(NEXUS_POOL, encodeFunctionData({ abi: ABI, functionName: "swapStorage" })),
    call(NEXUS_POOL, encodeFunctionData({ abi: ABI, functionName: "getToken", args: [0] })),
    call(NEXUS_POOL, encodeFunctionData({ abi: ABI, functionName: "getToken", args: [1] })),
    call(NEXUS_POOL, encodeFunctionData({ abi: ABI, functionName: "getToken", args: [2] })),
    call(NEXUS_POOL, encodeFunctionData({ abi: ABI, functionName: "getTokenBalance", args: [1] })),
    call(USDC, encodeFunctionData({ abi: ABI, functionName: "balanceOf", args: [NEXUS_POOL] })),
    call(USDC, encodeFunctionData({ abi: ABI, functionName: "decimals" })),
    call(USDC, encodeFunctionData({ abi: ABI, functionName: "paused" })),
    call(USDC, encodeFunctionData({ abi: ABI, functionName: "isBlacklisted", args: [NEXUS_POOL] })),
    call(NUSD, encodeFunctionData({ abi: ABI, functionName: "decimals" })),
    call(NUSD, encodeFunctionData({ abi: ABI, functionName: "totalSupply" })),
    call(NEXUS_POOL, encodeFunctionData({ abi: ABI, functionName: "calculateRemoveLiquidityOneToken", args: [BigInt(SMALL_NUSD) * UNIT_18, 1] })),
    call(NEXUS_POOL, encodeFunctionData({ abi: ABI, functionName: "calculateRemoveLiquidityOneToken", args: [BigInt(DEPTH_NUSD) * UNIT_18, 1] })),
  ];
  const results = await fetchEvmRpcBatch(ETHEREUM_CHAIN, batch, options);
  throwIfAborted(signal);
  if (!results) return reject("state-unavailable");
  if (results.length !== batch.length) return reject("state-invalid");

  const codes = results.slice(0, REVIEWED_CODE_HASHES.length);
  const calls = results.slice(REVIEWED_CODE_HASHES.length);
  if (
    codes.some((code, i) =>
      typeof code !== "string" || code.length % 2 !== 0 || !HEX_BYTES.test(code) ||
      keccak256(code as `0x${string}`) !== REVIEWED_CODE_HASHES[i][1],
    )
  ) return reject("runtime-code");
  if (
    !calls.every((value, i): value is `0x${string}` =>
      typeof value === "string" && (i === 1 ? HEX_BYTES.test(value) && value.length >= 2 + 7 * 64 : WORD.test(value)),
    )
  ) return reject("state-invalid");

  let poolPaused: boolean, lpToken: string, tok0: string, tok1: string, tok2: string;
  let usdcReserve: bigint, usdcBalance: bigint, usdcDecimals: bigint, usdcPaused: boolean, usdcBlacklisted: boolean;
  let nusdDecimals: bigint, nusdSupply: bigint, smallRaw: bigint, depthRaw: bigint;
  try {
    const bool = (i: number) => decodeAbiParameters(BOOL, calls[i])[0];
    const addr = (i: number) => decodeAbiParameters(ADDR, calls[i])[0].toLowerCase();
    const uint = (i: number) => decodeAbiParameters(UINT, calls[i])[0];
    poolPaused = bool(0);
    lpToken = decodeAbiParameters(SWAP_STORAGE, calls[1])[6].toLowerCase();
    tok0 = addr(2);
    tok1 = addr(3);
    tok2 = addr(4);
    usdcReserve = uint(5);
    usdcBalance = uint(6);
    usdcDecimals = uint(7);
    usdcPaused = bool(8);
    usdcBlacklisted = bool(9);
    nusdDecimals = uint(10);
    nusdSupply = uint(11);
    smallRaw = uint(12);
    depthRaw = uint(13);
  } catch {
    return reject("state-malformed");
  }

  if (lpToken !== NUSD || tok0 !== DAI || tok1 !== USDC || tok2 !== USDT || usdcDecimals !== 6n || nusdDecimals !== 18n) {
    return reject("identity");
  }
  if (poolPaused || usdcPaused || usdcBlacklisted) return reject("redemption-disabled");
  if (nusdSupply <= 0n || usdcReserve < MIN_USDC_RESERVE_RAW || usdcBalance < usdcReserve) return reject("inventory");

  const smallPrice = quoteUsdcPrice(smallRaw, SMALL_NUSD);
  const depthPrice = quoteUsdcPrice(depthRaw, DEPTH_NUSD);
  if (smallPrice == null || depthPrice == null || smallRaw >= usdcReserve || depthRaw >= usdcReserve) {
    return reject("quote-invalid");
  }
  if (Math.abs(depthPrice - smallPrice) / smallPrice > MAX_QUOTE_IMPACT_RATIO) return reject("quote-depth");

  const closing = (await fetchEvmRpcBatch(ETHEREUM_CHAIN, [
    { method: "eth_getBlockByNumber", params: [head.number, false] },
  ], options))?.[0] as { hash?: string } | undefined;
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) return reject("canonical-check");

  const freshParent = resolveTrustedOverrideParent(
    context,
    USDC_CIRCLE_ID,
    () => "[authoritative-price-sources] nusd-nexus: trusted USDC quote dependency expired during RPC",
    { allowFreshReplaySafeSingleSourceParent: true },
  );
  if (!freshParent) return null;

  const price = smallPrice * freshParent.trustedParent.price;
  if (!Number.isFinite(price) || price <= 0) return reject("price-invalid");
  const parentOlder = freshParent.trustedParent.observedAt < blockTs;
  return {
    price,
    source: PROTOCOL_REDEEM_SOURCE,
    confidence: "fallback",
    observedAt: parentOlder ? freshParent.trustedParent.observedAt : blockTs,
    observedAtMode: parentOlder ? freshParent.trustedParent.observedAtMode ?? "upstream" : "upstream",
  };
}

export const nusdSynapsePoolProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.NUSD_SYNAPSE_POOL,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  liveParentByAssetId: { [NUSD_ID]: USDC_CIRCLE_ID },
  matches: (stablecoinId: string) => stablecoinId === NUSD_ID,
  async fetchLivePrice(asset: PeggedAsset, context: LivePriceContext, signal?: AbortSignal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchNusdSynapsePoolPrice(context, signal);
  },
};
