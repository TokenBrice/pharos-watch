import { LEGACY_SOLOMON_USDV_ID } from "../../lib/solomon-usdv-identity";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { CHAIN_META, resolveChainId } from "@shared/lib/chains";
import { CIRCUIT_SOURCE, DEFILLAMA_COINS } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { throwIfAborted } from "../../lib/abort";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { DLPriceResponseSchema } from "../../lib/schemas";
import {
  applyResolvedPrice,
  hasMissingPrice,
  type PeggedAsset,
} from "./enrich-prices-shared";
import {
  type DlContractPassResult,
  type FallbackPriceQuote,
  isFreshFallbackObservedAt,
  isUsableFallbackPrice,
} from "./enrich-prices-pass-common";
import { TRACKED_ASSET_ADDRESS_OVERRIDES } from "./tracked-asset-overrides";

const DL_CONTRACT_MAX_AGE_SEC = 15 * 60;
const DL_CONTRACT_MIN_CONFIDENCE = 0.8;
const DL_CONTRACT_MAX_URL_LENGTH = 8_000;
const DL_CONTRACT_MAX_BATCHES = 8;

const DL_COINS_CHAIN_PREFIX_BY_CHAIN: Record<string, string> = {
  avalanche: "avax",
};

function isEvmChain(chain: string): boolean {
  const canonicalChain = resolveChainId(chain);
  return canonicalChain != null && CHAIN_META[canonicalChain]?.type === "evm";
}

function normalizeAddressForDefiLlamaChain(chain: string, address: string): string {
  return isEvmChain(chain) && address.startsWith("0x") ? address.toLowerCase() : address;
}

function addressToCoinId(address: string): string {
  const separatorIndex = address.indexOf(":");
  if (separatorIndex >= 0) {
    const chain = address.slice(0, separatorIndex);
    const rawAddress = address.slice(separatorIndex + 1);
    return `${chain}:${normalizeAddressForDefiLlamaChain(chain, rawAddress)}`;
  }
  if (address.startsWith("0x")) {
    return `ethereum:${address.toLowerCase()}`;
  }
  return `solana:${address}`;
}

interface DefiLlamaContractQuote extends FallbackPriceQuote {
  observedAt: number;
  symbol: string;
  confidence: number;
}

interface DefiLlamaContractLookup {
  index: number;
  coinId: string;
}

function parseDefiLlamaPriceMap(json: unknown): Map<string, DefiLlamaContractQuote> {
  const prices = new Map<string, DefiLlamaContractQuote>();
  const { coins } = DLPriceResponseSchema.parse(json);
  for (const [id, info] of Object.entries(coins)) {
    if (
      info.price > 0 &&
      typeof info.timestamp === "number" &&
      Number.isFinite(info.timestamp) &&
      typeof info.confidence === "number" &&
      Number.isFinite(info.confidence) &&
      typeof info.symbol === "string" &&
      info.symbol.trim().length > 0
    ) {
      prices.set(id, {
        price: info.price,
        observedAt: Math.floor(info.timestamp),
        observedAtMode: "upstream",
        symbol: info.symbol,
        confidence: info.confidence,
      });
    }
  }
  return prices;
}

