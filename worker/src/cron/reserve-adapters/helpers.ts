import type { LiveReserveInput, ReserveSlice } from "@shared/types";
import { DEFILLAMA_COINS, ETHERSCAN_V2_BASE } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { getChainRpc } from "../../lib/chain-registry";
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

function parseUint256Hex(value: unknown): bigint | null {
  if (typeof value !== "string" || !value.startsWith("0x") || value.length < 3) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

async function fetchJsonRpcUint256(url: string, contract: string, data: string, signal: AbortSignal): Promise<bigint | null> {
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: contract, data }, "latest"],
    }),
    signal,
  }, 1, { timeoutMs: 10_000 });

  if (!res || !res.ok) return null;
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (body.error) return null;
  return parseUint256Hex(body.result);
}

async function fetchEtherscanUint256(
  chain: string | undefined,
  contract: string,
  data: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<bigint | null> {
  if (!apiKey || chain !== "ethereum") return null;

  const params = new URLSearchParams({
    chainid: "1",
    module: "proxy",
    action: "eth_call",
    to: contract,
    data,
    tag: "latest",
    apikey: apiKey,
  });

  const res = await fetchWithRetry(`${ETHERSCAN_V2_BASE}?${params.toString()}`, { signal }, 1, { timeoutMs: 10_000 });
  if (!res || !res.ok) return null;
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (body.error) return null;
  return parseUint256Hex(body.result);
}

export async function fetchOnchainUint256(options: EvmCallOptions): Promise<bigint | null> {
  const urls: string[] = [];
  if (options.rpcUrl) urls.push(options.rpcUrl);
  if (options.fallbackRpcUrl) urls.push(options.fallbackRpcUrl);

  if (options.chain) {
    const chainRpc = getChainRpc(options.chain);
    if (chainRpc) {
      urls.push(chainRpc.rpcUrl);
      if (chainRpc.fallbackRpcUrl) urls.push(chainRpc.fallbackRpcUrl);
    }
  }

  for (const url of Array.from(new Set(urls.filter(Boolean)))) {
    const value = await fetchJsonRpcUint256(url, options.contract, options.data, options.signal);
    if (value != null) return value;
  }

  if (options.rpcMode === "etherscan-proxy") {
    return fetchEtherscanUint256(
      options.chain,
      options.contract,
      options.data,
      options.ctx?.etherscanApiKey,
      options.signal,
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

export function normalizeSlices(slices: ReserveSlice[]): ReserveSlice[] {
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
    .map((slice) => ({ ...slice, pct: Math.round(slice.pct) }))
    .filter((slice) => slice.pct > 0);

  if (normalized.length === 0) return normalized;

  const sum = normalized.reduce((acc, slice) => acc + slice.pct, 0);
  const maxIdx = normalized.reduce(
    (maxIndex, slice, index, arr) => (slice.pct > arr[maxIndex].pct ? index : maxIndex),
    0,
  );
  normalized[maxIdx].pct += 100 - sum;

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

export function getJsonPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as JsonObject)[part];
  }
  return current;
}
