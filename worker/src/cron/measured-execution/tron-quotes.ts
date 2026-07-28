import {
  DEX_MEASURED_MAX_COST_BPS,
} from "@shared/types/measured-execution";
import {
  TRON_MEASURED_MAX_BLOCK_WINDOW,
  quoteSunSwapV2ConstantProduct,
  type TronMeasuredExecutionQuotePointProof,
  type TronMeasuredExecutionTarget,
} from "@shared/types/tron-measured-execution";
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from "viem/utils";
import { rethrowIfAborted, sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { USER_AGENT } from "../../lib/constants";
import { tryParseJson } from "../../lib/json-parse";
import { readResponseTextWithinLimitWithSignal } from "../../lib/response-body";
import { tronBase58ToHex, tronHexAddressToBase58 } from "../../lib/tron-address";
import { rawAmountToUsd, usdToRawAmount } from "./fixed-point";
import { SUNSWAP_V2_ROUTER_QUOTE_URL } from "./tron-registry";

const TRONGRID_JSON_RPC = "https://api.trongrid.io/jsonrpc";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const SUN_ROUTER_REQUEST_SPACING_MS = 1_000;
const GET_PAIR_SELECTOR = "0xe6a43905";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";
const GET_RESERVES_SELECTOR = "0x0902f1ac";
const SUNSWAP_V2_ROUTER_ABI = parseAbi([
  "function factory() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);

type FetchLike = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function combineSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchBoundedJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const requestSignal = combineSignal(signal);
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
      throw new Error("response-too-large");
    }
    throw error;
  }
  if (!response.ok) throw new Error(`http-${response.status}`);
  const parsed = tryParseJson(text, { onFailure: () => undefined });
  if (parsed === null) throw new Error("invalid-json");
  return parsed;
}

async function tronRpc(
  method: string,
  params: unknown[],
  input: {
    signal?: AbortSignal;
    trongridApiKey?: string | null;
    fetchImpl: FetchLike;
  },
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.trongridApiKey?.trim()) headers["TRON-PRO-API-KEY"] = input.trongridApiKey.trim();
  const body = await fetchBoundedJson(
    TRONGRID_JSON_RPC,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    input.signal,
    input.fetchImpl,
  );
  if (!isRecord(body) || body.error != null || body.result == null) throw new Error(`tron-rpc-${method}-failed`);
  return body.result;
}

function parseHexResult(value: unknown): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() as `0x${string}` : null;
}