async function fetchPriceMapByIds(
  ids: string[],
  source: string,
  budget: { remaining: number },
  signal?: AbortSignal,
  db?: D1Database,
): Promise<{ prices: Map<string, DefiLlamaContractQuote>; failed: boolean }> {
  const prices = new Map<string, DefiLlamaContractQuote>();
  if (ids.length === 0) return { prices, failed: false };

  if (db && !(await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_COINS))) {
    return { prices, failed: false };
  }

  // DefiLlama IDs are one URL path segment. Preserve the documented chain:id
  // separator while escaping embedded slashes such as Osmosis IBC denoms.
  const prefix = `${DEFILLAMA_COINS}/prices/current/`;
  const batches: string[] = [];
  let batch = "";
  let failed = false;
  let providerOutcome: boolean | null = null;
  for (const id of new Set(ids)) {
    const encoded = encodeURIComponent(id).replaceAll("%3A", ":");
    if (prefix.length + encoded.length > DL_CONTRACT_MAX_URL_LENGTH) {
      failed = true;
      continue;
    }
    if (batch && prefix.length + batch.length + 1 + encoded.length > DL_CONTRACT_MAX_URL_LENGTH) {
      batches.push(batch);
      batch = "";
    }
    batch += `${batch ? "," : ""}${encoded}`;
  }
  if (batch) batches.push(batch);

  for (const encodedBatch of batches) {
    throwIfAborted(signal);
    if (budget.remaining <= 0) {
      failed = true;
      break;
    }
    budget.remaining -= 1;
    let result: Awaited<ReturnType<typeof fetchJsonWithRetry<unknown>>>;
    try {
      result = await fetchJsonWithRetry<unknown>(
        `${prefix}${encodedBatch}`,
        signal ? { signal } : undefined,
      );
    } catch {
      throwIfAborted(signal);
      providerOutcome = false;
      failed = true;
      break;
    }
    throwIfAborted(signal);
    if (!result?.response.ok) {
      providerOutcome = false;
      failed = true;
      break;
    }
    try {
      for (const [id, quote] of parseDefiLlamaPriceMap(result.body)) prices.set(id, quote);
      providerOutcome = true;
    } catch {
      logWorkerEventArgs("handler", "error", `[enrich-prices] Failed to parse JSON from ${source}: ${result.response.status}`);
      providerOutcome = false;
      failed = true;
      break;
    }
  }
  if (db && providerOutcome != null) await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, providerOutcome);
  return { prices, failed };
}

function isDefiLlamaContractQuoteUsable(
  asset: PeggedAsset,
  quote: DefiLlamaContractQuote,
  fxRates: Record<string, number> | undefined,
): boolean {
  if (asset.id === LEGACY_SOLOMON_USDV_ID) return false;
  if (quote.symbol.trim().toUpperCase() !== asset.symbol.trim().toUpperCase()) {
    return false;
  }
  if (quote.confidence < DL_CONTRACT_MIN_CONFIDENCE) {
    return false;
  }
  if (!isFreshFallbackObservedAt(quote.observedAt, DL_CONTRACT_MAX_AGE_SEC)) {
    return false;
  }
  return isUsableFallbackPrice(asset, quote.price, fxRates);
}

function buildDefiLlamaCoinIdForChainAddress(chain: string, address: string): string {
  const prefix = DL_COINS_CHAIN_PREFIX_BY_CHAIN[chain] ?? chain;
  const normalizedAddress = normalizeAddressForDefiLlamaChain(chain, address);
  return `${prefix}:${normalizedAddress}`;
}

function buildTrackedDeploymentCoinIds(asset: PeggedAsset): string[] {
  const meta = ACTIVE_META_BY_ID.get(asset.id);
  if (!meta) return [];

  const ids = new Set<string>();
  const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
  for (const deployment of deployments) {
    const chain = resolveChainId(deployment.chain);
    const address = deployment.address?.trim();
    if (!chain || !address) continue;
    ids.add(buildDefiLlamaCoinIdForChainAddress(chain, address));
  }
  return [...ids];
}

function buildPrimaryContractCoinIds(asset: PeggedAsset): string[] {
  const rawAddress = (asset.address?.trim() || TRACKED_ASSET_ADDRESS_OVERRIDES[asset.id])?.trim();
  if (!rawAddress) return buildTrackedDeploymentCoinIds(asset);
  if (rawAddress.includes(":")) {
    return [addressToCoinId(rawAddress)];
  }

  const meta = ACTIVE_META_BY_ID.get(asset.id);
  const matchedDeploymentIds = new Set<string>();
  const normalizedAddress = rawAddress.toLowerCase();
  for (const deployment of [...(meta?.contracts ?? []), ...(meta?.tradedContracts ?? [])]) {
    const chain = resolveChainId(deployment.chain);
    const address = deployment.address?.trim();
    if (!chain || !address) continue;
    if (address.toLowerCase() !== normalizedAddress) continue;
    matchedDeploymentIds.add(buildDefiLlamaCoinIdForChainAddress(chain, address));
  }
  if (matchedDeploymentIds.size > 0) {
    return [...matchedDeploymentIds];
  }

  const explicitChainIds = new Set<string>();
  for (const rawChain of asset.chains ?? []) {
    const chain = resolveChainId(rawChain);
    if (!chain) continue;
    explicitChainIds.add(buildDefiLlamaCoinIdForChainAddress(chain, rawAddress));
  }
  if (explicitChainIds.size > 0) {
    return [...explicitChainIds];
  }

  return [addressToCoinId(rawAddress)];
}

