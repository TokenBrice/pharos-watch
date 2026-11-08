import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { canonicalExitRouteChain } from "@shared/types/exit-route-identity";
import { decodeAbiParameters, encodeFunctionData, parseAbi } from "viem/utils";
import { rethrowIfAborted } from "../../lib/abort";
import { fetchEvmCodeAtBlock, fetchEvmRpcBatch } from "../../lib/evm-rpc";
import type { EvmRpcOptions } from "../../lib/evm-rpc";
import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import { runPinnedBlockCapture } from "./evm-capture-helpers";
import type { TrackedStablecoinMaps } from "./orchestrator-phases/lookups";
import type { SourcePoolGraph } from "./types";

const DEX = "0xdec0000000000000000000000000000000000000";
const PATH = "0x20c0000000000000000000000000000000000000";
const OUSD = "0x20c0000000000000000000006a37da5c996874be";
const USDT = "0x20c00000000000000000000014f22ca97301eb73";
const BOOK = "0x0e97fc372f446f247f99ba27614fb2ec87a502a765dedf7e20890909189eed2f";
const USDT_BOOK = "0xf9ae4b57f259c7f292ee1e6d6452621d169e4323ddf7550d6177213b91d6c3f0";
const ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function quoteToken() view returns (address)",
  "function books(bytes32) view returns (address,address,int16,int16)",
  "function quoteSwapExactAmountIn(address,address,uint128) view returns (uint128)",
  "function quoteSwapExactAmountOut(address,address,uint128) view returns (uint128)",
]);
type TempoPriceResult = { status: "unavailable"; reason: string } | {
  status: "observed"; priceUsd: number; supportUsd: number; observedAt: number; blockNumber: number;
};

