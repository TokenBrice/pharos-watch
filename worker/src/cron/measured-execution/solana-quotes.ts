import { DEX_MEASURED_MAX_COST_BPS } from "@shared/types/measured-execution";
import type {
  SolanaMeasuredExecutionQuotePointProof,
  SolanaMeasuredExecutionTarget,
  SolanaMeasuredRouteProof,
} from "@shared/types/solana-measured-execution";
import { isRecord } from "@shared/lib/type-guards";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { USER_AGENT } from "../../lib/constants";
import { tryParseJson } from "../../lib/json-parse";
import { readResponseTextWithinLimitWithSignal } from "../../lib/response-body";
import { quoteRaydiumClmmSingleSegment } from "./solana-clmm-math";
import { requiresRaydiumSingleSegmentStateProof } from "./solana-registry";
import { MAX_UINT64, rawAmountToUsd, usdToRawAmount } from "./fixed-point";

const RAYDIUM_TRADE_API = "https://transaction-v1.raydium.io/compute/swap-base-in";
const JUPITER_QUOTE_API = "https://api.jup.ag/swap/v1/quote";
const SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;
const REQUEST_TIMEOUT_MS = 15_000;
const SLOT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 200_000;
export const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const RAYDIUM_POOL_DISCRIMINATOR = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46] as const;
const RAYDIUM_POOL_MIN_BYTES = 273;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type FetchLike = typeof fetch;

interface RaydiumClmmPoolState {
  slot: number;
  programId: string;
  tokenMint0: string;
  tokenMint1: string;
  liquidity: string;
  sqrtPriceX64: string;
}

function toBase58(bytes: Uint8Array): string {
  let zeroCount = 0;
  while (zeroCount < bytes.length && bytes[zeroCount] === 0) zeroCount++;
  if (zeroCount === bytes.length) return "1".repeat(zeroCount);
  const digits = [0];
  for (let index = zeroCount; index < bytes.length; index++) {
    let carry = bytes[index]!;
    for (let digitIndex = 0; digitIndex < digits.length; digitIndex++) {
      const value = digits[digitIndex]! * 256 + carry;
      digits[digitIndex] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return `${"1".repeat(zeroCount)}${digits
    .reverse()
    .map((digit) => BASE58_ALPHABET[digit]!)
    .join("")}`;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function readUnsignedLittleEndian(bytes: Uint8Array, offset: number, width: number): bigint | null {
  if (offset < 0 || width < 1 || offset + width > bytes.length) return null;
  let value = 0n;
  for (let index = width - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[offset + index]!);
  return value;
}

/** Decode only the fixed Raydium pool fields needed by the pinned replay. */
export function parseRaydiumClmmPoolState(input: {
  accountDataBase64: string;
  owner: string;
  slot: number;
}): RaydiumClmmPoolState | null {
  if (input.owner !== RAYDIUM_CLMM_PROGRAM_ID || !Number.isInteger(input.slot) || input.slot < 0) return null;
  const bytes = decodeBase64(input.accountDataBase64);
  if (!bytes || bytes.length < RAYDIUM_POOL_MIN_BYTES) return null;
  if (RAYDIUM_POOL_DISCRIMINATOR.some((value, index) => bytes[index] !== value)) return null;
  const liquidity = readUnsignedLittleEndian(bytes, 237, 16);
  const sqrtPriceX64 = readUnsignedLittleEndian(bytes, 253, 16);
  if (liquidity == null || liquidity <= 0n || sqrtPriceX64 == null || sqrtPriceX64 <= 0n) return null;
  return {
    slot: input.slot,
    programId: input.owner,
    tokenMint0: toBase58(bytes.slice(73, 105)),
    tokenMint1: toBase58(bytes.slice(105, 137)),
    liquidity: liquidity.toString(),
    sqrtPriceX64: sqrtPriceX64.toString(),
  };
}

function positiveIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function nonNegativeIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchBoundedJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const requestSignal = combineSignal(signal, REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    signal: requestSignal,
  });
  let text: string;
  try {
    text = await readResponseTextWithinLimitWithSignal(response, MAX_RESPONSE_BYTES, requestSignal);
  } catch (error) {
    if (error instanceof Error && error.name === "ResponseBodyTooLargeError") {
      throw new Error("quote-response-too-large");
    }
    throw error;
  }
  if (!response.ok) throw new Error(`quote-http-${response.status}`);
  const parsed = tryParseJson(text, { onFailure: () => undefined });
  if (parsed === null) throw new Error("quote-invalid-json");
  return parsed;
}

async function fetchRaydiumClmmPoolState(
  target: SolanaMeasuredExecutionTarget,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<RaydiumClmmPoolState> {
  for (const rpcUrl of SOLANA_RPC_URLS) {
    throwIfAborted(signal);
    let response: Response;
    try {
      const requestSignal = combineSignal(signal, SLOT_REQUEST_TIMEOUT_MS);
      response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [target.poolId, { encoding: "base64", commitment: "confirmed" }],
        }),
        signal: requestSignal,
      });
      const text = await readResponseTextWithinLimitWithSignal(response, MAX_RESPONSE_BYTES, requestSignal);
      if (!response.ok) continue;
      const body = tryParseJson(text, { onFailure: () => undefined });
      if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.context) || !isRecord(body.result.value)) {
        throw new Error("raydium-state-rpc-invalid");
      }
      const context = body.result.context;
      const value = body.result.value;
      const data = value.data;
      if (
        !integer(context.slot) ||
        typeof value.owner !== "string" ||
        !Array.isArray(data) ||
        typeof data[0] !== "string" ||
        data[1] !== "base64"
      ) {
        throw new Error("raydium-state-rpc-invalid");
      }
      const state = parseRaydiumClmmPoolState({
        accountDataBase64: data[0],
        owner: value.owner,
        slot: context.slot,
      });
      if (!state) throw new Error("raydium-state-decode-invalid");
      if (
        !(
          (state.tokenMint0 === target.tokenIn.address && state.tokenMint1 === target.tokenOut.address) ||
          (state.tokenMint1 === target.tokenIn.address && state.tokenMint0 === target.tokenOut.address)
        )
      ) {
        throw new Error("raydium-state-mint-mismatch");
      }
      return state;
    } catch (error) {
      rethrowIfAborted(error, signal);
      if (error instanceof Error && error.message.startsWith("raydium-state-")) throw error;
    }
  }
  throw new Error("raydium-state-rpc-unavailable");
}