function applyDefiLlamaContractPrices(
  assets: PeggedAsset[],
  lookups: readonly DefiLlamaContractLookup[],
  prices: Map<string, DefiLlamaContractQuote>,
  fxRates: Record<string, number> | undefined,
): number {
  let resolvedCount = 0;
  const resolved = new Set<number>();
  for (const lookup of lookups) {
    if (resolved.has(lookup.index)) continue;
    const quote = prices.get(lookup.coinId);
    if (quote != null && isDefiLlamaContractQuoteUsable(assets[lookup.index], quote, fxRates)) {
      applyResolvedPrice(
        assets[lookup.index],
        quote.price,
        "defillama-contract",
        "single-source",
        quote.observedAt,
        quote.observedAtMode,
      );
      resolvedCount += 1;
      resolved.add(lookup.index);
    }
  }
  return resolvedCount;
}

export async function runDlContractPasses(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  signal?: AbortSignal,
  db?: D1Database,
): Promise<DlContractPassResult> {
  let pass1Count = 0;
  let pass1bCount = 0;
  const failures: string[] = [];
  const budget = { remaining: DL_CONTRACT_MAX_BATCHES };

  try {
    const withAddress: DefiLlamaContractLookup[] = [];
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      if (!hasMissingPrice(asset) || asset.id === LEGACY_SOLOMON_USDV_ID) continue;
      for (const coinId of buildPrimaryContractCoinIds(asset)) {
        withAddress.push({ index, coinId });
      }
    }

    if (withAddress.length > 0) {
      throwIfAborted(signal);
      const pass1Prices = await fetchPriceMapByIds(
        withAddress.map((lookup) => lookup.coinId),
        "DefiLlama coins API (pass 1)",
        budget,
        signal,
        db,
      );
      pass1Count += applyDefiLlamaContractPrices(assets, withAddress, pass1Prices.prices, fxRates);
      if (pass1Prices.failed) {
        failures.push("dl-contracts");
      }
    }

    const stillMissingAddr = withAddress.filter((lookup) => hasMissingPrice(assets[lookup.index]));
    if (stillMissingAddr.length > 0) {
      const altLookups: DefiLlamaContractLookup[] = [];
      for (const lookup of stillMissingAddr) {
        const asset = assets[lookup.index];
        const primaryCoinIds = new Set(buildPrimaryContractCoinIds(asset));
        for (const coinId of buildTrackedDeploymentCoinIds(asset)) {
          if (primaryCoinIds.has(coinId)) continue;
          altLookups.push({ index: lookup.index, coinId });
        }
      }

      if (altLookups.length > 0) {
        throwIfAborted(signal);
        const pass1bPrices = await fetchPriceMapByIds(
          altLookups.map((lookup) => lookup.coinId),
          "DefiLlama coins API (pass 1b)",
          budget,
          signal,
          db,
        );
        pass1bCount += applyDefiLlamaContractPrices(assets, altLookups, pass1bPrices.prices, fxRates);
        if (pass1bPrices.failed && !failures.includes("dl-contracts")) {
          failures.push("dl-contracts");
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    logWorkerEventArgs("handler", "warn", "[enrich-prices] Pass 1/1b (DefiLlama contracts) failed — continuing with CMC/DexScreener:", error);
    if (!failures.includes("dl-contracts")) failures.push("dl-contracts");
  }

  return {
    resolved: pass1Count + pass1bCount,
    failures,
    pass1: pass1Count,
    pass1b: pass1bCount,
  };
}
