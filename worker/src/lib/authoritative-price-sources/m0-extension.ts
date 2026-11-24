import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters } from "viem/utils";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { throwIfAborted } from "../abort";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmRpcBatch, type EvmRpcBatchCall } from "../evm-rpc";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  buildParentDerivedLiveOverride,
  ETHEREUM_CHAIN,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const M_M0_ID = "m-m0";
const MUSD_METAMASK_ID = "musd-metamask";
const M_TOKEN = "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b";
const SWAP_FACILITY = "0xb6807116b3b1b321a390594e31ecd6e0076f6278";
const SWAP_FACILITY_IMPL = "0x45bf08d042a8958f01f8e8319b791e4584550da8";
const MUSD = "0xaca92e438df0b2401ff60da7e4337b687a2435da";
const MUSD_IMPL = "0x37a309611e1d278cddc341e479957ec8bc6256ce";
const HUB_PORTAL = "0xd925c84b55e4e44a53749ff5f2a5a13f63d128fd";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// Ethereum mainnet bytecode hashes verified 2026-11-24.
const REVIEWED_CODE_HASHES = [
  [M_TOKEN, "0xb9cc3d9749ae74871b35f9b282fb3240347aebbd4cc63c3bcb823f66e91c839b"],
  [SWAP_FACILITY, "0x1dac6a3775026207a56c10224e32213cfb3c2c3b0bac5dee6c9dbf9a5fc19dcc"],
  [SWAP_FACILITY_IMPL, "0xae880fa04884e58d1de83309260500249a5e3a7a4e26118f7257c26a6dfa55ec"],
  [MUSD, "0x6beec3f6c97f67fd749caa154bca38b8af12da91f82a6d6f5f1654696afaa0d3"],
  [MUSD_IMPL, "0x32fed3ef38d418d661265618d7d254c8e1e535828002cb173d8bcd0976764930"],
] as const;
const MIN_MUSD_SUPPLY_RAW = 1_000_000n * 10n ** 6n;
const MAX_BLOCK_AGE_SEC = 5 * 60;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x[0-9a-fA-F]+$/;

