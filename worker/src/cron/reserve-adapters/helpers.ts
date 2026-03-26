import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput, LiveReservesConfig } from "@shared/types/live-reserves";
import { DEFILLAMA_COINS } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEtherscanProxyHex,
} from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";
export {
  parseTimestampLikeToUnixSeconds,
  notApplicableFreshnessMetadata,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./freshness";
export { htmlLayoutChangedError, htmlParseError } from "./html";
export { reserveDegradedWarning, reserveInfoWarning } from "./warnings";

const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const BALANCE_OF_SELECTOR = "0x70a08231";

type JsonObject = Record<string, unknown>;

type JsonInput = Extract<LiveReserveInput, { kind: "http-json" }>;
type HtmlInput = Extract<LiveReserveInput, { kind: "http-html" }>;
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

interface BucketedExposureOptions<Item, Bucket extends string> {
  items: Item[];
  getValue: (item: Item) => number;
  getBucket: (item: Item) => Bucket;
  isUnknown?: (item: Item, bucket: Bucket) => boolean;
  getUnknownKey?: (item: Item) => string;
}

const ADAPTER_USER_AGENT = "Mozilla/5.0";

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

export function accumulateBucketedExposure<Item, Bucket extends string>({
  items,
  getValue,
  getBucket,
  isUnknown,
  getUnknownKey,
}: BucketedExposureOptions<Item, Bucket>): {
  bucketTotals: Map<Bucket, number>;
  totalValue: number;
  unknownValue: number;
  unknownValuesByKey: Map<string, number>;
} {
  const bucketTotals = new Map<Bucket, number>();
  const unknownValuesByKey = new Map<string, number>();
  let totalValue = 0;
  let unknownValue = 0;

  for (const item of items) {
    const value = getValue(item);
    if (!Number.isFinite(value) || value <= 0) continue;

    totalValue += value;
    const bucket = getBucket(item);
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + value);

    if (isUnknown?.(item, bucket)) {
      unknownValue += value;
      const key = getUnknownKey?.(item);
      if (key) {
        unknownValuesByKey.set(key, (unknownValuesByKey.get(key) ?? 0) + value);
      }
    }
  }

  return { bucketTotals, totalValue, unknownValue, unknownValuesByKey };
}

export function isHttpJsonInput(input: LiveReserveInput): input is JsonInput {
  return input.kind === "http-json";
}