async function fetchBlockNumber(input: {
  signal?: AbortSignal;
  trongridApiKey?: string | null;
  fetchImpl: FetchLike;
}): Promise<number> {
  const result = parseHexResult(await tronRpc("eth_blockNumber", [], input));
  if (!result) throw new Error("tron-block-number-invalid");
  const parsed = Number.parseInt(result.slice(2), 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("tron-block-number-invalid");
  return parsed;
}

function encodeAddressWord(address: string): string {
  return address.slice(2).padStart(64, "0");
}

async function decodeTronAddressWord(value: unknown): Promise<string | null> {
  const hex = parseHexResult(value);
  if (!hex || hex.length < 66) return null;
  const addressHex = `0x${hex.slice(-40)}`;
  if (/^0x0{40}$/.test(addressHex)) return null;
  return tronHexAddressToBase58(addressHex);
}

function decodeReserves(value: unknown): { reserve0: bigint; reserve1: bigint } | null {
  const hex = parseHexResult(value);
  if (!hex || hex.length < 2 + 64 * 3) return null;
  try {
    const reserve0 = BigInt(`0x${hex.slice(2, 66)}`);
    const reserve1 = BigInt(`0x${hex.slice(66, 130)}`);
    return reserve0 > 0n && reserve1 > 0n ? { reserve0, reserve1 } : null;
  } catch {
    return null;
  }
}

interface SunSwapV2Binding {
  factoryCodeHash: `0x${string}`;
  pairCodeHash: `0x${string}`;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
}

async function fetchSunSwapV2Binding(input: {
  target: TronMeasuredExecutionTarget;
  signal?: AbortSignal;
  trongridApiKey?: string | null;
  fetchImpl: FetchLike;
}): Promise<SunSwapV2Binding> {
  const [factoryHex, poolHex, tokenInHex, tokenOutHex] = await Promise.all([
    tronBase58ToHex(input.target.factoryAddress),
    tronBase58ToHex(input.target.poolId),
    tronBase58ToHex(input.target.tokenIn.address),
    tronBase58ToHex(input.target.tokenOut.address),
  ]);
  if (!factoryHex || !poolHex || !tokenInHex || !tokenOutHex) throw new Error("tron-address-invalid");
  const rpcInput = {
    signal: input.signal,
    trongridApiKey: input.trongridApiKey,
    fetchImpl: input.fetchImpl,
  };
  const factoryCode = parseHexResult(await tronRpc("eth_getCode", [factoryHex, "latest"], rpcInput));
  if (!factoryCode || factoryCode === "0x") throw new Error("factory-code-missing");
  const factoryCodeHash = keccak256(factoryCode).toLowerCase() as `0x${string}`;
  if (factoryCodeHash !== input.target.expectedFactoryCodeHash) throw new Error("factory-code-hash-mismatch");

  const pairResult = await tronRpc(
    "eth_call",
    [{ to: factoryHex, data: `${GET_PAIR_SELECTOR}${encodeAddressWord(tokenInHex)}${encodeAddressWord(tokenOutHex)}` }, "latest"],
    rpcInput,
  );
  const factoryPair = await decodeTronAddressWord(pairResult);
  if (factoryPair !== input.target.poolId) throw new Error("factory-pair-mismatch");

  const pairCode = parseHexResult(await tronRpc("eth_getCode", [poolHex, "latest"], rpcInput));
  if (!pairCode || pairCode === "0x") throw new Error("pair-code-missing");
  const pairCodeHash = keccak256(pairCode).toLowerCase() as `0x${string}`;
  if (pairCodeHash !== input.target.expectedPairCodeHash) throw new Error("pair-code-hash-mismatch");

  const token0 = await decodeTronAddressWord(await tronRpc(
    "eth_call",
    [{ to: poolHex, data: TOKEN0_SELECTOR }, "latest"],
    rpcInput,
  ));
  const token1 = await decodeTronAddressWord(await tronRpc(
    "eth_call",
    [{ to: poolHex, data: TOKEN1_SELECTOR }, "latest"],
    rpcInput,
  ));
  if (
    !token0 ||
    !token1 ||
    !(
      (token0 === input.target.tokenIn.address && token1 === input.target.tokenOut.address) ||
      (token1 === input.target.tokenIn.address && token0 === input.target.tokenOut.address)
    )
  ) throw new Error("pair-token-mismatch");
  const reserves = decodeReserves(await tronRpc(
    "eth_call",
    [{ to: poolHex, data: GET_RESERVES_SELECTOR }, "latest"],
    rpcInput,
  ));
  if (!reserves) throw new Error("pair-reserves-invalid");
  return { factoryCodeHash, pairCodeHash, token0, token1, ...reserves };
}

function decimalAmountToRaw(value: unknown, decimals: number): string | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length > 2) return null;
  const [whole, fraction = ""] = parts;
  const isDigits = (input: string) =>
    input.length > 0 && [...input].every((character) => character >= "0" && character <= "9");
  if (!isDigits(whole) || (parts.length === 2 && !isDigits(fraction))) return null;
  if (fraction.length > decimals) return null;
  try {
    const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
    return raw > 0n ? raw.toString() : null;
  } catch {
    return null;
  }
}

