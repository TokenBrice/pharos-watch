import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput, LiveReservesConfig } from "@shared/types/live-reserves";
import { DEFILLAMA_COINS } from "../../lib/constants";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEtherscanProxyHex,
} from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";
import { reserveDegradedWarning, reserveInfoWarning } from "./warnings";
export {
  accumulateBucketedExposure,
  classifyBucketedValues,
} from "./classification";
export {
  buildUnknownExposureWarning,
  buildBucketSlices,
  computeUnknownExposurePct,
  decimalNumberFromBigInt,
  decimalStringFromBigInt,
  isReserveRisk,
  normalizeSlices,
  parsePositiveNumericLike,
  slicesFromPercentages,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./slice-math";
export {
  parseTimestampLikeToUnixSeconds,
  notApplicableFreshnessMetadata,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./freshness";
export { htmlLayoutChangedError, htmlParseError } from "./html";
export { reserveDegradedWarning, reserveInfoWarning };

type JsonObject = Record<string, unknown>;

type JsonInput = Extract<LiveReserveInput, { kind: "http-json" }>;
type HtmlInput = Extract<LiveReserveInput, { kind: "http-html" }>;
type SolanaInput = Extract<LiveReserveInput, { kind: "onchain-solana" }>;
type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

interface EvmCallOptions {
  contract: string;
  data: string;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  rpcMode?: EvmInput["rpcMode"];
  chain?: string;
  timeoutMs?: number;
}

interface OnchainRateProbe {
  contract: string;
  selector: string;
  decimals?: number;
}

interface JsonRetryOptions {
  headers?: HeadersInit;
}

const ADAPTER_USER_AGENT = "Mozilla/5.0";
const DEFILLAMA_PRICE_CHAIN_ALIASES: Record<string, string> = {
  hyperevm: "hyperliquid",
};
const SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
] as const;

function summarizeResponseBody(raw: string, limit = 120): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, limit);
}

function buildJsonParseError(url: string, res: Response, raw: string, error: unknown): Error {
  const contentType = res.headers.get("content-type") ?? "unknown";
  const snippet = summarizeResponseBody(raw);
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `JSON parse failed for ${url} (${contentType}): ${detail}${snippet ? `; body starts with: ${snippet}` : ""}`,
  );
}

function getRequestCache(ctx?: AdapterContext): Map<string, Promise<unknown>> | null {
  return ctx?.requestCache ?? null;
}

function getCachedRequest<T>(
  key: string,
  factory: () => Promise<T>,
  ctx?: AdapterContext,
): Promise<T> {
  const cache = getRequestCache(ctx);
  if (!cache) {
    return factory();
  }

  const cached = cache.get(key) as Promise<T> | undefined;
  if (cached) {
    return cached;
  }

  const promise = factory().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, promise);
  return promise;
}

function getDefiLlamaPriceAssetKey(chain: string, address: string): string {
  const resolvedChain = DEFILLAMA_PRICE_CHAIN_ALIASES[chain] ?? chain;
  return `${resolvedChain}:${address.toLowerCase()}`;
}

export function isHttpJsonInput(input: LiveReserveInput): input is JsonInput {
  return input.kind === "http-json";
}

function isOnchainEvmInput(input: LiveReserveInput): input is EvmInput {
  return input.kind === "onchain-evm";
}

function isOnchainSolanaInput(input: LiveReserveInput): input is SolanaInput {
  return input.kind === "onchain-solana";
}

export function isHttpHtmlInput(input: LiveReserveInput): input is HtmlInput {
  return input.kind === "http-html";
}

export function requireJsonInput(input: LiveReserveInput, adapterName: string): JsonInput {
  if (!isHttpJsonInput(input)) {
    throw new Error(`${adapterName} adapter requires an http-json primary input`);
  }
  return input;
}

export function requireHtmlInput(input: LiveReserveInput, adapterName: string): HtmlInput {
  if (!isHttpHtmlInput(input)) {
    throw new Error(`${adapterName} adapter requires an http-html primary input`);
  }
  return input;
}

export function requireOnchainInput(input: LiveReserveInput, adapterName: string): EvmInput {
  if (!isOnchainEvmInput(input)) {
    throw new Error(`${adapterName} adapter requires an onchain-evm primary input`);
  }
  return input;
}

export function requireJsonInputFromConfig(
  config: LiveReservesConfig,
  adapterName: string,
): JsonInput {
  return requireJsonInput(config.inputs.primary, adapterName);
}