function isOnchainEvmInput(input: LiveReserveInput): input is EvmInput {
  return input.kind === "onchain-evm";
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

const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;
/** Returns the adapter's explicit fallback timeout or the shared 10s default. */
export function getAdapterTimeout(config: LiveReservesConfig, fallbackMs = DEFAULT_ADAPTER_TIMEOUT_MS): number {
  void config;
  return fallbackMs;
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
): Promise<T> {
  return getCachedRequest(
    `json-get:${url}:${timeoutMs}`,
    async () => {
      const res = await fetchWithRetry(url, { signal, headers: { "User-Agent": ADAPTER_USER_AGENT } }, 2, { timeoutMs });
      if (!res) {
        throw new Error(`Fetch failed for ${url}`);
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res.json() as Promise<T>;
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
): Promise<T> {
  const serializedBody = JSON.stringify(body);
  return getCachedRequest(
    `json-post:${url}:${timeoutMs}:${serializedBody}`,
    async () => {
      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": ADAPTER_USER_AGENT },
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
        await res.body?.cancel();
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
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res.text();
    },
    ctx,
  );
}

export async function fetchDefiLlamaPrices(
  assets: Array<{ key: string; chain: string; address: string }>,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Map<string, number>> {
  if (assets.length === 0) return new Map();

  const assetKeys = assets.map(({ chain, address }) => `${chain}:${address.toLowerCase()}`);
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
        await res.body?.cancel();
        throw new Error(`DefiLlama price fetch failed (${res.status})`);
      }

      const body = (await res.json()) as {
        coins?: Record<string, { price?: number }>;
      };
      const priceMap = new Map<string, number>();

      for (const asset of assets) {
        const lookupKey = `${asset.chain}:${asset.address.toLowerCase()}`;
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
  const address = holder.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  return fetchOnchainUint256({
    contract,
    data: `${BALANCE_OF_SELECTOR}${address}`,
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
 * Deduplicate and normalize reserve slices so percentages sum to exactly 100%.
 * Slices sharing the same (name, risk, coinId, depType) key are merged by summing pct.
 * After rounding, the largest slice absorbs any remainder to maintain the 100% invariant.
 * Returns slices sorted by pct descending.
 */
export function normalizeSlices(slices: ReserveSlice[], decimals = 1): ReserveSlice[] {
  const factor = 10 ** decimals;
  const grouped = new Map<string, ReserveSlice>();

  for (const slice of slices) {
    if (!Number.isFinite(slice.pct) || slice.pct <= 0) continue;
    const key = `${slice.name}|${slice.risk}|${slice.coinId ?? ""}|${slice.depType ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.pct += slice.pct;
    } else {
      grouped.set(key, { ...slice });
    }
  }

  const normalized = Array.from(grouped.values())
    .map((slice) => ({ ...slice, pctUnits: Math.round(slice.pct * factor) }))
    .filter((slice) => slice.pctUnits > 0);

  if (normalized.length === 0) return [];

  const sumUnits = normalized.reduce((acc, slice) => acc + slice.pctUnits, 0);
  const maxIdx = normalized.reduce(
    (maxIndex, slice, index, arr) => (slice.pctUnits > arr[maxIndex].pctUnits ? index : maxIndex),
    0,
  );
  normalized[maxIdx].pctUnits += (100 * factor) - sumUnits;

  return normalized
    .map(({ pctUnits, ...slice }) => ({ ...slice, pct: pctUnits / factor }))
    .filter((slice) => slice.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

export function decimalNumberFromBigInt(value: bigint, decimals: number): number {
  if (decimals === 0) return Number(value);

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const digits = absolute.toString().padStart(decimals + 1, "0");
  const integerPart = digits.slice(0, digits.length - decimals) || "0";
  const fractionalPart = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const formatted = fractionalPart.length > 0
    ? `${negative ? "-" : ""}${integerPart}.${fractionalPart}`
    : `${negative ? "-" : ""}${integerPart}`;

  return Number(formatted);
}

export function parsePositiveNumericLike(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

export function slicesFromPercentages(
  values: Array<{
    pct: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
  }>,
  options?: {
    decimals?: number;
    tolerancePct?: number;
    context?: string;
  },
): ReserveSlice[] {
  const filtered = values.filter((value) => Number.isFinite(value.pct) && value.pct > 0);
  const total = filtered.reduce((acc, value) => acc + value.pct, 0);
  if (total <= 0) return [];

  const tolerancePct = options?.tolerancePct ?? 1.5;
  if (Math.abs(total - 100) > tolerancePct) {
    throw new Error(
      `${options?.context ?? "reserve percentages"} sum to ${total.toFixed(1)}% (expected 100% ± ${tolerancePct}%)`,
    );
  }

  return normalizeSlices(
    filtered.map((value) => ({
      name: value.name,
      pct: value.pct,
      risk: value.risk,
      ...(value.coinId ? { coinId: value.coinId } : {}),
      ...(value.depType ? { depType: value.depType } : {}),
    })),
    options?.decimals ?? 1,
  );
}

/**
 * Convert absolute values into percentage-based ReserveSlice[].
 * Filters out zero-value entries, calculates pct relative to total, and normalizes
 * so percentages sum to 100%. Used by adapters that receive dollar amounts from APIs.
 */
export function slicesFromValues(
  values: Array<{
    value: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
  }>,
  decimals = 1,
): ReserveSlice[] {
  const filtered = values.filter((v) => Number.isFinite(v.value) && v.value > 0);
  const total = filtered.reduce((acc, v) => acc + v.value, 0);
  if (total <= 0) return [];

  const factor = 10 ** decimals;
  const slices: ReserveSlice[] = filtered.map((v) => ({
    name: v.name,
    pct: Math.round(((v.value / total) * 100) * factor) / factor,
    risk: v.risk,
    ...(v.coinId ? { coinId: v.coinId } : {}),
    ...(v.depType ? { depType: v.depType } : {}),
  }));

  const nonZero = slices.filter((s) => s.pct > 0);
  if (nonZero.length === 0) return [];

  const roundedTotal = nonZero.reduce((acc, s) => acc + s.pct, 0);
  const adjustment = Math.round((100 - roundedTotal) * factor) / factor;
  if (adjustment !== 0) {
    const maxIdx = nonZero.reduce(
      (mi, s, i, arr) => (s.pct > arr[mi].pct ? i : mi),
      0,
    );
    const nextPct = Math.round((nonZero[maxIdx].pct + adjustment) * factor) / factor;
    if (nextPct > 0) {
      nonZero[maxIdx].pct = nextPct;
    }
  }

  return nonZero;
}

export function getJsonPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as JsonObject)[part];
  }
  return current;
}

export function isReserveRisk(value: unknown): value is ReserveSlice["risk"] {
  return value === "very-low"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "very-high";
}