export function parseSunRouterDirectV2Quote(
  body: unknown,
  target: TronMeasuredExecutionTarget,
  amountInRaw: string,
): { amountOutRaw: string; routeTokens: [string, string]; poolVersions: ["v2"] } | null {
  if (!isRecord(body) || body.code !== 0 || !Array.isArray(body.data)) return null;
  const matches = body.data.flatMap((candidate) => {
    if (
      !isSunRouterDirectV2Path(candidate, target) ||
      candidate.containsUnverifiedHook !== false ||
      candidate.poolKeys[0] !== null ||
      candidate.stepAmountsOut.length !== 1
    ) return [];
    const parsedInput = typeof candidate.amountInRaw === "string" && /^[1-9][0-9]*$/.test(candidate.amountInRaw)
      ? candidate.amountInRaw
      : decimalAmountToRaw(candidate.amountIn, target.tokenIn.decimals);
    const parsedOutput = typeof candidate.amountOutRaw === "string" && /^[1-9][0-9]*$/.test(candidate.amountOutRaw)
      ? candidate.amountOutRaw
      : decimalAmountToRaw(candidate.amountOut, target.tokenOut.decimals);
    if (
      parsedInput !== amountInRaw ||
      !parsedOutput ||
      candidate.amountOutMinimumRaw !== parsedOutput ||
      candidate.amountInRawReferral !== "0" ||
      candidate.amountInReferralBips !== 0 ||
      candidate.amountOutRawReferral !== "0" ||
      candidate.amountOutReferralBips !== 0
    ) return [];
    return [{
      amountOutRaw: parsedOutput,
      routeTokens: [target.tokenIn.address, target.tokenOut.address] as [string, string],
      poolVersions: ["v2"] as ["v2"],
    }];
  });
  return matches.length === 1 ? matches[0]! : null;
}

function isSunRouterDirectV2Path(
  candidate: unknown,
  target: TronMeasuredExecutionTarget,
): candidate is Record<string, unknown> & {
  poolKeys: unknown[];
  stepAmountsOut: unknown[];
} {
  return (
    isRecord(candidate) &&
    Array.isArray(candidate.tokens) &&
    candidate.tokens.length === 2 &&
    candidate.tokens[0] === target.tokenIn.address &&
    candidate.tokens[1] === target.tokenOut.address &&
    Array.isArray(candidate.poolVersions) &&
    candidate.poolVersions.length === 1 &&
    candidate.poolVersions[0] === "v2" &&
    Array.isArray(candidate.poolKeys) &&
    candidate.poolKeys.length === 1 &&
    Array.isArray(candidate.stepAmountsOut) &&
    candidate.stepAmountsOut.length === 1
  );
}

function isSunRouterMultiHopV2Path(candidate: unknown, target: TronMeasuredExecutionTarget): boolean {
  if (
    !isRecord(candidate) ||
    candidate.containsUnverifiedHook !== false ||
    !Array.isArray(candidate.tokens) ||
    candidate.tokens.length <= 2 ||
    candidate.tokens[0] !== target.tokenIn.address ||
    candidate.tokens[candidate.tokens.length - 1] !== target.tokenOut.address ||
    !Array.isArray(candidate.poolVersions) ||
    candidate.poolVersions.length !== candidate.tokens.length - 1 ||
    candidate.poolVersions.some((version) => version !== "v2") ||
    !Array.isArray(candidate.poolKeys) ||
    candidate.poolKeys.length !== candidate.poolVersions.length ||
    candidate.poolKeys.some((poolKey) => poolKey !== null) ||
    !Array.isArray(candidate.stepAmountsOut) ||
    candidate.stepAmountsOut.length !== candidate.poolVersions.length
  ) return false;
  return (
    candidate.amountInRawReferral === "0" &&
    candidate.amountInReferralBips === 0 &&
    candidate.amountOutRawReferral === "0" &&
    candidate.amountOutReferralBips === 0
  );
}

function sunRouterResponseAllowsV2RouterFallback(
  body: unknown,
  target: TronMeasuredExecutionTarget,
): boolean {
  return (
    isRecord(body) &&
    body.code === 0 &&
    Array.isArray(body.data) &&
    body.data.length > 0 &&
    body.data.every((candidate) => isSunRouterMultiHopV2Path(candidate, target))
  );
}