export function parseRaydiumExactRouteProof(
  body: unknown,
  target: SolanaMeasuredExecutionTarget,
  amountInRaw: string,
): SolanaMeasuredRouteProof | null {
  if (!isRecord(body) || body.success !== true || typeof body.id !== "string" || !isRecord(body.data)) return null;
  const data = body.data;
  if (
    data.swapType !== "BaseIn" ||
    data.inputMint !== target.tokenIn.address ||
    data.outputMint !== target.tokenOut.address ||
    data.inputAmount !== amountInRaw ||
    !nonNegativeIntegerString(data.outputAmount) ||
    data.otherAmountThreshold !== data.outputAmount ||
    data.slippageBps !== 0 ||
    !Array.isArray(data.routePlan) ||
    data.routePlan.length !== 1
  )
    return null;
  const route = data.routePlan[0];
  if (
    !isRecord(route) ||
    route.poolId !== target.poolId ||
    route.inputMint !== target.tokenIn.address ||
    route.outputMint !== target.tokenOut.address ||
    !positiveIntegerString(route.lastPoolPriceX64)
  )
    return null;
  return {
    provider: "raydium-trade-api",
    responseId: body.id.slice(0, 128),
    poolId: target.poolId,
    inputMint: target.tokenIn.address,
    outputMint: target.tokenOut.address,
    inputAmount: amountInRaw,
    outputAmount: data.outputAmount,
    lastPoolPriceX64: route.lastPoolPriceX64,
    ...(nonNegativeIntegerString(route.feeAmount) ? { feeAmount: route.feeAmount } : {}),
  };
}

