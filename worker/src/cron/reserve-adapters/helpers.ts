import type { LiveReserveInput, LiveReservesConfig, ReserveSlice } from "@shared/types";
import { DEFILLAMA_COINS } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { fetchEtherscanUint256AtBlock, fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import type { AdapterContext } from "./index";

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
  const res = await fetchWithRetry(url, { signal }, 2, { timeoutMs });
  if (!res) {
    throw new Error(`Fetch failed for ${url}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
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
      timeoutMs: 10_000,
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
        timeoutMs: 10_000,
      },
    );
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

export function slicesFromUsdValues(
  values: Array<{
    usd: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
  }>,
): ReserveSlice[] {
  const filtered = values.filter((value) => Number.isFinite(value.usd) && value.usd > 0);
  const total = filtered.reduce((acc, value) => acc + value.usd, 0);
  if (total <= 0) return [];

  return normalizeSlices(
    filtered.map((value) => ({
      name: value.name,
      pct: (value.usd / total) * 100,
      risk: value.risk,
      ...(value.coinId ? { coinId: value.coinId } : {}),
      ...(value.depType ? { depType: value.depType } : {}),
    })),
  );
}

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

  return normalizeSlices(
    filtered.map((v) => ({
      name: v.name,
      pct: (v.value / total) * 100,
      risk: v.risk,
      ...(v.coinId ? { coinId: v.coinId } : {}),
      ...(v.depType ? { depType: v.depType } : {}),
    })),
    decimals,
  );
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