/** Native quotes price one retained book; tested route notional is price support, never pool TVL. */
export async function refreshTempoPathUsdPrice(input: {
  sourcePools: ReadonlyMap<string, SourcePoolGraph>;
  stablecoinPriceById: ReadonlyMap<string, number>;
  stablecoinPriceProvenanceById: TrackedStablecoinMaps["stablecoinPriceProvenanceById"];
  chainRpcs?: EvmRpcOptions["chainRpcs"];
  nowSec: number;
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<TempoPriceResult> {
  const pool = input.sourcePools.get("pathusd-bridge")?.pools.find((row) =>
    canonicalExitRouteChain(row.chain) === "tempo" && row.project === "tempo" && row.poolId === `tempo:${BOOK}`);
  if (!pool || !Number.isFinite(pool.tvlUsd) || pool.tvlUsd < DEX_PRICE_OBSERVATION_MIN_TVL_USD) {
    return { status: "unavailable", reason: "retained-book-unavailable" } as const;
  }
  const quoteUsd = input.stablecoinPriceById.get("usdt-tether");
  const provenance = input.stablecoinPriceProvenanceById.get("usdt-tether");
  const quoteClock = provenance?.referencePriceObservedAt;
  if (!quoteUsd || !Number.isFinite(quoteUsd) || quoteUsd <= 0 || !provenance?.referencePriceSourceId ||
      !Number.isSafeInteger(quoteClock) || quoteClock! <= 0 || quoteClock! > input.nowSec ||
      input.nowSec - quoteClock! > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) {
    return { status: "unavailable", reason: "quote-unavailable" } as const;
  }
  for (const [id, address] of [["pathusd-bridge", PATH], ["ousd-open-standard", OUSD], ["usdt-tether", USDT]] as const) {
    if (!WORKER_TRACKED_META_BY_ID.get(id)?.contracts?.some((row) =>
      row.chain === "tempo" && row.address.toLowerCase() === address && row.decimals === 6)) {
      return { status: "unavailable", reason: "token-identity-mismatch" } as const;
    }
  }
  const rawNotional = Math.ceil(DEX_PRICE_OBSERVATION_MIN_TVL_USD / quoteUsd * 1e6);
  if (!Number.isSafeInteger(rawNotional) || rawNotional <= 0) {
    return { status: "unavailable", reason: "quote-unavailable" } as const;
  }
  const amount = BigInt(rawNotional);
  let result: TempoPriceResult = { status: "unavailable", reason: "capture-unavailable" };
  try {
    await runPinnedBlockCapture<Extract<TempoPriceResult, { status: "observed" }>>({
      chain: "tempo",
      nowSec: input.nowSec,
      maxAgeSec: DEX_FRESHNESS_SEC,
      rpcOptions: { chainRpcs: input.chainRpcs, signal: input.signal, maxRetries: 0,
        timeoutMs: 4_000, maxResponseBytes: 32_768,
        deadlineMs: Math.min(input.deadlineMs ?? Infinity, Date.now() + 20_000) },
      verifyDeployment: async ({ blockNumber, header, rpcOptions }) => ({
        // Native Tempo precompiles expose the reviewed 0xef marker, not EVM bytecode.
        ok: header.timestamp <= Math.floor(Date.now() / 1000) &&
          await fetchEvmCodeAtBlock("tempo", DEX, blockNumber, rpcOptions) === "0xef",
      }),
      buildCalls: async ({ blockNumber, header, rpcOptions }) => {
        const block = `0x${blockNumber.toString(16)}`;
        const metadata = await fetchEvmRpcBatch("tempo", [
          ...[PATH, OUSD, USDT].map((to) => ({ method: "eth_call", params: [
            { to, data: encodeFunctionData({ abi: ABI, functionName: "decimals" }) }, block] })),
          ...[OUSD, USDT].map((to) => ({ method: "eth_call", params: [
            { to, data: encodeFunctionData({ abi: ABI, functionName: "quoteToken" }) }, block] })),
          ...([BOOK, USDT_BOOK] as const).map((key) => ({ method: "eth_call", params: [
            { to: DEX, data: encodeFunctionData({ abi: ABI, functionName: "books", args: [key] }) }, block] })),
        ], rpcOptions);
        if (!metadata || metadata.length !== 7 || metadata.some((row, index) =>
          typeof row !== "string" || !(index < 5 ? /^0x[0-9a-f]{64}$/i : /^0x[0-9a-f]{256}$/i).test(row))) {
          return { ok: false };
        }
        const words = metadata as `0x${string}`[];
        if (words.slice(0, 3).some((row) => decodeAbiParameters([{ type: "uint8" }], row)[0] !== 6) ||
            decodeAbiParameters([{ type: "address" }], words[3]!)[0].toLowerCase() !== PATH ||
            decodeAbiParameters([{ type: "address" }], words[4]!)[0].toLowerCase() !== OUSD) return { ok: false };
        for (const [index, base, quote] of [[5, OUSD, PATH], [6, USDT, OUSD]] as const) {
          const [actualBase, actualQuote, bid, ask] = decodeAbiParameters(
            [{ type: "address" }, { type: "address" }, { type: "int16" }, { type: "int16" }], words[index]!);
          if (actualBase.toLowerCase() !== base || actualQuote.toLowerCase() !== quote || bid >= ask ||
              [bid, ask].some((tick) => Math.abs(tick) > 2000 || tick % 10 !== 0)) return { ok: false };
        }
        // Both directions must demonstrate the floor at this state; singleton custody proves no route depth.
        const quotes = await fetchEvmRpcBatch("tempo", [
          { method: "eth_call", params: [{ to: DEX, data: encodeFunctionData({ abi: ABI,
            functionName: "quoteSwapExactAmountOut", args: [PATH, USDT, amount] }) }, block] },
          { method: "eth_call", params: [{ to: DEX, data: encodeFunctionData({ abi: ABI,
            functionName: "quoteSwapExactAmountIn", args: [USDT, PATH, amount] }) }, block] },
        ], rpcOptions);
        if (!quotes || quotes.length !== 2 || quotes.some((row) =>
          typeof row !== "string" || !/^0x[0-9a-f]{64}$/i.test(row))) return { ok: false };
        const [sellInput, buyOutput] = (quotes as `0x${string}`[]).map((row) =>
          Number(decodeAbiParameters([{ type: "uint128" }], row)[0]));
        if (![sellInput, buyOutput].every((value) => Number.isFinite(value) && value! > 0) ||
            sellInput! < buyOutput!) return { ok: false };
        const priceUsd = (rawNotional / sellInput! + rawNotional / buyOutput!) / 2 * quoteUsd;
        const supportUsd = Math.min(pool.tvlUsd, rawNotional / 1e6 * quoteUsd);
        if (!Number.isFinite(priceUsd) || priceUsd <= 0 || supportUsd < DEX_PRICE_OBSERVATION_MIN_TVL_USD) return { ok: false };
        return { ok: true, value: { status: "observed" as const, priceUsd, supportUsd,
          observedAt: Math.min(header.timestamp, quoteClock!), blockNumber } };
      },
      onResults: (value) => {
        Object.assign(pool, { price: value.priceUsd, priceObservedAt: value.observedAt,
          priceSource: "direct_api", priceEvidenceTvlUsd: value.supportUsd });
        result = value;
      },
      onFailure: () => { result = { status: "unavailable", reason: "capture-unavailable" }; },
    });
  } catch (error) {
    rethrowIfAborted(error, input.signal);
  }
  return result;
}