async function fetchSunSwapV2RouterDirectQuote(input: {
  target: TronMeasuredExecutionTarget;
  amountInRaw: string;
  signal?: AbortSignal;
  trongridApiKey?: string | null;
  fetchImpl: FetchLike;
}): Promise<{
  amountOutRaw: string;
  routeTokens: [string, string];
  poolVersions: ["v2"];
  routerAddress: string;
  routerCodeHash: `0x${string}`;
  routerFactoryAddress: string;
}> {
  const [routerHex, tokenInHex, tokenOutHex] = await Promise.all([
    tronBase58ToHex(input.target.routerAddress),
    tronBase58ToHex(input.target.tokenIn.address),
    tronBase58ToHex(input.target.tokenOut.address),
  ]);
  if (!routerHex || !tokenInHex || !tokenOutHex) throw new Error("tron-address-invalid");
  const rpcInput = {
    signal: input.signal,
    trongridApiKey: input.trongridApiKey,
    fetchImpl: input.fetchImpl,
  };
  const routerCode = parseHexResult(await tronRpc("eth_getCode", [routerHex, "latest"], rpcInput));
  if (!routerCode || routerCode === "0x") throw new Error("router-code-missing");
  const routerCodeHash = keccak256(routerCode).toLowerCase() as `0x${string}`;
  if (routerCodeHash !== input.target.expectedRouterCodeHash) throw new Error("router-code-hash-mismatch");

  const factoryResult = await tronRpc(
    "eth_call",
    [{
      to: routerHex,
      data: encodeFunctionData({ abi: SUNSWAP_V2_ROUTER_ABI, functionName: "factory" }),
    }, "latest"],
    rpcInput,
  );
  const routerFactoryAddress = await decodeTronAddressWord(factoryResult);
  if (routerFactoryAddress !== input.target.factoryAddress) throw new Error("router-factory-mismatch");

  const quoteResult = parseHexResult(await tronRpc(
    "eth_call",
    [{
      to: routerHex,
      data: encodeFunctionData({
        abi: SUNSWAP_V2_ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [
          BigInt(input.amountInRaw),
          [tokenInHex as `0x${string}`, tokenOutHex as `0x${string}`],
        ],
      }),
    }, "latest"],
    rpcInput,
  ));
  if (!quoteResult) throw new Error("router-quote-invalid");
  let amounts: readonly bigint[];
  try {
    amounts = decodeFunctionResult({
      abi: SUNSWAP_V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      data: quoteResult,
    });
  } catch {
    throw new Error("router-quote-invalid");
  }
  if (
    amounts.length !== 2 ||
    amounts[0]?.toString() !== input.amountInRaw ||
    amounts[1] == null ||
    amounts[1] <= 0n
  ) throw new Error("router-quote-invalid");
  return {
    amountOutRaw: amounts[1].toString(),
    routeTokens: [input.target.tokenIn.address, input.target.tokenOut.address],
    poolVersions: ["v2"],
    routerAddress: input.target.routerAddress,
    routerCodeHash,
    routerFactoryAddress,
  };
}

