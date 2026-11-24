import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters } from "viem/utils";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { chainlinkNavMaxOracleAgeSec } from "../../cron/reserve-adapters/chainlink-nav-freshness";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { throwIfAborted } from "../abort";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmRpcBatch, type EvmRpcBatchCall } from "../evm-rpc";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  decimalFromRaw,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const RWAUSDI_ID = "rwausdi-multipli";
const CHAINLINK_NAV_SOURCE = "chainlink-nav";
const MONAD_CHAIN = "monad";
// Official Multipli rwaUSDi Chainlink NAV feed on Monad
// (https://docs.multipli.fi/rwausd/chainlink-data-feed,
// https://data.chain.link/feeds/monad/monad/rwausdi-nav), verified at Monad
// block 125030199 on 2026-11-24.
const PROXY = "0xf72885b0c01fbc1e4db78187507576298ef7f6b9";
const AGGREGATOR = "0x45309f5786d09241ee4649e0753062415cfe16cc";
const REVIEWED_CODE_HASHES = [
  [PROXY, "0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2"],
  [AGGREGATOR, "0x6c356f0b498f2e868c80c5ca1158faa7df8402400ca0d7af4e7399aa471e046e"],
] as const;
const EXPECTED_DESCRIPTION = "rwaUSDi NAV";
const EXPECTED_DECIMALS = 18;
const MAX_BLOCK_AGE_SEC = 5 * 60;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x[0-9a-fA-F]+$/;

const ABI = parseAbi([
  "function aggregator() view returns (address)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const ADDR = parseAbiParameters("address");
const UINT = parseAbiParameters("uint256");
const STR = parseAbiParameters("string");
const ROUND = parseAbiParameters("uint80,int256,uint256,uint256,uint80");

/**
 * Direct on-chain Chainlink NAV reader for Multipli `rwausdi-multipli`.
 *
 * `rwausdi-multipli` retains its AFI proof-of-reserves adapter for reserve
 * composition, so its Chainlink NAV oracle does not flow through the
 * `chainlink-nav` reserve adapter. This missing-only route reads the pinned
 * Monad Chainlink proxy/aggregator at one canonical block with closing-header
 * verification, stamps Chainlink's own upstream `updatedAt` under the shared
 * daily-heartbeat Chainlink NAV age ceiling (`chainlinkNavMaxOracleAgeSec`),
 * and publishes `single-source` `chainlink-nav` provenance (replay-safe,
 * `confirm_required` for depeg authority).
 */
async function fetchRwausdiChainlinkNavPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => {
    context.lastRejectionReason = `rwausdi-chainlink-nav:${reason}`;
    return null;
  };
  const options = {
    signal,
    extraRpcUrls: getPublicFallbackRpcUrls(MONAD_CHAIN),
    chainRpcs: context.chainRpcs,
    maxRetries: 0,
  };
  const head = (await fetchEvmRpcBatch(MONAD_CHAIN, [
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

  const tag = head.number!;
  const call = (data: string): EvmRpcBatchCall => ({ method: "eth_call", params: [{ to: PROXY, data }, tag] });
  const batch: EvmRpcBatchCall[] = [
    ...REVIEWED_CODE_HASHES.map(([address]): EvmRpcBatchCall => ({ method: "eth_getCode", params: [address, tag] })),
    call(encodeFunctionData({ abi: ABI, functionName: "aggregator" })),
    call(encodeFunctionData({ abi: ABI, functionName: "decimals" })),
    call(encodeFunctionData({ abi: ABI, functionName: "description" })),
    call(encodeFunctionData({ abi: ABI, functionName: "latestRoundData" })),
  ];
  const results = await fetchEvmRpcBatch(MONAD_CHAIN, batch, options);
  throwIfAborted(signal);
  if (!results) return reject("state-unavailable");
  if (results.length !== batch.length) return reject("state-invalid");

  const [proxyCode, aggregatorCode, aggregatorHex, decimalsHex, descriptionHex, roundHex] = results;
  if (
    typeof proxyCode !== "string" || proxyCode.length % 2 !== 0 || !HEX_BYTES.test(proxyCode) ||
    typeof aggregatorCode !== "string" || aggregatorCode.length % 2 !== 0 || !HEX_BYTES.test(aggregatorCode) ||
    keccak256(proxyCode as `0x${string}`) !== REVIEWED_CODE_HASHES[0][1] ||
    keccak256(aggregatorCode as `0x${string}`) !== REVIEWED_CODE_HASHES[1][1]
  ) return reject("runtime-code");
  if (
    typeof aggregatorHex !== "string" || !WORD.test(aggregatorHex) ||
    typeof decimalsHex !== "string" || !WORD.test(decimalsHex) ||
    typeof descriptionHex !== "string" || !HEX_BYTES.test(descriptionHex) || descriptionHex.length < 130 ||
    typeof roundHex !== "string" || !HEX_BYTES.test(roundHex) || roundHex.length < 322
  ) return reject("state-invalid");

  let aggregator: string, decimals: bigint, description: string;
  let roundId: bigint, answer: bigint, updatedAtRaw: bigint, answeredInRound: bigint;
  try {
    aggregator = decodeAbiParameters(ADDR, aggregatorHex as `0x${string}`)[0].toLowerCase();
    decimals = decodeAbiParameters(UINT, decimalsHex as `0x${string}`)[0];
    description = decodeAbiParameters(STR, descriptionHex as `0x${string}`)[0];
    [roundId, answer, , updatedAtRaw, answeredInRound] = decodeAbiParameters(ROUND, roundHex as `0x${string}`);
  } catch {
    return reject("state-malformed");
  }

  if (aggregator !== AGGREGATOR || decimals !== BigInt(EXPECTED_DECIMALS) || description !== EXPECTED_DESCRIPTION) {
    return reject("identity");
  }
  if (roundId <= 0n || answeredInRound < roundId || answer <= 0n || updatedAtRaw <= 0n) {
    return reject("round-invalid");
  }
  const updatedAt = Number(updatedAtRaw);
  const maxOracleAgeSec = chainlinkNavMaxOracleAgeSec({});
  const checkNowSec = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) return reject("round-invalid");
  if (updatedAt > checkNowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC) return reject("oracle-future");
  if (checkNowSec - updatedAt > maxOracleAgeSec) return reject("oracle-stale");

  const closing = (await fetchEvmRpcBatch(MONAD_CHAIN, [
    { method: "eth_getBlockByNumber", params: [tag, false] },
  ], options))?.[0] as { hash?: string } | undefined;
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) return reject("canonical-check");

  const price = decimalFromRaw(answer, EXPECTED_DECIMALS);
  if (!Number.isFinite(price) || price <= 0) return reject("price-invalid");

  return {
    price,
    source: CHAINLINK_NAV_SOURCE,
    confidence: "single-source",
    observedAt: updatedAt,
    observedAtMode: "upstream",
  };
}

export const rwausdiChainlinkNavProvider: PriceSourceProvider = {
  source: CHAINLINK_NAV_SOURCE,
  liveMissingOnly: true,
  liveCircuitSource: CIRCUIT_SOURCE.RWAUSDI_CHAINLINK_NAV,
  livePriority: 1,
  liveTimeoutMs: 6_000,
  matches: (stablecoinId: string) => stablecoinId === RWAUSDI_ID,
  async fetchLivePrice(asset: PeggedAsset, context: LivePriceContext, signal?: AbortSignal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchRwausdiChainlinkNavPrice(context, signal);
  },
};
