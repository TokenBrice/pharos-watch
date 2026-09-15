import { encodeFunctionData, erc20Abi, keccak256, parseAbi } from "viem";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmRpcBatch, type EvmRpcBatchCall } from "../evm-rpc";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  buildParentDerivedLiveOverride,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const BRIDGE = "0xb4ff7412f08c22d7381885e8bda9ee9825092fd1";
const DEURO = "0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea";
const EURC = "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c";
const BRIDGE_CODE_HASH = "0x60f7913b884fdb041998af6e2c401eb65984464164317e8a9b6e3c66c3eeaa32";
const DEURO_CODE_HASH = "0x0459afd840c25376c3c5991883bc81af8642bc044b4b4563b014e20f5a53b9cc";
const ABI = parseAbi([
  "function eur() view returns (address)",
  "function dEURO() view returns (address)",
  "function minted() view returns (uint256)",
  "function isMinter(address) view returns (bool)",
  "function paused() view returns (bool)",
  "function isBlacklisted(address) view returns (bool)",
]);
const WORD = /^0x[0-9a-fA-F]{64}$/;
const addressWord = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;

export async function fetchDeuroEurcBridgePrice(context: LivePriceContext, signal?: AbortSignal) {
  const parent = resolveTrustedOverrideParent(context, "eurc-circle", () =>
    "[authoritative-price-sources] deuro-deuro: trusted EURC dependency unavailable", {
    allowFreshNonReplaySafeParent: true,
  });
  if (!parent) return null;
  const options = { signal, extraRpcUrls: getPublicFallbackRpcUrls("ethereum"), maxRetries: 0 };
  const head = (await fetchEvmRpcBatch("ethereum", [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
  ], options))?.[0] as { number?: string; hash?: string; timestamp?: string } | undefined;
  if (!head || !/^0x[0-9a-f]+$/i.test(head.number ?? "") || !WORD.test(head.hash ?? "") ||
      !/^0x[0-9a-f]+$/i.test(head.timestamp ?? "")) return null;
  const blockNumber = Number(BigInt(head.number!));
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0 || BigInt(head.hash!) === 0n) return null;
  const observedAt = Number(BigInt(head.timestamp!));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > now + 60 || now - observedAt > 300) return null;
  const block = { blockHash: head.hash, requireCanonical: true };
  const call = (to: string, data: string): EvmRpcBatchCall => ({ method: "eth_call", params: [{ to, data }, block] });
  const results = await fetchEvmRpcBatch("ethereum", [
    { method: "eth_getCode", params: [BRIDGE, block] },
    { method: "eth_getCode", params: [DEURO, block] },
    call(BRIDGE, encodeFunctionData({ abi: ABI, functionName: "eur" })),
    call(BRIDGE, encodeFunctionData({ abi: ABI, functionName: "dEURO" })),
    call(BRIDGE, encodeFunctionData({ abi: ABI, functionName: "minted" })),
    call(DEURO, encodeFunctionData({ abi: ABI, functionName: "isMinter", args: [BRIDGE] })),
    call(EURC, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [BRIDGE] })),
    call(EURC, encodeFunctionData({ abi: erc20Abi, functionName: "decimals" })),
    call(EURC, encodeFunctionData({ abi: ABI, functionName: "paused" })),
    call(EURC, encodeFunctionData({ abi: ABI, functionName: "isBlacklisted", args: [BRIDGE] })),
  ], options);
  if (!results || results.length !== 10) return null;
  const [bridgeCode, tokenCode, ...words] = results;
  if (typeof bridgeCode !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(bridgeCode) ||
      typeof tokenCode !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(tokenCode) ||
      keccak256(bridgeCode as `0x${string}`) !== BRIDGE_CODE_HASH ||
      keccak256(tokenCode as `0x${string}`) !== DEURO_CODE_HASH ||
      !words.every((word) => typeof word === "string" && WORD.test(word))) return null;
  const [eur, deuro, mintedHex, minterHex, balanceHex, decimalsHex, pausedHex, blacklistedHex] = words as string[];
  if (eur.toLowerCase() !== addressWord(EURC) || deuro.toLowerCase() !== addressWord(DEURO) ||
      BigInt(minterHex) !== 1n || BigInt(decimalsHex) !== 6n || BigInt(pausedHex) !== 0n ||
      BigInt(blacklistedHex) !== 0n) return null;
  const minted = BigInt(mintedHex);
  const balance = BigInt(balanceHex);
  // Deployed immutable burn ignores the mint horizon, but requires minter permission,
  // allowance and minted capacity. Require 1,000 EUR exit depth and full bridge coverage.
  if (minted < 1_000n * 10n ** 18n || balance * 10n ** 12n < minted) return null;
  const closing = (await fetchEvmRpcBatch("ethereum", [
    { method: "eth_getBlockByNumber", params: [head.number, false] },
  ], options))?.[0] as { hash?: string } | undefined;
  if (closing?.hash !== head.hash) return null;
  const override = buildParentDerivedLiveOverride(parent, 1);
  if (!override) return null;
  return { ...override, observedAt: Math.min(observedAt, parent.trustedParent.observedAt) };
}

export const deuroEurcBridgeProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.PROTOCOL_REDEEM,
  liveTimeoutMs: 6_000,
  matches: (id) => id === "deuro-deuro",
  fetchLivePrice: (_asset, context, signal) => fetchDeuroEurcBridgePrice(context, signal),
};