export async function quoteTronMeasuredTarget(input: {
  target: TronMeasuredExecutionTarget;
  inputUsd: number;
  trongridApiKey?: string | null;
  routerRequestSpacingMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<TronMeasuredExecutionQuotePointProof> {
  throwIfAborted(input.signal);
  const fetchImpl = input.fetchImpl ?? fetch;
  const amountIn = usdToRawAmount(
    input.inputUsd,
    input.target.tokenIn.decimals,
    input.target.tokenIn.referencePriceUsd,
  );
  if (amountIn == null) throw new Error("invalid-quote-input");
  const amountInRaw = amountIn.toString();
  const rpcInput = { signal: input.signal, trongridApiKey: input.trongridApiKey, fetchImpl };
  const blockBefore = await fetchBlockNumber(rpcInput);
  const binding = await fetchSunSwapV2Binding({ target: input.target, ...rpcInput });
  const reserveIn = binding.token0 === input.target.tokenIn.address ? binding.reserve0 : binding.reserve1;
  const reserveOut = binding.token0 === input.target.tokenIn.address ? binding.reserve1 : binding.reserve0;
  const expectedOutput = quoteSunSwapV2ConstantProduct({ amountIn, reserveIn, reserveOut });
  if (expectedOutput == null) throw new Error("constant-product-quote-failed");

  const url = new URL(SUNSWAP_V2_ROUTER_QUOTE_URL);
  url.searchParams.set("fromToken", input.target.tokenIn.address);
  url.searchParams.set("toToken", input.target.tokenOut.address);
  url.searchParams.set("amountIn", amountInRaw);
  url.searchParams.set("typeList", "SUNSWAP_V2");
  let body: unknown;
  try {
    await sleepWithSignal(input.routerRequestSpacingMs ?? SUN_ROUTER_REQUEST_SPACING_MS, input.signal);
    body = await fetchBoundedJson(url.toString(), {}, input.signal, fetchImpl);
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    throw error;
  }
  const smartRouterDirectRoute = parseSunRouterDirectV2Quote(body, input.target, amountInRaw);
  const directRoute = smartRouterDirectRoute
    ? { ...smartRouterDirectRoute, provider: "sun-smart-router" as const }
    : sunRouterResponseAllowsV2RouterFallback(body, input.target)
      ? {
          ...await fetchSunSwapV2RouterDirectQuote({
            target: input.target,
            amountInRaw,
            ...rpcInput,
          }),
          provider: "sunswap-v2-router" as const,
        }
      : null;
  if (!directRoute) throw new Error("exact-route-mismatch");
  if (directRoute.amountOutRaw !== expectedOutput.toString()) throw new Error("canonical-pair-quote-mismatch");
  const blockAfter = await fetchBlockNumber(rpcInput);
  if (blockAfter < blockBefore || blockAfter - blockBefore > TRON_MEASURED_MAX_BLOCK_WINDOW) {
    throw new Error("block-window-invalid");
  }

  const outputAmount = BigInt(directRoute.amountOutRaw);
  const inputUsd = rawAmountToUsd(amountIn, input.target.tokenIn.decimals, input.target.tokenIn.referencePriceUsd);
  const outputUsd = rawAmountToUsd(
    outputAmount,
    input.target.tokenOut.decimals,
    input.target.tokenOut.referencePriceUsd,
  );
  if (!Number.isFinite(inputUsd) || inputUsd <= 0 || !Number.isFinite(outputUsd) || outputUsd <= 0) {
    throw new Error("invalid-quote-output");
  }
  if (Math.abs(inputUsd - input.inputUsd) > 0.02) throw new Error("invalid-quote-input-rounding");
  const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
  const providerProof = directRoute.provider === "sunswap-v2-router"
    ? {
        provider: directRoute.provider,
        routerAddress: directRoute.routerAddress,
        routerCodeHash: directRoute.routerCodeHash,
        routerFactoryAddress: directRoute.routerFactoryAddress,
      }
    : { provider: directRoute.provider };
  return {
    amountInRaw,
    amountOutRaw: directRoute.amountOutRaw,
    inputUsd,
    outputUsd,
    costBps,
    passesCostBound: costBps <= DEX_MEASURED_MAX_COST_BPS,
    route: {
      ...providerProof,
      poolId: input.target.poolId,
      factoryAddress: input.target.factoryAddress,
      factoryCodeHash: binding.factoryCodeHash,
      pairCodeHash: binding.pairCodeHash,
      token0: binding.token0,
      token1: binding.token1,
      reserve0Raw: binding.reserve0.toString(),
      reserve1Raw: binding.reserve1.toString(),
      inputToken: input.target.tokenIn.address,
      outputToken: input.target.tokenOut.address,
      inputAmountRaw: amountInRaw,
      outputAmountRaw: directRoute.amountOutRaw,
      expectedOutputAmountRaw: expectedOutput.toString(),
      routeTokens: directRoute.routeTokens,
      poolVersions: directRoute.poolVersions,
      blockBefore,
      blockAfter,
    },
  };
}