function bindRaydiumSingleSegmentStateProof(
  target: SolanaMeasuredExecutionTarget,
  route: Extract<SolanaMeasuredRouteProof, { provider: "raydium-trade-api" }>,
  state: RaydiumClmmPoolState,
): Extract<SolanaMeasuredRouteProof, { provider: "raydium-trade-api" }> {
  if (!route.feeAmount) throw new Error("raydium-onstate-fee-missing");
  const direction =
    state.tokenMint0 === target.tokenIn.address && state.tokenMint1 === target.tokenOut.address
      ? "zero-for-one"
      : state.tokenMint1 === target.tokenIn.address && state.tokenMint0 === target.tokenOut.address
        ? "one-for-zero"
        : null;
  if (!direction) throw new Error("raydium-state-mint-mismatch");
  const replay = quoteRaydiumClmmSingleSegment({
    liquidity: state.liquidity,
    sqrtPriceX64: state.sqrtPriceX64,
    amountIn: route.inputAmount,
    feeAmount: route.feeAmount,
    direction,
  });
  if (replay.amountOut !== route.outputAmount || replay.postSwapSqrtPriceX64 !== route.lastPoolPriceX64) {
    throw new Error("raydium-onstate-replay-mismatch");
  }
  return {
    ...route,
    stateProof: {
      slot: state.slot,
      programId: state.programId,
      tokenMint0: state.tokenMint0,
      tokenMint1: state.tokenMint1,
      liquidity: state.liquidity,
      sqrtPriceX64: state.sqrtPriceX64,
      feeAmount: route.feeAmount,
      direction,
    },
  };
}

export function parseOrcaExactRouteProof(
  body: unknown,
  target: SolanaMeasuredExecutionTarget,
  amountInRaw: string,
): SolanaMeasuredRouteProof | null {
  if (
    !isRecord(body) ||
    body.inputMint !== target.tokenIn.address ||
    body.outputMint !== target.tokenOut.address ||
    body.inAmount !== amountInRaw ||
    !nonNegativeIntegerString(body.outAmount) ||
    body.swapMode !== "ExactIn" ||
    body.slippageBps !== 0 ||
    body.otherAmountThreshold !== body.outAmount ||
    !integer(body.contextSlot) ||
    !Array.isArray(body.routePlan) ||
    body.routePlan.length !== 1
  )
    return null;
  const route = body.routePlan[0];
  if (!isRecord(route) || route.percent !== 100 || !isRecord(route.swapInfo)) return null;
  const swapInfo = route.swapInfo;
  if (
    swapInfo.ammKey !== target.poolId ||
    swapInfo.label !== "Whirlpool" ||
    swapInfo.inputMint !== target.tokenIn.address ||
    swapInfo.outputMint !== target.tokenOut.address ||
    swapInfo.inAmount !== amountInRaw ||
    swapInfo.outAmount !== body.outAmount
  )
    return null;
  return {
    provider: "jupiter-swap-api",
    label: "Whirlpool",
    poolId: target.poolId,
    inputMint: target.tokenIn.address,
    outputMint: target.tokenOut.address,
    inputAmount: amountInRaw,
    outputAmount: body.outAmount,
    contextSlot: body.contextSlot,
  };
}

export function buildSolanaMeasuredQuotePoint(
  target: SolanaMeasuredExecutionTarget,
  route: SolanaMeasuredRouteProof,
): SolanaMeasuredExecutionQuotePointProof | null {
  try {
    const amountIn = BigInt(route.inputAmount);
    const amountOut = BigInt(route.outputAmount);
    const inputUsd = rawAmountToUsd(amountIn, target.tokenIn.decimals, target.tokenIn.referencePriceUsd);
    const outputUsd = rawAmountToUsd(amountOut, target.tokenOut.decimals, target.tokenOut.referencePriceUsd);
    if (!Number.isFinite(inputUsd) || inputUsd <= 0 || !Number.isFinite(outputUsd) || outputUsd < 0) return null;
    const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
    return {
      amountInRaw: route.inputAmount,
      amountOutRaw: route.outputAmount,
      inputUsd,
      outputUsd,
      costBps,
      passesCostBound: costBps <= DEX_MEASURED_MAX_COST_BPS,
      route,
    };
  } catch {
    return null;
  }
}