export async function fetchJsonWithRetry<T>(
  url: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
  ctx?: AdapterContext,
  options?: JsonRetryOptions,
): Promise<T> {
  return getCachedRequest(
    `json-get:${url}:${timeoutMs}:${JSON.stringify(options?.headers ?? null)}`,
    async () => {
      const res = await fetchWithRetry(
        url,
        {
          signal,
          headers: {
            Accept: "application/json",
            "User-Agent": ADAPTER_USER_AGENT,
            ...(options?.headers ?? {}),
          },
        },
        2,
        { timeoutMs },
      );
      if (!res) {
        throw new Error(`Fetch failed for ${url}`);
      }
      if (!res.ok) {
        await cancelResponseBodyQuietly(res);
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const raw = await res.text();
      try {
        return JSON.parse(raw) as T;
      } catch (error) {
        throw buildJsonParseError(url, res, raw, error);
      }
    },
    ctx,
  );
}

export async function fetchJsonPostWithRetry<T>(
  url: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs = 10_000,
  ctx?: AdapterContext,
  options?: JsonRetryOptions,
): Promise<T> {
  const serializedBody = JSON.stringify(body);
  return getCachedRequest(
    `json-post:${url}:${timeoutMs}:${serializedBody}:${JSON.stringify(options?.headers ?? null)}`,
    async () => {
      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": ADAPTER_USER_AGENT,
            ...(options?.headers ?? {}),
          },
          body: serializedBody,
          signal,
        },
        2,
        { timeoutMs },
      );
      if (!res) {
        throw new Error(`POST fetch failed for ${url}`);
      }
      if (!res.ok) {
        await cancelResponseBodyQuietly(res);
        throw new Error(`HTTP ${res.status} for POST ${url}`);
      }
      return res.json() as Promise<T>;
    },
    ctx,
  );
}

