import { encodeFunctionData, keccak256, parseAbi } from "viem/utils";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { throwIfAborted } from "../abort";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmRpcBatch, type EvmRpcBatchCall } from "../evm-rpc";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  buildParentDerivedLiveOverride,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
  type TrustedOverrideParent,
} from "./helpers";

const EURC_BRIDGE = "0xb4ff7412f08c22d7381885e8bda9ee9825092fd1";
const EURS_BRIDGE = "0x73f38ca06b27eaefb1612d062d885f58924f5897";
const DEURO = "0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea";
const EURC = "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c";
const EURS = "0xdb25f211ab05b1c97d595516f45794528a807ad8";
const EURS_DELEGATE = "0x25d772b21b0e5197f2dc8169e3aa976b16be04ac";
const EURC_BRIDGE_CODE_HASH = "0x60f7913b884fdb041998af6e2c401eb65984464164317e8a9b6e3c66c3eeaa32";
const EURS_BRIDGE_CODE_HASH = "0xa108d72cb40f3776ca20ded14055f96efcaeaf645d41a10fb90d48ec285e6b60";
const DEURO_CODE_HASH = "0x0459afd840c25376c3c5991883bc81af8642bc044b4b4563b014e20f5a53b9cc";
const EURS_CODE_HASH = "0x8dddfd3c077268d84f636f0f57baf71053dabedc11a1c98cd4b49b6205f99aa8";
const EURS_DELEGATE_CODE_HASH = "0x932e0d74598f20e7e0372c207540ee26f2d16a164e2248436547829cc3925401";
const EURS_FROZEN_SLOT = "0x5";
const EURS_DELEGATE_SLOT = "0xc";
const EURS_BLACK_LIST_FLAG = 1n;
const MIN_EXIT_DEURO = 1_000n * 10n ** 18n;
const EURS_FEE_PROBE_RAW = 100_000n;
const ABI = parseAbi([
  "function eur() view returns (address)",
  "function dEURO() view returns (address)",
  "function minted() view returns (uint256)",
  "function isMinter(address) view returns (bool)",
  "function paused() view returns (bool)",
  "function isBlacklisted(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function flags(address) view returns (uint256)",
  "function calculateFee(uint256) view returns (uint256)",
]);
const WORD = /^0x[0-9a-fA-F]{64}$/;
const addressWord = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const isEvenHex = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) && value.length % 2 === 0;
const isWord = (value: unknown): value is `0x${string}` => typeof value === "string" && WORD.test(value);

interface PinnedHead {
  number: string;
  hash: string;
  observedAt: number;
}

async function confirmCanonicalHead(
  head: PinnedHead,
  options: { signal?: AbortSignal; extraRpcUrls: string[]; chainRpcs: LivePriceContext["chainRpcs"]; maxRetries: number },
): Promise<boolean> {
  const closing = (await fetchEvmRpcBatch("ethereum", [
    { method: "eth_getBlockByNumber", params: [head.number, false] },
  ], options))?.[0] as { hash?: string } | undefined;
  throwIfAborted(options.signal);
  return closing?.hash === head.hash;
}

async function evaluateEurcBridgeLane(
  parent: TrustedOverrideParent,
  head: PinnedHead,
  options: { signal?: AbortSignal; extraRpcUrls: string[]; chainRpcs: LivePriceContext["chainRpcs"]; maxRetries: number },
  reject: (lane: string, reason: string) => null,
): Promise<CurrentPriceOverride | null> {
  const lane = "deuro-eurc-bridge";
  const block = { blockHash: head.hash, requireCanonical: true };
  const call = (to: string, data: string): EvmRpcBatchCall => ({ method: "eth_call", params: [{ to, data }, block] });
  const results = await fetchEvmRpcBatch("ethereum", [
    { method: "eth_getCode", params: [EURC_BRIDGE, block] },
    { method: "eth_getCode", params: [DEURO, block] },
    call(EURC_BRIDGE, encodeFunctionData({ abi: ABI, functionName: "eur" })),
    call(EURC_BRIDGE, encodeFunctionData({ abi: ABI, functionName: "dEURO" })),
    call(EURC_BRIDGE, encodeFunctionData({ abi: ABI, functionName: "minted" })),
    call(DEURO, encodeFunctionData({ abi: ABI, functionName: "isMinter", args: [EURC_BRIDGE] })),
    call(EURC, encodeFunctionData({ abi: ABI, functionName: "balanceOf", args: [EURC_BRIDGE] })),
    call(EURC, encodeFunctionData({ abi: ABI, functionName: "decimals" })),
    call(EURC, encodeFunctionData({ abi: ABI, functionName: "paused" })),
    call(EURC, encodeFunctionData({ abi: ABI, functionName: "isBlacklisted", args: [EURC_BRIDGE] })),
  ], options);
  throwIfAborted(options.signal);
  if (!results) return reject(lane, "state-unavailable");
  if (results.length !== 10) return reject(lane, "state-invalid");
  const [bridgeCode, tokenCode, ...words] = results;
  if (!isEvenHex(bridgeCode) || !isEvenHex(tokenCode) ||
      keccak256(bridgeCode) !== EURC_BRIDGE_CODE_HASH ||
      keccak256(tokenCode) !== DEURO_CODE_HASH ||
      !words.every(isWord)) return reject(lane, "state-invalid-or-code-mismatch");
  const [eur, deuro, mintedHex, minterHex, balanceHex, decimalsHex, pausedHex, blacklistedHex] = words;
  if (eur.toLowerCase() !== addressWord(EURC) || deuro.toLowerCase() !== addressWord(DEURO) ||
      BigInt(minterHex) !== 1n || BigInt(decimalsHex) !== 6n || BigInt(pausedHex) !== 0n ||
      BigInt(blacklistedHex) !== 0n) return reject(lane, "identity-or-redemption-disabled");
  const minted = BigInt(mintedHex);
  const balance = BigInt(balanceHex);
  // Deployed immutable burn ignores the mint horizon, but requires minter permission,
  // allowance and minted capacity. Require 1,000 EUR exit depth and full bridge coverage.
  if (minted < MIN_EXIT_DEURO || balance * 10n ** 12n < minted) return reject(lane, "capacity-insufficient");
  if (!(await confirmCanonicalHead(head, options))) return reject(lane, "canonical-check-failed");
  const override = buildParentDerivedLiveOverride(parent, 1);
  if (!override) return null;
  return { ...override, observedAt: Math.min(head.observedAt, parent.trustedParent.observedAt) };
}

