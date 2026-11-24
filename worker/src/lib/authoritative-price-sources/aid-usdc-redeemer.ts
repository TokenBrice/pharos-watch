import { encodeFunctionData, keccak256, parseAbi } from "viem/utils";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { throwIfAborted } from "../abort";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmRpcBatch, type EvmRpcBatchCall } from "../evm-rpc";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  ETHEREUM_CHAIN,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  USDC_CIRCLE_ID,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const AID_GAIB_ID = "aid-gaib";
const REDEEMER = "0x52323f33551188f170d8de14fe8d8423a839629d";
const BEACON = "0xc787e7f060acab38d30aceb539355b328024e8b8";
const REDEEMER_IMPL = "0xb835004007296f5278fbf85f090af7195361e946";
const AID = "0x18f52b3fb465118731d9e0d276d4eb3599d57596";
const AID_IMPL = "0x2db74834f556e1f19ed397e5f935a983e4c2f38b";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// keccak256("REDEEMER_ROLE") on the canonical AID token.
const REDEEMER_ROLE = "0x44ac9762eec3a11893fefb11d028bb3102560094137c3ed4518712475b2577cc" as const;

// Reviewed at Ethereum block 26485679 (2026-11-24T14:41:11Z):
// StablecoinRedeemer (BeaconProxy) redeems AID 1:1 into USDC minus redemptionFeeBps,
// with no on-chain caller whitelist (AID enforces a per-address deny list on burn).
const REVIEWED_RUNTIME = [
  [REDEEMER, "0x5ee166d6067edf55070985eadf39a2cb051eb1009747ce5721980b80c1113192"],
  [BEACON, "0x15e8556685fc2cd2812f8aaa2982a6e55a3d5736b605c81808a73310aae5cde9"],
  [REDEEMER_IMPL, "0x40ed58a76b6375199595a25da64f0f0f17afa9963fa4e27603fef008affc7a59"],
  [AID, "0xe8edf5bd14c2391859ff5e6686edb2429c89995723a7519f848a1690fceab901"],
  [AID_IMPL, "0xc09ad6e42763b1e770caf550f1fccd887825dd8e9964b9100fe00d96f7650400"],
] as const;

const MIN_EXIT_AID = 1_000n * 10n ** 18n;
const MIN_EXIT_USDC = 1_000n * 10n ** 6n;
const EXPECTED_DECIMAL_ADJUSTMENT = 10n ** 12n;
const FEE_DENOMINATOR_BPS = 10_000n;
const SECONDS_PER_DAY = 86_400n;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const addressWord = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const isEvenHex = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) && value.length % 2 === 0;
const isWord = (value: unknown): value is `0x${string}` => typeof value === "string" && WORD.test(value);

