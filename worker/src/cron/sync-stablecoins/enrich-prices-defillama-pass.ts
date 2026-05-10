import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { resolveChainId } from "@shared/lib/chains";
import { CIRCUIT_SOURCE, DEFILLAMA_COINS } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
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

const DL_CONTRACT_MAX_AGE_SEC = 15 * 60;
const DL_CONTRACT_MIN_CONFIDENCE = 0.8;

const DL_COINS_CHAIN_PREFIX_BY_CHAIN: Record<string, string> = {
  avalanche: "avax",
};

const ADDRESS_OVERRIDES: Record<string, string> = {
  "m-m0": "0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b",
  "bean-beanstalk": "arbitrum:0xBEA0005B8599265D41256905A9B3073D397812E4",
};

function addressToCoinId(address: string): string {
  if (address.includes(":")) {
    return address;
  }
  if (address.startsWith("0x")) {
    return `ethereum:${address}`;
  }
  return `solana:${address}`;
}

interface DefiLlamaContractQuote extends FallbackPriceQuote {
  observedAt: number;
  symbol: string;
  confidence: number;
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
  signal?: AbortSignal,
  db?: D1Database,
): Promise<Map<string, DefiLlamaContractQuote> | null> {
  if (ids.length === 0) return new Map();

  if (db && !(await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_COINS))) {
    return new Map();
  }

  const res = await fetchWithRetry(
    `${DEFILLAMA_COINS}/prices/current/${ids.join(",")}`,
    signal ? { signal } : undefined,
  );
  if (!res?.ok) {
    if (db) {
      await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, false);
    }
    return null;
  }

  try {
    const prices = parseDefiLlamaPriceMap(await res.json());
    if (db) {
      await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, true);
    }
    return prices;
  } catch {
    console.error(`[enrich-prices] Failed to parse JSON from ${source}: ${res.status}`);
    if (db) {
      await recordOutcome(db, CIRCUIT_SOURCE.DL_COINS, false);
    }
    return new Map();
  }
}

function isDefiLlamaContractQuoteUsable(
  asset: PeggedAsset,
  quote: DefiLlamaContractQuote,
  fxRates: Record<string, number> | undefined,
): boolean {
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
  return `${prefix}:${address}`;
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
  const rawAddress = (asset.address?.trim() || ADDRESS_OVERRIDES[asset.id])?.trim();
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

export async function runDlContractPasses(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  signal?: AbortSignal,
  db?: D1Database,
): Promise<DlContractPassResult> {
  let pass1Count = 0;
  let pass1bCount = 0;
  const failures: string[] = [];

  try {
    const withAddress: { index: number; coinId: string }[] = [];
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      if (!hasMissingPrice(asset)) continue;
      for (const coinId of buildPrimaryContractCoinIds(asset)) {
        withAddress.push({ index, coinId });
      }
    }

    if (withAddress.length > 0) {
      throwIfAborted(signal);
      const pass1Prices = await fetchPriceMapByIds(
        withAddress.map((lookup) => lookup.coinId),
        "DefiLlama coins API (pass 1)",
        signal,
        db,
      );
      if (pass1Prices) {
        const resolved = new Set<number>();
        for (const lookup of withAddress) {
          if (resolved.has(lookup.index)) continue;
          const quote = pass1Prices.get(lookup.coinId);
          if (quote != null && isDefiLlamaContractQuoteUsable(assets[lookup.index], quote, fxRates)) {
            applyResolvedPrice(
              assets[lookup.index],
              quote.price,
              "defillama-contract",
              "single-source",
              quote.observedAt,
              quote.observedAtMode,
            );
            pass1Count += 1;
            resolved.add(lookup.index);
          }
        }
      }
    }

    const stillMissingAddr = withAddress.filter((lookup) => hasMissingPrice(assets[lookup.index]));
    if (stillMissingAddr.length > 0) {
      const altLookups: { index: number; coinId: string }[] = [];
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
          signal,
          db,
        );
        if (pass1bPrices) {
          const resolved = new Set<number>();
          for (const lookup of altLookups) {
            if (resolved.has(lookup.index)) continue;
            const quote = pass1bPrices.get(lookup.coinId);
            if (quote != null && isDefiLlamaContractQuoteUsable(assets[lookup.index], quote, fxRates)) {
              applyResolvedPrice(
                assets[lookup.index],
                quote.price,
                "defillama-contract",
                "single-source",
                quote.observedAt,
                quote.observedAtMode,
              );
              pass1bCount += 1;
              resolved.add(lookup.index);
            }
          }
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[enrich-prices] Pass 1/1b (DefiLlama contracts) failed — continuing with CMC/DexScreener:", error);
    failures.push("dl-contracts");
  }

  return {
    resolved: pass1Count + pass1bCount,
    failures,
    pass1: pass1Count,
    pass1b: pass1bCount,
  };
}