export async function quoteSolanaMeasuredTarget(input: {
  target: SolanaMeasuredExecutionTarget;
  inputUsd: number;
  jupiterApiKey?: string | null;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<SolanaMeasuredExecutionQuotePointProof> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const amountIn = usdToRawAmount(
    input.inputUsd,
    input.target.tokenIn.decimals,
    input.target.tokenIn.referencePriceUsd,
    { maxRawAmount: MAX_UINT64 },
  );
  if (amountIn == null) throw new Error("invalid-quote-input");
  const amountInRaw = amountIn.toString();
  let route: SolanaMeasuredRouteProof | null;

  if (input.target.adapterProfileId === "raydium-clmm-trade-api-v1") {
    const state = requiresRaydiumSingleSegmentStateProof(input.target)
      ? await fetchRaydiumClmmPoolState(input.target, input.signal, fetchImpl)
      : null;
    const url = new URL(RAYDIUM_TRADE_API);
    url.searchParams.set("inputMint", input.target.tokenIn.address);
    url.searchParams.set("outputMint", input.target.tokenOut.address);
    url.searchParams.set("amount", amountInRaw);
    url.searchParams.set("slippageBps", "0");
    url.searchParams.set("txVersion", "V0");
    const body = await fetchBoundedJson(url.toString(), {}, input.signal, fetchImpl);
    route = parseRaydiumExactRouteProof(body, input.target, amountInRaw);
    if (state && route?.provider === "raydium-trade-api") {
      route = bindRaydiumSingleSegmentStateProof(input.target, route, state);
    }
  } else {
    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set("inputMint", input.target.tokenIn.address);
    url.searchParams.set("outputMint", input.target.tokenOut.address);
    url.searchParams.set("amount", amountInRaw);
    url.searchParams.set("swapMode", "ExactIn");
    url.searchParams.set("slippageBps", "0");
    url.searchParams.set("onlyDirectRoutes", "true");
    url.searchParams.set("restrictIntermediateTokens", "true");
    url.searchParams.set("dexes", "Whirlpool");
    const headers = input.jupiterApiKey?.trim() ? { "x-api-key": input.jupiterApiKey.trim() } : undefined;
    const body = await fetchBoundedJson(url.toString(), { headers }, input.signal, fetchImpl);
    route = parseOrcaExactRouteProof(body, input.target, amountInRaw);
  }
  if (!route) throw new Error("exact-route-mismatch");
  const point = buildSolanaMeasuredQuotePoint(input.target, route);
  if (!point || Math.abs(point.inputUsd - input.inputUsd) > 0.02) throw new Error("invalid-quote-output");
  return point;
}

export async function fetchSolanaCurrentSlot(
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<number | null> {
  for (const rpcUrl of SOLANA_RPC_URLS) {
    throwIfAborted(signal);
    try {
      const requestSignal = combineSignal(signal, SLOT_REQUEST_TIMEOUT_MS);
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
        signal: requestSignal,
      });
      const text = await readResponseTextWithinLimitWithSignal(response, MAX_RESPONSE_BYTES, requestSignal);
      if (!response.ok) continue;
      const body = tryParseJson(text, { onFailure: () => undefined });
      if (isRecord(body) && integer(body.result)) return body.result;
    } catch (error) {
      rethrowIfAborted(error, signal);
    }
  }
  return null;
}

const OPERATIONAL_SOLANA_MEASURED_FAILURES = new Set([
  "budget-deferred",
  "quote-request-unavailable",
  "raydium-state-rpc-unavailable",
  "runtime-deadline-exceeded",
  "slot-after-unavailable",
  "slot-before-unavailable",
  "slot-window-invalid",
]);

export function isOperationalSolanaMeasuredFailure(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (
    OPERATIONAL_SOLANA_MEASURED_FAILURES.has(reason) ||
    /^quote-http-(408|429|5[0-9]{2})$/.test(reason)
  );
}

/**
 * Only explicit transport and producer-budget failures may reuse last-known-
 * good evidence. Unknown, malformed, and deterministic quote failures stay
 * semantic so they cannot be masked by old output.
 */
export function normalizeSolanaMeasuredExecutionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isOperationalSolanaMeasuredFailure(message)) return message;
  if (error instanceof DOMException && error.name === "TimeoutError") return "runtime-deadline-exceeded";
  if (error instanceof TypeError || /fetch failed|networkerror/i.test(message)) return "quote-request-unavailable";
  return message.slice(0, 300) || "quote-failed";
}
