import { DEX_MEASURED_MAX_COST_BPS } from "@shared/types/measured-execution";
import type {
  SolanaMeasuredExecutionQuotePointProof,
  SolanaMeasuredExecutionTarget,
  SolanaMeasuredRouteProof,
} from "@shared/types/solana-measured-execution";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { USER_AGENT } from "../../lib/constants";

const RAYDIUM_TRADE_API = "https://transaction-v1.raydium.io/compute/swap-base-in";
const JUPITER_QUOTE_API = "https://api.jup.ag/swap/v1/quote";
const SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;
const REQUEST_TIMEOUT_MS = 15_000;
const SLOT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_CHARS = 200_000;

type FetchLike = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const response = await fetchImpl(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    signal: combineSignal(signal, REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`quote-http-${response.status}`);
  if (text.length > MAX_RESPONSE_CHARS) throw new Error("quote-response-too-large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("quote-invalid-json");
  }
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
    swapInfo.label !== "Orca V2" ||
    swapInfo.inputMint !== target.tokenIn.address ||
    swapInfo.outputMint !== target.tokenOut.address ||
    swapInfo.inAmount !== amountInRaw ||
    swapInfo.outAmount !== body.outAmount
  )
    return null;
  return {
    provider: "jupiter-swap-api",
    label: "Orca V2",
    poolId: target.poolId,
    inputMint: target.tokenIn.address,
    outputMint: target.tokenOut.address,
    inputAmount: amountInRaw,
    outputAmount: body.outAmount,
    contextSlot: body.contextSlot,
  };
}

function usdToRawAmount(inputUsd: number, decimals: number, referencePriceUsd: number): bigint | null {
  if (!Number.isFinite(inputUsd) || inputUsd <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return null;
  }
  if (!Number.isFinite(referencePriceUsd) || referencePriceUsd <= 0) return null;
  const usdScale = 1_000_000n;
  const priceScale = 100_000_000n;
  const usdScaled = BigInt(Math.floor(inputUsd * Number(usdScale)));
  const priceScaled = BigInt(Math.round(referencePriceUsd * Number(priceScale)));
  if (priceScaled <= 0n) return null;
  const amount = (usdScaled * 10n ** BigInt(decimals) * priceScale) / (usdScale * priceScaled);
  return amount > 0n && amount <= 18_446_744_073_709_551_615n ? amount : null;
}

function rawAmountToUsd(amount: bigint, decimals: number, referencePriceUsd: number): number {
  const priceScale = 100_000_000n;
  const usdScale = 1_000_000n;
  const priceScaled = BigInt(Math.round(referencePriceUsd * Number(priceScale)));
  const usdScaled = (amount * priceScaled * usdScale) / (10n ** BigInt(decimals) * priceScale);
  return Number(usdScaled) / Number(usdScale);
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
  );
  if (amountIn == null) throw new Error("invalid-quote-input");
  const amountInRaw = amountIn.toString();
  let route: SolanaMeasuredRouteProof | null;

  if (input.target.adapterProfileId === "raydium-clmm-trade-api-v1") {
    const url = new URL(RAYDIUM_TRADE_API);
    url.searchParams.set("inputMint", input.target.tokenIn.address);
    url.searchParams.set("outputMint", input.target.tokenOut.address);
    url.searchParams.set("amount", amountInRaw);
    url.searchParams.set("slippageBps", "0");
    url.searchParams.set("txVersion", "V0");
    const body = await fetchBoundedJson(url.toString(), {}, input.signal, fetchImpl);
    route = parseRaydiumExactRouteProof(body, input.target, amountInRaw);
  } else {
    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set("inputMint", input.target.tokenIn.address);
    url.searchParams.set("outputMint", input.target.tokenOut.address);
    url.searchParams.set("amount", amountInRaw);
    url.searchParams.set("swapMode", "ExactIn");
    url.searchParams.set("slippageBps", "0");
    url.searchParams.set("onlyDirectRoutes", "true");
    url.searchParams.set("restrictIntermediateTokens", "true");
    url.searchParams.set("dexes", "Orca V2");
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
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
        signal: combineSignal(signal, SLOT_REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok || text.length > MAX_RESPONSE_CHARS) continue;
      const body = JSON.parse(text) as unknown;
      if (isRecord(body) && integer(body.result)) return body.result;
    } catch (error) {
      rethrowIfAborted(error, signal);
    }
  }
  return null;
}