const ABI = parseAbi([
  "function implementation() view returns (address)",
  "function aid() view returns (address)",
  "function stablecoin() view returns (address)",
  "function aidDecimals() view returns (uint8)",
  "function stablecoinDecimals() view returns (uint8)",
  "function DECIMAL_ADJUSTMENT() view returns (uint256)",
  "function redemptionFeeBps() view returns (uint16)",
  "function redeemLimitPerDay() view returns (uint256)",
  "function dailyRedeemed(uint256) view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function paused() view returns (bool)",
  "function decimals() view returns (uint8)",
  "function isBlacklisted(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export async function fetchAidUsdcRedeemerPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => {
    context.lastRejectionReason = `aid-usdc-redeemer:${reason}`;
    return null;
  };
  const parent = resolveTrustedOverrideParent(
    context,
    USDC_CIRCLE_ID,
    () => "[authoritative-price-sources] aid-gaib: trusted USDC dependency unavailable",
    { allowFreshNonReplaySafeParent: true, allowFreshReplaySafeSingleSourceParent: true },
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
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0 || BigInt(head.hash!) === 0n) return reject("head-invalid");
  const headTimestamp = Number(BigInt(head.timestamp!));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(headTimestamp) || headTimestamp <= 0 ||
      headTimestamp > now + 60 || now - headTimestamp > 300) return reject("head-stale-or-invalid");

  const block = { blockHash: head.hash, requireCanonical: true };
  const currentDay = BigInt(headTimestamp) / SECONDS_PER_DAY;
  const call = (to: string, data: string): EvmRpcBatchCall => ({ method: "eth_call", params: [{ to, data }, block] });
  const batchCalls: EvmRpcBatchCall[] = [
    ...REVIEWED_RUNTIME.map(([address]): EvmRpcBatchCall => ({ method: "eth_getCode", params: [address, block] })),
    { method: "eth_getStorageAt", params: [REDEEMER, EIP1967_BEACON_SLOT, block] },
    { method: "eth_getStorageAt", params: [AID, EIP1967_IMPL_SLOT, block] },
    call(BEACON, encodeFunctionData({ abi: ABI, functionName: "implementation" })),
    call(REDEEMER, encodeFunctionData({ abi: ABI, functionName: "aid" })),
    call(REDEEMER, encodeFunctionData({ abi: ABI, functionName: "stablecoin" })),
    call(REDEEMER, encodeFunctionData({ abi: ABI, functionName: "aidDecimals" })),
    call(REDEEMER, encodeFunctionData({ abi: ABI, functionName: "stablecoinDecimals" })),
    call(REDEEMER, encodeFunctionData({ abi: ABI, functionName: "DECIMAL_ADJUSTMENT" })),
    call(REDEEMER, encodeFunctionData({ abi: ABI, functionName: "redemptionFeeBps" })),
    call(REDEEMER, encodeFunctionData({ abi: ABI, functionName: "redeemLimitPerDay" })),
    call(REDEEMER, encodeFunctionData({ abi: ABI, functionName: "dailyRedeemed", args: [currentDay] })),
    call(AID, encodeFunctionData({ abi: ABI, functionName: "hasRole", args: [REDEEMER_ROLE, REDEEMER] })),
    call(AID, encodeFunctionData({ abi: ABI, functionName: "paused" })),
    call(AID, encodeFunctionData({ abi: ABI, functionName: "decimals" })),
    call(USDC, encodeFunctionData({ abi: ABI, functionName: "decimals" })),
    call(USDC, encodeFunctionData({ abi: ABI, functionName: "paused" })),
    call(USDC, encodeFunctionData({ abi: ABI, functionName: "isBlacklisted", args: [REDEEMER] })),
    call(USDC, encodeFunctionData({ abi: ABI, functionName: "balanceOf", args: [REDEEMER] })),
  ];
  const results = await fetchEvmRpcBatch(ETHEREUM_CHAIN, batchCalls, options);
  throwIfAborted(signal);
  if (!results) return reject("state-unavailable");
  if (results.length !== batchCalls.length) return reject("state-invalid");

  const codeResults = results.slice(0, REVIEWED_RUNTIME.length);
  const words = results.slice(REVIEWED_RUNTIME.length);
  if (codeResults.some((code, i) => !isEvenHex(code) || keccak256(code) !== REVIEWED_RUNTIME[i][1]) ||
      !words.every(isWord)) return reject("state-invalid-or-code-mismatch");

  const [
    beaconSlotHex, aidImplSlotHex, beaconImplHex,
    redeemerAidHex, redeemerStablecoinHex, aidDecimalsHex, stablecoinDecimalsHex, decimalAdjustmentHex,
    feeBpsHex, dailyLimitHex, dailyRedeemedHex,
    hasRedeemerRoleHex, aidPausedHex, aidTokenDecimalsHex,
    usdcDecimalsHex, usdcPausedHex, usdcBlacklistedHex, usdcBalanceHex,
  ] = words;

  if (beaconSlotHex.toLowerCase() !== addressWord(BEACON) ||
      aidImplSlotHex.toLowerCase() !== addressWord(AID_IMPL) ||
      beaconImplHex.toLowerCase() !== addressWord(REDEEMER_IMPL) ||
      redeemerAidHex.toLowerCase() !== addressWord(AID) ||
      redeemerStablecoinHex.toLowerCase() !== addressWord(USDC) ||
      BigInt(aidDecimalsHex) !== 18n || BigInt(stablecoinDecimalsHex) !== 6n ||
      BigInt(decimalAdjustmentHex) !== EXPECTED_DECIMAL_ADJUSTMENT ||
      BigInt(aidTokenDecimalsHex) !== 18n || BigInt(usdcDecimalsHex) !== 6n) {
    return reject("identity-mismatch");
  }

  if (BigInt(hasRedeemerRoleHex) !== 1n || BigInt(aidPausedHex) !== 0n ||
      BigInt(usdcPausedHex) !== 0n || BigInt(usdcBlacklistedHex) !== 0n) {
    return reject("redemption-disabled");
  }

  const feeBps = BigInt(feeBpsHex);
  if (feeBps >= FEE_DENOMINATOR_BPS) return reject("fee-invalid");

  const dailyLimit = BigInt(dailyLimitHex);
  const redeemedToday = BigInt(dailyRedeemedHex);
  const usdcBalance = BigInt(usdcBalanceHex);
  if (dailyLimit <= redeemedToday || dailyLimit - redeemedToday < MIN_EXIT_AID || usdcBalance < MIN_EXIT_USDC) {
    return reject("capacity-insufficient");
  }

  const closing = (await fetchEvmRpcBatch(ETHEREUM_CHAIN, [
    { method: "eth_getBlockByNumber", params: [head.number, false] },
  ], options))?.[0] as { hash?: string } | undefined;
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) return reject("canonical-check-failed");

  const quoteUnitsPerToken = Number(FEE_DENOMINATOR_BPS - feeBps) / Number(FEE_DENOMINATOR_BPS);
  const price = parent.trustedParent.price * quoteUnitsPerToken;
  if (!Number.isFinite(price) || price <= 0) return reject("price-invalid");

  const parentClockSelected = parent.trustedParent.observedAt <= headTimestamp;
  const observedAt = parentClockSelected ? parent.trustedParent.observedAt : headTimestamp;
  const observedAtMode = parentClockSelected ? (parent.trustedParent.observedAtMode ?? "upstream") : "upstream";
  const maxAgeSec = getPricingSourceRegistryEntry(PROTOCOL_REDEEM_SOURCE)?.maxTrustedAgeSec;
  if (maxAgeSec == null || Math.floor(Date.now() / 1000) - observedAt > maxAgeSec) return reject("dependency-age");

  return {
    price,
    source: PROTOCOL_REDEEM_SOURCE,
    confidence: "fallback",
    observedAt,
    observedAtMode,
    metadata: {
      inheritedFrom: parent.parentId,
      parentSource: parent.parentAsset.priceSource ?? null,
      parentConfidence: parent.parentAsset.priceConfidence ?? null,
      parentObservedAt: parent.parentAsset.priceObservedAt ?? parent.parentAsset.priceUpdatedAt ?? null,
      parentObservedAtMode: parent.parentAsset.priceObservedAtMode ?? null,
      parentReplaySafe: parent.trustedParent.replaySafe,
    },
  };
}

export const aidUsdcRedeemerProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.PROTOCOL_REDEEM,
  liveTimeoutMs: 6_000,
  liveParentByAssetId: { [AID_GAIB_ID]: USDC_CIRCLE_ID },
  matches: (id) => id === AID_GAIB_ID,
  fetchLivePrice: (asset, context, signal) =>
    hasPublishableCurrentPrice(asset) ? Promise.resolve(null) : fetchAidUsdcRedeemerPrice(context, signal),
};
