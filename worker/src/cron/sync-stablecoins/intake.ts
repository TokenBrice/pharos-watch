import { REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { CIRCUIT_SOURCE, DEFILLAMA_BASE, MIN_VALID_ASSET_COUNT } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { upsertDiscoveryCandidates } from "../discovery-scan";
import type { PeggedAsset } from "../enrich-prices";
import {
  applyTrackedAssetOverrides,
  type CanonicalDeduplicationResult,
  dedupeCanonicalAssets,
  filterStructurallyValidAssets,
  normalizeChainCirculating,
} from "./stages";
import {
  fetchCoinGeckoMarketData,
  fetchSupplementalTrackedTokens,
  type CoinGeckoMcapData,
} from "./supplemental-assets";
import {
  hydrateGeckoIdAliases,
  loadPreviousStablecoinsById,
  mergeSupplementalLastKnownGood,
  type CronResult,
} from "./shared";

interface StablecoinsIntakeMainResult {
  kind: "main";
  assets: PeggedAsset[];
  rawAssetCount: number;
  droppedMalformedAssets: number;
  canonicalDeduplication: CanonicalDeduplicationResult;
  fxFallbackRates?: Record<string, number>;
  previousAssetsById: Map<string, PeggedAsset>;
  cgData: CoinGeckoMcapData;
}

interface StablecoinsIntakeFallbackResult {
  kind: "fallback";
  result: CronResult;
  errorMessage: string;
}

export type StablecoinsIntakeResult =
  | StablecoinsIntakeMainResult
  | StablecoinsIntakeFallbackResult;

export async function loadStablecoinsIntake(
  input: {
    db: D1Database;
    signal?: AbortSignal;
    syncStartSec: number;
    coingeckoApiKey?: string | null;
    chainRpcs?: Map<string, ChainRpcConfig>;
    fallbackToCoingecko: (cgData: CoinGeckoMcapData) => Promise<CronResult>;
  },
): Promise<StablecoinsIntakeResult> {
  const previousAssetsById = await loadPreviousStablecoinsById(input.db);
  const cgData = await fetchCoinGeckoMarketData(input.db, input.signal, input.coingeckoApiKey);

  const dlAllowed = await shouldAttemptFetch(input.db, CIRCUIT_SOURCE.DL_STABLECOINS);
  const [llamaRes, supplementalTokens] = await Promise.all([
    dlAllowed
      ? fetchWithRetry(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`, input.signal ? { signal: input.signal } : undefined)
      : Promise.resolve(null),
    fetchSupplementalTrackedTokens(cgData, input.signal, input.coingeckoApiKey, input.chainRpcs),
  ]);
  const { goldTokens, silverTokens, fiatCgTokens } = supplementalTokens;

  if (dlAllowed) {
    if (!llamaRes?.ok) {
      console.error(`[sync-stablecoins] DefiLlama API error: ${llamaRes?.status ?? "no response"}`);
      await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
      return {
        kind: "fallback",
        result: await input.fallbackToCoingecko(cgData),
        errorMessage: "DefiLlama stablecoins API failed and CoinGecko fallback was insufficient",
      };
    }
  } else {
    console.warn("[sync-stablecoins] DL stablecoins circuit open — using CG supply fallback");
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: "DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient",
    };
  }

  let llamaData: {
    peggedAssets: PeggedAsset[];
    fxFallbackRates?: Record<string, number>;
  };
  try {
    llamaData = await llamaRes!.json() as typeof llamaData;
  } catch (parseErr) {
    console.error("[sync-stablecoins] DL response body parse failed:", parseErr);
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: "DefiLlama response body parse failed",
    };
  }
  const rawAssetCount = llamaData.peggedAssets?.length ?? 0;

  if (llamaData.peggedAssets === undefined) {
    console.warn("[sync] DefiLlama response missing peggedAssets field — possible API contract change");
  }
  if (!llamaData.peggedAssets || llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Unexpected asset count (${llamaData.peggedAssets?.length}), need ${MIN_VALID_ASSET_COUNT}+, skipping cache write`);
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload was structurally invalid (asset count=${llamaData.peggedAssets?.length ?? 0}) and fallback failed`,
    };
  }

  const { validAssets, droppedMalformedAssets } = filterStructurallyValidAssets(llamaData.peggedAssets);
  if (validAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Only ${validAssets.length} valid assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`);
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload had too many malformed assets (valid=${validAssets.length}) and fallback failed`,
    };
  }
  if (validAssets.length < llamaData.peggedAssets.length) {
    console.warn(`[sync-stablecoins] Dropped ${llamaData.peggedAssets.length - validAssets.length} malformed assets`);
    llamaData.peggedAssets = validAssets;
  }

  hydrateGeckoIdAliases(llamaData.peggedAssets);
  normalizeChainCirculating(llamaData.peggedAssets);

  const dlResiduals = llamaData.peggedAssets
    .filter((a) => !REGISTRY_BY_LLAMA_ID.has(String(a.id)))
    .filter((a) => {
      const circ = a.circulating;
      if (!circ || typeof circ !== "object") return false;
      const total = Object.values(circ).reduce((sum: number, v: unknown) => sum + (typeof v === "number" ? v : 0), 0);
      return total >= 5_000_000;
    })
    .map((a) => ({
      llamaId: Number(a.id),
      name: a.name as string,
      symbol: a.symbol as string,
      marketCap: Object.values(a.circulating ?? {}).reduce((sum: number, v: unknown) => sum + (typeof v === "number" ? v : 0), 0),
      source: "defillama" as const,
    }));

  if (dlResiduals.length > 0) {
    try {
      await upsertDiscoveryCandidates(input.db, dlResiduals);
      console.log(`[discovery] DL residuals: ${dlResiduals.length} untracked coins above $5M`);
    } catch (err) {
      console.warn("[discovery] DL residuals upsert failed:", err);
    }
  }

  for (const asset of llamaData.peggedAssets) {
    const mapped = REGISTRY_BY_LLAMA_ID.get(String(asset.id));
    if (mapped) {
      asset.id = mapped.id;
    }
  }

  const canonicalDeduplication = dedupeCanonicalAssets(llamaData.peggedAssets);
  if (canonicalDeduplication.duplicateRows > 0) {
    console.warn(
      `[sync-stablecoins] Deduped ${canonicalDeduplication.duplicateRows} canonical duplicate row(s): ` +
      canonicalDeduplication.affectedIds.join(", "),
    );
    llamaData.peggedAssets = canonicalDeduplication.dedupedAssets;
  }
  if (llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(
      `[sync-stablecoins] Canonical dedupe reduced asset count to ${llamaData.peggedAssets.length} ` +
      `(need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`,
    );
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload collapsed to ${llamaData.peggedAssets.length} unique canonical IDs and fallback failed`,
    };
  }

  const supplementalResolution = mergeSupplementalLastKnownGood(
    [...goldTokens, ...silverTokens, ...fiatCgTokens],
    previousAssetsById,
    new Set(llamaData.peggedAssets.map((asset) => String(asset.id))),
  );
  if (supplementalResolution.assets.length > 0) {
    llamaData.peggedAssets = [...llamaData.peggedAssets, ...supplementalResolution.assets];
  }
  if (supplementalResolution.restoredCount > 0 || supplementalResolution.skippedDuplicates > 0) {
    console.log(
      `[sync-stablecoins] Supplemental resolution: restored=${supplementalResolution.restoredCount}, ` +
      `skippedDuplicates=${supplementalResolution.skippedDuplicates}`,
    );
  }

  applyTrackedAssetOverrides(llamaData.peggedAssets);

  return {
    kind: "main",
    assets: llamaData.peggedAssets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
    fxFallbackRates: llamaData.fxFallbackRates,
    previousAssetsById,
    cgData,
  };
}
