import type { LiveReserveInput, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { DEFILLAMA_COINS } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEtherscanProxyHex,
} from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";

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

export function isHttpJsonInput(input: LiveReserveInput): input is JsonInput {
  return input.kind === "http-json";
}

export function isOnchainEvmInput(input: LiveReserveInput): input is EvmInput {
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
const MAX_ADAPTER_TIMEOUT_MS = 30_000;

/** Reads timeout from config.params.timeoutMs, falling back to the adapter's default or 10s. */
export function getAdapterTimeout(config: LiveReservesConfig, fallbackMs = DEFAULT_ADAPTER_TIMEOUT_MS): number {
  const paramTimeout = (config.params as Record<string, unknown> | undefined)?.timeoutMs;
  if (typeof paramTimeout === "number" && paramTimeout > 0 && paramTimeout <= MAX_ADAPTER_TIMEOUT_MS) {
    return paramTimeout;
  }
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
): Promise<T> {
  const res = await fetchWithRetry(url, { signal, headers: { "User-Agent": "Mozilla/5.0" } }, 2, { timeoutMs });
  if (!res) {
    throw new Error(`Fetch failed for ${url}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchJsonPostWithRetry<T>(
  url: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<T> {
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify(body),
      signal,
    },
    2,
    { timeoutMs },
  );
  if (!res) {
    throw new Error(`POST fetch failed for ${url}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for POST ${url}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchTextWithRetry(
  url: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<string> {
  const res = await fetchWithRetry(
    url,
    {
      signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    },
    2,
    { timeoutMs },
  );
  if (!res) {
    throw new Error(`Fetch failed for ${url}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

export async function fetchDefiLlamaPrices(
  assets: Array<{ key: string; chain: string; address: string }>,
  signal: AbortSignal,
): Promise<Map<string, number>> {
  if (assets.length === 0) return new Map();

  const assetKeys = assets.map(({ chain, address }) => `${chain}:${address.toLowerCase()}`);
  const res = await fetchWithRetry(`${DEFILLAMA_COINS}/prices/current/${assetKeys.join(",")}`, { signal }, 2, { timeoutMs: 10_000 });
  if (!res || !res.ok) {
    throw new Error(`DefiLlama price fetch failed (${res?.status ?? "no-response"})`);
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
export function normalizeSlices(slices: ReserveSlice[], decimals = 0): ReserveSlice[] {
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
    .map((slice) => ({ ...slice, pct: Math.round(slice.pct * factor) / factor }))
    .filter((slice) => slice.pct > 0);

  if (normalized.length === 0) return normalized;

  const sum = normalized.reduce((acc, slice) => acc + slice.pct, 0);
  const maxIdx = normalized.reduce(
    (maxIndex, slice, index, arr) => (slice.pct > arr[maxIndex].pct ? index : maxIndex),
    0,
  );
  const adjustment = Math.round((100 - sum) * factor) / factor;
  normalized[maxIdx].pct = Math.round((normalized[maxIdx].pct + adjustment) * factor) / factor;

  return normalized
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