export async function fetchTextWithRetry(
  url: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
  ctx?: AdapterContext,
): Promise<string> {
  return getCachedRequest(
    `text-get:${url}:${timeoutMs}`,
    async () => {
      const res = await fetchWithRetry(
        url,
        {
          signal,
          headers: { "User-Agent": ADAPTER_USER_AGENT },
        },
        2,
        { timeoutMs },
      );
      if (!res) {
        throw new Error(`Fetch failed for ${url}`);
      }
      if (!res.ok) {
        await cancelResponseBodyQuietly(res);
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res.text();
    },
    ctx,
  );
}

interface SolanaTokenSupplyResponse {
  result?: {
    value?: {
      amount?: string;
    };
  };
}

async function fetchSolanaTokenSupplyRaw(
  mintAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<bigint | null> {
  let lastError: unknown = null;

  for (const rpcUrl of SOLANA_RPC_URLS) {
    try {
      const body = await fetchJsonPostWithRetry<SolanaTokenSupplyResponse>(
        rpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenSupply",
          params: [mintAddress],
        },
        signal,
        10_000,
        ctx,
      );

      const amount = body.result?.value?.amount;
      if (typeof amount !== "string" || amount.length === 0) {
        continue;
      }

      try {
        return BigInt(amount);
      } catch {
        continue;
      }
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (lastError) throw lastError;
  return null;
}

export async function fetchDefiLlamaPrices(
  assets: Array<{ key: string; chain: string; address: string }>,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Map<string, number>> {
  if (assets.length === 0) return new Map();

  const assetKeys = assets.map(({ chain, address }) => getDefiLlamaPriceAssetKey(chain, address));
  return getCachedRequest(
    `defillama-prices:${assetKeys.join(",")}`,
    async () => {
      const res = await fetchWithRetry(
        `${DEFILLAMA_COINS}/prices/current/${assetKeys.join(",")}`,
        { signal },
        2,
        { timeoutMs: 10_000 },
      );
      if (!res) {
        throw new Error("DefiLlama price fetch failed (no-response)");
      }
      if (!res.ok) {
        await cancelResponseBodyQuietly(res);
        throw new Error(`DefiLlama price fetch failed (${res.status})`);
      }

      const body = (await res.json()) as {
        coins?: Record<string, { price?: number }>;
      };
      const priceMap = new Map<string, number>();

      for (const asset of assets) {
        const lookupKey = getDefiLlamaPriceAssetKey(asset.chain, asset.address);
        const price = body.coins?.[lookupKey]?.price;
        if (typeof price === "number" && price > 0) {
          priceMap.set(asset.key, price);
        }
      }

      return priceMap;
    },
    ctx,
  );
}

export async function fetchOnchainUint256(options: EvmCallOptions): Promise<bigint | null> {
  const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );

  const rpcValue = await fetchEvmUint256AtBlock(
    options.chain,
    options.contract,
    options.data,
    "latest",
    {
      extraRpcUrls,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 10_000,
      chainRpcs: options.ctx?.chainRpcs,
    },
  );
  if (rpcValue != null) {
    return rpcValue;
  }

  if (options.rpcMode === "etherscan-proxy") {
    if (options.chain !== "ethereum") return null;
    return fetchEtherscanUint256AtBlock(
      1,
      options.contract,
      options.data,
      "latest",
      {
        apiKey: options.ctx?.etherscanApiKey,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10_000,
      },
    );
  }

  return null;
}

export async function fetchOnchainRateBps(
  input: EvmInput,
  probe: OnchainRateProbe,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<number | null> {
  const decimals = probe.decimals ?? 18;
  const scale = 10n ** BigInt(decimals);
  const raw = await fetchOnchainUint256({
    contract: probe.contract,
    data: probe.selector,
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  });
  if (raw == null) return null;

  const roundedBps = (raw * 10_000n + scale / 2n) / scale;
  return Number(roundedBps);
}

export async function fetchOnchainRawCall(options: EvmCallOptions): Promise<string | null> {
  const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );

  const rpcValue = await fetchEvmCallHexAtBlock(
    options.chain,
    options.contract,
    options.data,
    "latest",
    {
      extraRpcUrls,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 10_000,
      chainRpcs: options.ctx?.chainRpcs,
    },
  );
  if (rpcValue != null) {
    return rpcValue;
  }

  if (options.rpcMode === "etherscan-proxy") {
    if (options.chain !== "ethereum") return null;
    return fetchEtherscanProxyHex({
      evmChainId: 1,
      action: "eth_call",
      to: options.contract,
      data: options.data,
      blockNumberOrTag: "latest",
      apiKey: options.ctx?.etherscanApiKey,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
  }

  return null;
}

export async function fetchErc20Balance(
  input: EvmInput,
  contract: string,
  holder: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint | null> {
  return fetchOnchainUint256({
    contract,
    data: encodeBalanceOfCallData(holder),
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  });
}

export async function fetchErc20TotalSupply(
  input: EvmInput,
  contract: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint | null> {
  return fetchOnchainUint256({
    contract,
    data: TOTAL_SUPPLY_SELECTOR,
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
  });
}

/**
 * Resolves contract address for a coin on a given chain, fetches ERC-20 totalSupply,
 * and validates it is non-zero. Throws with descriptive error on any failure.
 */
export async function probeOnchainTotalSupply(
  coin: StablecoinMeta,
  input: LiveReserveInput,
  signal: AbortSignal,
  adapterName: string,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint> {
  const onchain = requireOnchainInput(input, adapterName);
  const contract = coin.contracts?.find((c) => c.chain === onchain.chain)?.address;
  if (!contract) {
    throw new Error(`${adapterName} could not find a ${onchain.chain} contract for ${coin.id}`);
  }
  const supply = await fetchErc20TotalSupply(onchain, contract, signal, ctx, rpcUrl, fallbackRpcUrl);
  if (supply == null || supply <= 0n) {
    throw new Error(`${adapterName} totalSupply probe failed for ${coin.id}`);
  }
  return supply;
}

/**
 * Resolves contract/mint metadata for a coin on a supported onchain input and
 * validates that the published token supply is non-zero.
 */
export async function probeTrackedTokenSupply(
  coin: StablecoinMeta,
  input: LiveReserveInput,
  signal: AbortSignal,
  adapterName: string,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<bigint> {
  if (isOnchainEvmInput(input)) {
    return probeOnchainTotalSupply(
      coin,
      input,
      signal,
      adapterName,
      ctx,
      rpcUrl,
      fallbackRpcUrl,
    );
  }

  if (!isOnchainSolanaInput(input)) {
    throw new Error(`${adapterName} adapter requires a supported onchain primary input`);
  }

  const mintAddress = coin.contracts?.find((contract) => contract.chain === "solana")?.address;
  if (!mintAddress) {
    throw new Error(`${adapterName} could not find a solana contract for ${coin.id}`);
  }

  const supply = await fetchSolanaTokenSupplyRaw(mintAddress, signal, ctx);
  if (supply == null || supply <= 0n) {
    throw new Error(`${adapterName} totalSupply probe failed for ${coin.id}`);
  }
  return supply;
}

export function getJsonPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as JsonObject)[part];
  }
  return current;
}