const ABI = parseAbi([
  "function mToken() view returns (address)",
  "function swapFacility() view returns (address)",
  "function paused() view returns (bool)",
  "function isApprovedExtension(address) view returns (bool)",
  "function canSwapViaPath(address,address,address) view returns (bool)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ADDR = parseAbiParameters("address");
const BOOL = parseAbiParameters("bool");
const UINT = parseAbiParameters("uint256");

/**
 * On-chain verified 1:1 M0 extension valuation for `m-m0`.
 *
 * Raw `$M` has no liquid secondary market and no permissionless on-chain USDC
 * redemption pool; M0 issues `$M` through off-chain-collateralized Minters and
 * wraps/unwraps `$M` 1:1 into extensions through `SwapFacility`. MetaMask mUSD
 * (`musd-metamask`) is a verified 1:1 pure wrapper of `$M` with live secondary
 * markets. Each live read pins a canonical Ethereum block, checks the deployed
 * bytecode and EIP-1967 implementations of MToken, SwapFacility and mUSD,
 * verifies unpaused SwapFacility approval and bidirectional HubPortal swap
 * paths, and confirms Ethereum mUSD holds at least 1:1 `$M` backing against at
 * least $1M supply before inheriting `musd-metamask`'s trusted live price.
 * Soft single-source provenance stays `single-source` (never upgraded to hard
 * `protocol-redeem` / `high`).
 */
async function fetchM0ExtensionPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => {
    context.lastRejectionReason = `m0-extension:${reason}`;
    return null;
  };
  const parent = resolveTrustedOverrideParent(
    context,
    MUSD_METAMASK_ID,
    () => "[authoritative-price-sources] m-m0: trusted musd-metamask extension parent unavailable",
    { allowFreshReplaySafeSingleSourceParent: true, requireReportedSingleSourceConfidence: true },
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
    { method: "eth_getStorageAt", params: [SWAP_FACILITY, IMPL_SLOT, block] },
    { method: "eth_getStorageAt", params: [MUSD, IMPL_SLOT, block] },
    call(SWAP_FACILITY, encodeFunctionData({ abi: ABI, functionName: "mToken" })),
    call(SWAP_FACILITY, encodeFunctionData({ abi: ABI, functionName: "paused" })),
    call(SWAP_FACILITY, encodeFunctionData({ abi: ABI, functionName: "isApprovedExtension", args: [MUSD] })),
    call(SWAP_FACILITY, encodeFunctionData({ abi: ABI, functionName: "canSwapViaPath", args: [HUB_PORTAL, M_TOKEN, MUSD] })),
    call(SWAP_FACILITY, encodeFunctionData({ abi: ABI, functionName: "canSwapViaPath", args: [HUB_PORTAL, MUSD, M_TOKEN] })),
    call(MUSD, encodeFunctionData({ abi: ABI, functionName: "mToken" })),
    call(MUSD, encodeFunctionData({ abi: ABI, functionName: "swapFacility" })),
    call(MUSD, encodeFunctionData({ abi: ABI, functionName: "paused" })),
    call(MUSD, encodeFunctionData({ abi: ABI, functionName: "decimals" })),
    call(M_TOKEN, encodeFunctionData({ abi: ABI, functionName: "decimals" })),
    call(MUSD, encodeFunctionData({ abi: ABI, functionName: "totalSupply" })),
    call(M_TOKEN, encodeFunctionData({ abi: ABI, functionName: "balanceOf", args: [MUSD] })),
  ];
  const results = await fetchEvmRpcBatch(ETHEREUM_CHAIN, batch, options);
  throwIfAborted(signal);
  if (!results) return reject("state-unavailable");
  if (results.length !== batch.length) return reject("state-invalid");

  const codes = results.slice(0, REVIEWED_CODE_HASHES.length);
  const words = results.slice(REVIEWED_CODE_HASHES.length);
  if (
    codes.some((code, i) =>
      typeof code !== "string" || code.length % 2 !== 0 || !HEX_BYTES.test(code) ||
      keccak256(code as `0x${string}`) !== REVIEWED_CODE_HASHES[i][1],
    )
  ) return reject("runtime-code");
  if (!words.every((word): word is `0x${string}` => typeof word === "string" && WORD.test(word))) {
    return reject("state-invalid");
  }

  let sfImpl: string, musdImpl: string, sfMToken: string, sfPaused: boolean, approved: boolean;
  let canSwapIn: boolean, canSwapOut: boolean, musdMToken: string, musdSf: string, musdPaused: boolean;
  let musdDecimals: bigint, mDecimals: bigint, musdSupply: bigint, mHeld: bigint;
  try {
    const addr = (i: number) => decodeAbiParameters(ADDR, words[i])[0].toLowerCase();
    const bool = (i: number) => decodeAbiParameters(BOOL, words[i])[0];
    const uint = (i: number) => decodeAbiParameters(UINT, words[i])[0];
    sfImpl = addr(0);
    musdImpl = addr(1);
    sfMToken = addr(2);
    sfPaused = bool(3);
    approved = bool(4);
    canSwapIn = bool(5);
    canSwapOut = bool(6);
    musdMToken = addr(7);
    musdSf = addr(8);
    musdPaused = bool(9);
    musdDecimals = uint(10);
    mDecimals = uint(11);
    musdSupply = uint(12);
    mHeld = uint(13);
  } catch {
    return reject("state-malformed");
  }

  if (
    sfImpl !== SWAP_FACILITY_IMPL ||
    musdImpl !== MUSD_IMPL ||
    sfMToken !== M_TOKEN ||
    musdMToken !== M_TOKEN ||
    musdSf !== SWAP_FACILITY ||
    musdDecimals !== 6n ||
    mDecimals !== 6n
  ) return reject("identity");
  if (sfPaused || musdPaused || !approved || !canSwapIn || !canSwapOut) return reject("swap-disabled");
  if (musdSupply < MIN_MUSD_SUPPLY_RAW || mHeld < musdSupply) return reject("backing-insufficient");

  const closing = (await fetchEvmRpcBatch(ETHEREUM_CHAIN, [
    { method: "eth_getBlockByNumber", params: [head.number, false] },
  ], options))?.[0] as { hash?: string } | undefined;
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) return reject("canonical-check");

  // Re-verify parent freshness after RPC work so an observation that expired
  // in flight cannot be published.
  const freshParent = resolveTrustedOverrideParent(
    context,
    MUSD_METAMASK_ID,
    () => "[authoritative-price-sources] m-m0: trusted musd-metamask extension parent expired during RPC",
    { allowFreshReplaySafeSingleSourceParent: true, requireReportedSingleSourceConfidence: true },
  );
  if (!freshParent) return null;

  const override = buildParentDerivedLiveOverride(freshParent, 1);
  if (!override) return null;
  const blockOlder = blockTs < freshParent.trustedParent.observedAt;
  return {
    ...override,
    observedAt: blockOlder ? blockTs : freshParent.trustedParent.observedAt,
    observedAtMode: blockOlder ? "upstream" : override.observedAtMode,
  };
}

export const m0ExtensionProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.M0_EXTENSION,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  liveParentByAssetId: { [M_M0_ID]: MUSD_METAMASK_ID },
  matches: (stablecoinId: string) => stablecoinId === M_M0_ID,
  async fetchLivePrice(asset: PeggedAsset, context: LivePriceContext, signal?: AbortSignal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchM0ExtensionPrice(context, signal);
  },
};