async function evaluateEursBridgeLane(
  parent: TrustedOverrideParent,
  head: PinnedHead,
  options: { signal?: AbortSignal; extraRpcUrls: string[]; chainRpcs: LivePriceContext["chainRpcs"]; maxRetries: number },
  reject: (lane: string, reason: string) => null,
): Promise<CurrentPriceOverride | null> {
  const lane = "deuro-eurs-bridge";
  const block = { blockHash: head.hash, requireCanonical: true };
  const call = (to: string, data: string): EvmRpcBatchCall => ({ method: "eth_call", params: [{ to, data }, block] });
  // StablecoinBridge._burn is fee-less (18 -> 2 decimal truncation via 10^16);
  // EURSToken has no paused()/isBlacklisted(), so pin its active zero-fee delegate,
  // frozen slot, address flags and calculateFee(1000 EURS) == 0 alongside bridge coverage.
  const results = await fetchEvmRpcBatch("ethereum", [
    { method: "eth_getCode", params: [EURS_BRIDGE, block] },
    { method: "eth_getCode", params: [DEURO, block] },
    { method: "eth_getCode", params: [EURS, block] },
    { method: "eth_getCode", params: [EURS_DELEGATE, block] },
    { method: "eth_getStorageAt", params: [EURS, EURS_DELEGATE_SLOT, block] },
    { method: "eth_getStorageAt", params: [EURS, EURS_FROZEN_SLOT, block] },
    call(EURS_BRIDGE, encodeFunctionData({ abi: ABI, functionName: "eur" })),
    call(EURS_BRIDGE, encodeFunctionData({ abi: ABI, functionName: "dEURO" })),
    call(EURS_BRIDGE, encodeFunctionData({ abi: ABI, functionName: "minted" })),
    call(DEURO, encodeFunctionData({ abi: ABI, functionName: "isMinter", args: [EURS_BRIDGE] })),
    call(EURS, encodeFunctionData({ abi: ABI, functionName: "balanceOf", args: [EURS_BRIDGE] })),
    call(EURS, encodeFunctionData({ abi: ABI, functionName: "decimals" })),
    call(EURS, encodeFunctionData({ abi: ABI, functionName: "flags", args: [EURS_BRIDGE] })),
    call(EURS, encodeFunctionData({ abi: ABI, functionName: "calculateFee", args: [EURS_FEE_PROBE_RAW] })),
  ], options);
  throwIfAborted(options.signal);
  if (!results) return reject(lane, "state-unavailable");
  if (results.length !== 14) return reject(lane, "state-invalid");
  const [bridgeCode, tokenCode, eursCode, delegateCode, ...words] = results;
  if (!isEvenHex(bridgeCode) || !isEvenHex(tokenCode) || !isEvenHex(eursCode) || !isEvenHex(delegateCode) ||
      keccak256(bridgeCode) !== EURS_BRIDGE_CODE_HASH ||
      keccak256(tokenCode) !== DEURO_CODE_HASH ||
      keccak256(eursCode) !== EURS_CODE_HASH ||
      keccak256(delegateCode) !== EURS_DELEGATE_CODE_HASH ||
      !words.every(isWord)) return reject(lane, "state-invalid-or-code-mismatch");
  const [delegateSlotHex, frozenSlotHex, eur, deuro, mintedHex, minterHex, balanceHex, decimalsHex, flagsHex, feeHex] = words;
  if (delegateSlotHex.toLowerCase() !== addressWord(EURS_DELEGATE) ||
      BigInt(frozenSlotHex) !== 0n ||
      eur.toLowerCase() !== addressWord(EURS) || deuro.toLowerCase() !== addressWord(DEURO) ||
      BigInt(minterHex) !== 1n || BigInt(decimalsHex) !== 2n ||
      (BigInt(flagsHex) & EURS_BLACK_LIST_FLAG) !== 0n ||
      BigInt(feeHex) !== 0n) return reject(lane, "identity-or-redemption-disabled");
  const minted = BigInt(mintedHex);
  const balance = BigInt(balanceHex);
  if (minted < MIN_EXIT_DEURO || balance * 10n ** 16n < minted) return reject(lane, "capacity-insufficient");
  if (!(await confirmCanonicalHead(head, options))) return reject(lane, "canonical-check-failed");
  const price = parent.trustedParent.price;
  const parentClockSelected = parent.trustedParent.observedAt <= head.observedAt;
  const observedAt = parentClockSelected ? parent.trustedParent.observedAt : head.observedAt;
  const observedAtMode = parentClockSelected ? (parent.trustedParent.observedAtMode ?? "upstream") : "upstream";
  const maxAgeSec = getPricingSourceRegistryEntry(PROTOCOL_REDEEM_SOURCE)?.maxTrustedAgeSec;
  if (maxAgeSec == null || Math.floor(Date.now() / 1000) - observedAt > maxAgeSec) return reject(lane, "dependency-age");
  // Explicit source + fallback confidence prevents a single-source CoinGecko parent's
  // label from carrying over while keeping a thin-surplus lane non-replay-safe and non-authoritative.
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

export async function fetchDeuroEurcBridgePrice(context: LivePriceContext, signal?: AbortSignal) {
  const reject = (lane: string, reason: string): null => {
    context.lastRejectionReason = `${lane}:${reason}`;
    return null;
  };
  const eurcParent = resolveTrustedOverrideParent(context, "eurc-circle", () =>
    "[authoritative-price-sources] deuro-deuro: trusted EURC dependency unavailable", {
    allowFreshNonReplaySafeParent: true,
  });
  const eurcUntrustedParent = context.lastUntrustedParent ?? null;
  context.lastUntrustedParent = null;
  const eursParent = resolveTrustedOverrideParent(context, "eurs-stasis", () =>
    "[authoritative-price-sources] deuro-deuro: trusted EURS dependency unavailable", {
    allowFreshNonReplaySafeParent: true,
    allowFreshReplaySafeSingleSourceParent: true,
  });
  const eursUntrustedParent = context.lastUntrustedParent ?? null;
  if (!eurcParent && !eursParent) {
    context.lastUntrustedParent = eurcUntrustedParent ?? eursUntrustedParent;
    return null;
  }
  context.lastUntrustedParent = null;

  const headLane = eurcParent ? "deuro-eurc-bridge" : "deuro-eurs-bridge";
  const options = { signal, extraRpcUrls: getPublicFallbackRpcUrls("ethereum"), chainRpcs: context.chainRpcs, maxRetries: 0 };
  const head = (await fetchEvmRpcBatch("ethereum", [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
  ], options))?.[0] as { number?: string; hash?: string; timestamp?: string } | undefined;
  throwIfAborted(signal);
  if (!head) return reject(headLane, "head-unavailable");
  if (!/^0x[0-9a-f]+$/i.test(head.number ?? "") || !WORD.test(head.hash ?? "") ||
      !/^0x[0-9a-f]+$/i.test(head.timestamp ?? "")) return reject(headLane, "head-invalid");
  const blockNumber = Number(BigInt(head.number!));
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0 || BigInt(head.hash!) === 0n) return reject(headLane, "head-invalid");
  const observedAt = Number(BigInt(head.timestamp!));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > now + 60 || now - observedAt > 300) {
    return reject(headLane, "head-stale-or-invalid");
  }
  const pinnedHead: PinnedHead = { number: head.number!, hash: head.hash!, observedAt };

  if (eurcParent) {
    const eurcResult = await evaluateEurcBridgeLane(eurcParent, pinnedHead, options, reject);
    if (eurcResult) return eurcResult;
  }
  if (eursParent) {
    const eursResult = await evaluateEursBridgeLane(eursParent, pinnedHead, options, reject);
    if (eursResult) context.lastRejectionReason = null;
    return eursResult;
  }
  return null;
}

export const deuroEurcBridgeProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.PROTOCOL_REDEEM,
  liveTimeoutMs: 6_000,
  liveParentByAssetId: { "deuro-deuro": "eurc-circle" },
  matches: (id) => id === "deuro-deuro",
  fetchLivePrice: (asset, context, signal) =>
    hasPublishableCurrentPrice(asset) ? Promise.resolve(null) : fetchDeuroEurcBridgePrice(context, signal),
};
