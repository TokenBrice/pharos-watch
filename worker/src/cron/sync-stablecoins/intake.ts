import { REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import { FROZEN_SNAPSHOTS } from "@shared/lib/stablecoins/frozen-snapshots";
import type { FrozenSnapshot } from "@shared/lib/stablecoins/frozen-snapshots";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { CIRCUIT_SOURCE, DEFILLAMA_BASE, MIN_VALID_ASSET_COUNT } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { upsertDiscoveryCandidates } from "../discovery-scan";
import type { PeggedAsset } from "./enrich-prices";
import {
  applyTrackedAssetOverrides,
  type CanonicalDeduplicationResult,
  dedupeCanonicalAssets,
  filterStructurallyValidAssets,
  normalizeChainCirculating,
} from "./phase-helpers";
import {
  fetchCoinGeckoMarketData,
  fetchSupplementalTrackedTokens,
  type CoinGeckoMcapData,
} from "./supplemental-assets";
import {
  reconcileTrackedSupplyGaps,
  type SupplyGapReconciliationResult,
} from "./supply-gap-reconciliation";
import {
  hydrateGeckoIdAliases,
  loadPreviousStablecoinsById,
  mergeSupplementalLastKnownGood,
  restoreMissingTrackedAssets,
  type CronResult,
  type TrackedCoverageRestoreResult,
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
  supplyGapReconciliation: SupplyGapReconciliationResult;
  trackedCoverage: TrackedCoverageRestoreResult;
}

interface StablecoinsIntakeFallbackResult {
  kind: "fallback";
  result: CronResult;
  errorMessage: string;
}

export type StablecoinsIntakeResult =
  | StablecoinsIntakeMainResult
  | StablecoinsIntakeFallbackResult;

const DEFILLAMA_STABLECOINS_URL = `${DEFILLAMA_BASE}/stablecoins?includePrices=true`;
const DL_PARSE_MAX_ATTEMPTS = 3;
const DL_PARSE_RETRY_BASE_DELAY_MS = 500;

type DefillamaStablecoinsPayload = {
  peggedAssets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
};

interface DefillamaFetchResult {
  payload: DefillamaStablecoinsPayload | null;
  attempts: number;
  lastError: "fetch-failed" | "parse-failed" | null;
  lastHttpStatus: number | null;
}

async function fetchDefillamaStablecoinsPayload(
  signal: AbortSignal | undefined,
): Promise<DefillamaFetchResult> {
  let lastError: DefillamaFetchResult["lastError"] = null;
  let lastHttpStatus: number | null = null;
  let attempts = 0;
  for (let attempt = 0; attempt < DL_PARSE_MAX_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    attempts = attempt + 1;
    const result = await fetchTextWithRetry(
      DEFILLAMA_STABLECOINS_URL,
      signal ? { signal } : undefined,
      2,
      { returnFinalResponse: true },
    );
    if (!result?.response.ok) {
      lastError = "fetch-failed";
      lastHttpStatus = result?.response.status ?? null;
      break;
    }
    try {
      const payload = JSON.parse(result.body) as DefillamaStablecoinsPayload;
      return {
        payload,
        attempts,
        lastError: null,
        lastHttpStatus: result.response.status,
      };
    } catch (parseErr) {
      lastError = "parse-failed";
      lastHttpStatus = result.response.status;
      console.warn(
        `[sync-stablecoins] DL response body parse failed on attempt ${attempts}/${DL_PARSE_MAX_ATTEMPTS}:`,
        parseErr,
      );
      if (attempts < DL_PARSE_MAX_ATTEMPTS) {
        await sleepWithSignal(DL_PARSE_RETRY_BASE_DELAY_MS * attempts, signal);
      }
    }
  }
  return {
    payload: null,
    attempts,
    lastError,
    lastHttpStatus,
  };
}

/**
 * Append captured frozen-coin rows for any canonical id absent from the
 * upstream payload. This is intentionally run before structural validation,
 * chain-circulating normalization, canonical-id mapping, and dedupe so frozen
 * snapshots pass through the same intake safeguards as live DefiLlama rows.
 * Upstream rows always win — if DefiLlama still serves the asset, that's the
 * authoritative copy. Returns the input array unchanged when there is nothing
 * to inject (so existing identity tests pass).
 */
export function mergeFrozenSnapshots(
  upstream: PeggedAsset[],
  snapshots: FrozenSnapshot[],
): PeggedAsset[] {
  if (snapshots.length === 0) {
    return upstream;
  }
  const upstreamIds = new Set(
    upstream.flatMap((a) => {
      const id = String((a as { id?: unknown }).id ?? "");
      const mapped = REGISTRY_BY_LLAMA_ID.get(id)?.id;
      return mapped && mapped !== id ? [id, mapped] : [id];
    }),
  );
  const additions: PeggedAsset[] = [];
  for (const snapshot of snapshots) {
    if (upstreamIds.has(snapshot.id)) {
      continue;
    }
    additions.push(snapshot.peggedAssetRow as unknown as PeggedAsset);
    upstreamIds.add(snapshot.id);
  }
  if (additions.length === 0) {
    return upstream;
  }
  return [...upstream, ...additions];
}

export async function loadStablecoinsIntake(
  input: {
    db: D1Database;
    signal?: AbortSignal;
    syncStartSec: number;
    fxFallbackRates?: Record<string, number>;
    coingeckoApiKey?: string | null;
    chainRpcs?: Map<string, ChainRpcConfig>;
    fallbackToCoingecko: (cgData: CoinGeckoMcapData) => Promise<CronResult>;
  },
): Promise<StablecoinsIntakeResult> {
  const previousAssetsById = await loadPreviousStablecoinsById(input.db);
  const cgData = await fetchCoinGeckoMarketData(input.db, input.signal, input.coingeckoApiKey);

  const dlAllowed = await shouldAttemptFetch(input.db, CIRCUIT_SOURCE.DL_STABLECOINS);
  if (!dlAllowed) {
    console.warn("[sync-stablecoins] DL stablecoins circuit open — using CG supply fallback");
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: "DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient",
    };
  }

  const supplementalTokensPromise = fetchSupplementalTrackedTokens(
    cgData,
    input.signal,
    input.coingeckoApiKey,
    input.chainRpcs,
    input.fxFallbackRates,
    input.db,
  );

  const [dlFetchResult, supplementalTokens] = await Promise.all([
    fetchDefillamaStablecoinsPayload(input.signal),
    supplementalTokensPromise,
  ]);
  const { goldTokens, silverTokens, fiatCgTokens } = supplementalTokens;

  if (!dlFetchResult.payload) {
    if (dlFetchResult.lastError === "parse-failed") {
      console.error(
        `[sync-stablecoins] DL response body parse failed after ${dlFetchResult.attempts} attempts (last HTTP status=${dlFetchResult.lastHttpStatus ?? "unknown"})`,
      );
    } else {
      console.error(
        `[sync-stablecoins] DefiLlama API error after ${dlFetchResult.attempts} attempt(s) (last HTTP status=${dlFetchResult.lastHttpStatus ?? "no response"})`,
      );
    }
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage:
        dlFetchResult.lastError === "parse-failed"
          ? "DefiLlama response body parse failed"
          : "DefiLlama stablecoins API failed and CoinGecko fallback was insufficient",
    };
  }

  const llamaData = dlFetchResult.payload;
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

  // Run the transformation pipeline on a local variable instead of mutating the
  // parsed payload struct's array field. `llamaData.peggedAssets` is guaranteed
  // defined and valid by the guards above; the steps below reassign `assets`
  // rather than the upstream payload, so the original parsed response is left
  // intact and the transformation sequence is self-documenting.
  let assets = mergeFrozenSnapshots(llamaData.peggedAssets, FROZEN_SNAPSHOTS);
  const injectedFrozenSnapshots = assets.length - llamaData.peggedAssets.length;
  if (injectedFrozenSnapshots > 0) {
    console.log(`[sync-stablecoins] Injected ${injectedFrozenSnapshots} frozen-snapshot row(s)`);
  }

  const { validAssets, droppedMalformedAssets } = filterStructurallyValidAssets(assets);
  if (validAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Only ${validAssets.length} valid assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`);
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload had too many malformed assets (valid=${validAssets.length}) and fallback failed`,
    };
  }
  if (validAssets.length < assets.length) {
    console.warn(`[sync-stablecoins] Dropped ${assets.length - validAssets.length} malformed assets`);
    assets = validAssets;
  }

  hydrateGeckoIdAliases(assets);
  normalizeChainCirculating(assets);

  const dlResiduals = assets
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

  for (const asset of assets) {
    const mapped = REGISTRY_BY_LLAMA_ID.get(String(asset.id));
    if (mapped) {
      asset.id = mapped.id;
    }
  }

  const canonicalDeduplication = dedupeCanonicalAssets(assets);
  if (canonicalDeduplication.duplicateRows > 0) {
    console.warn(
      `[sync-stablecoins] Deduped ${canonicalDeduplication.duplicateRows} canonical duplicate row(s): ` +
      canonicalDeduplication.affectedIds.join(", "),
    );
    assets = canonicalDeduplication.dedupedAssets;
  }
  if (assets.length < MIN_VALID_ASSET_COUNT) {
    console.error(
      `[sync-stablecoins] Canonical dedupe reduced asset count to ${assets.length} ` +
      `(need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`,
    );
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload collapsed to ${assets.length} unique canonical IDs and fallback failed`,
    };
  }

  const supplementalResolution = mergeSupplementalLastKnownGood(
    [...goldTokens, ...silverTokens, ...fiatCgTokens],
    previousAssetsById,
    new Set(assets.map((asset) => String(asset.id))),
    input.syncStartSec,
  );
  if (supplementalResolution.assets.length > 0) {
    assets = [...assets, ...supplementalResolution.assets];
  }
  if (supplementalResolution.restoredCount > 0 || supplementalResolution.skippedDuplicates > 0) {
    console.log(
      `[sync-stablecoins] Supplemental resolution: restored=${supplementalResolution.restoredCount}, ` +
      `skippedDuplicates=${supplementalResolution.skippedDuplicates}`,
    );
  }
  if (supplementalResolution.expiredRestoreIds.length > 0) {
    console.warn(
      "[sync-stablecoins] Supplemental supply carry-forward expired past the " +
      "7d ceiling (publishing without restored supply): " +
      supplementalResolution.expiredRestoreIds.join(", "),
    );
  }

  // Restore-or-degrade on tracked-id coverage: a DefiLlama list omission must
  // not silently drop a tracked coin from the published payload for a cycle.
  const trackedCoverage = restoreMissingTrackedAssets(
    assets,
    previousAssetsById,
    input.syncStartSec,
  );
  if (trackedCoverage.assets.length > 0) {
    assets = [...assets, ...trackedCoverage.assets];
    console.warn(
      "[sync-stablecoins] Intake omitted tracked coin(s); restored last-known-good row(s): " +
      trackedCoverage.restoredIds.join(", "),
    );
  }
  if (trackedCoverage.droppedIds.length > 0) {
    console.error(
      "[sync-stablecoins] Tracked coin(s) missing from intake with no restorable row " +
      "(publishing without them): " + trackedCoverage.droppedIds.join(", "),
    );
  }

  applyTrackedAssetOverrides(assets);

  const supplyGapReconciliation = await reconcileTrackedSupplyGaps(
    assets,
    input.signal,
    input.coingeckoApiKey,
    input.chainRpcs,
    input.fxFallbackRates,
  );
  if (supplyGapReconciliation.totalReconciled > 0) {
    console.warn(
      `[sync-stablecoins] Reconciled ${supplyGapReconciliation.totalReconciled} tracked supply gap(s) from gap repair: ` +
      supplyGapReconciliation.reconciledIds.join(", "),
    );
  }

  return {
    kind: "main",
    assets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
    fxFallbackRates: llamaData.fxFallbackRates,
    previousAssetsById,
    cgData,
    supplyGapReconciliation,
    trackedCoverage,
  };
}
